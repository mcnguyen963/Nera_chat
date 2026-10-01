import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { state } from "../state.js";
import * as messagesApi from "../messages.js";
import { buildContextForRequest, computeContextUsage } from "../context-builder.js";
import { chatCompletion } from "../llm-client.js";
import { runSummarization, shouldAutoSummarize } from "../summarizer.js";
import { extractPlan, extractPlanThread, stripPlan } from "../plan-parser.js";
import { updateSession } from "../sessions.js";
import { currentUid } from "../auth.js";
import { loadChatCache, saveChatCache, deleteChatCache } from "../chat-cache.js";
import {
  useLocalSettings,
  normalizeProfiles,
  activeProfile,
  mirrorFromActiveProfile,
  mirrorToActiveProfile,
} from "../settings.js";
import { initPetView, startPetTurn, finishPetTurn, refreshPetPlacement, updatePetPhase, invalidatePetLayout } from "./pet-view.js";

let msgUnsub = null;
let sessUnsub = null;
let session = null;      // latest snapshot of the active session doc
let streamState = null;  // live streaming UI handle
let busy = false;
let indicatorRun = 0;
let editingState = null; // { id, ta } while a message is being edited inline
const PAGE_SIZE = 100;
let visibleCount = PAGE_SIZE;
let hasEarlier = false;
let latestMessageIds = new Set();
let latestReady = false;
let historyMessages = null; // full history or the active checkpoint onward
let historyStartOrder = 0;
let historyLoading = null;
const historyCache = new Map(); // three most recently visited sessions in memory
let cacheSaveTimer = null;
let continuityRefresh = 0;
let watchedBranchId;
let continuityRetry = null;
let continuityModules = null;
let continuityContextStats = null;
let continuityContextSnapshot = null;
let contextPreviewTimer = null;
const renderedMessages = new Map();

function loadContinuity() {
  return continuityModules ??= Promise.all([
    import("../continuity/runtime.js"),
    import("../continuity/turn-controller.js"),
    import("../continuity/store.js"),
    import("../continuity/saver.js"),
  ]).then(([runtime, controller, store, saver]) => ({ ...runtime, ...controller, ...store, ...saver }))
    .catch((error) => { continuityModules = null; throw error; });
}

const el = {};

export function initChatView() {
  el.list = document.getElementById("message-list");
  el.input = document.getElementById("chat-input");
  el.composer = document.getElementById("composer");
  el.sendBtn = document.getElementById("btn-send");
  el.mode = document.getElementById("composer-mode");
  el.summarizeBtn = document.getElementById("btn-summarize");
  el.contextFill = document.getElementById("context-fill");
  el.contextThreshold = document.getElementById("context-threshold");
  el.contextLabel = document.getElementById("context-label");
  el.earlierBtn = document.createElement("button");
  el.earlierBtn.className = "btn earlier-messages";
  el.earlierBtn.type = "button";
  el.earlierBtn.addEventListener("click", async () => {
    if (!lastMessages.length) return;
    if (lastMessages.length > visibleCount) {
      visibleCount += PAGE_SIZE;
      renderMessages(lastMessages);
      return;
    }
    if (!hasEarlier) return;
    const previousHeight = el.list.scrollHeight;
    const previousTop = el.list.scrollTop;
    const sessionId = state.sessionId;
    const beforeOrder = lastMessages[0].order;
    el.earlierBtn.disabled = true;
    try {
      const cachedEarlier = historyMessages && historyStartOrder === 0
        ? historyMessages.filter((m) => m.order < beforeOrder)
        : null;
      const older = session?.continuityEnabled
        ? await (await loadContinuity()).storyStore(sessionId).listMessages(session.continuityBranchId || "main", beforeOrder, PAGE_SIZE)
        : cachedEarlier
        ? cachedEarlier.slice(-PAGE_SIZE)
        : await messagesApi.getEarlierMessages(sessionId, beforeOrder, PAGE_SIZE);
      if (state.sessionId !== sessionId) return;
      hasEarlier = cachedEarlier
        ? cachedEarlier.length > older.length
        : older.length === PAGE_SIZE;
      visibleCount += older.length;
      renderMessages(mergeMessages(lastMessages, older));
      el.list.scrollTop = previousTop + el.list.scrollHeight - previousHeight;
    } catch (err) {
      showTransientError("Could not load earlier messages: " + err.message);
    } finally {
      el.earlierBtn.disabled = false;
    }
  });

  el.composer.addEventListener("submit", handleSend);
  el.summarizeBtn.addEventListener("click", handleSummarize);
  document.addEventListener("summarize-full", handleFullSummarize);
  document.addEventListener("reset-summary", handleResetSummary);

  // Auto-grow composer: starts at one row, grows with content, capped by CSS
  // (max-height: min(40vh, 240px)) — beyond the cap the textarea scrolls.
  const autoGrow = () => {
    el.input.style.height = "auto";
    el.input.style.height = el.input.scrollHeight + "px";
  };
  el.input.addEventListener("input", autoGrow);
  el.input.addEventListener("input", () => {
    if (!session?.continuityEnabled) return;
    clearTimeout(contextPreviewTimer);
    contextPreviewTimer = setTimeout(updateIndicator, 250);
  });
  el.mode.addEventListener("change", updateIndicator);
  window.addEventListener("resize", autoGrow);
  autoGrow();

  // iOS keyboard: keep the composer right above the keyboard, not pushed far
  // above it (iOS auto-scrolls the window on focus; app.js cancels that, and
  // this compensates inside the list if the user was scrolled deep).
  el.input.addEventListener("focus", () => {
    requestAnimationFrame(() => alignFieldToKeyboard(el.composer));
  });

  document.querySelectorAll("[data-starter]").forEach((button) => {
    button.addEventListener("click", () => {
      el.input.value = button.dataset.starter;
      autoGrow();
      el.input.focus();
    });
  });
  document.getElementById("btn-welcome-new")?.addEventListener("click", () => {
    document.getElementById("btn-new-session")?.click();
  });
  updateWelcome();
  initQuickControls();
  initPetView();
}

// ---------- quick model / thinking chips (composer) ----------

// Quick controls update the device cache and live settings without Firestore.
function initQuickControls() {
  el.chipModel = document.getElementById("btn-model-chip");
  el.chipModelLabel = document.getElementById("chip-model");
  el.popover = document.getElementById("composer-popover");
  el.quickProfile = document.getElementById("quick-profile");
  el.quickThinking = document.getElementById("quick-thinking");

  el.chipModel.addEventListener("click", () => toggleQuickPopover());

  el.quickProfile.addEventListener("change", () => {
    const s = structuredClone(state.settings);
    if (!s) return;
    s.activeProfileId = el.quickProfile.value;
    normalizeProfiles(s);
    mirrorFromActiveProfile(s); // load the chosen profile's connection fields
    useLocalSettings(s);
  });

  el.quickThinking.addEventListener("change", () => {
    const s = structuredClone(state.settings);
    if (!s) return;
    const v = el.quickThinking.value;
    if (v === "off") {
      s.reasoning = { ...s.reasoning, enabled: false };
    } else if (v === "max_tokens") {
      s.reasoning = { ...s.reasoning, enabled: true, mode: "max_tokens" };
    } else {
      s.reasoning = { ...s.reasoning, enabled: true, mode: "effort", effort: v };
    }
    normalizeProfiles(s);
    mirrorToActiveProfile(s);
    useLocalSettings(s);
  });

  // Close when tapping anywhere outside the popover and the chip.
  document.addEventListener("click", (e) => {
    if (el.popover.hidden) return;
    if (el.popover.contains(e.target)) return;
    if (el.chipModel.contains(e.target)) return;
    el.popover.hidden = true;
  });

  document.addEventListener("settings-changed", refreshQuickChips);
  document.addEventListener("settings-changed", updateIndicator);
  refreshQuickChips();
}

function toggleQuickPopover() {
  if (el.popover.hidden) {
    const s = state.settings;
    if (s) normalizeProfiles(s);
    fillQuickProfileSelect(s);
    el.quickThinking.value = quickThinkingValue(s);
    el.popover.hidden = false;
  } else {
    el.popover.hidden = true;
  }
}

function fillQuickProfileSelect(s) {
  if (!s) return;
  el.quickProfile.replaceChildren(
    ...s.profiles.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      return o;
    })
  );
  el.quickProfile.value = s.activeProfileId;
}

function quickThinkingValue(s) {
  const r = s?.reasoning;
  if (!r?.enabled) return "off";
  return r.mode === "max_tokens" ? "max_tokens" : r.effort ?? "medium";
}

function refreshQuickChips() {
  const s = state.settings;
  if (!s) return;
  normalizeProfiles(s);
  const p = activeProfile(s);
  fillQuickProfileSelect(s);
  el.quickThinking.value = quickThinkingValue(s);
  el.chipModelLabel.textContent = p?.name
    ? `${p.name} · ${s.modelId || "no model"}`
    : s.modelId || "Model not set";
}

export function setSession(sessionId, opts = {}) {
  if (state.sessionId === sessionId) return true;
  continuityContextStats = null;
  continuityContextSnapshot = null;
  if (busy) {
    showTransientError("Wait for the current reply or summary to finish before switching sessions.");
    return false;
  }
  if (cacheSaveTimer) { clearTimeout(cacheSaveTimer); cacheSaveTimer = null; }
  if (state.sessionId && session && latestReady && !opts.skipCacheSave) {
    const snapshot = chatSnapshot();
    historyCache.delete(state.sessionId);
    historyCache.set(state.sessionId, snapshot);
    void saveChatCache(currentUid(), state.sessionId, snapshot);
    if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
  }
  msgUnsub?.();
  sessUnsub?.();
  msgUnsub = sessUnsub = null;
  watchedBranchId = undefined;
  ++continuityRefresh;
  state.sessionId = sessionId;
  session = null;
  streamState = null;
  editingState = null;
  lastMessages = [];
  visibleCount = PAGE_SIZE;
  hasEarlier = false;
  latestMessageIds = new Set();
  latestReady = false;
  const cachedHistory = opts.fresh ? null : historyCache.get(sessionId);
  historyMessages = cachedHistory?.history ?? null;
  historyStartOrder = 0;
  if (cachedHistory) {
    historyCache.delete(sessionId);
    historyCache.set(sessionId, cachedHistory);
  } else if (sessionId && historyCache.size >= 3) {
    historyCache.delete(historyCache.keys().next().value);
  }
  historyLoading = null;
  renderedMessages.clear();
  ++indicatorRun;
  el.list.innerHTML = "";
  el.contextFill.style.width = "0%";
  el.contextLabel.textContent = "No session selected";
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session: null } }));
  updateWelcome();
  if (!sessionId) return true;
  el.contextLabel.textContent = "Loading chat…";
  if (opts.fresh) {
    subscribeChat(sessionId);
    return true;
  }
  if (cachedHistory) {
    restoreCachedChat(sessionId, cachedHistory);
    if (savedContinuity(cachedHistory)) subscribeChat(sessionId);
    return true;
  }
  void loadChatCache(currentUid(), sessionId).then((saved) => {
    if (state.sessionId !== sessionId) return;
    if (saved?.session && Array.isArray(saved.recent)) {
      historyCache.set(sessionId, saved);
      if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
      restoreCachedChat(sessionId, saved);
      if (savedContinuity(saved)) subscribeChat(sessionId);
    } else {
      subscribeChat(sessionId);
    }
  }).catch(() => {
    if (state.sessionId === sessionId) subscribeChat(sessionId);
  });
  return true;
}

function savedContinuity(saved) { return saved?.session?.continuityEnabled === true; }

function chatSnapshot() {
  return structuredClone({ session, recent: lastMessages, hasEarlier, history: historyMessages });
}

function queueCacheSave() {
  if (!session || !latestReady) return;
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    void saveChatCache(currentUid(), state.sessionId, chatSnapshot());
  }, 250);
}

function restoreCachedChat(sessionId, saved) {
  session = saved.session;
  historyMessages = saved.history ?? null;
  hasEarlier = saved.hasEarlier;
  latestReady = true;
  renderMessages(saved.recent);
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session } }));
  updateIndicator();
  queueCacheSave(); // refresh recency for the three-entry device cache
}

function subscribeChat(sessionId) {

  sessUnsub = onSnapshot(
    doc(db, "users", currentUid(), "sessions", sessionId),
    (snap) => {
      if (state.sessionId !== sessionId) return;
      const previous = session;
      session = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      const branchId = session?.continuityEnabled ? session.continuityBranchId || "main" : null;
      if (branchId !== watchedBranchId) {
        msgUnsub?.();
        msgUnsub = null;
        watchedBranchId = branchId;
        if (branchId) subscribeContinuity(sessionId, branchId);
        else subscribeLegacyMessages(sessionId);
      }
      if (!session || !previous ||
          session.longTermPlan !== previous.longTermPlan ||
          session.activeSummaryMessageId !== previous.activeSummaryMessageId ||
          session.breakpointOrder !== previous.breakpointOrder) {
        updateIndicator();
      }
      if (!session || !previous || session.title !== previous.title ||
          session.longTermPlan !== previous.longTermPlan) {
        document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session } }));
      }
      if (branchId && session?.continuityPendingTurnId !== previous?.continuityPendingTurnId)
        void refreshPendingContinuity(sessionId, branchId);
      updateWelcome();
      queueCacheSave();
    },
    (err) => console.error("Session listener error:", err)
  );

}

async function subscribeContinuity(sessionId, branchId) {
  let runtime;
  try { runtime = await loadContinuity(); }
  catch (error) { showTransientError("Could not load character continuity: " + error.message); return; }
  if (state.sessionId !== sessionId || watchedBranchId !== branchId) return;
  const store = runtime.storyStore(sessionId);
  msgUnsub = runtime.watchContinuityHead(sessionId, branchId, async () => {
    const run = ++continuityRefresh;
    continuityContextSnapshot = null;
    try {
      const latest = await store.listMessages(branchId, Infinity, PAGE_SIZE);
      if (run !== continuityRefresh || state.sessionId !== sessionId || watchedBranchId !== branchId) return;
      latestReady = true;
      hasEarlier = latest.length === PAGE_SIZE;
      historyMessages = null;
      renderMessages(latest);
      await refreshPendingContinuity(sessionId, branchId);
      updateIndicator();
    } catch (error) { showTransientError("Could not load continuity story: " + error.message); }
  }, (error) => showTransientError("Could not watch continuity story: " + error.message));
}

async function refreshPendingContinuity(sessionId, branchId) {
  if (state.sessionId !== sessionId || watchedBranchId !== branchId) return;
  const current = session?.continuityPendingTurnId;
  const normal = lastMessages.filter((message) => !message.pendingSaver);
  if (!current) {
    if (normal.length !== lastMessages.length) renderMessages(normal);
    return;
  }
  try {
    const { storyStore } = await loadContinuity();
    const pending = await storyStore(sessionId).readTurn(branchId, current);
    if (state.sessionId !== sessionId || watchedBranchId !== branchId ||
        session?.continuityPendingTurnId !== current) return;
    if (pending?.status === "needs_state_review") renderMessages(mergeMessages(lastMessages.filter((message) => !message.pendingSaver), [
      { ...pending.user, pendingSaver: true }, { ...pending.assistant, pendingSaver: true },
    ]));
  } catch (error) { showTransientError("Could not load pending narration: " + error.message); }
}

function subscribeLegacyMessages(sessionId) {
  msgUnsub = messagesApi.subscribeLatestMessages(
    sessionId,
    ({ messages: latest, hasEarlier: olderExists }) => {
      if (state.sessionId !== sessionId) return;
      latestReady = true;
      const ids = new Set(latest.map((m) => m.id));
      const oldestOrder = latest[0]?.order ?? Infinity;
      const deleted = new Set([...latestMessageIds].filter((id) =>
        !ids.has(id) && (latest.length === 0 ||
          (lastMessages.find((m) => m.id === id)?.order ?? Infinity) >= oldestOrder)
      ));
      latestMessageIds = ids;
      lastMessages = lastMessages.filter((m) => !deleted.has(m.id));
      if (historyMessages) historyMessages = historyMessages.filter((m) => !deleted.has(m.id));
      if (lastMessages.length <= latest.length) hasEarlier = olderExists;
      const merged = mergeMessages(lastMessages, latest);
      renderMessages(visibleCount <= PAGE_SIZE ? merged.slice(-PAGE_SIZE) : merged);
      if (historyMessages) historyMessages = mergeMessages(historyMessages, latest);
      updateIndicator(); // cached data — no extra Firestore reads
      queueCacheSave();
    },
    (err) => showTransientError("Could not load chat: " + err.message)
  );
}

// The sidebar already watches session metadata, so use that feed to keep a
// restored chat current without attaching another Firestore listener.
export function syncActiveSession(metadata) {
  if (!metadata || metadata.id !== state.sessionId || !session) return;
  const previous = session;
  session = { ...session, ...metadata };
  if (session.title !== previous.title || session.longTermPlan !== previous.longTermPlan) {
    document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId: session.id, session } }));
  }
  if (session.continuityEnabled && session.continuityPendingTurnId !== previous.continuityPendingTurnId)
    void refreshPendingContinuity(session.id, session.continuityBranchId || "main");
  updateWelcome();
  if (session.longTermPlan !== previous.longTermPlan ||
      session.activeSummaryMessageId !== previous.activeSummaryMessageId ||
      session.breakpointOrder !== previous.breakpointOrder) updateIndicator();
  queueCacheSave();
}

export function forgetChatSession(sessionId) {
  historyCache.delete(sessionId);
  void deleteChatCache(currentUid(), sessionId);
}

// ---------- rendering ----------

let lastMessages = [];

function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

async function ensureHistory() {
  if (historyMessages) return historyMessages;
  if (historyLoading) {
    await historyLoading;
    return ensureHistory();
  }
  if (latestReady && !hasEarlier) {
    historyMessages = [...lastMessages];
    historyStartOrder = 0;
    queueCacheSave();
    return historyMessages;
  }
  const sessionId = state.sessionId;
  historyLoading = (async () => {
    const messages = await messagesApi.getMessages(sessionId);
    if (state.sessionId !== sessionId) throw new Error("Session changed while loading history.");
    historyMessages = mergeMessages(messages, lastMessages);
    historyStartOrder = 0;
    const snapshot = chatSnapshot();
    historyCache.delete(sessionId);
    historyCache.set(sessionId, snapshot);
    if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
    void saveChatCache(currentUid(), sessionId, snapshot);
    return historyMessages;
  })().finally(() => { historyLoading = null; });
  return historyLoading;
}

function applySummaryResult(result) {
  if (result.skipped) return;
  session = {
    ...session,
    activeSummaryMessageId: result.summaryId,
    breakpointOrder: result.newBreakpointOrder,
  };
  historyMessages = mergeMessages(historyMessages, [result.summaryMessage]);
  renderMessages(mergeMessages(lastMessages, [result.summaryMessage]));
  updateIndicator();
  queueCacheSave();
}

function renderMessages(msgs) {
  if (!isNearBottom() && msgs.length > lastMessages.length) {
    visibleCount += msgs.length - lastMessages.length;
  }
  lastMessages = msgs;
  if (editingState) {
    // A Firestore snapshot must never destroy the open edit textarea (it
    // would wipe the user's in-progress text). The fresh data is already
    // cached in lastMessages and is rendered on Save/Cancel.
    if (msgs.some((m) => m.id === editingState.id)) return;
    editingState = null; // the edited message was deleted remotely
  }
  const sticky = isNearBottom();
  const visible = msgs.slice(-visibleCount);
  const visibleIds = new Set(visible.map((m) => m.id));
  for (const [id, entry] of renderedMessages) {
    if (!visibleIds.has(id)) {
      entry.node.remove();
      renderedMessages.delete(id);
    }
  }
  // Keep status, errors, and a live stream after the saved messages.
  let anchor = [...el.list.children].find((node) =>
    node !== el.earlierBtn && !node.dataset.messageId
  ) ?? null;
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i];
    let entry = renderedMessages.get(m.id);
    if (!entry || !entry.message || !sameRenderedMessage(entry.message, m)) {
      const node = renderMessage(m);
      node.dataset.messageId = m.id;
      entry?.node.remove();
      entry = { node, message: m };
      renderedMessages.set(m.id, entry);
    }
    if (entry.node.parentNode !== el.list || entry.node.nextSibling !== anchor) {
      el.list.insertBefore(entry.node, anchor);
    }
    anchor = entry.node;
  }
  if (hasEarlier || msgs.length > visible.length) {
    el.earlierBtn.textContent = "Show earlier messages";
    if (el.earlierBtn.parentNode !== el.list || el.earlierBtn.nextSibling !== anchor) {
      el.list.insertBefore(el.earlierBtn, anchor);
    }
  } else {
    el.earlierBtn.remove();
  }
  updateWelcome();
  if (sticky) scrollToEnd();
  queueCacheSave();
}

function sameRenderedMessage(a, b) {
  return a.role === b.role && a.content === b.content && a.thinking === b.thinking &&
    Boolean(a.editedAt) === Boolean(b.editedAt) && Boolean(a.pendingSaver) === Boolean(b.pendingSaver) &&
    Boolean(a.audit) === Boolean(b.audit);
}

function updateWelcome() {
  const welcome = document.getElementById("welcome");
  const empty = lastMessages.length === 0 && !streamState;
  if (welcome) welcome.hidden = !empty;
  const newStory = document.getElementById("btn-welcome-new");
  if (newStory) newStory.hidden = Boolean(state.sessionId);
  document.getElementById("chat-tab")?.classList.toggle("is-empty", empty);
  el.input.placeholder = state.sessionId ? "Write your next turn…" : "Create a new story to begin…";
  el.input.disabled = !state.sessionId || Boolean(session?.continuityPendingTurnId);
  el.sendBtn.disabled = busy || !state.sessionId || Boolean(session?.continuityPendingTurnId);
  el.mode.hidden = !session?.continuityEnabled;
  el.summarizeBtn.hidden = Boolean(session?.continuityEnabled);
  document.querySelectorAll('[data-action="summarize-full"], [data-action="reset-summary"]').forEach((item) => {
    item.hidden = Boolean(session?.continuityEnabled);
  });
  document.querySelectorAll("[data-starter]").forEach((button) => { button.disabled = !state.sessionId; });
  refreshPetPlacement();
}

function renderMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const label = document.createElement("span");
  label.textContent =
    m.role === "user" ? "You" : m.role === "author" ? "Author note" : m.role === "summary" ? "Summary checkpoint" : "Assistant";
  if (m.archived) label.textContent += " · history";
  if (m.pendingSaver) label.textContent += " · needs state review";
  if (m.audit) label.textContent += " · state correction";
  if (m.editedAt) label.textContent += " (edited)";
  meta.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "msg-actions";
  actions.appendChild(actionBtn("Copy", "copy", () => copyText(m.content)));
  if (!m.archived && !m.pendingSaver && !m.audit && (m.role === "user" || m.role === "author" || m.role === "assistant" || m.role === "summary")) {
    actions.appendChild(actionBtn("Edit", null, () => startEdit(m, wrap)));
  }
  if (!m.archived && !m.pendingSaver && !m.audit) actions.appendChild(actionBtn(session?.continuityEnabled ? "Rewind" : "Delete", "del", async () => {
    if (busy) return;
    if (!confirm(session?.continuityEnabled
      ? "Rewind to before this turn? Later turns will leave the active story."
      : "Delete this message permanently?")) return;
    if (session?.continuityEnabled) {
      await reviseContinuityTurn(m, "delete");
      return;
    }
    await messagesApi.deleteMessage(state.sessionId, m.id, m.order);
    if (state.settings?.chatRecallEnabled) {
      try {
        const { invalidateRecallSession } = await import("../chat-recall.js");
        await invalidateRecallSession(state.sessionId);
      } catch { /* Optional local index cannot block message deletion. */ }
    }
    if (historyMessages) historyMessages = historyMessages.filter((item) => item.id !== m.id);
    renderMessages(lastMessages.filter((item) => item.id !== m.id));
  }));
  if (m.role === "assistant" && m.pendingSaver) {
    actions.appendChild(actionBtn("Review state", null, () =>
      document.dispatchEvent(new CustomEvent("open-continuity-editor"))));
  }
  if (m.role === "assistant" && !m.archived && !m.pendingSaver) {
    actions.appendChild(actionBtn("Regenerate", "regen", () => {
      if (busy) return;
      if (session?.continuityEnabled) void reviseContinuityTurn(m, "regenerate");
      else runAssistantTurn({ upToOrder: m.order, overwriteId: m.id });
    }));
  }
  meta.appendChild(actions);
  wrap.appendChild(meta);

  if (m.role === "assistant" && m.thinking) {
    wrap.appendChild(buildThinking(m.thinking, false));
  }

  const content = document.createElement("div");
  content.className = "msg-content";
  content.textContent = m.content;
  wrap.appendChild(content);

  attachHoldToCopy(wrap, () => m.content);
  return wrap;
}

function actionBtn(text, cls, onClick) {
  // Tolerate a 2-arg call: actionBtn("Edit", () => …) — callback shifts into `cls`.
  if (typeof cls === "function") { onClick = cls; cls = null; }
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick?.(); });
  return b;
}

function buildThinking(text, streaming) {
  const det = document.createElement("details");
  det.className = "thinking" + (streaming ? " streaming" : "");
  if (streaming) det.open = true;
  const sum = document.createElement("summary");
  sum.textContent = "Thinking";
  const body = document.createElement("div");
  body.className = "thinking-body";
  body.textContent = text;
  det.append(sum, body);
  return det;
}

function startEdit(m, wrap) {
  if (busy) return;
  const contentEl = wrap.querySelector(".msg-content");
  if (!contentEl || editingState) return; // one edit at a time
  const wrapRect = wrap.getBoundingClientRect();
  const contentRect = contentEl.getBoundingClientRect();
  const meta = wrap.querySelector(".msg-meta");
  const actions = wrap.querySelector(".msg-actions");
  const scrollTop = el.list.scrollTop;
  // Match the original bubble and text area before focusing. Changing either
  // size here makes the conversation jump, especially with the phone keyboard.
  wrap.style.width = wrapRect.width + "px";
  wrap.style.height = wrapRect.height + "px";
  meta.style.height = meta.getBoundingClientRect().height + "px";
  const ta = document.createElement("textarea");
  ta.className = "msg-editor";
  ta.value = m.content;
  ta.rows = 1;
  ta.style.height = contentRect.height + "px";

  const finish = () => {
    editingState = null;
    const top = wrap.getBoundingClientRect().top;
    const entry = renderedMessages.get(m.id);
    if (entry) entry.message = null;
    renderMessages(lastMessages);
    const next = renderedMessages.get(m.id)?.node;
    if (next) el.list.scrollTop += next.getBoundingClientRect().top - top;
  };
  const save = actionBtn("Save", "small", async () => {
    const text = ta.value;
    save.disabled = true;
    cancel.disabled = true;
    try {
      if (session?.continuityEnabled) {
        if (!await reviseContinuityTurn(m, "edit", text)) return;
        editingState = null;
        return;
      }
      const { tokenCount } = await messagesApi.editMessage(state.sessionId, m.id, text, m.order);
      if (state.settings?.chatRecallEnabled) {
        try {
          const { invalidateRecallSession } = await import("../chat-recall.js");
          await invalidateRecallSession(state.sessionId);
        } catch { /* Optional local index cannot block message editing. */ }
      }
      lastMessages = lastMessages.map((item) =>
        item.id === m.id ? { ...item, content: text, tokenCount, editedAt: item.editedAt || true } : item
      );
      if (historyMessages) historyMessages = historyMessages.map((item) =>
        item.id === m.id ? { ...item, content: text, tokenCount, editedAt: item.editedAt || true } : item
      );
      finish();
    } catch (e) {
      showTransientError(e.message);
    } finally {
      save.disabled = false;
      cancel.disabled = false;
    }
  });
  const cancel = actionBtn("Cancel", "small", finish);
  save.classList.add("btn"); cancel.classList.add("btn");
  actions.replaceChildren(save, cancel);
  contentEl.replaceWith(ta);
  editingState = { id: m.id, ta };
  ta.focus({ preventScroll: true });
  el.list.scrollTop = scrollTop;
}

// ---------- hold-to-copy ----------

// Long-press (mobile) / mouse-hold on a message copies its text to the
// clipboard and shows a toast. A >10px finger movement (scrolling) cancels it.
function attachHoldToCopy(target, getText) {
  const HOLD_MS = 500;
  let holding = false;   // press in progress
  let eligible = false;  // held ≥ HOLD_MS without scrolling
  let startX = 0, startY = 0, startT = 0;

  const cancel = () => {
    holding = false;
    eligible = false;
    target.classList.remove("holding");
  };

  target.addEventListener("contextmenu", (e) => e.preventDefault());
  target.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't hijack presses on the inline controls (Edit/Delete/Regenerate).
    if (e.target.closest("button, textarea, input, select, a, details")) return;
    startX = e.clientX; startY = e.clientY; startT = performance.now();
    holding = true;
    target.classList.add("holding");
    // iOS WebKit (Safari AND Chrome-on-iOS) drops the user gesture inside
    // setTimeout, so the clipboard write must NOT happen here — the timer
    // only marks the hold as long enough. The copy runs in pointerup.
    setTimeout(() => {
      if (holding) eligible = true;
    }, HOLD_MS);
  });
  target.addEventListener("pointermove", (e) => {
    if (holding && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  target.addEventListener("pointerup", () => {
    // Copy synchronously inside this gesture handler — the only way an
    // iOS clipboard write succeeds.
    const held = holding && eligible;
    cancel();
    if (held) copyText(getText());
  });
  target.addEventListener("pointercancel", cancel);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts / older iOS WebKit. The focus +
      // explicit selection is required for execCommand('copy') on iOS;
      // readonly + contentEditable keeps the keyboard from popping up.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      ta.contentEditable = true;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand("copy");
      ta.remove();
    }
    showToast("Copied to clipboard", true);
  } catch {
    showToast("Copy failed", false);
  }
}

function showToast(text, ok) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast" + (ok ? "" : " error");
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

// ---------- context indicator ----------

function renderContinuityUsage(usage, loadedMessages) {
  const ratio = Math.max(...usage.requests.map((request) => request.usedTokens / request.max));
  el.contextFill.style.width = Math.min(100, ratio * 100) + "%";
  el.contextFill.classList.toggle("over", usage.requests.some((request) => request.usedTokens > request.budget));
  const tightest = usage.requests.reduce((a, b) => a.budget / a.max < b.budget / b.max ? a : b);
  el.contextThreshold.style.left = Math.max(0, tightest.budget / tightest.max * 100) + "%";
  el.contextLabel.textContent = usage.requests.map((request) =>
    `${request.label}: ${request.usedTokens.toLocaleString()} / ${request.max.toLocaleString()} tokens`).join(" · ") +
    ` · ${loadedMessages} messages loaded` +
    (usage.historyMessages != null ? ` · ${usage.historyMessages} in context` : "");
  el.contextLabel.title = "Estimated input tokens include system policies, selected story state, schemas, tools, recent conversation and the current draft. Balanced narration grows when lookup results are added. The marker reserves response tokens and the safety margin.";
}

export async function updateIndicator() {
  if (!session || !state.settings || !latestReady) return;
  if (session.continuityEnabled) {
    const run = ++indicatorRun;
    const selectedSession = session.id;
    const branchId = session.continuityBranchId || "main";
    const loadedMessages = lastMessages.length || 0;
    if (busy && continuityContextStats) {
      const stats = continuityContextStats;
      const requests = [];
      if (stats.preparationInputTokens != null) requests.push({ label: "Lookup", usedTokens: stats.preparationInputTokens,
        max: stats.preparationContextLimit, budget: stats.preparationContextLimit });
      requests.push({ label: "Narration", usedTokens: stats.narrationInputTokens,
        max: stats.narrationContextLimit, budget: stats.narrationContextLimit });
      renderContinuityUsage({ requests }, loadedMessages);
      return;
    }
    el.contextLabel.textContent = `Calculating context tokens… · ${loadedMessages} messages loaded`;
    try {
      if (!continuityContextSnapshot || continuityContextSnapshot.sessionId !== selectedSession ||
          continuityContextSnapshot.branchId !== branchId) {
        const cached = { sessionId: selectedSession, branchId,
          promise: loadContinuity().then((runtime) => runtime.storyStore(selectedSession).load(branchId)) };
        continuityContextSnapshot = cached;
        cached.promise.catch(() => { if (continuityContextSnapshot === cached) continuityContextSnapshot = null; });
      }
      const snapshot = await continuityContextSnapshot.promise;
      const { computeContinuityUsage } = await import("../continuity/usage.js");
      if (run !== indicatorRun || state.sessionId !== selectedSession) return;
      const usage = await computeContinuityUsage({ snapshot, settings: structuredClone(state.settings),
        continuityMode: session.continuityMode || "reviewed", input: el.input.value.trim(),
        mode: el.mode.value || "player", stylePrompt: state.settings.continuityStylePrompt || "" });
      if (run !== indicatorRun || state.sessionId !== selectedSession) return;
      renderContinuityUsage(usage, loadedMessages);
    } catch (error) {
      if (run !== indicatorRun || state.sessionId !== selectedSession) return;
      el.contextLabel.textContent = `Context estimate unavailable: ${error.message} · ${loadedMessages} messages loaded`;
      el.contextFill.style.width = "0%";
      el.contextFill.classList.remove("over");
    }
    return;
  }
  const run = ++indicatorRun;
  const usage = await computeContextUsage(session, state.settings, historyMessages ?? lastMessages);
  if (run !== indicatorRun) return; // a newer computation superseded this one

  const pct = usage.max > 0 ? (usage.usedTokens / usage.max) * 100 : 0;
  el.contextFill.style.width = Math.min(100, pct) + "%";
  el.contextFill.classList.toggle("over", usage.overThreshold);
  el.contextThreshold.style.left =
    (usage.max > 0 ? (usage.threshold / usage.max) * 100 : 0) + "%";
  el.contextLabel.textContent =
    `${usage.usedTokens.toLocaleString()} / ${usage.max.toLocaleString()} tokens` +
    (usage.droppedCount > 0 ? ` · ${usage.droppedCount} out of window` : "") +
    (!historyMessages && hasEarlier ? " · recent history estimate" : "");
}
export const refreshContextIndicator = updateIndicator;

// ---------- send / stream / summarize ----------

async function handleSend(e) {
  e.preventDefault();
  if (busy || !session || editingState || session.continuityPendingTurnId) return;
  const text = el.input.value.trim();
  if (!text) return;
  const settings = structuredClone(state.settings);
  if (!settings?.modelId || !settings?.apiKey) {
    showTransientError("Set your API key and Model ID in the Settings tab first.");
    return;
  }
  el.input.value = "";
  el.input.style.height = "auto";
  setBusy(true);
  try {
    if (session.continuityEnabled) {
      await sendContinuityTurn(text, el.mode.value);
      return;
    }
    await ensureHistory();
    const userMsg = await messagesApi.addMessage(session.id, { role: "user", content: text });
    // Bridge until the snapshot arrives so the context build includes the user turn
    // without re-reading the collection from Firestore.
    if (!lastMessages.some((m) => m.id === userMsg.id)) {
      lastMessages = lastMessages.concat([
        { id: userMsg.id, order: userMsg.order, role: "user", content: text, tokenCount: userMsg.tokenCount },
      ]);
    }
    historyMessages = mergeMessages(historyMessages, [lastMessages.find((m) => m.id === userMsg.id)]);
    // Explicitly pass the bridged cache: opts.messages keeps buildContextForRequest
    // off the racy getMessages() fallback, which would hit the watch cache and
    // potentially miss the just-committed user message.
    await runAssistantTurn({ messages: historyMessages });
  } catch (err) {
    if (session?.continuityEnabled) el.input.value = text;
    showTransientError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function sendContinuityTurn(input, mode, options = {}) {
  continuityContextStats = null;
  const petTurn = startPetTurn();
  try {
    const { storyStore, runContinuityTurn, runSaverTurn, runBalancedTurn, switchContinuityBranch } = await loadContinuity();
    const branchId = options.branchId ?? session.continuityBranchId ?? "main";
    const store = storyStore(session.id);
    const retry = !options.branchId && continuityRetry && continuityRetry.sessionId === session.id &&
      continuityRetry.branchId === branchId && continuityRetry.input === input &&
      continuityRetry.mode === mode ? continuityRetry : null;
    const turnId = retry?.turnId ?? `turn_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!options.branchId) continuityRetry = { sessionId: session.id, branchId, input, mode, turnId };
    const turnRunner = options.draftOverride != null ? runContinuityTurn
      : session.continuityMode === "balanced" ? runBalancedTurn
      : session.continuityMode === "saver" ? runSaverTurn : runContinuityTurn;
    const receipt = await turnRunner({ store, branchId,
      turnId, input,
      mode, settings: structuredClone(state.settings), stylePrompt: state.settings.continuityStylePrompt || "",
      reviewEveryTurn: session.continuitySaverReviewEveryTurn === true,
      draftOverride: options.draftOverride ?? null,
      expectedActiveBranchId: options.previousBranchId ?? branchId,
      onContextStats: (stats) => { continuityContextStats = stats; updateIndicator(); },
      onStatus: (phase) => {
        updatePetPhase(phase === "generating" ? "writing" : "thinking", petTurn);
        setStatus({ building_context: "Building story context…", preparing: "Looking up story context…",
        generating: "Narrating…", reviewing: "Checking continuity…", repairing: "Repairing narration…",
        saving: "Saving story…", accepted: "Story saved.", failed: "Story turn failed.",
        needs_state_review: "Narration saved. Review its state before continuing." }[phase] || phase, phase === "accepted"); } });
    if (options.branchId && receipt.status !== "needs_state_review") {
      await switchContinuityBranch(session.id, options.previousBranchId, branchId, options.previousRevision);
    } else {
      const latest = await store.listMessages(branchId, Infinity, PAGE_SIZE);
      renderMessages(receipt.status === "needs_state_review"
        ? mergeMessages(latest, [{ ...receipt.user, pendingSaver: true },
          { ...receipt.assistant, pendingSaver: true }]) : latest);
      if (receipt.status === "needs_state_review") {
        session = { ...session, continuityBranchId: branchId, continuityPendingTurnId: turnId };
        updateWelcome();
      }
      hasEarlier = latest.length === PAGE_SIZE;
      continuityRetry = null;
    }
    finishPetTurn("ready", petTurn);
    return receipt;
  } catch (error) {
    finishPetTurn("blocked", petTurn);
    throw error;
  }
}

async function reviseContinuityTurn(message, action, replacement = null) {
  if (busy) return;
  if (session?.continuityPendingTurnId)
    return showTransientError("Resolve the pending story state before editing or rewinding another turn.");
  const activeSession = session;
  const priorBranch = activeSession.continuityBranchId || "main";
  setBusy(true);
  try {
    const { storyStore, forkAtRevision, switchContinuityBranch } = await loadContinuity();
    const store = storyStore(activeSession.id);
    const { initial, turns } = await store.history(priorBranch);
    const previousRevision = turns.at(-1)?.revision ?? initial.state.revision;
    const original = turns.find((turn) => turn.user.id === message.id || turn.assistant.id === message.id);
    if (!original) throw new Error("The selected message has no accepted story turn.");
    const branchId = `branch_${crypto.randomUUID().replaceAll("-", "")}`;
    await forkAtRevision(store, priorBranch, original.baseRevision, branchId);
    if (action === "delete") {
      await switchContinuityBranch(activeSession.id, priorBranch, branchId, previousRevision);
      setStatus("Story forked before the selected turn.", true);
    } else {
      const input = action === "edit" && message.role !== "assistant" ? replacement : original.user.content;
      const draftOverride = action === "edit" && message.role === "assistant" ? replacement : null;
      await sendContinuityTurn(input, original.user.role === "author" ? "author" : "player",
        { branchId, previousBranchId: priorBranch, previousRevision, draftOverride });
    }
  } catch (error) { showTransientError(error.message || String(error)); return false; }
  finally { setBusy(false); }
  return true;
}

async function runAssistantTurn(opts = {}) {
  const settings = structuredClone(state.settings);
  if (!settings) return;
  const petTurn = startPetTurn();
  setBusy(true);
  try {
    startStreamUI();
    const allMessages = opts.messages ?? await ensureHistory();
    const base = await buildContextForRequest(session, settings, {
      ...opts, messages: allMessages,
      recallReserveTokens: settings.chatRecallEnabled === true ? settings.chatRecallBudgetTokens : 0,
    });
    let apiMessages = base.apiMessages;
    if (settings.chatRecallEnabled === true && base.availableRecallTokens > 0) {
      try {
        const { findRecalledMessages } = await import("../chat-recall.js");
        const recall = await findRecalledMessages(session, settings, {
          messages: allMessages, excludedIds: base.includedMessageIds,
          upToOrder: opts.upToOrder ?? Infinity, maxTokens: base.availableRecallTokens,
        });
        if (recall.messages.length) {
          ({ apiMessages } = await buildContextForRequest(session, settings, {
            ...opts, messages: allMessages, recalledMessages: recall.messages,
            recallBudgetTokens: base.availableRecallTokens,
          }));
        }
        if (recall.warning) setStatus(recall.warning, true);
      } catch (error) { setStatus("Past chat recall unavailable: " + error.message, true); }
    }
    const { content, thinking } = await chatCompletion({
      settings,
      messages: apiMessages,
      onDelta: (t) => { updatePetPhase("writing", petTurn); streamState && appendStream("content", t); },
      onReasoning: (t) => { updatePetPhase("thinking", petTurn); streamState && appendStream("thinking", t); },
    });
    updatePetPhase("saving", petTurn);
    streamState?.wrap.remove();
    streamState = null;
    refreshPetPlacement();

    // Plan tag handling (spec §11): extract, save, strip from visible content.
    const plan = extractPlan(content);
    const planThread = extractPlanThread(content);
    const clean = stripPlan(content);
    const finalContent =
      clean || (plan !== null ? "(plan updated — no narrative content in the reply)" : "(empty response)");
    const newPlan = plan !== null && plan.length > 0 ? plan : null;

    // Bridge the local cache for the auto-summary check (avoids a fresh
    // getSession/getMessages round-trip — the snapshots will reconcile shortly).
    let savedMsg;
    if (opts.overwriteId) {
      const { tokenCount } = await messagesApi.overwriteMessage(session.id, opts.overwriteId, {
        content: finalContent, thinking, planThread,
      }, opts.upToOrder);
      const i = lastMessages.findIndex((m) => m.id === opts.overwriteId);
      if (i >= 0) lastMessages[i] = { ...lastMessages[i], content: finalContent, thinking, planThread, tokenCount };
      historyMessages = historyMessages.map((m) =>
        m.id === opts.overwriteId ? { ...m, content: finalContent, thinking, planThread, tokenCount } : m
      );
    } else {
      savedMsg = await messagesApi.addMessage(session.id, {
        role: "assistant", content: finalContent, thinking, planThread,
      });
      lastMessages = lastMessages.filter((m) => m.id !== savedMsg.id).concat([
        { id: savedMsg.id, order: savedMsg.order, role: "assistant", content: finalContent, thinking, planThread, tokenCount: savedMsg.tokenCount },
      ]);
    historyMessages = mergeMessages(historyMessages, [lastMessages[lastMessages.length - 1]]);
    }
    renderMessages(lastMessages);
    queueCacheSave();

    if (newPlan !== null) {
      await updateSession(session.id, { longTermPlan: newPlan });
      session = { ...session, longTermPlan: newPlan };
    }

    if (settings.chatRecallEnabled === true && opts.overwriteId) {
      try {
        const { invalidateRecallSession } = await import("../chat-recall.js");
        await invalidateRecallSession(session.id);
      } catch { /* The next index pass can rebuild. */ }
    }
    if (settings.shortMemoryEnabled === true) {
      try {
        const { refreshShortMemory } = await import("../short-memory.js");
        const updated = await refreshShortMemory(session, settings, historyMessages, {
          overwriteOrder: opts.overwriteId ? opts.upToOrder : null,
        });
        if (updated) session = { ...session, ...updated };
      } catch (error) { setStatus("Short memory update failed: " + error.message, true); }
    }

    // Auto-summary trigger: checked after each assistant reply is saved (spec §8.1),
    // computed entirely from cached data.
    const fresh = { ...session, longTermPlan: newPlan ?? session.longTermPlan };
    if (await shouldAutoSummarize(fresh, settings, historyMessages)) {
      const ui = streamSummaryUI("Context near limit — auto-summarizing…");
      try {
        const r = await runSummarization(fresh, settings, {
          messages: historyMessages,
          onDelta: (text) => { updatePetPhase("writing", petTurn); ui.onDelta(text); },
          onReasoning: (text) => { updatePetPhase("thinking", petTurn); ui.onReasoning(text); },
        });
        applySummaryResult(r);
        setStatus(r.skipped ? r.reason : "Summary updated.", true);
      } finally {
        ui.done();
      }
    }
    finishPetTurn("ready", petTurn);
  } catch (err) {
    finishPetTurn("blocked", petTurn);
    streamState?.wrap.remove();
    streamState = null;
    refreshPetPlacement();
    showTransientError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

// Live-stream the summarizer's output into a proper summary bubble (tail only,
// so the element stays a fixed size while tokens arrive). Reasoning deltas go
// into the same collapsible Thinking pane used by chat messages.
function streamSummaryUI(label) {
  let acc = "";
  let thinkAcc = "";
  let frame = 0;
  const bubble = document.createElement("div");
  bubble.className = "msg summary streaming-summary";
  const head = document.createElement("div");
  head.className = "msg-meta";
  head.textContent = label;
  const thinking = buildThinking("", true);
  const body = document.createElement("div");
  body.className = "summary-stream-body";
  bubble.append(head, thinking, body);
  const thinkingBody = thinking.querySelector(".thinking-body");
  const sticky = isNearBottom();
  el.list.appendChild(bubble);
  if (sticky) scrollToEnd();
  const schedulePaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stickyNow = isNearBottom();
      body.textContent = acc.slice(-2000);
      thinkingBody.textContent = thinkAcc.slice(-4000);
      if (stickyNow) scrollToEnd();
    });
  };
  return {
    setLabel: (text) => { head.textContent = text; },
    onDelta: (t) => { acc += t; schedulePaint(); },
    onReasoning: (t) => { thinkAcc += t; schedulePaint(); },
    done: () => {
      if (frame) cancelAnimationFrame(frame);
      bubble.remove();
    },
  };
}

async function handleSummarize() {
  if (busy || !session || session.continuityEnabled) return;
  const petTurn = startPetTurn();
  setBusy(true);
  const ui = streamSummaryUI("Summarizing…");
  try {
    await ensureHistory();
    const r = await runSummarization(session, state.settings, {
      messages: historyMessages,
      onDelta: (text) => { updatePetPhase("writing", petTurn); ui.onDelta(text); },
      onReasoning: (text) => { updatePetPhase("thinking", petTurn); ui.onReasoning(text); },
    });
    applySummaryResult(r);
    setStatus(r.skipped ? r.reason : "Summary checkpoint created.", true);
    finishPetTurn("ready", petTurn);
  } catch (err) {
    finishPetTurn("blocked", petTurn);
    showTransientError("Summarization failed: " + (err.message || String(err)));
  } finally {
    ui.done();
    setBusy(false);
  }
}

// Full-history summary: ignores the checkpoint and folds in every message
// from the very start, replacing the active summary (local-only action).
async function handleFullSummarize() {
  if (busy || !session || session.continuityEnabled) return;
  if (
    !confirm(
      "Summarize the ENTIRE chat history from the start? This replaces the current summary and may take a while."
    )
  )
    return;
  const petTurn = startPetTurn();
  setBusy(true);
  const ui = streamSummaryUI("Summarizing full history…");
  try {
    await ensureHistory();
    const r = await runSummarization(session, state.settings, {
      messages: historyMessages,
      full: true,
      onDelta: (text) => { updatePetPhase("writing", petTurn); ui.onDelta(text); },
      onReasoning: (text) => { updatePetPhase("thinking", petTurn); ui.onReasoning(text); },
      onProgress: (multi, i, total) => {
        if (multi) ui.setLabel(`Summarizing part ${i}/${total}…`);
      },
    });
    applySummaryResult(r);
    setStatus(r.skipped ? r.reason : "Full-history summary created.", true);
    finishPetTurn("ready", petTurn);
  } catch (err) {
    finishPetTurn("blocked", petTurn);
    showTransientError("Summarization failed: " + (err.message || String(err)));
  } finally {
    ui.done();
    setBusy(false);
  }
}

// Reset the summary checkpoint: no summary is injected and every message
// becomes context again (local-only action, no LLM call).
async function handleResetSummary() {
  if (busy || !session || session.continuityEnabled) return;
  if (
    !confirm(
      "Reset the summary checkpoint? The summary will stop being injected and the full history will be sent again (may exceed context until re-summarized)."
    )
  )
    return;
  try {
    await updateSession(session.id, { activeSummaryMessageId: null, breakpointOrder: 0 });
    session = { ...session, activeSummaryMessageId: null, breakpointOrder: 0 };
    updateIndicator();
    queueCacheSave();
    setStatus("Summary checkpoint reset.", true);
  } catch (err) {
    showTransientError("Reset failed: " + (err.message || String(err)));
  }
}

// ---------- streaming UI ----------

function startStreamUI() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const label = document.createElement("span");
  label.textContent = "Assistant · working…";
  meta.appendChild(label);
  wrap.appendChild(meta);

  const thinking = buildThinking("", true);
  const content = document.createElement("div");
  content.className = "msg-content";
  wrap.append(thinking, content);

  el.list.appendChild(wrap);
  scrollToEnd();

  streamState = {
    wrap, thinking, thinkingBody: thinking.querySelector(".thinking-body"), content,
    thinkingText: "", contentText: "", frame: 0,
  };
  updateWelcome();
}

function appendStream(kind, text) {
  if (!streamState) return;
  if (kind === "content") {
    streamState.contentText += text;
  } else {
    streamState.thinkingText += text;
  }
  if (!streamState.frame) {
    const current = streamState;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      if (streamState !== current) return;
      const sticky = isNearBottom();
      current.content.textContent = stripPlan(current.contentText);
      invalidatePetLayout();
      current.thinkingBody.textContent = current.thinkingText.slice(-4000);
      if (sticky) scrollToEnd();
    });
  }
}

// ---------- helpers ----------

function setBusy(b) {
  busy = state.busy = b;
  el.sendBtn.disabled = b || !state.sessionId || Boolean(session?.continuityPendingTurnId);
  el.summarizeBtn.disabled = b;
  if (!b && session?.continuityEnabled) updateIndicator();
}

// Only keep the list pinned to the bottom while the user hasn't scrolled up.
function isNearBottom() {
  return el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;
}

function scrollToEnd() {
  el.list.scrollTop = el.list.scrollHeight;
}

// Scroll the inner message list (never the window) so the field's bottom edge
// sits just above the iOS keyboard. Runs over a few frames because the
// keyboard (and thus visualViewport) animates in after focus.
function alignFieldToKeyboard(field) {
  const vv = window.visualViewport;
  if (!vv) return;
  let frames = 0;
  const tick = () => {
    const keyboardTop = vv.offsetTop + vv.height; // viewport-Y of the keyboard
    const rect = field.getBoundingClientRect();
    if (rect.bottom > keyboardTop) {
      // Element extends under the keyboard: scroll the list up by the overlap.
      el.list.scrollTop += rect.bottom - keyboardTop + 8;
    } else if (rect.bottom < keyboardTop - vv.height * 0.45) {
      // Element floats far above the keyboard: walk it back down.
      el.list.scrollTop -= Math.min(
        keyboardTop - rect.bottom - vv.height * 0.45,
        el.list.scrollTop
      );
    }
    if (++frames < 10) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setStatus(text, autoHide = false) {
  let statusEl = el.list.querySelector(".status-line");
  if (!text) { statusEl?.remove(); return; }
  const sticky = isNearBottom();
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "status-line";
    el.list.appendChild(statusEl);
  }
  statusEl.textContent = text;
  if (autoHide) setTimeout(() => statusEl?.remove(), 4000);
  if (sticky) scrollToEnd();
}

function showTransientError(text) {
  const sticky = isNearBottom();
  const div = document.createElement("div");
  div.className = "msg error";
  div.textContent = "⚠ " + text;
  el.list.appendChild(div);
  if (sticky) scrollToEnd();
  setTimeout(() => div.remove(), 10000);
}
