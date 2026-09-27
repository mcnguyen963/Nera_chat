import {
  doc, collection, query, orderBy, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { state } from "../state.js";
import * as messagesApi from "../messages.js";
import { buildContextForRequest, computeContextUsage } from "../context-builder.js";
import { chatCompletion } from "../llm-client.js";
import { runSummarization, shouldAutoSummarize } from "../summarizer.js";
import { extractPlan, stripPlan } from "../plan-parser.js";
import { updateSession } from "../sessions.js";
import { currentUid } from "../auth.js";
import {
  saveSettings,
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

const el = {};

export function initChatView() {
  el.list = document.getElementById("message-list");
  el.input = document.getElementById("chat-input");
  el.composer = document.getElementById("composer");
  el.sendBtn = document.getElementById("btn-send");
  el.summarizeBtn = document.getElementById("btn-summarize");
  el.contextFill = document.getElementById("context-fill");
  el.contextThreshold = document.getElementById("context-threshold");
  el.contextLabel = document.getElementById("context-label");

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
}

// ---------- quick model / thinking chips (composer) ----------

// Quick controls edit the live settings object and persist immediately, so
// they stay in sync with the Settings tab (which re-reads state.settings).
function initQuickControls() {
  el.chipModel = document.getElementById("btn-model-chip");
  el.chipModelLabel = document.getElementById("chip-model");
  el.popover = document.getElementById("composer-popover");
  el.quickProfile = document.getElementById("quick-profile");
  el.quickThinking = document.getElementById("quick-thinking");

  el.chipModel.addEventListener("click", () => toggleQuickPopover());

  el.quickProfile.addEventListener("change", async () => {
    const s = structuredClone(state.settings);
    if (!s) return;
    s.activeProfileId = el.quickProfile.value;
    normalizeProfiles(s);
    mirrorFromActiveProfile(s); // load the chosen profile's connection fields
    try {
      await saveSettings(s);
    } catch (e) {
      refreshQuickChips();
      showTransientError("Save failed: " + e.message);
    }
  });

  el.quickThinking.addEventListener("change", async () => {
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
    try {
      await saveSettings(s);
    } catch (e) {
      refreshQuickChips();
      showTransientError("Save failed: " + e.message);
    }
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
  if (busy) {
    showTransientError("Wait for the current reply or summary to finish before switching sessions.");
    return false;
  }
  msgUnsub?.();
  sessUnsub?.();
  msgUnsub = sessUnsub = null;
  state.sessionId = sessionId;
  session = null;
  streamState = null;
  editingState = null;
  lastMessages = [];
  ++indicatorRun;
  el.list.innerHTML = "";
  el.contextFill.style.width = "0%";
  el.contextLabel.textContent = "No session selected";
  document.dispatchEvent(new CustomEvent("session-changed"));
  updateWelcome();
  if (!sessionId) return true;

  sessUnsub = onSnapshot(
    doc(db, "users", currentUid(), "sessions", sessionId),
    (snap) => {
      if (state.sessionId !== sessionId) return;
      session = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      updateIndicator();
      document.dispatchEvent(new CustomEvent("session-changed"));
    },
    (err) => console.error("Session listener error:", err)
  );

  msgUnsub = onSnapshot(
    query(collection(db, "users", currentUid(), "sessions", sessionId, "messages"), orderBy("order", "asc")),
    (snap) => {
      if (state.sessionId !== sessionId) return;
      renderMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      updateIndicator(); // cached data — no extra Firestore reads
    },
    (err) => showTransientError("Firestore listener error: " + err.message)
  );
  return true;
}

// ---------- rendering ----------

let lastMessages = [];

function renderMessages(msgs) {
  lastMessages = msgs;
  if (editingState) {
    // A Firestore snapshot must never destroy the open edit textarea (it
    // would wipe the user's in-progress text). The fresh data is already
    // cached in lastMessages and is rendered on Save/Cancel.
    if (msgs.some((m) => m.id === editingState.id)) return;
    editingState = null; // the edited message was deleted remotely
  }
  const sticky = isNearBottom();
  el.list.innerHTML = "";
  updateWelcome();
  for (const m of msgs) el.list.appendChild(renderMessage(m));
  if (streamState) el.list.appendChild(streamState.wrap);
  if (sticky) scrollToEnd();
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
}

function renderMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const label = document.createElement("span");
  label.textContent =
    m.role === "user" ? "You" : m.role === "summary" ? "Summary checkpoint" : "Assistant";
  if (m.editedAt) label.textContent += " (edited)";
  meta.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "msg-actions";
  if (m.role === "user" || m.role === "assistant" || m.role === "summary") {
    actions.appendChild(actionBtn("Edit", null, () => startEdit(m, wrap)));
  }
  actions.appendChild(actionBtn("Delete", "del", async () => {
    if (busy) return;
    if (!confirm("Delete this message permanently?")) return;
    await messagesApi.deleteMessage(state.sessionId, m.id);
  }));
  if (m.role === "assistant") {
    actions.appendChild(actionBtn("Regenerate", "regen", () => {
      if (busy) return;
      runAssistantTurn({ upToOrder: m.order, overwriteId: m.id, messages: lastMessages });
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
  // The bubble is shrink-to-fit; replacing the content with a textarea would
  // collapse it to the textarea's default ~20-col width. Freeze its size.
  wrap.style.width = wrap.getBoundingClientRect().width + "px";
  const ta = document.createElement("textarea");
  ta.value = m.content;
  ta.rows = Math.max(2, Math.min(20, m.content.split("\n").length + 1));
  ta.style.width = "100%";
  ta.style.display = "block";
  ta.style.maxHeight = "40vh"; // stay within the area above the keyboard

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;margin-top:6px;";
  const finish = () => {
    editingState = null;
    renderMessages(lastMessages);
  };
  const save = actionBtn("Save", "small", async () => {
    const text = ta.value;
    editingState = null; // let the snapshot re-render the edited message
    try {
      await messagesApi.editMessage(state.sessionId, m.id, text);
      renderMessages(lastMessages); // in case the snapshot hasn't landed yet
    } catch (e) {
      // Keep the textarea (and the render lock) so the text isn't lost.
      editingState = { id: m.id, ta };
      showTransientError(e.message);
    }
  });
  const cancel = actionBtn("Cancel", "small", finish);
  save.classList.add("btn"); cancel.classList.add("btn");
  bar.append(save, cancel);

  contentEl.replaceWith(ta, bar);
  editingState = { id: m.id, ta };
  ta.focus();
  alignFieldToKeyboard(ta);
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
  if (!session || !state.settings) return;
  const run = ++indicatorRun;
  const usage = await computeContextUsage(session, state.settings, lastMessages);
  if (run !== indicatorRun) return; // a newer computation superseded this one

  const pct = usage.max > 0 ? (usage.usedTokens / usage.max) * 100 : 0;
  el.contextFill.style.width = Math.min(100, pct) + "%";
  el.contextFill.classList.toggle("over", usage.overThreshold);
  el.contextThreshold.style.left =
    (usage.max > 0 ? (usage.threshold / usage.max) * 100 : 0) + "%";
  el.contextLabel.textContent =
    `${usage.usedTokens.toLocaleString()} / ${usage.max.toLocaleString()} tokens` +
    (usage.droppedCount > 0 ? ` · ${usage.droppedCount} out of window` : "");
}
export const refreshContextIndicator = updateIndicator;

// ---------- send / stream / summarize ----------

async function handleSend(e) {
  e.preventDefault();
  if (busy || !session || editingState) return;
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
    const userMsg = await messagesApi.addMessage(session.id, { role: "user", content: text });
    // Bridge until the snapshot arrives so the context build includes the user turn
    // without re-reading the collection from Firestore.
    if (!lastMessages.some((m) => m.id === userMsg.id)) {
      lastMessages = lastMessages.concat([
        { id: userMsg.id, order: userMsg.order, role: "user", content: text, tokenCount: userMsg.tokenCount },
      ]);
    }
    // Explicitly pass the bridged cache: opts.messages keeps buildContextForRequest
    // off the racy getMessages() fallback, which would hit the watch cache and
    // potentially miss the just-committed user message.
    await runAssistantTurn({ messages: lastMessages });
  } catch (err) {
    showTransientError(err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function runAssistantTurn(opts = {}) {
  const settings = structuredClone(state.settings);
  if (!settings) return;
  setBusy(true);
  try {
    const { apiMessages } = await buildContextForRequest(session, settings, opts);
    startStreamUI();

    const { content, thinking } = await chatCompletion({
      settings,
      messages: apiMessages,
      onDelta: (t) => { streamState && appendStream("content", t); },
      onReasoning: (t) => { streamState && appendStream("thinking", t); },
    });
    streamState?.wrap.remove();
    streamState = null;

    // Plan tag handling (spec §11): extract, save, strip from visible content.
    const plan = extractPlan(content);
    const clean = stripPlan(content);
    const finalContent =
      clean || (plan !== null ? "(plan updated — no narrative content in the reply)" : "(empty response)");
    const newPlan = plan !== null && plan.length > 0 ? plan : null;

    // Bridge the local cache for the auto-summary check (avoids a fresh
    // getSession/getMessages round-trip — the snapshots will reconcile shortly).
    let savedMsg;
    if (opts.overwriteId) {
      const { tokenCount } = await messagesApi.overwriteMessage(session.id, opts.overwriteId, {
        content: finalContent, thinking,
      });
      const i = lastMessages.findIndex((m) => m.id === opts.overwriteId);
      if (i >= 0) lastMessages[i] = { ...lastMessages[i], content: finalContent, thinking, tokenCount };
    } else {
      savedMsg = await messagesApi.addMessage(session.id, {
        role: "assistant", content: finalContent, thinking,
      });
      lastMessages = lastMessages.filter((m) => m.id !== savedMsg.id).concat([
        { id: savedMsg.id, order: savedMsg.order, role: "assistant", content: finalContent, thinking, tokenCount: savedMsg.tokenCount },
      ]);
    }
    renderMessages(lastMessages);

    if (newPlan !== null) {
      await updateSession(session.id, { longTermPlan: newPlan });
    }

    // Auto-summary trigger: checked after each assistant reply is saved (spec §8.1),
    // computed entirely from cached data.
    const fresh = { ...session, longTermPlan: newPlan ?? session.longTermPlan };
    if (await shouldAutoSummarize(fresh, settings, lastMessages)) {
      const ui = streamSummaryUI("Context near limit — auto-summarizing…");
      try {
        const r = await runSummarization(fresh, settings, {
          messages: lastMessages,
          onDelta: ui.onDelta,
          onReasoning: ui.onReasoning,
        });
        setStatus(r.skipped ? r.reason : "Summary updated.", true);
      } finally {
        ui.done();
      }
    }
  } catch (err) {
    streamState?.wrap.remove();
    streamState = null;
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
  const bubble = document.createElement("div");
  bubble.className = "msg summary streaming-summary";
  const head = document.createElement("div");
  head.className = "msg-meta";
  head.textContent = label;
  const thinking = buildThinking("", true);
  const body = document.createElement("div");
  body.className = "summary-stream-body";
  bubble.append(head, thinking, body);
  const sticky = isNearBottom();
  el.list.appendChild(bubble);
  if (sticky) scrollToEnd();
  return {
    setLabel: (text) => { head.textContent = text; },
    onDelta: (t) => {
      acc += t;
      body.textContent = acc.slice(-2000);
      if (isNearBottom()) scrollToEnd();
    },
    onReasoning: (t) => {
      thinkAcc += t;
      thinking.querySelector(".thinking-body").textContent = thinkAcc;
      if (isNearBottom()) scrollToEnd();
    },
    done: () => bubble.remove(),
  };
}

async function handleSummarize() {
  if (busy || !session) return;
  setBusy(true);
  const ui = streamSummaryUI("Summarizing…");
  try {
    const r = await runSummarization(session, state.settings, {
      messages: lastMessages,
      onDelta: ui.onDelta,
      onReasoning: ui.onReasoning,
    });
    setStatus(r.skipped ? r.reason : "Summary checkpoint created.", true);
  } catch (err) {
    showTransientError("Summarization failed: " + (err.message || String(err)));
  } finally {
    ui.done();
    setBusy(false);
  }
}

// Full-history summary: ignores the checkpoint and folds in every message
// from the very start, replacing the active summary (local-only action).
async function handleFullSummarize() {
  if (busy || !session) return;
  if (
    !confirm(
      "Summarize the ENTIRE chat history from the start? This replaces the current summary and may take a while."
    )
  )
    return;
  setBusy(true);
  const ui = streamSummaryUI("Summarizing full history…");
  try {
    const r = await runSummarization(session, state.settings, {
      messages: lastMessages,
      full: true,
      onDelta: ui.onDelta,
      onReasoning: ui.onReasoning,
      onProgress: (multi, i, total) => {
        if (multi) ui.setLabel(`Summarizing part ${i}/${total}…`);
      },
    });
    setStatus(r.skipped ? r.reason : "Full-history summary created.", true);
  } catch (err) {
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

  streamState = { wrap, thinking, content, thinkingText: "", contentText: "" };
  updateWelcome();
}

function appendStream(kind, text) {
  if (!streamState) return;
  const sticky = isNearBottom();
  if (kind === "content") {
    streamState.contentText += text;
    streamState.content.textContent = stripPlan(streamState.contentText);
  } else {
    streamState.thinkingText += text;
    streamState.thinking.querySelector(".thinking-body").textContent = streamState.thinkingText;
  }
  if (sticky) scrollToEnd();
}

// ---------- helpers ----------

function setBusy(b) {
  busy = state.busy = b;
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
