import { assertSource, noteNeedsReview } from '../continuity.js';
import { normalizeMemory, anyMemory } from '../memory-settings.js';
import { extractScene, inspectSceneOutput, formatSceneForDisplay, latestScene, isPureOoc, MAX_SCENE_LENGTH } from '../scene.js';
import { computeTurns } from '../turns.js';
import { getLore, subscribeLore, configureLoreWrites, loreWritesPending, waitForLoreWrites } from '../lore-store.js';
import * as memoryUpdater from '../memory-updater.js';
import { initPetView, startPetTurn, finishPetTurn, refreshPetPlacement, updatePetPhase, invalidatePetLayout } from "./pet-view.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { state } from "../state.js";
import * as messagesApi from "../messages.js";
import { buildContextForRequest, computeContextUsage, normalizeAdDirective } from "../context-builder.js";
import { chatCompletion } from "../llm-client.js";
import { runSummarization, shouldAutoSummarize } from "../summarizer.js";
import { extractPlan, extractPlanThread, stripPlan } from "../plan-parser.js";
import { updateSession, duplicateSession, getSessionFromServer } from "../sessions.js";
import { currentUid } from "../auth.js";
import { loadChatCache, saveChatCache, deleteChatCache } from "../chat-cache.js";
import {
  useLocalSettings,
  normalizeProfiles,
  activeProfile,
  mirrorFromActiveProfile,
  mirrorToActiveProfile,
} from "../settings.js";

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
let historyEpoch = 0;
let historyRevision = null;
let loreReady = Promise.resolve();
let verifiedLoreRevision = null;
const historyCache = new Map(); // three most recently visited sessions in memory
let cacheSaveTimer = null;
const renderedMessages = new Map();

const el = {};
let loreUnsub = null, loreEntries = [], loreSessionId = null, managerOpen = false;
const memoryStories = new Map();
let lastMemoryReport = null;
export function memorySnapshot(sid = state.sessionId) {
  if (sid === state.sessionId && session) return { session, settings: state.settings, messages: historyMessages ?? lastMessages, entries: loreEntries, busy, report: lastMemoryReport };
  const cached = memoryStories.get(sid); return cached?.owner === currentUid() ? cached : null;
}
export async function prepareMemorySnapshot() {
  if (!session) throw new Error('Open a story first.');
  const sid = state.sessionId;
  await reconcileStory();
  if (sid !== state.sessionId) throw new Error('Story changed while loading history.');
  return memorySnapshot();
}
function rememberMemoryStory() {
  if (session && anyMemory(normalizeMemory(session.memory))) memoryStories.set(session.id,{ ...memorySnapshot(),owner:currentUid() });
}
function syncLore() {
  const wanted = session && (anyMemory(normalizeMemory(session.memory)) || managerOpen);
  if (!wanted) { loreUnsub?.(); loreUnsub = null; loreSessionId = null; loreReady = Promise.resolve(); updateMemoryChip(); return; }
  if (loreSessionId === session.id) return;
  loreUnsub?.();
  const sid = session.id, owner = currentUid(); loreSessionId = sid; loreEntries = []; verifiedLoreRevision = null;
  let ready, fail;
  loreReady = new Promise((resolve,reject) => { ready = resolve; fail = reject; });
  // A listener error is displayed and is also propagated to generation readiness.
  loreReady.catch(() => {});
  loreUnsub = subscribeLore(sid,entries => {
    if (currentUid() !== owner || state.sessionId !== sid || loreSessionId !== sid) return;
    loreEntries = entries; ready(); rememberMemoryStory(); updateMemoryChip();
    document.dispatchEvent(new CustomEvent('lore-changed',{ detail:{ sessionId:sid,entries } }));
    void updateIndicator();
  },error => { fail(error); if (currentUid() === owner && state.sessionId === sid) showTransientError('Could not load lorebooks: '+error.message); });
}
async function reconcileStory() {
  const sid = state.sessionId, owner = currentUid();
  if (!sid) throw new Error('Open a story first.');
  await messagesApi.ensureContinuityMetadata(sid);
  const fresh = await getSessionFromServer(sid);
  if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Account or story changed while reconciling.');
  if (!fresh) throw new Error('Story no longer exists.');
  session = fresh;
  if (historyRevision !== (fresh.historyRevision ?? 0)) historyMessages = null;
  syncLore();
  if (normalizeMemory(fresh.memory).lorebooks || normalizeMemory(fresh.memory).autoUpdate) {
    await loreReady;
    if (verifiedLoreRevision !== (fresh.loreRevision ?? 0)) { const entries = await getLore(sid); if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Story changed while loading lorebooks.'); loreEntries = entries; verifiedLoreRevision = fresh.loreRevision ?? 0; }
  }
  await ensureHistory(true);
  if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Account or story changed while loading.');
  rememberMemoryStory();
  return memorySnapshot();
}
function updateMemoryChip() {
  const chip = document.getElementById('btn-memory'); if (!chip) return;
  const mem = normalizeMemory(session?.memory), pointer = session?.memoryState?.extractedThroughOrder;
  const turn = computeTurns(historyMessages ?? lastMessages).assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0;
  const running = memoryUpdater.isRunning(session?.id);
  chip.classList.toggle('hidden', !session || !anyMemory(mem) && !loreEntries.length);
  chip.classList.toggle('running', running); chip.classList.toggle('paused', session?.memoryState?.paused === true);
  chip.textContent = running ? 'Updating memory…' : session?.memoryState?.paused ? 'Memory paused' : mem.autoUpdate && turn ? 'Memory · T'+turn : 'Memory';
}


export function initChatView() {
  configureLoreWrites(() => {
    if (!busy) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { if (!busy) { document.removeEventListener('turn-finished', done); resolve(); } };
      document.addEventListener('turn-finished', done);
    });
  });
  memoryUpdater.configureMemoryUpdater({
    get: memorySnapshot, busy: () => busy,
    prepare: async sid => { if (sid !== state.sessionId) throw new Error("Open the story before maintenance."); return reconcileStory(); },
    patch(sid, patch, entries) {
      const live = memorySnapshot(sid); if (!live) return;
      live.session = { ...live.session, memoryState: { ...live.session.memoryState, ...patch } };
      if (entries) live.entries = entries;
      memoryStories.set(sid,{ ...live,owner:currentUid() });
      if (sid === state.sessionId) { session = live.session; if (entries) loreEntries = entries; updateMemoryChip(); void updateIndicator(); }
    },
    waitIdle(signal) {
      if (!busy || signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => { if (!busy || signal?.aborted) { document.removeEventListener('turn-finished', done); signal?.removeEventListener('abort', done); resolve(); } };
        document.addEventListener('turn-finished', done); signal?.addEventListener('abort', done, { once: true });
      });
    },
  });
  document.addEventListener('memory-session-deleting', e => { memoryUpdater.stop(e.detail.sessionId); memoryStories.delete(e.detail.sessionId); });
  document.addEventListener('memory-session-saved', e => {
    if (e.detail.sessionId !== state.sessionId || !session) return;
    const { partial } = e.detail;
    session = { ...session, ...partial };
    if ('memoryState.extractedThroughOrder' in partial) session.memoryState = { ...session.memoryState, extractedThroughOrder: partial['memoryState.extractedThroughOrder'] };
    delete session['memoryState.extractedThroughOrder'];
    syncLore(); rememberMemoryStory(); invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator();
  });
  document.addEventListener('scene-preference', () => { invalidateRenderedMessages(); renderMessages(lastMessages); });
  const openViewer = () => document.dispatchEvent(new CustomEvent('context-details'));
  document.getElementById('context-indicator')?.addEventListener('click', openViewer);
  document.getElementById('context-indicator')?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(); } });
  document.getElementById('btn-memory')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('lorebooks')));
  document.addEventListener('lorebook-visibility', e => { managerOpen = e.detail.open; syncLore(); });
  document.addEventListener('memory-status', e => {
    if (e.detail.sessionId !== state.sessionId) return;
    updateMemoryChip(); document.dispatchEvent(new CustomEvent('memory-refresh'));
    const d = e.detail;
    if (d.status === 'success' && (d.notes || d.manual || managerOpen)) {
      const text = `Memory updated (turns ${d.range.fromTurn}–${d.range.toTurn}): `+(d.notes ? `${d.notes} notes · ${d.drafts} new characters.` : 'nothing new.');
      document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text, action: d.notes ? 'Review' : null, event: 'lorebooks', options: { filter: 'review' } } }));
    } else if (d.status === 'failed') document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: d.failureStreak >= 3 ? 'Memory updates paused after 3 failures.' : "Memory update didn't work — I'll try again next turn.", action: d.failureStreak >= 3 ? 'Open settings' : null, event: 'memory-settings' } }));
  });
  el.list = document.getElementById("message-list");
  el.input = document.getElementById("chat-input");
  el.composer = document.getElementById("composer");
  el.sendBtn = document.getElementById("btn-send");
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
    const sessionId = state.sessionId, owner = currentUid();
    const beforeOrder = lastMessages[0].order;
    el.earlierBtn.disabled = true;
    try {
      const cachedEarlier = historyMessages && historyStartOrder === 0
        ? historyMessages.filter((m) => m.order < beforeOrder)
        : null;
      const older = cachedEarlier
        ? cachedEarlier.slice(-PAGE_SIZE)
        : await messagesApi.getEarlierMessages(sessionId, beforeOrder, PAGE_SIZE);
      if (state.sessionId !== sessionId || currentUid() !== owner) return;
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
    void updateIndicator();
  };
  el.input.addEventListener("input", autoGrow);
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

export function setSession(sessionId) {
  const owner = currentUid();
  if (state.sessionId === sessionId) return true;
  if (busy) {
    showTransientError("Wait for the current reply or summary to finish before switching sessions.");
    return false;
  }
  if (cacheSaveTimer) { clearTimeout(cacheSaveTimer); cacheSaveTimer = null; }
  if (state.sessionId && session && latestReady) {
    const snapshot = chatSnapshot();
    historyCache.delete(currentUid()+':'+state.sessionId);
    historyCache.set(currentUid()+':'+state.sessionId, snapshot);
    void saveChatCache(currentUid(), state.sessionId, snapshot);
    if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
  }
  rememberMemoryStory();
  loreUnsub?.(); loreUnsub = null; loreSessionId = null; loreEntries = []; lastMemoryReport = null;
  msgUnsub?.();
  sessUnsub?.();
  msgUnsub = sessUnsub = null;
  state.sessionId = sessionId;
  session = null;
  streamState = null;
  editingState = null;
  lastMessages = [];
  visibleCount = PAGE_SIZE;
  hasEarlier = false;
  latestMessageIds = new Set();
  latestReady = false;
  const cachedHistory = historyCache.get(currentUid()+':'+sessionId);
  historyMessages = cachedHistory?.history ?? null;
  historyRevision = null;
  historyStartOrder = 0;
  if (cachedHistory) {
    historyCache.delete(currentUid()+':'+sessionId);
    historyCache.set(currentUid()+':'+sessionId, cachedHistory);
  } else if (sessionId && historyCache.size >= 3) {
    historyCache.delete(historyCache.keys().next().value);
  }
  historyLoading = null;
  historyEpoch++;
  renderedMessages.clear();
  ++indicatorRun;
  el.list.innerHTML = "";
  el.contextFill.style.width = "0%";
  el.contextLabel.textContent = "No session selected";
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session: null } }));
  updateWelcome();
  updateMemoryChip();
  if (!sessionId) return true;
  el.contextLabel.textContent = "Loading chat…";
  if (cachedHistory) {
    restoreCachedChat(sessionId, cachedHistory);
    subscribeChat(sessionId);
    return true;
  }
  void loadChatCache(currentUid(), sessionId).then((saved) => {
    if (state.sessionId !== sessionId || currentUid() !== owner) return;
    if (saved?.session && Array.isArray(saved.recent)) {
      historyCache.set(currentUid()+':'+sessionId, saved);
      if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
      restoreCachedChat(sessionId, saved);
      subscribeChat(sessionId);
    } else {
      subscribeChat(sessionId);
    }
  }).catch(() => {
    if (state.sessionId === sessionId) subscribeChat(sessionId);
  });
  return true;
}

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
  syncLore(); rememberMemoryStory();
  historyMessages = saved.history ?? null;
  historyRevision = saved.session.historyRevision ?? 0;
  hasEarlier = saved.hasEarlier;
  latestReady = true;
  renderMessages(saved.recent);
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session } }));
  updateIndicator();
  queueCacheSave(); // refresh recency for the three-entry device cache
}

function subscribeChat(sessionId) {
  const owner = currentUid();

  sessUnsub = onSnapshot(
    doc(db, "users", currentUid(), "sessions", sessionId),
    (snap) => {
      if (state.sessionId !== sessionId || currentUid() !== owner) return;
      // Pending/cached metadata can lag the server history query and our own
      // committed writes. Wait for authoritative subscription metadata.
      if (snap.metadata?.fromCache || snap.metadata?.hasPendingWrites) return;
      const previous = session;
      if (snap.exists() && (snap.data().historyRevision ?? 0) < (previous?.historyRevision ?? 0)) return;
      session = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      if (historyRevision !== (session?.historyRevision ?? 0)) historyMessages = null;
      if (!session || !previous ||
          session.longTermPlan !== previous.longTermPlan ||
          session.allowLlmPlanUpdates !== previous.allowLlmPlanUpdates ||
          session.activeSummaryMessageId !== previous.activeSummaryMessageId ||
          session.breakpointOrder !== previous.breakpointOrder || JSON.stringify(session.memory) !== JSON.stringify(previous.memory)) {
        updateIndicator();
      }
      if (!session || !previous || session.title !== previous.title ||
          session.longTermPlan !== previous.longTermPlan || JSON.stringify(session.memory) !== JSON.stringify(previous.memory) || JSON.stringify(session.memoryState) !== JSON.stringify(previous.memoryState)) {
        document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session } }));
      }
      syncLore(); rememberMemoryStory();
      document.dispatchEvent(new CustomEvent('memory-refresh'));
      if (JSON.stringify(previous?.memory) !== JSON.stringify(session?.memory)) { invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator(); }
      queueCacheSave();
    },
    (err) => console.error("Session listener error:", err)
  );

  msgUnsub = messagesApi.subscribeLatestMessages(
    sessionId,
    ({ messages: latest, hasEarlier: olderExists }) => {
      if (state.sessionId !== sessionId || currentUid() !== owner) return;
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
      if (session && anyMemory(normalizeMemory(session.memory))) {
        const epoch = historyEpoch;
        const active = () => state.sessionId === sessionId && currentUid() === owner && historyEpoch === epoch;
        void ensureHistory().then(() => {
          if (active()) { invalidateRenderedMessages(); renderMessages(lastMessages); rememberMemoryStory(); void updateIndicator(); }
        }).catch(error => { if (active()) console.error('Memory history:',error); });
      }
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
  if ((metadata.historyRevision ?? 0) < (session.historyRevision ?? 0)) return;
  const previous = session;
  session = { ...session, ...metadata };
  syncLore(); rememberMemoryStory();
  if (historyRevision !== (session.historyRevision ?? 0)) historyMessages = null;
  if (JSON.stringify(previous.memory) !== JSON.stringify(session.memory)) { invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator(); }
  if (session.title !== previous.title || session.longTermPlan !== previous.longTermPlan) {
    document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId: session.id, session } }));
  }
  if (session.longTermPlan !== previous.longTermPlan ||
      session.allowLlmPlanUpdates !== previous.allowLlmPlanUpdates ||
      session.activeSummaryMessageId !== previous.activeSummaryMessageId ||
      session.breakpointOrder !== previous.breakpointOrder) updateIndicator();
  queueCacheSave();
}

export function forgetChatSession(sessionId) {
  memoryUpdater.stop(sessionId); memoryStories.delete(sessionId);
  historyCache.delete(currentUid()+':'+sessionId);
  void deleteChatCache(currentUid(), sessionId);
}

// ---------- rendering ----------

let lastMessages = [];

function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

async function ensureHistory(forceServer = false) {
  const sessionId = state.sessionId, owner = currentUid(), epoch = historyEpoch;
  const checkScope = () => {
    if (state.sessionId !== sessionId || historyEpoch !== epoch) throw new Error("Session changed while loading history.");
    if (currentUid() !== owner) throw new Error("Account changed while loading history.");
  };
  if (historyMessages && historyRevision === (session?.historyRevision ?? 0)) return historyMessages;
  if (historyLoading) {
    await historyLoading;
    checkScope();
    return ensureHistory(forceServer);
  }
  if (!forceServer && historyRevision === (session?.historyRevision ?? 0) && latestReady && !hasEarlier) {
    historyMessages = [...lastMessages];
    historyStartOrder = 0;
    queueCacheSave();
    return historyMessages;
  }
  const pending = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const revision = session?.historyRevision ?? 0;
      const messages = await messagesApi.getMessages(sessionId);
      checkScope();
      // A subscription or a local save may arrive while the read is in flight.
      // Keep a newly bridged/loaded cache if it already matches that revision;
      // otherwise discard this read and refresh within the same shared job.
      if (revision !== (session?.historyRevision ?? 0)) {
        if (historyMessages && historyRevision === (session?.historyRevision ?? 0)) return historyMessages;
        continue;
      }
      historyMessages = messages;
      historyRevision = revision;
      renderMessages(messages.slice(-Math.max(visibleCount,PAGE_SIZE)));
      historyStartOrder = 0;
      const snapshot = chatSnapshot();
      historyCache.delete(owner+':'+sessionId);
      historyCache.set(owner+':'+sessionId,snapshot);
      if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
      void saveChatCache(owner,sessionId,snapshot);
      return historyMessages;
    }
    throw new Error('History is updating repeatedly. Try again after the current writes finish.');
  })().finally(() => {
    // A session switch can start another read before this one settles.
    if (historyLoading === pending) historyLoading = null;
  });
  historyLoading = pending;
  return pending;
}

function applySummaryResult(result) {
  if (result.skipped) return;
  session = {
    ...session,
    activeSummaryMessageId: result.summaryId,
    breakpointOrder: result.newBreakpointOrder,
    historyRevision:result.historyRevision ?? session.historyRevision,
  };
  historyMessages = mergeMessages(historyMessages ?? [], [result.summaryMessage]);
  historyRevision = session.historyRevision ?? 0;
  renderMessages(mergeMessages(lastMessages, [result.summaryMessage]));
  updateIndicator();
  queueCacheSave();
}

// Retain the existing nodes so the next render can replace them. Clearing the
// map leaves orphaned bubbles in the list and creates duplicate visible messages.
function invalidateRenderedMessages() {
  for (const entry of renderedMessages.values()) entry.message = null;
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
    a.scene === b.scene && Boolean(a.editedAt) === Boolean(b.editedAt);
}

function updateWelcome() {
  const welcome = document.getElementById("welcome");
  const empty = lastMessages.length === 0 && !streamState;
  if (welcome) welcome.hidden = !empty;
  const newStory = document.getElementById("btn-welcome-new");
  if (newStory) newStory.hidden = Boolean(state.sessionId);
  document.getElementById("chat-tab")?.classList.toggle("is-empty", empty);
  el.input.placeholder = state.sessionId ? "Write your next turn…" : "Create a new story to begin…";
  el.input.disabled = !state.sessionId;
  el.sendBtn.disabled = busy || !state.sessionId;
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
    m.role === "user" ? "You" : m.role === "summary" ? "Summary checkpoint" : "Assistant";
  if (m.role !== 'summary' && anyMemory(normalizeMemory(session?.memory))) label.textContent += ' · T'+(computeTurns(historyMessages ?? lastMessages).turnById.get(m.id) ?? '?');
  if (m.editedAt) label.textContent += " (edited)";
  meta.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "msg-actions";
  if (m.role === "user" || m.role === "assistant") {
    const createCopy = actionBtn("Create copy", "create-copy", async () => {
      if (busy || state.busy || createCopy.disabled) return;
      const sourceId = state.sessionId;
      createCopy.disabled = true;
      createCopy.textContent = "Creating…";
      try {
        const newId = await duplicateSession(sourceId, null, m.id);
        if (state.sessionId === sourceId && setSession(newId)) {
          document.dispatchEvent(new CustomEvent("sidebar:close"));
        }
      } catch (error) {
        showTransientError("Copy failed: " + (error.message || error));
      } finally {
        createCopy.disabled = false;
        createCopy.textContent = "Create copy";
      }
    });
    createCopy.title = "Create a new session with settings and all messages through this message";
    actions.appendChild(createCopy);
  }
  actions.appendChild(actionBtn("Copy", "copy", () => copyText(m.content)));
  if (m.role === "user" || m.role === "assistant" || m.role === "summary") {
    actions.appendChild(actionBtn("Edit", null, () => startEdit(m, wrap)));
  }
  actions.appendChild(actionBtn("Delete", "del", async () => {
    if (busy) return;
    if (!confirm("Delete this message permanently?")) return;
    const result = await messagesApi.deleteMessage(state.sessionId, m.id, m.order);
    if (result.summaryReset) clearLocalSummary();
    session = { ...session,historyRevision:result.historyRevision,memoryInvalidations:result.memoryInvalidations }; historyRevision = result.historyRevision;
    if (historyMessages) historyMessages = historyMessages.filter((item) => item.id !== m.id);
    renderMessages(lastMessages.filter((item) => item.id !== m.id));
    await reconcileDeletedMemory();
  }));
  if (m.role === "assistant") {
    actions.appendChild(actionBtn("Regenerate", "regen", () => {
      if (busy) return;
      void regenerateMessage(m);
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

  if (m.role === 'assistant' && m.scene && normalizeMemory(session?.memory).scene && localStorage.getItem('nera.memory.showScene') !== '0') {
    const chip = document.createElement('button'); chip.className = 'scene-chip'; chip.type = 'button'; chip.textContent = formatSceneForDisplay(m.scene); chip.title = 'Edit scene line';
    chip.addEventListener('click', () => {
      const row = document.createElement('div'), field = document.createElement('input'); field.value = m.scene; field.maxLength = MAX_SCENE_LENGTH;
      const save = actionBtn('Save', async () => {
        if (busy) return; save.disabled = true;
        try {
          const raw = field.value.trim() || null; const result = await messagesApi.updateMessageScene(state.sessionId,m.id,m.order,raw);
          if (result.summaryReset) clearLocalSummary();
          session = { ...session,historyRevision:result.historyRevision,memoryInvalidations:result.memoryInvalidations }; historyRevision = result.historyRevision;
          lastMessages = lastMessages.map(x => x.id === m.id ? { ...x, scene: raw } : x);
          if (historyMessages) historyMessages = historyMessages.map(x => x.id === m.id ? { ...x, scene: raw } : x);
          renderMessages(lastMessages); await updateIndicator();
        } catch (e) { showTransientError(e.message); save.disabled = false; }
      });
      row.append(field, save, actionBtn('Cancel', () => row.replaceWith(chip))); chip.replaceWith(row); field.focus();
    }); wrap.append(chip);
  }
  attachHoldToCopy(wrap, () => m.content);
  return wrap;
}

function actionBtn(text, cls, onClick) {
  // Tolerate a 2-arg call: actionBtn("Edit", () => …) — callback shifts into `cls`.
  if (typeof cls === "function") { onClick = cls; cls = null; }
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener("click", (e) => { e.stopPropagation(); return onClick?.(); });
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
      const { tokenCount, summaryReset, replacement,historyRevision:revision,memoryInvalidations } = await messagesApi.editMessage(state.sessionId, m.id, text, m.order,{ expectedRevision:m.revision ?? 0 });
      if (summaryReset) clearLocalSummary();
      session = { ...session,historyRevision:revision,memoryInvalidations }; historyRevision = revision;
      lastMessages = lastMessages.map((item) =>
        item.id === m.id ? replacement : item
      );
      if (historyMessages) historyMessages = historyMessages.map((item) =>
        item.id === m.id ? replacement : item
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

export async function updateIndicator() {
  if (!session || !state.settings || !latestReady) return;
  const run = ++indicatorRun;
  let usage;
  try { const messages = await ensureHistory(); usage = await computeContextUsage(session,state.settings,messages,{ loreEntries,draftText:el.input.value }); } catch (error) { if (run === indicatorRun) el.contextLabel.textContent = error.message; return; }
  if (run !== indicatorRun) return; // a newer computation superseded this one

  lastMemoryReport = usage.report;
  const reserved = state.settings.maxResponseTokens;
  const allocated = usage.usedTokens + reserved;
  const pct = usage.max > 0 ? (allocated / usage.max) * 100 : 0;
  el.contextFill.style.width = Math.min(100, pct) + "%";
  el.contextFill.classList.toggle("over", usage.overThreshold);
  el.contextThreshold.style.left =
    (usage.max > 0 ? (usage.threshold / usage.max) * 100 : 0) + "%";
  el.contextLabel.textContent =
    `${usage.usedTokens.toLocaleString()} input + ${reserved.toLocaleString()} output / ${usage.max.toLocaleString()} tokens` +
    (usage.droppedCount > 0 ? ` · ${usage.droppedCount} out of window` : "") +
    (!historyMessages && hasEarlier ? " · recent history estimate" : "") +
    (normalizeMemory(session.memory).autoUpdate ? ' · memory T'+(computeTurns(historyMessages ?? lastMessages).assistants.filter(a => a.order <= (session.memoryState?.extractedThroughOrder ?? 0)).at(-1)?.turn ?? 0) : '');
  updateMemoryChip();
}
export const refreshContextIndicator = updateIndicator;

// ---------- send / stream / summarize ----------

function clearLocalSummary() {
  session = { ...session, activeSummaryMessageId: null, breakpointOrder: 0 };
  updateIndicator();
  queueCacheSave();
}

async function regenerateMessage(message) {
  const requestedSessionId = state.sessionId;
  try {
    await reconcileStory();
    const all = await ensureHistory();
    const latest = all.filter((m) => m.role !== "summary").at(-1);
    if (latest?.id !== message.id || message.order <= (session.breakpointOrder ?? 0)) {
      throw new Error("Only the latest, unsummarized reply can be regenerated. Later story turns depend on older replies.");
    }
    if (loreWritesPending()) await waitForLoreWrites();
    if (requestedSessionId !== state.sessionId || busy) return;
    await runAssistantTurn({
      messages: all, upToOrder: message.order, overwriteId: message.id,

    });
  } catch (err) {
    showTransientError(err.message || String(err));
  }
}

async function handleSend(e) {
  e.preventDefault();
  if (busy || !session || editingState) return;
  const requestedSessionId = state.sessionId;
  const text = el.input.value.trim();
  if (!text) return;
  const settings = structuredClone(state.settings);
  if (!settings?.modelId || !settings?.apiKey) {
    showTransientError("Set your API key and Model ID in the Settings tab first.");
    return;
  }
  if (loreWritesPending()) await waitForLoreWrites();
  if (busy || !session || requestedSessionId !== state.sessionId) return;
  el.input.value = "";
  el.input.style.height = "auto";
  setBusy(true);
  try {
    await reconcileStory();
    const userMsg = await messagesApi.addMessage(session.id, { role: "user", content: text });
    // Bridge until the snapshot arrives so the context build includes the user turn
    // without re-reading the collection from Firestore.
    if (!lastMessages.some((m) => m.id === userMsg.id)) {
      lastMessages = lastMessages.concat([
        { ...userMsg,role:"user",content:text },
      ]);
    }
    session = { ...session,historyRevision:userMsg.historyRevision };
    historyRevision = userMsg.historyRevision;
    historyMessages = mergeMessages(historyMessages ?? [], [lastMessages.find((m) => m.id === userMsg.id)]);
    // Explicitly pass the bridged cache: opts.messages keeps buildContextForRequest
    // off the racy getMessages() fallback, which would hit the watch cache and
    // potentially miss the just-committed user message.
    await runAssistantTurn({ messages: historyMessages });
  } catch (err) {
    showTransientError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function runAssistantTurn(opts = {}) {
  const settings = structuredClone(state.settings), sid = state.sessionId;
  if (!settings) return;
  const petTurn = startPetTurn(); setBusy(true);
  let maintenanceUsed = false;
  try {
    await reconcileStory();
    let sourceMessages = structuredClone(historyMessages);
    let sourceSession = structuredClone(session);
    let built = await buildContextForRequest(sourceSession,settings,{ ...opts,messages:sourceMessages,requireLatestUser:true,loreEntries:structuredClone(loreEntries) });
    if (!opts.overwriteId && settings.autoSummarizationEnabled === true && built.droppedCount > 0) {
      maintenanceUsed = true;
      const ui = streamSummaryUI('Summarizing uncovered history before narration…');
      try {
        const result = await runSummarization(sourceSession,settings,{ messages:sourceMessages,loreEntries:structuredClone(loreEntries),onDelta:ui.onDelta,validateSource:async expected => { const fresh = await getSessionFromServer(sid); assertSource(fresh,expected); } });
        applySummaryResult(result);
      } finally { ui.done(); }
      await reconcileStory(); sourceMessages = structuredClone(historyMessages); sourceSession = structuredClone(session);
      built = await buildContextForRequest(sourceSession,settings,{ ...opts,messages:sourceMessages,requireLatestUser:true,loreEntries:structuredClone(loreEntries) });
    }
    startStreamUI();
    const { content,thinking } = await chatCompletion({ settings,messages:built.apiMessages,onDelta:t => { updatePetPhase('writing',petTurn); if (streamState) appendStream('content',t); },onReasoning:t => { updatePetPhase('thinking',petTurn); if (streamState) appendStream('thinking',t); } });
    streamState?.wrap.remove(); streamState = null; refreshPetPlacement();
    const fresh = await getSessionFromServer(sid);
    if (!fresh) throw new Error('Story no longer exists.');
    const planThread = extractPlanThread(content), clean = stripPlan(content);
    if (!clean) throw new Error('The model returned no reply; nothing was saved.');
    const ooc = isPureOoc(normalizeAdDirective(sourceMessages.filter(m => m.role === 'user' && m.order < (opts.upToOrder ?? Infinity)).at(-1)?.content ?? ''));
    const sceneEnabled = normalizeMemory(sourceSession.memory).scene;
    const sceneOutput = sceneEnabled ? inspectSceneOutput(content) : { scene:extractScene(content),warning:null };
    const scene = ooc ? null : sceneOutput.scene;
    const sceneWarning = sceneEnabled && !ooc ? sceneOutput.warning : null;
    const message = { role:'assistant',content:clean,thinking,planThread,planBefore:sourceSession.longTermPlan ?? '',scene,ooc };
    updatePetPhase('saving',petTurn);
    let saved;
    if (opts.overwriteId) {
      const result = await messagesApi.overwriteMessage(sid,opts.overwriteId,message,opts.upToOrder);
      saved = result.replacement; session = { ...fresh,historyRevision:result.historyRevision,memoryInvalidations:result.memoryInvalidations,memoryState:{ ...fresh.memoryState,paused:true,needsRebuild:true } };
    } else {
      saved = await messagesApi.addMessage(sid,message);
      session = { ...fresh,historyRevision:saved.historyRevision };
    }
    // Save completed narration even if inputs changed during generation. Reload
    // changed history before the next request instead of caching the old snapshot.
    const historyChanged = session.historyRevision !== (sourceSession.historyRevision ?? 0) + 1;
    historyMessages = historyChanged ? null : mergeMessages(sourceMessages,[saved]);
    historyRevision = historyChanged ? null : session.historyRevision;
    renderMessages(mergeMessages(lastMessages,[saved])); queueCacheSave(); rememberMemoryStory();
    if (sceneWarning) showTransientError('Reply saved, but scene state was not updated. '+sceneWarning);
    lastMemoryReport = built.report;
    finishPetTurn('ready',petTurn);
    setBusy(false);
    if (!maintenanceUsed && !opts.overwriteId && memoryUpdater.maybeStartAfterTurn(sid)) maintenanceUsed = true;
    if (settings.autoSummarizationEnabled === true && !maintenanceUsed && !memoryUpdater.isRunning(sid) && await shouldAutoSummarize(session,settings,historyMessages)) {
      maintenanceUsed = true; setBusy(true);
      const ui = streamSummaryUI('Context near limit — summarizing…');
      try { const result = await runSummarization(structuredClone(session),settings,{ messages:structuredClone(historyMessages),loreEntries:structuredClone(loreEntries),onDelta:ui.onDelta }); applySummaryResult(result); } finally { ui.done(); }
    }
  } catch (err) {
    finishPetTurn('blocked',petTurn); streamState?.wrap.remove(); streamState = null; refreshPetPlacement(); showTransientError(err.message || String(err));
  } finally { setBusy(false); }
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
      invalidatePetLayout();
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
  if (memoryUpdater.isRunning(state.sessionId)) { showTransientError('Wait for the current memory update.'); return; }
  if (busy || !session) return;
  const petTurn = startPetTurn();
  setBusy(true);
  const ui = streamSummaryUI("Summarizing…");
  try {
    await reconcileStory();
    const r = await runSummarization(session, state.settings, {
      messages: structuredClone(historyMessages),loreEntries:structuredClone(loreEntries),
      onDelta: (t) => { updatePetPhase("writing", petTurn); ui.onDelta(t); },
      onReasoning: (t) => { updatePetPhase("thinking", petTurn); ui.onReasoning(t); },
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
  if (memoryUpdater.isRunning(state.sessionId)) { showTransientError('Wait for the current memory update.'); return; }
  if (busy || !session) return;
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
    await reconcileStory();
    const r = await runSummarization(session, state.settings, {
      messages: structuredClone(historyMessages),loreEntries:structuredClone(loreEntries),
      full: true,
      onDelta: (t) => { updatePetPhase("writing", petTurn); ui.onDelta(t); },
      onReasoning: (t) => { updatePetPhase("thinking", petTurn); ui.onReasoning(t); },
      onProgress: (multi, i, total) => {
        if (multi) ui.setLabel(total ? `Summarizing part ${i}/${total}…` : `Summarizing part ${i}…`);
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
  if (busy || !session) return;
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
  label.textContent = "Assistant · streaming…";
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
      current.thinkingBody.textContent = current.thinkingText.slice(-4000);
      if (sticky) scrollToEnd();
    });
  }
}

// ---------- helpers ----------

function setBusy(b) {
  busy = state.busy = b;
  if (!b) document.dispatchEvent(new CustomEvent('turn-finished'));
  updateMemoryChip();
  el.sendBtn.disabled = b;
  el.summarizeBtn.disabled = b;
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

async function reconcileDeletedMemory() {
  if (!session || !normalizeMemory(session.memory).autoUpdate && !loreEntries.length) return;
  const messages = await ensureHistory(), orders = new Set(messages.filter(m => m.role === 'assistant').map(m => m.order));
  const maxOrder = Math.max(0, ...orders), pointer = session.memoryState?.extractedThroughOrder;

  const count = loreEntries.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+s.lines.filter(l => l.src != null && !orders.has(l.src)).length,0),0);
  if (count) document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: `${count} memory notes came from deleted turns.`, action: 'Review', event: 'lorebooks', options: { filter: 'deleted' } } }));
  rememberMemoryStory();
}
