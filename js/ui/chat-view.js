import {diagnostics} from '../version.js';
import {getPref} from '../local-pref.js';
import {friendlyError} from '../errors.js';
import {loadUnsavedReply,storeUnsavedReply} from '../unsaved-replies.js';
import {effectivelyPaused} from '../continuity.js';
import {copyText as copyClipboard} from './clipboard.js';
import * as tokenizer from '../tokenizer.js';
import {createBusyGate,bridgeHistory,waitForPreparation} from './busy-token.js';
import {pickMaintenance} from '../maintenance.js';
import { assertSource, noteNeedsReview } from '../continuity.js';
import { normalizeMemory, anyMemory } from '../memory-settings.js';
import { formatSceneForDisplay, latestScene, MAX_SCENE_LENGTH, carryScene, validateSceneValues, readSceneOutput, classifyUserInput, sceneTimeline, parseScene } from '../scene.js';
import { lintPlayerAgency, lintUnestablishedTime, isAcceptedTurn, lastUserOrderOf } from '../turn-review.js';
import { recoverScene } from '../scene-recovery.js';
import { computeTurns, dueRangeStatus } from '../turns.js';
import { getLore, subscribeLore, configureLoreWrites, loreWritesPending, waitForLoreWrites } from '../lore-store.js';
import * as memoryUpdater from '../memory-updater.js';
import { initPetView, startPetTurn, finishPetTurn, refreshPetPlacement, updatePetPhase, invalidatePetLayout } from "./pet-view.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { state } from "../state.js";
import * as messagesApi from "../messages.js";
import { buildContextForRequest, computeContextUsage, normalizeAdDirective } from "../context-builder.js";
import { chatCompletion } from "../llm-client.js";
import { runSummarization, shouldAutoSummarize, planSummary } from "../summarizer.js";
import { stripPlan } from "../plan-parser.js";
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

const unsavedReplies=new Map(),unsavedRevisions=new Map();
const unsavedKey=(owner,sid)=>owner+':'+sid;
let unsavedNode=null;
let chatRetry=0,chatRetryTimer=null,chatStatus='ok';
let msgUnsub = null;
let sessUnsub = null;
let session = null;      // latest snapshot of the active session doc
let streamState = null;  // live streaming UI handle
let busy = false;
let tokenizerWarned=false;
const busyGate=createBusyGate({current:()=>({sid:state.sessionId,epoch:historyEpoch,owner:state.user?.uid ?? (()=>{try{return currentUid();}catch{return null;}})()}),onChange:b=>applyBusyUi(b),onRelease:()=>document.dispatchEvent(new CustomEvent('turn-finished'))});
const acquireBusy=kind=>busyGate.acquire(kind),releaseBusy=token=>busyGate.release(token);
class StaleTurn extends Error {}
function assertActive(token){if(cacheWritesPaused || !session || !busyGate.stillActive(token))throw new StaleTurn('Story changed; this action was cancelled.');}
async function historyAction(kind,run) {
  const token=acquireBusy(kind);if(!token){showTransientInfo('Wait for the current reply to finish.');return false;}
  try{await run(token);return true;}catch(error){if(!(error instanceof StaleTurn))showTransientError(error);return false;}finally{releaseBusy(token);}
}
function applyLocalChange(token,result,mutate) {
  assertActive(token);
  if(result.summaryReset)clearLocalSummary();
  const before=historyRevision;
  const committed=result.session ?? {...session,historyRevision:result.historyRevision,memoryInvalidations:result.memoryInvalidations ?? session.memoryInvalidations,memoryState:{...session.memoryState,...result.memoryStatePatch}};
  const newerSnapshot=(session.historyRevision ?? 0)>result.historyRevision;
  if(!newerSnapshot)session=committed;
  lastMessages=mutate(lastMessages);
  historyMessages=historyMessages && !newerSnapshot && before===result.historyRevision-1 ? mutate(historyMessages) : null;
  historyRevision=historyMessages ? result.historyRevision : null;
}
let wasNearBottom = true;
let lastProviderUsage = null;
const memoryDeferrals=new Map(),summaryBackoff=new Map();
let indicatorRun=0,indicatorTimer;
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
let cacheWritesPaused = false;
const pendingCacheWrites = new Set();
const renderedMessages = new Map();

const el = {};
let loreRetry=0,loreRetryTimer=null,loreStatus='ok';
let loreUnsub = null, loreEntries = [], loreSessionId = null, managerOpen = false;
const memoryStories = new Map();
let lastMemoryReport = null;
export function memorySnapshot(sid = state.sessionId) {
  if (sid === state.sessionId && session) return { session, settings: state.settings, messages: historyMessages ?? lastMessages, historyComplete:!!historyMessages && historyRevision===(session.historyRevision ?? 0), entries: loreEntries, busy, report: lastMemoryReport, providerUsage:lastProviderUsage?.sessionId === sid ? lastProviderUsage : null };
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
  if (!wanted) {clearTimeout(loreRetryTimer); loreUnsub?.(); loreUnsub = null; loreSessionId = null; loreReady = Promise.resolve(); updateMemoryChip(); return; }
  if (loreSessionId === session.id) return;
  loreUnsub?.();
  const sid = session.id, owner = currentUid(); loreSessionId = sid; loreEntries = []; verifiedLoreRevision = null;
  let ready, fail;
  loreReady = new Promise((resolve,reject) => { ready = resolve; fail = reject; });
  // A listener error is displayed and is also propagated to generation readiness.
  loreReady.catch(() => {});
  loreUnsub = subscribeLore(sid,entries => {
    if (currentUid() !== owner || state.sessionId !== sid || loreSessionId !== sid) return;
    loreRetry=0;loreStatus='ok';loreEntries = entries; ready(); rememberMemoryStory(); updateMemoryChip();
    document.dispatchEvent(new CustomEvent('lore-changed',{ detail:{ sessionId:sid,entries } }));
    void updateIndicator();
  },error=>{if(currentUid()!==owner || state.sessionId!==sid)return;fail(error);loreUnsub?.();loreUnsub=null;loreSessionId=null;loreStatus='error';updateMemoryChip();clearTimeout(loreRetryTimer);const delay=[2000,5000,15000,60000][Math.min(loreRetry++,3)];loreRetryTimer=setTimeout(()=>{if(state.sessionId===sid && currentUid()===owner)syncLore();},delay);if(loreRetry===1)showTransientError('Could not load lorebooks: '+error.message+' Retrying…');});
}
async function reconcileStory(token = null) {
  const sid = state.sessionId, owner = currentUid();
  if (!sid) throw new Error('Open a story first.');
  await messagesApi.ensureContinuityMetadata(sid);
  const fresh = await getSessionFromServer(sid);
  if (token) assertActive(token);
  if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Account or story changed while reconciling.');
  if (!fresh) throw new Error('Story no longer exists.');
  session = fresh;
  if (historyRevision !== (fresh.historyRevision ?? 0)) historyMessages = null;
  syncLore();
  if (normalizeMemory(fresh.memory).lorebooks || normalizeMemory(fresh.memory).autoUpdate) {
    try {await loreReady;} catch {syncLore();await loreReady;}
    if (verifiedLoreRevision !== (fresh.loreRevision ?? 0)) { const entries = await getLore(sid); if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Story changed while loading lorebooks.'); loreEntries = entries; verifiedLoreRevision = fresh.loreRevision ?? 0; }
  }
  if (token) assertActive(token);
  await ensureHistory(true);
  if (token) assertActive(token);
  if(fresh.memory?.autoUpdate && fresh.memoryState?.extractedThroughOrder==null && computeTurns(historyMessages).lastTurn<=normalizeMemory(fresh.memory).lagTurns){await updateSession(sid,{'memoryState.extractedThroughOrder':0});if(currentUid()!==owner || state.sessionId!==sid)throw new Error('Story changed while setting memory start.');session={...session,memoryState:{...session.memoryState,extractedThroughOrder:0}};}
  if (currentUid() !== owner || state.sessionId !== sid) throw new Error('Account or story changed while loading.');
  rememberMemoryStory();
  return memorySnapshot();
}
function updateMemoryChip() {
  const chip = document.getElementById('btn-memory'); if (!chip) return;chip.setAttribute('aria-controls','lorebook-overlay');chip.setAttribute('aria-expanded',String(managerOpen));
  const mem = normalizeMemory(session?.memory), pointer = session?.memoryState?.extractedThroughOrder;
  const turn = turnsFor(historyMessages ?? lastMessages).assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0;
  const running = memoryUpdater.isRunning(session?.id);
  chip.classList.toggle('hidden', !session || !anyMemory(mem) && !loreEntries.length);
  chip.classList.toggle('running', running); chip.classList.toggle('paused', effectivelyPaused(session?.memoryState));
  const status=dueRangeStatus(historyMessages ?? lastMessages,session?.memoryState,mem);
  chip.title=session?.memoryState?.needsRebuild ? 'History edited. Re-extract from the Memory settings.' : loreStatus==='error' ? 'Lorebooks offline — retrying…' : status.reason==='pointer-unset' ? 'Memory start not set. Choose a start turn.' : status.reason==='pending' ? `Waiting for you to accept the reply at T${status.turn}.` : status.reason==='waiting' ? `${status.have} of ${status.need} turns ready (the last ${status.lag} turns wait).` : 'Memory ready to update.';
  chip.textContent = running ? 'Updating memory…' : effectivelyPaused(session?.memoryState) ? 'Memory paused' : loreStatus==='error' ? 'Lorebooks offline' : mem.autoUpdate && pointer==null ? 'Choose start' : mem.autoUpdate && turn ? 'Memory · T'+turn : 'Memory';
}


export function initChatView() {
  document.getElementById('btn-copy-diagnostics')?.addEventListener('click',async()=>{try{await copyClipboard(JSON.stringify(diagnostics({...state,session}),null,2));showTransientInfo('Diagnostics copied.');}catch(error){showTransientError(error);}});
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
    patch(sid, patch, entries,loreRevision) {
      const live = memorySnapshot(sid); if (!live) return;
      if(loreRevision!=null && sid===state.sessionId)verifiedLoreRevision=loreRevision;
      live.session = { ...live.session,...(loreRevision!=null ? {loreRevision} : {}), memoryState: { ...live.session.memoryState, ...patch } };
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
  document.addEventListener('memory-session-deleting', e => { memoryUpdater.stop(e.detail.sessionId); memoryStories.delete(e.detail.sessionId); clearUnsaved(currentUid(),e.detail.sessionId); });
  document.addEventListener('memory-session-saved', e => {
    if (e.detail.sessionId !== state.sessionId || !session) return;
    const { partial } = e.detail;
    session={...session};
    for(const [key,value] of Object.entries(partial)){const parts=key.split('.');if(parts.length===1){session[key]=value;continue;}let dest=session;for(const part of parts.slice(0,-1)){dest[part]={...dest[part]};dest=dest[part];}dest[parts.at(-1)]=value;}
    if ('memoryState.extractedThroughOrder' in partial) session.memoryState = { ...session.memoryState, extractedThroughOrder: partial['memoryState.extractedThroughOrder'] };
    delete session['memoryState.extractedThroughOrder'];
    syncLore(); rememberMemoryStory(); invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator();
  });
  document.addEventListener('scene-preference', () => { invalidateRenderedMessages(); renderMessages(lastMessages); });
  const openViewer = () => document.dispatchEvent(new CustomEvent('context-details'));
  document.getElementById('context-indicator')?.addEventListener('click', openViewer);
  document.getElementById('context-indicator')?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(); } });
  document.getElementById('btn-memory')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent(session?.memory?.autoUpdate && session?.memoryState?.extractedThroughOrder==null ? 'memory-settings' : 'lorebooks')));
  document.addEventListener('lorebook-visibility', e => { managerOpen = e.detail.open;document.getElementById('btn-memory')?.setAttribute('aria-expanded',String(managerOpen)); syncLore(); });
  document.addEventListener('memory-status', e => {
    if (e.detail.sessionId !== state.sessionId) return;
    updateMemoryChip(); document.dispatchEvent(new CustomEvent('memory-refresh'));
    const d = e.detail;
    if(d.status==='rebuild-review')document.dispatchEvent(new CustomEvent('memory-rebuild-review',{detail:d}));
    if (d.status === 'success' && (d.notes || d.manual || managerOpen)) {
      const text = `Memory updated (turns ${d.range.fromTurn}–${d.range.toTurn}): `+(d.notes ? `${d.notes} notes · ${d.drafts} new characters.` : 'nothing new.');
      document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text, action: d.notes ? 'Review' : null, event: 'lorebooks', options: { filter: 'review' } } }));
    } else if ((d.status==='idle' || d.status==='info') && d.manual && d.message) showTransientInfo(d.message);
    else if (d.status === 'failed') document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: (d.failureStreak >= 3 ? 'Memory updates paused after 3 failures. ' : 'Memory update failed. ')+(d.lastError ?? ''), action: 'Open settings', event: 'memory-settings' } }));
  });
  el.list = document.getElementById("message-list");
  let listHeight = el.list.clientHeight;
  el.list.addEventListener("scroll", () => {
    if (el.list.clientHeight === listHeight) wasNearBottom = isNearBottom();
  }, { passive: true });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (el.list.clientHeight === listHeight) return;
      listHeight = el.list.clientHeight;
      if (wasNearBottom) scrollToEnd();
      else clampListScroll();
    }).observe(el.list);
  }

  el.input = document.getElementById("chat-input");
  el.composer = document.getElementById("composer");
  el.sendBtn = document.getElementById("btn-send");
  el.stopBtn=document.getElementById("btn-stop");el.stopBtn.addEventListener("click",()=>busyGate.active?.abort?.());
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
    clearTimeout(indicatorTimer);indicatorTimer=setTimeout(()=>void updateIndicator(),300);
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
  if (!cacheWritesPaused && state.sessionId && session && latestReady) {
    const snapshot = chatSnapshot();
    historyCache.delete(currentUid()+':'+state.sessionId);
    historyCache.set(currentUid()+':'+state.sessionId, snapshot);
    saveLocalCache(currentUid(), state.sessionId, snapshot);
    if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
  }
  rememberMemoryStory();
  clearTimeout(chatRetryTimer);chatRetry=0;chatStatus='ok';
  clearTimeout(indicatorTimer);clearTimeout(loreRetryTimer);loreRetry=0;loreStatus='ok';
  loreUnsub?.(); loreUnsub = null; loreSessionId = null; loreEntries = []; lastMemoryReport = null; lastProviderUsage = null;
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
  const unsavedVersion=unsavedRevisions.get(unsavedKey(owner,sessionId)) ?? 0;
  void loadUnsavedReply(owner,sessionId).then(reply=>{if(reply && (unsavedRevisions.get(unsavedKey(owner,sessionId)) ?? 0)===unsavedVersion && !unsavedReplies.has(unsavedKey(owner,sessionId)))unsavedReplies.set(unsavedKey(owner,sessionId),reply);if(state.sessionId===sessionId && currentUid()===owner)renderUnsavedReply();});
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

function saveLocalCache(owner, sid, snapshot) {
  if (cacheWritesPaused) return;
  const pending = saveChatCache(owner, sid, snapshot);
  pendingCacheWrites.add(pending);
  void pending.then(() => pendingCacheWrites.delete(pending), error => {
    pendingCacheWrites.delete(pending);
    console.error('Could not save chat cache:', error);
  });
}

export async function prepareChatLogout() {
  cacheWritesPaused = true;clearTimeout(chatRetryTimer);
  clearTimeout(cacheSaveTimer); cacheSaveTimer = null;
  busyGate.active?.abort?.();
  memoryUpdater.stopAll();
  historyCache.clear(); memoryStories.clear();
  await Promise.allSettled([...pendingCacheWrites]);
}

function queueCacheSave() {
  if (cacheWritesPaused) return;
  const scheduledSid=state.sessionId,scheduledOwner=currentUid();
  if (!session || !latestReady) return;
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    if(cacheWritesPaused || state.sessionId!==scheduledSid || currentUid()!==scheduledOwner)return;
    saveLocalCache(scheduledOwner, scheduledSid, chatSnapshot());
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
  msgUnsub?.();sessUnsub?.();
  const reconnect=error=>{if(state.sessionId!==sessionId || currentUid()!==owner || cacheWritesPaused)return;chatStatus='reconnecting';msgUnsub?.();sessUnsub?.();void updateIndicator();if(chatRetryTimer)return;if(chatRetry===0)showTransientError(error);const delay=[2000,5000,15000,60000][Math.min(chatRetry++,3)];chatRetryTimer=setTimeout(()=>{chatRetryTimer=null;if(state.sessionId===sessionId && currentUid()===owner && !cacheWritesPaused)subscribeChat(sessionId);},delay);};

  sessUnsub = onSnapshot(
    doc(db, "users", currentUid(), "sessions", sessionId),
    (snap) => {
      if (state.sessionId !== sessionId || currentUid() !== owner) return;
      // Pending/cached metadata can lag the server history query and our own
      // committed writes. Wait for authoritative subscription metadata.
      if(snap.metadata?.fromCache || snap.metadata?.hasPendingWrites){if(snap.metadata?.fromCache && navigator.onLine===false)el.contextLabel.textContent=el.contextLabel.textContent.replace(/ · offline$/,'')+' · offline';return;}
      chatRetry=0;chatStatus='ok';el.contextLabel.textContent=el.contextLabel.textContent.replace(/ · (?:offline|reconnecting)$/,'');
      if(!snap.exists() || snap.data().deleting){const deletedId=state.sessionId;forgetChatSession(deletedId);session=null;const clear=()=>{if(state.sessionId===deletedId){setSession(null);showTransientInfo('This story was deleted.');}};if(busy){busyGate.active?.abort?.();document.addEventListener('turn-finished',clear,{once:true});}else clear();return;}
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
      if(JSON.stringify([previous?.memory,previous?.memoryState,previous?.loreRevision])!==JSON.stringify([session?.memory,session?.memoryState,session?.loreRevision]))document.dispatchEvent(new CustomEvent('memory-refresh'));
      if (JSON.stringify(previous?.memory) !== JSON.stringify(session?.memory)) { invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator(); }
      queueCacheSave();
    },
    reconnect
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
    reconnect
  );
}

export function forgetChatSession(sessionId) {
  memoryUpdater.stop(sessionId); memoryStories.delete(sessionId);clearUnsaved(currentUid(),sessionId);
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
      queueCacheSave();
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
  const savedStream = streamState?.savedId && msgs.some(m => m.id === streamState.savedId) ? streamState : null;
  const position = savedStream ? captureListPosition() : null;
  const renderHistory=historyMessages ?? msgs;
  const timeline=sceneTimeline(renderHistory,{startingScene:session?.memory?.startingScene});
  const lastUserOrder=lastUserOrderOf(renderHistory);
  const latestAssistant=renderHistory.filter(m => m.role==='assistant').at(-1)?.id;
  const latestStory = msgs.filter(m => m.role !== 'summary').at(-1);
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
    const turnLabel=anyMemory(normalizeMemory(session?.memory)) ? turnsFor(historyMessages ?? lastMessages).turnById.get(m.id) : null;
    const sceneState=timeline.get(m.id),renderedScene=sceneState?.effective;
    const pending=m.id===latestAssistant && !isAcceptedTurn(m,{lastUserOrder,sceneOn:session?.memory?.scene === true});
    const retry = !busy && m.role === 'user' && m.id === latestStory?.id;
    if (!entry || !entry.message || entry.retry !== retry || entry.turnLabel!==turnLabel || entry.renderedScene!==renderedScene || entry.pending!==pending || !sameRenderedMessage(entry.message, m)) {
      const node = renderMessage(m, retry, sceneState, pending);
      node.dataset.messageId = m.id;
      entry?.node.remove();
      entry = { node, message: m, retry, turnLabel, renderedScene, pending };
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
  renderUnsavedReply();
  updateWelcome();
  if (savedStream && renderedMessages.has(savedStream.savedId)) {
    if (savedStream.saveCompleted) {
      if (savedStream.frame) cancelAnimationFrame(savedStream.frame);
      savedStream.wrap.remove(); streamState = null;
    }
    restoreListPosition(position, savedStream.saveCompleted ? savedStream.savedId : undefined);
    refreshPetPlacement();
  } else if (sticky) scrollToEnd();
  queueCacheSave();
}

export function sameRenderedMessage(a,b) {
  return a.role===b.role && a.content===b.content && a.thinking===b.thinking && a.scene===b.scene &&
    (a.revision ?? 0)===(b.revision ?? 0) && a.acceptance===b.acceptance &&
    Boolean(a.editedAt)===Boolean(b.editedAt) && Boolean(a.ooc)===Boolean(b.ooc) && Boolean(a.truncated)===Boolean(b.truncated) &&
    JSON.stringify(a.sceneMeta ?? null)===JSON.stringify(b.sceneMeta ?? null) && JSON.stringify(a.sceneCandidate ?? null)===JSON.stringify(b.sceneCandidate ?? null) &&
    (a.reviewWarnings ?? []).join('\n')===(b.reviewWarnings ?? []).join('\n');
}
let turnsMemo={src:null,value:null};
export function turnsFor(list) { if (turnsMemo.src!==list) turnsMemo={src:list,value:computeTurns(list)}; return turnsMemo.value; }

function updateWelcome() {
  const welcome = document.getElementById("welcome");
  const empty = lastMessages.length === 0 && !streamState && !unsavedReplies.has(unsavedKey(currentUid(),state.sessionId));
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

function renderMessage(m, retry = false, sceneState = null, pending = false) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const label = document.createElement("span");
  label.textContent =
    m.role === "user" ? "You" : m.role === "summary" ? "Summary checkpoint" : "Assistant";
  if (m.role !== 'summary' && anyMemory(normalizeMemory(session?.memory))) label.textContent += ' · T'+(turnsFor(historyMessages ?? lastMessages).turnById.get(m.id) ?? '?');
  if (m.editedAt) label.textContent += " (edited)";
  if (m.truncated) label.textContent += " · cut off";
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
    if ((isFolded(m) || isActiveSummary(m)) && !confirm('Deleting this will invalidate the summary. The next summary must rebuild it from history. Continue?')) return;
    if (!confirm("Delete this message permanently?")) return;
    return historyAction('delete',async token=>{
    const result = await messagesApi.deleteMessage(token.sid, m.id, m.order);
    applyLocalChange(token,result,list=>list.filter(item=>item.id!==m.id));
    renderMessages(lastMessages.filter((item) => item.id !== m.id));
    await reconcileDeletedMemory();
    });
  }));
  if (retry) actions.appendChild(actionBtn('Retry reply', 'retry', () => retryReply(m)));
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
  if (pending) {
    const review = document.createElement('div');review.className = 'muted';
    review.textContent = 'Needs review: '+(m.reviewWarnings?.length ? m.reviewWarnings : lintPlayerAgency(m.content,normalizeMemory(session?.memory).protagonist)).join(' ')+' Memory and summaries wait for acceptance.';
    const accept=actionBtn('Accept reply',()=>historyAction('accept',async token=>{
      const result=await messagesApi.acceptMessage(token.sid,m.id,m.order,m.revision ?? 0);
      applyLocalChange(token,result,list=>list.map(x=>x.id===m.id ? result.replacement : x));renderMessages(lastMessages);void updateIndicator();
    }));
    if (m.sceneCandidate?.scene) { const candidate=document.createElement('p'); candidate.textContent=m.sceneCandidate.scene;review.append(candidate); }
    review.append(accept,actionBtn('Regenerate',() => { if (!busy) void regenerateMessage(m); }));wrap.append(review);
  }

  if (m.role==='assistant' && m.reviewWarnings?.length) { const note=document.createElement('p');note.className='muted';note.textContent='Note: '+m.reviewWarnings.join(' ');wrap.append(note); }
  if (m.role === 'assistant' && !m.ooc && normalizeMemory(session?.memory).scene && getPref('nera.memory.showScene') !== '0') {
    const chip = document.createElement('button'); chip.className = 'scene-chip'; chip.type = 'button'; chip.textContent = sceneState?.effective ? formatSceneForDisplay(sceneState.effective) : '+ Add scene'; chip.title = 'Edit scene line';
    if (!sceneState?.own && sceneState?.effective) chip.textContent += ' (carried forward · stale)';
    if (m.sceneMeta?.kind === 'inferred') chip.textContent += ' (inferred)';
    chip.addEventListener('click', () => {
      const row = document.createElement('div'), field = document.createElement('input'); field.value = sceneState?.effective ?? ''; field.maxLength = MAX_SCENE_LENGTH;
      const save = actionBtn('Save', async () => {
        const token=acquireBusy('scene');if(!token){showTransientInfo('Wait for the current reply to finish.');return;}save.disabled=true;
        try {
          const raw = field.value.trim() || null; const result = await messagesApi.updateMessageScene(token.sid,m.id,m.order,raw,sceneState);
          applyLocalChange(token,result,list=>list.map(x=>x.id===m.id ? result.replacement : x));
          renderMessages(lastMessages); await updateIndicator();
        } catch (e) {if(!(e instanceof StaleTurn))showTransientError(e);} finally {save.disabled=false;releaseBusy(token);}
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

function isFolded(m) {
  return m.role !== 'summary' && session?.activeSummaryMessageId && m.order <= (session.breakpointOrder ?? 0);
}
const isActiveSummary = m => m.role === 'summary' && m.id === session?.activeSummaryMessageId;

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
    const text=ta.value,token=acquireBusy('edit');if(!token){showTransientInfo('Wait for the current reply to finish.');return;}
    save.disabled = true;
    cancel.disabled = true;
    try {
      const result=await messagesApi.editMessage(token.sid,m.id,text,m.order,{expectedRevision:m.revision ?? 0});
      applyLocalChange(token,result,list=>list.map(x=>x.id===m.id ? result.replacement : x));
      finish();
    } catch (e) {
      if(e instanceof StaleTurn)return;
      showTransientError(e);
    } finally {
      save.disabled = false;
      cancel.disabled=false;releaseBusy(token);
    }
  });
  const cancel = actionBtn("Cancel", "small", finish);
  save.classList.add("btn"); cancel.classList.add("btn");
  actions.replaceChildren(save, cancel);
  contentEl.replaceWith(ta);
  const fit = () => {
    if (ta.scrollHeight <= ta.clientHeight) return;
    wrap.style.height = '';
    ta.style.height = Math.max(contentRect.height, ta.scrollHeight) + 'px';
  };
  fit(); ta.addEventListener('input', fit);
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

async function copyText(text) {try{await copyClipboard(text);showToast('Copied to clipboard',true);}catch(e){showTransientError(e);}}

function showToast(text, ok) {
  text=friendlyError(text);
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
  try { const messages = !anyMemory(normalizeMemory(session.memory)) && !historyMessages && hasEarlier ? lastMessages : await ensureHistory(); usage = await computeContextUsage(session,state.settings,messages,{ loreEntries,draftText:el.input.value }); } catch (error) { if (run === indicatorRun) el.contextLabel.textContent = error.message; return; }
  if (run !== indicatorRun) return; // a newer computation superseded this one

  lastMemoryReport = usage.report;
  const estimated=tokenizer.tokenizerStatus?.()==='fallback';if(estimated && !tokenizerWarned){tokenizerWarned=true;showTransientInfo('Token counts are estimates; the tokenizer failed to load.');}
  el.contextLabel.title = usage.droppedCount > 0 && state.settings.autoSummarizationEnabled !== true ? 'Older turns no longer fit. Turn on auto-summary or run Summarize to keep them in memory.' : '';
  const allocated=usage.usedTokens;
  const pct = usage.max > 0 ? (allocated / usage.max) * 100 : 0;
  el.contextFill.style.width = Math.min(100, pct) + "%";
  el.contextFill.classList.toggle("over", usage.overThreshold);
  el.contextThreshold.style.left =
    (usage.max > 0 ? (usage.threshold / usage.max) * 100 : 0) + "%";
  el.contextLabel.textContent =
    `${usage.usedTokens.toLocaleString()} input / ${usage.max.toLocaleString()} tokens` +
    (usage.droppedCount > 0 ? ` · ${usage.droppedCount} ${state.settings.autoSummarizationEnabled === true ? "out of window" : "turns not sent"}` : "") +
    (chatStatus==='reconnecting' ? ' · reconnecting' : '') +
    (estimated ? ' · estimate (tokenizer unavailable)' : '') +
    (!historyMessages && hasEarlier ? " · recent history estimate" : "") +
    (normalizeMemory(session.memory).autoUpdate ? ' · memory T'+(turnsFor(historyMessages ?? lastMessages).assistants.filter(a => a.order <= (session.memoryState?.extractedThroughOrder ?? 0)).at(-1)?.turn ?? 0) : '');
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
  if(busy)return;
  while(loreWritesPending()){await waitForLoreWrites();if(requestedSessionId!==state.sessionId)return;}
  const token=acquireBusy('regenerate');if(!token)return;
  try {
    await reconcileStory();assertActive(token);
    const all = await ensureHistory();assertActive(token);
    const latest = all.filter((m) => m.role !== "summary").at(-1);
    if (latest?.id !== message.id || message.order <= (session.breakpointOrder ?? 0)) {
      throw new Error("Only the latest, unsummarized reply can be regenerated. Later story turns depend on older replies.");
    }
    assertActive(token);
    await runAssistantTurn({
      reconciled:true,messages: all, upToOrder: message.order, overwriteId: message.id,

    },token);
  } catch (err) {
    if(!(err instanceof StaleTurn))showTransientError(err);
  } finally {releaseBusy(token);}
}

function setComposerText(text) {
  el.input.value = text; el.input.style.height = 'auto';
  el.input.style.height = el.input.scrollHeight + 'px'; el.input.scrollTop = el.input.scrollHeight;
}
async function retryReply(message) {
  if (busy || editingState || !session) return;
  const sid = state.sessionId;
  if (loreWritesPending()) await waitForLoreWrites();
  if (busy || !session || sid !== state.sessionId) return;
  await runAssistantTurn({ expectLatestUserId:message.id });
}

async function handleSend(e) {
  e.preventDefault();
  if (busy || !session || editingState) return;
  if(unsavedReplies.has(unsavedKey(currentUid(),state.sessionId))){showTransientInfo('Save or discard the unsaved reply before sending another turn.');return;}
  const requestedSessionId = state.sessionId;
  const draft = el.input.value;
  let saved = false;
  const text = draft.trim();
  if (!text) return;
  const settings = structuredClone(state.settings);
  if (!settings?.modelId || !settings?.apiKey) {
    showTransientError("Set your API key and Model ID in the Settings tab first.");
    return;
  }
  if (loreWritesPending()) await waitForLoreWrites();
  if (busy || !session || requestedSessionId !== state.sessionId) return;
  const token=acquireBusy('send');if(!token)return;
  try {
    await reconcileStory();assertActive(token);
    const baseHistory=historyMessages,baseRevision=historyRevision;
    const userResult = await messagesApi.addMessage(session.id, { role: "user", content: text });
    const {session:committedUserSession,message:resultMessage,...flatUserMessage}=userResult;
    const userMsg=resultMessage ?? flatUserMessage;
    saved = true;
    if(el.input.value===draft)setComposerText('');
    assertActive(token);
    // Bridge until the snapshot arrives so the context build includes the user turn
    // without re-reading the collection from Firestore.
    if (!lastMessages.some((m) => m.id === userMsg.id)) {
      lastMessages = lastMessages.concat([
        { ...userMsg,role:"user",content:text },
      ]);
    }
    session = committedUserSession ?? { ...session,historyRevision:userMsg.historyRevision };
    historyRevision = userMsg.historyRevision;
    historyMessages=bridgeHistory(baseHistory,baseRevision,userMsg);
    if(!historyMessages){historyRevision=null;await ensureHistory(true);assertActive(token);}
    // Explicitly pass the bridged cache: opts.messages keeps buildContextForRequest
    // off the racy getMessages() fallback, which would hit the watch cache and
    // potentially miss the just-committed user message.
    await runAssistantTurn({messages:historyMessages,reconciled:true},token);
  } catch (err) {
    if (!saved && requestedSessionId === state.sessionId && !el.input.value) setComposerText(draft);
    if(!(err instanceof StaleTurn))showTransientError(err);
  } finally {
    releaseBusy(token);
  }
}

async function runAssistantTurn(opts = {},suppliedToken=null) {
  if(unsavedReplies.has(unsavedKey(currentUid(),state.sessionId))){showTransientInfo('Save or discard the unsaved reply first.');return;}
  const token=suppliedToken ?? acquireBusy('reply');if(!token)return;
  const ownsToken=!suppliedToken;
  const settings = structuredClone(state.settings), sid = state.sessionId;
  if (!settings) {if(ownsToken)releaseBusy(token);return;}
  const controller=new AbortController();token.abort=()=>controller.abort('user');el.stopBtn.classList.remove('hidden');el.sendBtn.hidden=true;
  const petTurn = startPetTurn();
  let maintenanceUsed = false;
  try {
    if(!opts.reconciled)await waitForPreparation(reconcileStory(token),controller);assertActive(token);
    if (opts.expectLatestUserId) {
      const latest = (historyMessages ?? []).filter(m => m.role !== 'summary').at(-1);
      if (latest?.role !== 'user' || latest.id !== opts.expectLatestUserId) throw new Error('The latest story turn changed. Review it before retrying.');
    }
    let sourceMessages = structuredClone(historyMessages);
    let sourceSession = structuredClone(session);
    let built = await waitForPreparation(buildContextForRequest(sourceSession,settings,{ ...opts,messages:sourceMessages,requireLatestUser:true,loreEntries:structuredClone(loreEntries) }),controller);
    assertActive(token);
    startStreamUI();
    let result,stopReason=null;
    try {
      result=await chatCompletion({ settings,messages:built.apiMessages,allowTruncated:true,signal:controller.signal,onDelta:t => { updatePetPhase('writing',petTurn); if (streamState) appendStream('content',t); },onReasoning:t => { updatePetPhase('thinking',petTurn); if (streamState) appendStream('thinking',t); } });
    } catch(error) {
      assertActive(token);
      if(!error.partial?.content?.trim() || !confirm('Keep the partial reply? It will be marked as cut off.'))throw error;
      stopReason=error.aborted==='timeout' ? 'timeout' : 'stopped';
      result={...error.partial,finishReason:'length',usage:null};
    }
    const {content,thinking,finishReason,usage}=result;
    assertActive(token);
    const truncated = finishReason === 'length';
    lastProviderUsage = usage?.prompt_tokens != null ? { sessionId:sid,promptTokens:usage.prompt_tokens,estimate:built.usedTokens } : null;
    const fresh=session;
    const mem=normalizeMemory(sourceSession.memory),sceneEnabled=mem.scene;
    const out=readSceneOutput(content,{sceneEnabled}),clean=out.clean;
    let planThread=sceneEnabled && sourceSession.longTermPlan?.trim() ? out.planThread : null;
    if (truncated && !clean) throw new Error('The output limit left no narrative reply. Raise Max response tokens or lower the reasoning budget.');
    if (!clean) throw new Error('The model returned no reply; nothing was saved.');
    const userText=normalizeAdDirective(sourceMessages.filter(m => m.role==='user' && m.order < (opts.upToOrder ?? Infinity)).at(-1)?.content ?? '');
    const inputKind=classifyUserInput(userText),ooc=inputKind==='ooc' || inputKind==='question' && !out.scene;
    const prior=latestScene(sourceMessages,opts.upToOrder ?? Infinity,mem.startingScene);
    let acceptedScene={scene:null,sceneMeta:null},sceneWarning=null;
    if (sceneEnabled && !ooc) {
      acceptedScene=carryScene(prior);
      if (!truncated && out.scene) acceptedScene=validateSceneValues(out.scene,{narration:clean,userText,prior:prior.scene});
      else if (!truncated && mem.sceneFallback && !maintenanceUsed) {
        try {
          const recovered=await recoverScene(settings,{narration:clean,userText,prior,
            names:loreEntries.filter(e => e.book==='characters').map(e => e.name),protagonist:mem.protagonist,plan:sourceSession.longTermPlan,model:mem.sceneFallbackModel},{signal:controller.signal,onStart:()=>{maintenanceUsed=true;}});
          assertActive(token);
          if (recovered) { acceptedScene=recovered; planThread ||= sourceSession.longTermPlan?.trim() ? recovered.planThread : null; }
        } catch (error) {if(error instanceof StaleTurn)throw error; sceneWarning=String(error?.message ?? 'Scene recovery failed.'); }
      }
    }
    const reviewWarnings=sceneEnabled && !ooc && !truncated ? [
      ...lintPlayerAgency(clean,mem.protagonist),
      ...(!prior.scene?.time && !parseScene(acceptedScene.scene).time ? lintUnestablishedTime(clean,{prior:prior.scene,userText}) : []),
      ...(acceptedScene.warnings ?? []),...(out.count > 1 ? ['Several scene tags; the last one was used.'] : []),
      ...(sceneWarning ? [sceneWarning] : [])] : [];
    const message={role:'assistant',content:clean,thinking,truncated,planThread,planBefore:sourceSession.longTermPlan ?? '',
      scene:acceptedScene.scene,sceneMeta:acceptedScene.sceneMeta,ooc,
      ...(sceneEnabled ? {acceptance:'accepted',reviewWarnings} : {})};
    updatePetPhase('saving',petTurn);
    let saved;
    const pendingReply={sid,owner:currentUid(),message,id:opts.overwriteId ?? messagesApi.newMessageId(),overwriteId:opts.overwriteId ?? null,order:opts.upToOrder ?? null,sourceRevision:sourceSession.historyRevision ?? 0};
    if(streamState)streamState.savedId=pendingReply.id;
    try {
      const result=await saveNarration(pendingReply);
      saved=result.message;
      assertActive(token);const committed=result.session ?? {...fresh,historyRevision:result.historyRevision};
      if((committed.historyRevision ?? 0)>=(session.historyRevision ?? 0))session=committed;
      clearUnsaved(pendingReply.owner,sid);
    } catch(error) {
      if(error instanceof StaleTurn)throw error;
      pendingReply.conflict=error.name==='HistoryConflict';pendingReply.error=error.message;
      const key=unsavedKey(pendingReply.owner,sid);unsavedRevisions.set(key,(unsavedRevisions.get(key) ?? 0)+1);
      unsavedReplies.set(key,pendingReply);
      void storeUnsavedReply(pendingReply.owner,sid,pendingReply);
      streamState?.wrap.remove();streamState=null;renderUnsavedReply();finishPetTurn('ready',petTurn);
      showTransientInfo('Reply not saved. Your text is available below — Save again or Copy.');
      return;
    }
    // Save completed narration even if inputs changed during generation. Reload
    // changed history before the next request instead of caching the old snapshot.
    const historyChanged = session.historyRevision !== (sourceSession.historyRevision ?? 0) + 1;
    historyMessages = historyChanged ? null : mergeMessages(sourceMessages,[saved]);
    historyRevision = historyChanged ? null : session.historyRevision;
    if (streamState) { streamState.savedId = saved.id; streamState.saveCompleted = true; }
    renderMessages(mergeMessages(lastMessages,[saved])); queueCacheSave(); rememberMemoryStory();
    if (truncated) {if(stopReason)showTransientInfo(stopReason==='timeout' ? 'Partial reply saved (timed out after 120 s).' : 'Partial reply saved (stopped).');else showTransientError('Reply saved but cut off at the output limit. Raise Max response tokens or use Regenerate.');}
    else if (sceneEnabled && !ooc && acceptedScene.sceneMeta?.kind==='carried') showTransientInfo('No scene tag in this reply; the previous scene was kept.');
    lastMemoryReport = built.report;
    finishPetTurn('ready',petTurn);
    try {
    const backoff=summaryBackoff.get(sid) ?? 0;if(backoff)summaryBackoff.set(sid,backoff-1);
    const due=memoryUpdater.dueRangeFor?.(sid) ?? (memoryUpdater.maybeStartAfterTurn && null);
    const hist=historyMessages ?? await ensureHistory();assertActive(token);
    const contextUsage=await computeContextUsage(session,settings,hist,{loreEntries});assertActive(token);
    const planned=settings.autoSummarizationEnabled===true && !backoff && (contextUsage.overThreshold || contextUsage.droppedCount>0) ? planSummary(session,settings,hist,{maxChunks:1,urgent:contextUsage.droppedCount>0}) : null;
    const summary=planned && !planned.skip ? planned : null;
    const pick=maintenanceUsed ? null : pickMaintenance({overwrite:!!opts.overwriteId,summary,memoryDue:!!due,memoryRunning:memoryUpdater.isRunning(sid),memoryDeferrals:memoryDeferrals.get(sid) ?? 0});
    if(due && pick!=='memory')memoryDeferrals.set(sid,(memoryDeferrals.get(sid) ?? 0)+1);
    if(pick==='memory'){memoryUpdater.maybeStartAfterTurn(sid);memoryDeferrals.set(sid,0);}
    else if(pick==='summary') {
      const ui=streamSummaryUI('Context near limit — summarizing…');
      try {const summaryResult=await runSummarization(structuredClone(session),settings,{signal:controller.signal,maxChunks:1,messages:structuredClone(hist),loreEntries:structuredClone(loreEntries),onDelta:ui.onDelta});assertActive(token);applySummaryResult(summaryResult);}
      catch(error){if(error instanceof StaleTurn)throw error;assertActive(token);summaryBackoff.set(sid,3);showTransientInfo('Summary skipped: '+error.message);}
      finally {ui.done();}
    }
    } catch(error){if(!(error instanceof StaleTurn))showTransientInfo('Reply saved. Background memory was skipped: '+error.message);}

  } catch (err) {
    if(err instanceof StaleTurn)return;
    finishPetTurn('blocked',petTurn); streamState?.wrap.remove(); streamState = null; refreshPetPlacement(); clampListScroll(); showTransientError(err);
  } finally {if(ownsToken)releaseBusy(token);}
}

async function saveNarration(reply,asNew=false) {
  const expectedSource={historyRevision:reply.sourceRevision};
  if(reply.overwriteId && !asNew){
    const result=await messagesApi.overwriteMessage(reply.sid,reply.overwriteId,reply.message,reply.order,{},expectedSource);
    return {...result,message:result.replacement};
  }
  const saved=await messagesApi.addMessage(reply.sid,reply.message,{id:reply.id,expectedSource});
  const {session:committed,message:payload,...flat}=saved;
  const message=payload ?? flat;
  return {message,session:committed,historyRevision:saved.historyRevision};
}
function clearUnsaved(owner,sid) {
  const key=unsavedKey(owner,sid);unsavedRevisions.set(key,(unsavedRevisions.get(key) ?? 0)+1);
  unsavedReplies.delete(key);void storeUnsavedReply(owner,sid,null);
  if(owner===currentUid() && sid===state.sessionId){unsavedNode?.remove();unsavedNode=null;}
}
function renderUnsavedReply() {
  unsavedNode?.remove();unsavedNode=null;
  const reply=unsavedReplies.get(unsavedKey(currentUid(),state.sessionId));if(!reply || !el.list)return;
  const wrap=document.createElement('div');wrap.className='msg assistant unsaved';
  const label=document.createElement('div');label.className='msg-meta';label.textContent='Not saved'+(reply.conflict ? ' · story changed on another device' : '');
  const body=document.createElement('div');body.className='msg-content';body.textContent=reply.message.content;
  const controls=document.createElement('div');controls.className='msg-actions';
  const retry=asNew=>historyAction('save-reply',async token=>{
    const pending=unsavedReplies.get(unsavedKey(reply.owner,reply.sid));if(pending!==reply)return;
    if(asNew){const fresh=await getSessionFromServer(reply.sid);assertActive(token);if(!fresh || fresh.deleting)throw new Error('This story was deleted.');reply.sourceRevision=fresh.historyRevision ?? 0;reply.id=messagesApi.newMessageId();}
    try {
      const result=await saveNarration(reply,asNew);assertActive(token);
      session=result.session ?? {...session,historyRevision:result.historyRevision};historyMessages=null;historyRevision=null;
      clearUnsaved(reply.owner,reply.sid);renderMessages(mergeMessages(lastMessages,[result.message]));queueCacheSave();void updateIndicator();showTransientInfo('Reply saved.');
    }catch(error){if(error.name==='HistoryConflict'){reply.conflict=true;void storeUnsavedReply(reply.owner,reply.sid,reply);renderUnsavedReply();}throw error;}
  });
  controls.append(actionBtn('Save again',()=>retry(false)),actionBtn('Copy',()=>copyClipboard(reply.message.content)),actionBtn('Discard',()=>{if(confirm('Discard this unsaved reply?')){clearUnsaved(reply.owner,reply.sid);updateWelcome();}}));
  if(reply.conflict)controls.append(actionBtn('Save as new reply at the end',()=>retry(true)));
  wrap.append(label,body,controls);if(reply.message.thinking)wrap.append(buildThinking(reply.message.thinking));el.list.append(wrap);unsavedNode=wrap;
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
      bubble.remove(); clampListScroll();
    },
  };
}

async function handleSummarize() {
  if (memoryUpdater.isRunning(state.sessionId)) { showTransientError('Wait for the current memory update.'); return; }
  if (busy || !session) return;
  const petTurn = startPetTurn();
  const token=acquireBusy('summary');if(!token)return;
  const ui = streamSummaryUI("Summarizing…");
  try {
    await reconcileStory();assertActive(token);
    const r = await runSummarization(session, state.settings, {
      validateSource: () => assertActive(token),
      messages: structuredClone(historyMessages),loreEntries:structuredClone(loreEntries),
      onDelta: (t) => { updatePetPhase("writing", petTurn); ui.onDelta(t); },
      onReasoning: (t) => { updatePetPhase("thinking", petTurn); ui.onReasoning(t); },
    });
    assertActive(token);applySummaryResult(r);
    setStatus(r.skipped ? r.reason : "Summary checkpoint created.", true);
    finishPetTurn("ready", petTurn);
  } catch (err) {
    finishPetTurn("blocked", petTurn);
    showTransientError("Summarization failed: " + (err.message || String(err)));
  } finally {
    ui.done();
    releaseBusy(token);
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
  const token=acquireBusy('summary');if(!token)return;
  const ui = streamSummaryUI("Summarizing full history…");
  try {
    await reconcileStory();assertActive(token);
    const r = await runSummarization(session, state.settings, {
      validateSource: () => assertActive(token),
      messages: structuredClone(historyMessages),loreEntries:structuredClone(loreEntries),
      full: true,
      onDelta: (t) => { updatePetPhase("writing", petTurn); ui.onDelta(t); },
      onReasoning: (t) => { updatePetPhase("thinking", petTurn); ui.onReasoning(t); },
      onProgress: (multi, i, total) => {
        if (multi) ui.setLabel(total ? `Summarizing part ${i}/${total}…` : `Summarizing part ${i}…`);
      },
    });
    assertActive(token);applySummaryResult(r);
    setStatus(r.skipped ? r.reason : "Full-history summary created.", true);
    finishPetTurn("ready", petTurn);
  } catch (err) {
    finishPetTurn("blocked", petTurn);
    showTransientError("Summarization failed: " + (err.message || String(err)));
  } finally {
    ui.done();
    releaseBusy(token);
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
  const token=acquireBusy('reset');if(!token)return;
  try {
    await updateSession(session.id, { activeSummaryMessageId: null, breakpointOrder: 0 });
    assertActive(token);session = { ...session, activeSummaryMessageId: null, breakpointOrder: 0 };
    updateIndicator();
    queueCacheSave();
    setStatus("Summary checkpoint reset.", true);
  } catch (err) {
    showTransientError("Reset failed: " + (err.message || String(err)));
  } finally {releaseBusy(token);}
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

function applyBusyUi(b) {
  busy = state.busy = b;
  updateMemoryChip();
  el.sendBtn.disabled=b;
  if(!b){el.sendBtn.hidden=false;el.stopBtn?.classList.add('hidden');}
  el.summarizeBtn.disabled = b;
  if (!editingState) renderMessages(lastMessages);
}

// Only keep the list pinned to the bottom while the user hasn't scrolled up.
function isNearBottom() {
  return el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;
}

function scrollToEnd() {
  el.list.scrollTop = el.list.scrollHeight;
  wasNearBottom = true;
}

function clampListScroll() {
  el.list.scrollTop = Math.max(0, Math.min(el.list.scrollTop,
    Math.max(0, el.list.scrollHeight - el.list.clientHeight)));
}

function captureListPosition() {
  const edge = el.list.getBoundingClientRect().top;
  const node = [...el.list.children].find((child) => {
    const rect = child.getBoundingClientRect();
    return rect.top + rect.height > edge;
  });
  return { sticky: isNearBottom(), node, id: node?.dataset.messageId,
    top: node?.getBoundingClientRect().top };
}

function restoreListPosition(position, replacementId) {
  if (position.sticky) { scrollToEnd(); return; }
  const node = position.id ? renderedMessages.get(position.id)?.node
    : position.node?.parentNode === el.list ? position.node
      : renderedMessages.get(replacementId)?.node;
  if (node && Number.isFinite(position.top)) {
    el.list.scrollTop += node.getBoundingClientRect().top - position.top;
  }
  clampListScroll();
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
  if (!text) { statusEl?.remove(); clampListScroll(); return; }
  const sticky = isNearBottom();
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "status-line";
    el.list.appendChild(statusEl);
  }
  statusEl.textContent = text;
  if (autoHide) setTimeout(() => { statusEl?.remove(); clampListScroll(); }, 4000);
  if (sticky) scrollToEnd();
}

function showTransientInfo(text) {
  const sticky=isNearBottom(),div=document.createElement('div');
  div.className='msg info muted'; div.textContent=text;el.list.append(div);
  if (sticky) scrollToEnd();setTimeout(() => {div.remove();clampListScroll();},10000);
}

function showTransientError(text) {
  text=friendlyError(text);
  const sticky = isNearBottom();
  const div = document.createElement("div");
  div.className = "msg error";
  div.textContent = "⚠ " + text;
  el.list.appendChild(div);
  if (sticky) scrollToEnd();
  setTimeout(() => { div.remove(); clampListScroll(); }, 10000);
}

async function reconcileDeletedMemory() {
  if (!session || !normalizeMemory(session.memory).autoUpdate && !loreEntries.length) return;
  const messages = await ensureHistory(), orders = new Set(messages.filter(m => m.role === 'assistant').map(m => m.order));

  const count = loreEntries.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+s.lines.filter(l => l.src != null && l.src<=Math.max(0,...messages.map(m=>m.order)) && !orders.has(l.src)).length,0),0);
  if (count) document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: `${count} memory notes came from deleted turns.`, action: 'Review', event: 'lorebooks', options: { filter: 'deleted' } } }));
  rememberMemoryStory();
}
