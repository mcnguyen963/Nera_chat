import {buildDirectorContext} from '../director-context.js';
import {seedDirectorState} from '../director-state.js';
import {tokenUsageCache,tokenContextFingerprint} from './token-usage-cache.js';
import * as deviceCache from '../chat-cache.js';
import {deviceStoryCopies,validateDeviceStory,uploadDeviceStory} from '../device-story-upload.js';
import {cachedLoreSnapshot} from '../lore-cache.js';
import {node,button,subSheet,download} from './memory-ui.js';
import {requestInputLimit} from '../request-budget.js';
import {afterUiPaint} from '../ui-work.js';
import {openStoryStore,storyStore,flushStory,closeStoryStores,forgetStoryStore} from '../local-story-store.js';
import {loadStoryData,saveStoryData,storyQueueStorage,replaceStoryCache} from '../chat-cache.js';
import * as directorStore from '../director-store.js';
import { prepareDirectorTurn } from '../director-turn.js';
import { directorScene, directorSceneWarnings } from '../director-state.js';
import { requestSource } from '../continuity.js';
import {setIcon, rewritePresentation, contextRingPresentation, thinkingIcon} from './icons.js';
import {messageMenu, initMessageMenus} from './message-menu.js';
import {copyDisplayedMessage, initFloatingCopy} from './message-copy.js';
import {createComposerSizer, observeComposerInset} from './composer-size.js';
import {createIndicatorRefresh} from './indicator-refresh.js';
import {continuationTarget,continuationPrefix,appendContinuation} from '../continuation.js';
import {selectStorySettings,effectiveActiveSettings,saveStorySettings,readStorySettingsRefresh,applyStorySettingsRefresh,invalidateStorySettingsLoads} from '../story-settings-store.js';
import {resolveModelProfile} from '../model-profiles.js';
import {maxOf} from '../math-utils.js';
import {storyText} from '../story-text.js';
import {buildRewriteMessages} from '../rewrite.js';
import {createStreamVibration} from '../stream-vibration.js';
import {diagnostics} from '../version.js';
import {getPref} from '../local-pref.js';
import {friendlyError} from '../errors.js';
import {loadUnsavedReply,storeUnsavedReply} from '../unsaved-replies.js';
import {effectivelyPaused} from '../continuity.js';
import {copyText as copyClipboard} from './clipboard.js';
import * as tokenizer from '../tokenizer.js';
import {createBusyGate,bridgeHistory,waitForPreparation,protectStop} from './busy-token.js';
import {hasPendingSettings,waitForPendingSettings} from './pending-settings.js';
import {pickMaintenance} from '../maintenance.js';
import { assertSource, noteNeedsReview } from '../continuity.js';
import { normalizeMemory, anyMemory } from '../memory-settings.js';
import { formatSceneForDisplay, latestScene, MAX_SCENE_LENGTH, carryScene, validateSceneValues, readSceneOutput, classifyUserInput, sceneTimeline, parseScene, sceneFromThinking } from '../scene.js';
import { lintPlayerAgency, lintDirectorGestures, lintDirectorHistory, lintDirectorResponseBoundary, lintUnestablishedTime, isAcceptedTurn, lastUserOrderOf } from '../turn-review.js';
import { recoverScene } from '../scene-recovery.js';
import { computeTurns, dueRangeStatus } from '../turns.js';
import { getLore, configureLoreWrites, holdLoreWrites } from '../lore-store.js';
import * as loreStore from '../lore-store.js';
import * as memoryUpdater from '../memory-updater.js';
import { dismissRebuild } from '../session-memory.js';
import { initPetView, startPetTurn, finishPetTurn, refreshPetPlacement, updatePetPhase, invalidatePetLayout } from "./pet-view.js";
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
  saveSettings,readSettingsRefresh,
  normalizeProfiles,
  activeProfile,
  mirrorFromActiveProfile,
  mirrorToActiveProfile,
} from "../settings.js";

const unsavedReplies=new Map(),unsavedRevisions=new Map();
const unsavedKey=(owner,sid)=>owner+':'+sid;
let unsavedNode=null;
let chatRetry=0,chatRetryTimer=null,chatStatus='ok';
function clearChatRetry(){clearTimeout(chatRetryTimer);chatRetryTimer=null;}
let msgUnsub = null;
let sessUnsub = null;
let session = null;      // latest snapshot of the active session doc
let sessionSnapshotVersion = 0;
let streamState = null;  // live streaming UI handle
let busy = false;
const busyGate=createBusyGate({current:()=>({sid:state.sessionId,epoch:historyEpoch,owner:state.user?.uid ?? (()=>{try{return currentUid();}catch{return null;}})()}),onChange:b=>applyBusyUi(b),onRelease:()=>{document.dispatchEvent(new CustomEvent('turn-finished'));void updateIndicator();scheduleIdleMaintenance();void checkActiveStoryFreshness();}});
const releaseBusy=token=>{
  if(busyGate.active!==token)return false;
  token.stopTimer?.();const released=busyGate.release(token);token.loreHold?.release();return released;
};
const acquireBusy=kind=>{
  const token=busyGate.acquire(kind);if(!token)return null;
  token.loreHold=holdLoreWrites(token.sid);
  if(['send','reply','continue','regenerate','rewrite'].includes(kind)){
    token.abort=()=>{token.cancelled=true;restoreStreamUI();releaseBusy(token);};
    el.stopBtn?.classList.remove('hidden');if(el.sendBtn)el.sendBtn.hidden=true;
    if(kind==='send'){
      if(el.stopBtn)el.stopBtn.disabled=true;
      token.stopTimer=protectStop(token,{isActive:t=>busyGate.stillActive(t),onReady:()=>{if(el.stopBtn)el.stopBtn.disabled=false;}});
    }else if(el.stopBtn)el.stopBtn.disabled=false;
  }
  return token;
};
class StaleTurn extends Error {}
function assertActive(token){if(cacheWritesPaused || !session || !busyGate.stillActive(token))throw new StaleTurn('Story changed; this action was cancelled.');}
async function waitForPendingChanges(token) {
  if(hasPendingSettings(currentUid(),token.sid)){showTransientInfo('Waiting for settings to save…');token.waitingSettings=true;try{await waitForPendingSettings(currentUid(),token.sid);assertActive(token);}finally{token.waitingSettings=false;}}
  await token.loreHold?.ready;assertActive(token);await loreReloading;assertActive(token);
}
let storySettingsReady=Promise.resolve(),chatLoading=Promise.resolve();
// Disabled: page reloads use the local cache; full refresh is explicit Sync only.
// let refreshOnReload=globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type==='reload';
let syncStatus={pending:0,error:null,durable:true};
let indicatorTimer=null,maintenanceTimer=null,pendingMaintenance=null;
const turnCheckpoints=new Map();
// let freshnessRequested=false,freshnessJob=null;
function checkpointTurn(token){
  let owner;try{owner=currentUid();}catch{return;}
  if(token.owner!==owner)return;
  const store=storyStore(token.sid);if(!store)return;
  const pending=store.checkpoint();turnCheckpoints.set(store,pending);
  void pending.catch(()=>{/* The queue retains the text and exposes the save error. */}).finally(()=>{
    if(turnCheckpoints.get(store)===pending)turnCheckpoints.delete(store);
    scheduleIdleMaintenance();void checkActiveStoryFreshness();
  });
}
function requestStoryFreshness(){
  // Disabled: foreground events must not download the story or acquire the chat lock.
  // freshnessRequested=true;void checkActiveStoryFreshness();
}
async function checkActiveStoryFreshness(){
  /* Disabled automatic freshness checks. Keep explicit Sync available.
  if(!freshnessRequested || freshnessJob || !session || cacheWritesPaused || busy || editingState || document.hidden || hasPendingSettings(currentUid(),state.sessionId))return;
  const store=storyStore(state.sessionId);if(!store || store.status.pending || store.status.running || store.status.paused)return;
  freshnessRequested=false;
  const sid=state.sessionId,owner=currentUid(),epoch=historyEpoch;
  const active=()=>sid===state.sessionId && owner===currentUid() && epoch===historyEpoch && !cacheWritesPaused;
  freshnessJob=(async()=>{
    await chatLoading;if(!active())return;
    const fresh=await getSessionFromServer(sid);if(!active())return;
    if(busy || editingState || hasPendingSettings(owner,sid) || store.status.pending || store.status.running){freshnessRequested=true;return;}
    if(store.requiresReconciliation || !fresh || fresh.deleting || preparationKey(fresh)!==preparationKey(session) || fresh.directorCheckpoint!==session.directorCheckpoint){
      await historyAction('refresh',token=>refreshStoryFromServer(token));
    }
  })();
  try{await freshnessJob;}catch(error){if(active())showTransientError(error);}
  finally{freshnessJob=null;if(freshnessRequested)void checkActiveStoryFreshness();}
  */
}
function scheduleIdleMaintenance(){
  const store=storyStore(state.sessionId);
  // Disabled as a global blocker: store?.requiresReconciliation
  if(!pendingMaintenance || busy || maintenanceTimer!==null || turnCheckpoints.has(store) || store?.status.pending || store?.status.running || store?.status.paused || store?.status.error)return;
  maintenanceTimer=setTimeout(()=>{maintenanceTimer=null;const task=pendingMaintenance;pendingMaintenance=null;if(!task || busy || task.owner!==currentUid() || task.sid!==state.sessionId || task.key!==preparationKey(session))return;void runIdleMaintenance(task);},0);
}

const directStorySaves=new Set();
const revisionFields=['historyRevision','directorRevision','loreRevision','storySettingsRevision'];
function applyWorkingStory(view,status) {
  // Keep a stale cache from undoing a confirmed scene/state edit on screen.
  // This does not prevent queue admissions or require a full Sync.
  if(storyStore(state.sessionId)?.requiresReconciliation || status.paused && directStorySaves.has(currentUid()+':'+state.sessionId))return;
  if(!status.pending && session && revisionFields.some(key=>(view.session[key] ?? 0)<(session[key] ?? 0)))return;
  if(!session || view.session.id!==state.sessionId)return;
  const changed=!sameHistoryRendering(historyMessages,view.messages) || preparationKey(session)!==preparationKey(view.session);
  session={...view.session};historyMessages=view.messages;historyRevision=session.historyRevision ?? 0;
  syncStatus=status;latestReady=true;hasEarlier=false;
  if(changed)renderMessages(historyMessages.slice(-Math.max(visibleCount,PAGE_SIZE)));
  updateSyncStatus();queueCacheSave();void updateIndicator();scheduleIdleMaintenance();void checkActiveStoryFreshness();
}
function updateSyncStatus(){
  const node=document.getElementById('chat-sync-status');if(!node)return;
  node.textContent=!syncStatus.durable && syncStatus.pending?'Local only':syncStatus.error?'Changes not synced':syncStatus.pending?'Saving…':syncStatus.synced?'Synced':'';
  node.title=!syncStatus.durable && syncStatus.pending?'Local storage is unavailable. Keep this page open until changes sync.':syncStatus.error?.code==='story-conflict'?'Story changed on another device. Use Sync data to load the latest version.':syncStatus.error?.message ?? '';node.hidden=!node.textContent;
}
async function ensureLocalStory({pendingStateSave=false,saveHold=null,token=busyGate.active}={}) {
  const sid=state.sessionId,owner=currentUid(),epoch=historyEpoch;
  const active=()=>sid===state.sessionId && owner===currentUid() && epoch===historyEpoch;
  const observe=(view,status)=>{if(active())applyWorkingStory(view,status);};
  let store=storyStore(sid);
  // Disabled: a stale local receipt must not force a full account/lore/settings Sync.
  // if(store?.requiresReconciliation){await refreshStoryFromServer(token,{pendingStateSave,saveHold});if(!active())throw new StaleTurn();}
  if(store?.requiresReconciliation && !store.status.pending && !store.status.paused){
    // Recover only the affected story header and history, once, on demand.
    const fresh=await getSessionFromServer(sid);if(!active())throw new StaleTurn();
    if(token)assertActive(token);
    if(store.status.pending || store.status.paused)return store;
    if(!fresh || fresh.deleting)throw new Error('Story no longer exists.');
    session=fresh;historyMessages=null;historyRevision=null;
    const messages=await ensureHistory();if(!active())throw new StaleTurn();
    if(token)assertActive(token);
    if(store.status.pending || store.status.paused)return store;
    store.adopt({session,messages,turns:store.view.turns},{reconciled:true});
  }
  if(!store){const messages=await ensureHistory();if(!active())throw new StaleTurn();
    store=await openStoryStore(sid,{session:{...session,storySettingsRevision:state.storySettings?.revision ?? session.storySettingsRevision ?? 0},messages,turns:{}},observe);
  }else{
    // Reopening a cached story must reconnect its view, including queues opened
    // by background sync. Never replace newer local work with an older snapshot.
    const upToDate=['historyRevision','directorRevision','loreRevision','storySettingsRevision'].every(key=>(session[key] ?? 0)>=(store.view.session[key] ?? 0));
    if(!store.status.pending && !store.status.paused && upToDate && historyMessages && historyRevision===(session.historyRevision ?? 0) && preparationKey(store.view.session)!==preparationKey(session))store.adopt({session,messages:historyMessages ?? store.view.messages,turns:store.view.turns});
    store.observe=observe;observe(store.view,store.status);
  }
  if(!active())throw new StaleTurn();
  // if(store.requiresReconciliation){await refreshStoryFromServer(token,{pendingStateSave,saveHold});if(!active())throw new StaleTurn();}
  return store;
}
function cancelGeneration(token,controller,vibration,petTurn){
  if(!busyGate.stillActive(token))return;
  token.cancelled=true;controller.abort('user');vibration.stop();
  restoreStreamUI();finishPetTurn('ready',petTurn);checkpointTurn(token);releaseBusy(token);
}
async function historyAction(kind,run) {
  const token=acquireBusy(kind);if(!token){showTransientInfo('Wait for the current reply to finish.');return false;}
  try{await run(token);return true;}catch(error){if(!(error instanceof StaleTurn))showTransientError(error);return false;}finally{releaseBusy(token);}
}
// Direct state edits remain server-confirmed and exclude new queue admissions
// until their receipts have been applied. Cache I/O and token estimates are deferred.
async function saveStoryState(write,apply,{token=null,sid=state.sessionId,owner=currentUid(),epoch=historyEpoch,reconcile=false}={}) {
  const key=owner+':'+sid;
  const check=()=>{
    if(token)assertActive(token);
    if(owner!==currentUid() || sid!==state.sessionId || epoch!==historyEpoch || cacheWritesPaused)throw new StaleTurn('Story changed while saving.');
    if(busy && busyGate.active!==token && !busyGate.active?.waitingSettings)throw new Error('Finish the current reply before saving state.');
  };
  check();if(directStorySaves.has(key))throw new Error('State is already saving.');
  directStorySaves.add(key);pendingMaintenance=null;
  const hold=token?.loreHold ?? holdLoreWrites(sid);let store=null,committed=false;
  try {
    await chatLoading;check();await hold.ready;check();await loreReloading;check();
    store=await ensureLocalStory({pendingStateSave:true,saveHold:hold,token});check();
    await store.pause();check();await store.flush({whilePaused:true});check();
    const baseline=preparationKey(session);
    const result=await write(store.confirmed);committed=true;check();
    if(!apply(result,store,baseline)){
      store.invalidate();historyMessages=null;historyRevision=null;historyCache.delete(key);
      // Disabled: saving state must not trigger a full Sync or delay a waiting Send.
      // if(reconcile)await refreshStoryFromServer(busyGate.active?.waitingSettings ? busyGate.active : token,{pendingStateSave:true,saveHold:hold});
    }
    check();rememberMemoryStory();invalidateRenderedMessages();renderMessages(lastMessages);
    queueCacheSave();void updateIndicator();return result;
  } catch(error) {
    if(committed || error.code==='story-conflict' || error.name==='HistoryConflict'){
      store?.invalidate();
      if(owner===currentUid() && sid===state.sessionId && epoch===historyEpoch){historyMessages=null;historyRevision=null;historyCache.delete(key);}
    }
    if(committed)throw Object.assign(new Error('State was saved. Refresh the story before continuing.'),{saveCommitted:true,cause:error});
    throw error;
  } finally {directStorySaves.delete(key);store?.resume();if(!token)hold.release();}
}
function applySceneSave(result,store,baseline) {
  const retired=new Set(result.retiredSummaryIds ?? []);
  const mutate=list=>list.map(m=>m.id===result.replacement.id && (m.revision ?? 0)<=(result.replacement.revision ?? 0) ? result.replacement : retired.has(m.id) ? {...m,retired:true} : m);
  // The saved scene remains visible even when a newer snapshot needs reloading.
  lastMessages=mutate(lastMessages);
  const base=result.baseHistoryRevision,after=result.session;
  const safe=after && historyMessages && historyRevision===base && !store.status.pending &&
    (store.confirmed.session.historyRevision ?? 0)===base &&
    (preparationKey(session)===baseline || preparationKey(session)===preparationKey(after)) &&
    revisionFields.every(key=>(session[key] ?? 0)<=(after[key] ?? 0)) &&
    ['loreRevision','storySettingsRevision'].every(key=>(session[key] ?? 0)===(after[key] ?? 0));
  if(!safe)return false;
  session={...session,...after};historyMessages=mutate(historyMessages);historyRevision=result.historyRevision;
  store.adopt({session,messages:historyMessages,turns:store.view.turns},{serverConfirmed:true});
  return true;
}
export async function saveDirectorLiveState(sid,value,expected,{owner=currentUid(),epoch=historyEpoch}={}) {
  return saveStoryState(()=>directorStore.resetDirectorState(sid,value,expected),(result,store)=>{
    const matches=story=>{try{assertSource(story,result.source);return true;}catch{return false;}};
    const applied={...result.source,directorRevision:result.patch.directorRevision,directorCheckpoint:result.patch.directorCheckpoint};
    const alreadyApplied=story=>{try{assertSource(story,applied);return true;}catch{return false;}};
    // Apply this confirmed state edit even when an unrelated dependency changed.
    if((session.directorRevision ?? 0)<=result.patch.directorRevision)session={...session,...result.patch};
    if(store.status.pending || !historyMessages || historyRevision!==result.source.historyRevision ||
      !matches(store.confirmed.session) || !matches(session) && !alreadyApplied(session))return false;
    session={...session,...result.patch};
    store.adopt({session,messages:historyMessages,turns:{...store.view.turns,[result.checkpoint.id]:result.checkpoint}},{serverConfirmed:true});
    return true;
  },{sid,owner,epoch,reconcile:true});
}
export async function dismissMemoryRebuild(sid,seenRevision,{owner=currentUid(),epoch=historyEpoch}={}) {
  const result=await saveStoryState(()=>dismissRebuild(sid,seenRevision),(saved,store)=>{
    // Preserve edits that arrived after the notice, including a newer local snapshot.
    const newer=(session.memoryInvalidations ?? []).filter(i=>i.revision>seenRevision);
    const remaining=[...new Map([...saved.memoryInvalidations,...newer].map(i=>[JSON.stringify([i.revision,i.fromOrder,i.toOrder]),i])).values()];
    session={...session,memoryInvalidations:remaining,memoryState:{...session.memoryState,...saved.memoryState,
      needsRebuild:remaining.length>0,rebuildFromOrder:remaining.length ? Math.min(...remaining.map(i=>i.fromOrder)) : null}};
    if(!historyMessages || historyRevision!==(session.historyRevision ?? 0) || saved.historyRevision!==(session.historyRevision ?? 0))return false;
    store.adopt({session,messages:historyMessages,turns:store.view.turns},{serverConfirmed:true});
    return true;
  },{sid,owner,epoch});
  if(owner!==currentUid() || sid!==state.sessionId || epoch!==historyEpoch)return result;
  saveLocalCache(owner,sid,chatSnapshot());
  updateMemoryChip();
  document.dispatchEvent(new CustomEvent('memory-refresh',{detail:{sessionId:sid}}));
  return result;
}
function applyLocalChange(token,result,mutate) {
  assertActive(token);
  if(result.summaryReset && !result.session)clearLocalSummary();
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
let rewriteController = null, originalDraft = null;
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
let loreReady = Promise.resolve(),loreReloading=Promise.resolve(),dataEpoch=0,loreLoadVersion=0,loreReloadVersion=0;
let verifiedLoreRevision = null;
const historyCache = new Map(); // three most recently visited sessions in memory
let cacheSaveTimer = null;
let cacheWritesPaused = false;
let refreshingStory=null;
const pendingCacheWrites = new Set();
const renderedMessages = new Map();
const expandedSummaries = new Set();

const el = {};
let refreshFloatingCopy = () => {};
const sizeComposer=createComposerSizer({input:()=>el.input,frame:fn=>requestAnimationFrame(fn)});
const dismissedStaleScenes=new Set();
let loreRetry=0,loreRetryTimer=null,loreStatus='ok';
let loreUnsub = null, loreEntries = [], loreSessionId = null, managerOpen = false;
const memoryStories = new Map();
let lastMemoryReport = null;
let lastSentContext = null;
export function memorySnapshot(sid = state.sessionId) {
  if (sid === state.sessionId && session && state.storySettings && !state.storySettingsLoadFailed) return { storyEpoch:historyEpoch,session:{...session,storySettingsRevision:state.storySettings.revision}, settings: effectiveActiveSettings(), messages:(historyMessages ?? lastMessages).filter(m=>!(session.directorAbandonedTurnIds ?? []).includes(m.directorTurnId)), historyComplete:!!historyMessages && historyRevision===(session.historyRevision ?? 0), entries: loreEntries, busy:busy || /* Disabled refresh lock: !!storyStore(sid)?.requiresReconciliation || */ !!storyStore(sid)?.status.paused || !!storyStore(sid)?.status.pending || !!storyStore(sid)?.status.error, report: lastMemoryReport, sentContext:lastSentContext, providerUsage:lastProviderUsage?.sessionId === sid ? lastProviderUsage : null };
  if(sid===state.sessionId)return null;
  const cached = memoryStories.get(sid); return cached?.owner === currentUid() ? cached : null;
}
let tokenUsageError=null;
let persistedTokenUsage=new WeakSet();
let tokenKeyMemo=null,tokenDisplayMeta=null;
function tokenContextKey(activeSettings=null) {
  if(!session || !state.settings || !state.storySettings)return null;
  const settings=activeSettings ?? effectiveActiveSettings();
  // Context-affecting settings only: never persist credentials in a cache key.
  const values=[session.historyRevision ?? 0,session.loreRevision ?? 0,state.storySettings.revision,
    session.directorRevision ?? 0,session.directorPending,session.directorCheckpoint,session.longTermPlan,
    session.activeSummaryMessageId,session.breakpointOrder,session.memory,session.memoryState?.extractedThroughOrder,
    settings.modelId,settings.narrationMode,settings.maxContextTokens,settings.modelContextTokens,settings.maxResponseTokens,
    settings.tokenCountingMode,settings.narratorSystemPrompt,settings.directorNarratorSystemPrompt,
    historyMessages?.length ?? lastMessages.length,historyMessages ? historyStartOrder : lastMessages[0]?.order];
  if(tokenKeyMemo && values.every((value,i)=>value===tokenKeyMemo.values[i]))return tokenKeyMemo.key;
  const key=tokenContextFingerprint(values);tokenKeyMemo={values,key};return key;
}
function persistTokenUsage() {
  const owner=currentUid(),sid=state.sessionId,record=tokenUsageCache.read(owner,sid);
  if(!record || persistedTokenUsage.has(record))return;
  persistedTokenUsage.add(record);
  const pending=deviceCache.saveTokenUsage?.(owner,sid,tokenUsageCache.serialize(owner,sid));
  if(pending){pendingCacheWrites.add(pending);void Promise.resolve(pending).catch(()=>{}).finally(()=>pendingCacheWrites.delete(pending));}
}
function tokenUsageChanged() {
  document.dispatchEvent(new CustomEvent('token-usage-changed',{detail:{sessionId:state.sessionId}}));
}
function tokenOwner(){try{return currentUid();}catch{return null;}}
function refreshTokenDisplayMeta() {
  const owner=tokenOwner(),sid=state.sessionId;
  if(!owner || !session || !state.settings || !state.storySettings){tokenDisplayMeta=null;return;}
  try{const settings=effectiveActiveSettings();tokenDisplayMeta={owner,sid,key:tokenContextKey(settings),max:requestInputLimit(settings)};}catch{tokenDisplayMeta=null;}
}
export function tokenUsageSnapshot() {
  // Opening the window reads this prepared metadata, never resolves settings,
  // fingerprints prompts, traverses history, or starts a calculation.
  const owner=tokenOwner();if(!owner)return {owner:null,sid:null,record:null,max:0,contextKey:null,busy:false,loading:false,error:null};
  const sid=state.sessionId,record=tokenUsageCache.read(owner,sid);
  const meta=tokenDisplayMeta?.owner===owner && tokenDisplayMeta.sid===sid ? tokenDisplayMeta : null;
  const key=meta?.key ?? null;
  return {owner,sid,record,max:meta?.max ?? record?.max ?? 0,contextKey:key,busy,loading:!!sid && (!session || !latestReady || !state.storySettings),error:tokenUsageError,
    contextChanged:!!record && key!==null && record.contextKey!==key,
    previewCached:!!key && tokenUsageCache.hasPreview(owner,sid,key),
    sentContext:record && lastSentContext?.sentAt===record.at ? lastSentContext : null};
}
export async function calculateCurrentTokenPreview() {
  if(busy || editingState)throw new Error('Finish the current reply or edit before calculating a preview.');
  const live=memorySnapshot();if(!live)throw new Error('Open a story first.');
  refreshTokenDisplayMeta();
  const owner=currentUid(),sid=state.sessionId,key=tokenContextKey(),epoch=historyEpoch;
  return tokenUsageCache.preview(owner,sid,key,async check=>{
    const built=await buildContextForRequest(live.session,live.settings,{
      messages:live.messages,loreEntries:live.entries,draftText:'',includeInspection:true,check,
    });
    let director=null,directorError=null;
    if(live.settings.narrationMode==='director'){try{director=await buildDirectorContext(live.session,live.settings,live.messages,live.entries,live.session.directorState ?? seedDirectorState(live.session,live.messages,live.entries));}catch(error){check();directorError=error.message;}}
    check();return {built,live,director,directorError,countingMethod:tokenizer.tokenizerStatus?.()==='ok' ? 'tokenizer' : 'estimate'};
  },()=>currentUid()===owner && state.sessionId===sid && historyEpoch===epoch && tokenContextKey()===key);
}
export async function prepareMemorySnapshot() {
  if (!session) throw new Error('Open a story first.');
  const sid = state.sessionId;
  await flushStory(sid);await reconcileStory();
  if (sid !== state.sessionId) throw new Error('Story changed while loading history.');
  return memorySnapshot();
}
function rememberMemoryStory() {
  if (session && anyMemory(normalizeMemory(session.memory))) memoryStories.set(session.id,{ ...memorySnapshot(),owner:currentUid() });
}
function syncLore(force=false) {
  const wanted=session && (anyMemory(normalizeMemory(session.memory)) || state.storySettings?.values?.narrationMode==='director' || managerOpen);
  if(!wanted){loreReady=Promise.resolve();return;}
  if(loreSessionId===session.id && !force)return;
  const sid=session.id,owner=currentUid(),epoch=dataEpoch,run=++loreLoadVersion,revision=session.loreRevision ?? 0;loreSessionId=sid;
  loreReady=(async()=>{
    // const cached=await loadStoryData(owner,sid);
    // Disabled: a different server revision must not invalidate initialized cached lore.
    // const entries=!force && cached?.lore?.revision===revision?cached.lore.entries:await getLore(sid);
    const snapshot=await loreStore.getLoreSnapshot(sid),entries=snapshot.entries;
    if(currentUid()!==owner || state.sessionId!==sid || epoch!==dataEpoch || run!==loreLoadVersion)return;
    loreEntries=entries;verifiedLoreRevision=snapshot.loadedRevision;loreStatus='ok';
    rememberMemoryStory();updateMemoryChip();document.dispatchEvent(new CustomEvent('lore-changed',{detail:{sessionId:sid,entries}}));void updateIndicator();
  })();
  loreReady.catch(error=>{if(currentUid()===owner && state.sessionId===sid && epoch===dataEpoch && run===loreLoadVersion){loreSessionId=null;loreStatus='error';showTransientError('Could not load lorebooks. Your draft is kept. Use Sync data to retry.');}});
}
// Fields that can change the context or the caches needed to build it.
function preparationKey(story) {
  return JSON.stringify([story?.historyRevision ?? 0,story?.loreRevision ?? 0,
    story?.storySettingsRevision ?? 0,story?.directorRevision ?? 0,story?.directorPending,story?.directorNeedsReview,story?.longTermPlan,story?.allowLlmPlanUpdates,
    story?.activeSummaryMessageId,story?.breakpointOrder,story?.memory,story?.memoryState]);
}
async function reconcileStory(token = null, forceServer = false) {
  if(!forceServer && session){const epoch=historyEpoch;await ensureLocalStory();if(epoch!==historyEpoch)throw new StaleTurn();return prepareStoryDocument(session,token);}
  const sid = state.sessionId, owner = currentUid(),epoch=dataEpoch;
  const check = () => {
    if (token) assertActive(token);
    if (currentUid() !== owner || state.sessionId !== sid || epoch!==dataEpoch) throw new StaleTurn('Account or story changed while reconciling.');
  };
  if (!sid) throw new Error('Open a story first.');
  await messagesApi.ensureContinuityMetadata(sid);check();
  const version = sessionSnapshotVersion;
  const fresh = await getSessionFromServer(sid);check();
  if (!fresh || fresh.deleting) throw new Error('Story no longer exists.');
  // A listener may have advanced while the server read was in flight.
  const newer = session && (sessionSnapshotVersion !== version ||
    (session.historyRevision ?? 0) > (fresh.historyRevision ?? 0));
  return prepareStoryDocument(newer ? session : fresh,token);
}
async function prepareStoryDocument(fresh,token = null) {
  const sid = state.sessionId, owner = currentUid(),epoch=dataEpoch, key = preparationKey(fresh);
  const check = () => {
    if (token) assertActive(token);
    if (currentUid() !== owner || state.sessionId !== sid || epoch!==dataEpoch) throw new StaleTurn('Account or story changed while loading.');
    // Disabled: unrelated revision/status changes must not cancel reply preparation.
    // if (preparationKey(session) !== key) throw new Error('Story changed while preparing the reply. Refresh and retry.');
  };
  if (!fresh || fresh.deleting) throw new Error('Story no longer exists.');
  session = fresh;
  if (historyRevision !== (fresh.historyRevision ?? 0)) historyMessages = null;
  syncLore();
  if (normalizeMemory(fresh.memory).lorebooks || normalizeMemory(fresh.memory).autoUpdate || state.storySettings?.values?.narrationMode==='director') {
    try {await loreReady;check();} catch {check();syncLore();await loreReady;check();}
    /* Disabled automatic collection reload on revision mismatch.
    if (verifiedLoreRevision !== (fresh.loreRevision ?? 0)) {
      const entries = await getLore(sid);check();
      loreEntries = entries; verifiedLoreRevision = fresh.loreRevision ?? 0;
    }
    */
  }
  check();
  await ensureHistory();check();
  if(fresh.memory?.autoUpdate && fresh.memoryState?.extractedThroughOrder==null && computeTurns(historyMessages).lastTurn<=normalizeMemory(fresh.memory).lagTurns){
    await updateSession(sid,{'memoryState.extractedThroughOrder':0});
    if(token)assertActive(token);
    if(currentUid()!==owner || state.sessionId!==sid || epoch!==dataEpoch)throw new StaleTurn('Story changed while setting memory start.');
    // Do not overwrite memory state supplied by a newer subscription.
    if(preparationKey(session)===key)session={...session,memoryState:{...session.memoryState,extractedThroughOrder:0}};
    // else if(preparationKey(session)!==preparationKey({...fresh,memoryState:{...fresh.memoryState,extractedThroughOrder:0}}))throw new Error('Story changed while setting memory start. Refresh and retry.');
  }
  rememberMemoryStory();
  return memorySnapshot();
}
function validateSavedStorySettings() {
  // Disabled: revision mismatch alone must not block generation using loaded local prompts.
  // state.storySettings.revision !== (session.storySettingsRevision ?? 0)
  if(state.storySettingsId!==state.sessionId || !state.storySettings || state.storySettingsLoadFailed) {
    throw new Error('Story prompts changed or have not loaded. Your message was saved. Refresh the story and use Retry reply.');
  }
}

function updateMemoryChip() {
  const running = memoryUpdater.isRunning(session?.id);
  const composerStatus = document.getElementById('composer-memory-status');
  if (composerStatus) composerStatus.hidden = !running;
  document.getElementById('composer-box')?.classList.toggle('memory-updating', running);
  const chip = document.getElementById('btn-memory'); if (!chip) return;chip.setAttribute('aria-controls','lorebook-overlay');chip.setAttribute('aria-expanded',String(managerOpen));
  const mem = normalizeMemory(session?.memory), pointer = session?.memoryState?.extractedThroughOrder;
  const turn = turnsFor(historyMessages ?? lastMessages).assistants.filter(a => a.order <= (pointer ?? 0)).at(-1)?.turn ?? 0;
  chip.classList.toggle('hidden', !session || !anyMemory(mem) && !loreEntries.length);
  chip.classList.toggle('running', running); chip.classList.toggle('paused', effectivelyPaused(session?.memoryState));
  const status=dueRangeStatus(historyMessages ?? lastMessages,session?.memoryState,mem);
  chip.title=session?.memoryState?.needsRebuild ? 'History edited. Re-extract from the Memory settings.' : loreStatus==='error' ? 'Lorebooks unavailable. Use Sync data to retry.' : status.reason==='pointer-unset' ? 'Memory start not set. Choose a start turn.' : status.reason==='pending' ? `Waiting for you to accept the reply at T${status.turn}.` : status.reason==='waiting' ? `${status.have} of ${status.need} turns ready (the last ${status.lag} turns wait).` : 'Memory ready to update.';
  chip.textContent = running ? 'Updating memory…' : effectivelyPaused(session?.memoryState) ? 'Memory paused' : loreStatus==='error' ? 'Lorebooks offline' : mem.autoUpdate && pointer==null ? 'Choose start' : mem.autoUpdate && turn ? 'Memory · T'+turn : 'Memory';
}


export function initChatView() {
  document.addEventListener('provider-fallback',event=>showTransientInfo('Provider unavailable. Trying '+event.detail.to+'…'));
  // Disabled automatic full Sync; reconnecting still retries pending saves.
  // document.addEventListener('visibilitychange',()=>{if(!document.hidden)requestStoryFreshness();});
  // window.addEventListener('pageshow',requestStoryFreshness);
  // window.addEventListener('focus',requestStoryFreshness);
  // window.addEventListener('online',()=>{storyStore(state.sessionId)?.retry();requestStoryFreshness();});
  window.addEventListener('online',()=>{storyStore(state.sessionId)?.retry();});
  document.addEventListener('settings-save-finished',()=>{void checkActiveStoryFreshness();});
  document.getElementById('btn-copy-diagnostics')?.addEventListener('click',async()=>{try{await copyClipboard(JSON.stringify(diagnostics({...state,session}),null,2));showTransientInfo('Diagnostics copied.');}catch(error){showTransientError(error);}});
  configureLoreWrites(sid=>flushStory(sid));
  memoryUpdater.configureMemoryUpdater({
    get: memorySnapshot, busy: () => busy || !!storyStore(state.sessionId)?.status.pending || !!storyStore(state.sessionId)?.status.error,
    prepare: async sid => { if (sid !== state.sessionId) throw new Error("Open the story before maintenance."); return reconcileStory(); },
    patch(sid, patch, entries,loreRevision) {
      const live = memorySnapshot(sid); if (!live) return;
      // The committed delta already updated lore. A write is not a full download.
      live.session = { ...live.session,...(loreRevision!=null ? {loreRevision:Math.max(live.session.loreRevision ?? 0,loreRevision)} : {}), memoryState: { ...live.session.memoryState, ...patch } };
      if (entries) live.entries = entries;
      memoryStories.set(sid,{ ...live,owner:currentUid() });
      if (sid === state.sessionId) { session = live.session; if (entries)loreEntries=entries;const local=storyStore(sid);if(local && !local.status.pending)local.adopt({session,messages:historyMessages ?? local.view.messages,turns:local.view.turns});updateMemoryChip();void updateIndicator(); }
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
    const local=storyStore(state.sessionId);if(local && !local.status.pending)local.adopt({session,messages:historyMessages ?? local.view.messages,turns:local.view.turns});
    syncLore(); rememberMemoryStory(); invalidateRenderedMessages(); renderMessages(lastMessages); void updateIndicator();
  });
  document.addEventListener('local-lore-saved',e=>{
    /* Disabled: successful writes must not reread the header and all lore cards.
    const sid=e.detail.sessionId,owner=currentUid(),epoch=dataEpoch;
    if(sid!==state.sessionId)return;
    const run=++loreReloadVersion;
    const active=()=>state.sessionId===sid && currentUid()===owner && epoch===dataEpoch && run===loreReloadVersion;
    loreReloading=(async()=>{
      await flushStory(sid);const fresh=await getSessionFromServer(sid);if(!active())return;
      session={...session,...fresh};syncLore(true);await loreReady;if(!active())return;
      const store=storyStore(sid);
      if(store && !store.status.pending)store.adopt({session,messages:historyMessages ?? store.view.messages,turns:store.view.turns});
      queueCacheSave();
    })();
    void loreReloading.catch(error=>{if(active())showTransientError(error);});
    */
    const d=e.detail;
    if(d.uid!==currentUid() || !d.snapshot)return;
    const active=d.sessionId===state.sessionId && session,remembered=memoryStories.get(d.sessionId);
    if(!active && remembered?.owner!==d.uid)return;
    const patched={...(active?session:remembered.session),loreRevision:Math.max((active?session:remembered.session).loreRevision ?? 0,d.revision ?? 0)};
    for(const [key,value]of Object.entries(d.sessionPatch ?? {})){
      const parts=key.split('.');let target=patched;
      for(const part of parts.slice(0,-1))target=target[part]={...target[part]};
      target[parts.at(-1)]=value;
    }
    if(!active){memoryStories.set(d.sessionId,{...remembered,session:patched,entries:d.snapshot.entries});return;}
    session=patched;loreEntries=d.snapshot.entries;verifiedLoreRevision=d.snapshot.loadedRevision;
    if(d.snapshot.initialized!==false)loreStatus='ok';
    const store=storyStore(d.sessionId);
    if(store && !store.status.pending && !store.status.paused)store.adopt({session,messages:historyMessages ?? store.view.messages,turns:store.view.turns});
    rememberMemoryStory();updateMemoryChip();void updateIndicator();queueCacheSave();
    document.dispatchEvent(new CustomEvent('lore-changed',{detail:{sessionId:d.sessionId,entries:loreEntries}}));
  });
  document.addEventListener('scene-preference', () => { invalidateRenderedMessages(); renderMessages(lastMessages); });
  const openViewer = () => document.dispatchEvent(new CustomEvent('context-details'));
  document.getElementById('context-indicator')?.addEventListener('click', openViewer);
  document.getElementById('btn-memory')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent(session?.memory?.autoUpdate && session?.memoryState?.extractedThroughOrder==null ? 'memory-settings' : 'lorebooks')));
  document.addEventListener('lorebook-visibility', e => { managerOpen = e.detail.open;document.getElementById('btn-memory')?.setAttribute('aria-expanded',String(managerOpen)); syncLore(); });
  document.addEventListener('memory-status', e => {
    if (e.detail.sessionId !== state.sessionId) return;
    updateMemoryChip(); document.dispatchEvent(new CustomEvent('memory-refresh'));
    const d = e.detail;
    if(d.status==='rebuild-review')document.dispatchEvent(new CustomEvent('memory-rebuild-review',{detail:d}));
    if (d.status === 'running') {
      document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: 'Extracting memory… Keep this page open.' } }));
    } else if (d.status === 'success' && (d.notes || d.manual || managerOpen)) {
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
  el.rewriteBtn=document.getElementById('btn-rewrite');el.restoreDraftBtn=document.getElementById('btn-restore-draft');
  el.rewriteBtn.addEventListener('click',handleRewrite);
  el.restoreDraftBtn.addEventListener('click',()=>{if(busy || originalDraft===null)return;setComposerText(originalDraft);clearOriginalDraft();updateRewriteControls();});
  el.input.addEventListener('input',()=>{clearOriginalDraft();updateRewriteControls();});
  document.addEventListener('sync-chat',()=>{void syncChatData();});
  document.addEventListener('upload-device-story',()=>{void openDeviceStoryUpload().catch(showTransientError);});
  el.stopBtn=document.getElementById("btn-stop");el.stopBtn.addEventListener("click",()=>{const token=busyGate.active;if(token && token.stopReady!==false)token.abort?.();});
  el.summarizeBtn = document.getElementById("btn-summarize");
  el.contextFill = document.getElementById("context-fill");
  el.contextThreshold = document.getElementById("context-threshold");
  el.contextLabel = document.getElementById("context-label");
  el.contextLabel.title = indicatorHint;
  document.getElementById('chat-sync-status')?.addEventListener('click',()=>storyStore(state.sessionId)?.retry());
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
  // (max-height: min(35% of the visual viewport, 240px)) — beyond the cap the textarea scrolls.
  const measureComposer = observeComposerInset({
    shell:document.getElementById('composer-shell'), style:document.getElementById('chat-tab').style,
    onResize:() => { if (wasNearBottom) scrollToEnd(); else clampListScroll(); },
  });
  const autoGrow = () => { sizeComposer(); measureComposer(); };
  el.input.addEventListener("input", () => { autoGrow(); });
  window.addEventListener("resize", autoGrow);
  autoGrow();

  // iOS keyboard: keep the composer right above the keyboard, not pushed far
  // above it (iOS auto-scrolls the window on focus; app.js cancels that, and
  // this compensates inside the list if the user was scrolled deep).
  el.input.addEventListener("focus", () => {
    requestAnimationFrame(() => alignFieldToKeyboard(document.getElementById("composer-box")));
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
  initMessageMenus();
  document.getElementById('jump-to-latest')?.addEventListener('click', scrollToEnd);
  refreshFloatingCopy = initFloatingCopy({list:el.list, button:document.getElementById('floating-copy'), editing:()=>!!editingState, onError:error=>showToast(error,false)}) || (()=>{});
  updateWelcome();
  initQuickControls();
  initPetView();
}

// ---------- inline model / thinking selectors (composer) ----------

// Saved connections are shared; Director mode can select both roles per story.
const storyRoleProfiles=()=>state.storySettings?.values?.narrationMode==='director' || !!state.storySettings?.values?.narratorProfileId;
async function saveQuickRoleProfile(key,value) {
  try{
    if(busy)throw new Error('Finish the current reply before changing profiles.');
    if(!state.sessionId || state.storySettingsId!==state.sessionId || !state.storySettings || state.storySettingsLoadFailed)throw new Error('Story settings have not loaded.');
    if(!value && key==='directorProfileId')throw new Error('Choose a Director profile.');
    if(value && !state.settings.profiles.some(p=>p.id===value))throw new Error('Choose an existing profile.');
    await saveStorySettings(state.sessionId,state.storySettings.values,{[key]:value});
  }catch(error){showTransientError(error.message);}
  refreshQuickControls();
}
function initQuickControls() {
  el.quickProfile = document.getElementById("quick-profile");
  el.quickDirector = document.getElementById('quick-director-profile');
  el.quickThinking = document.getElementById("quick-thinking");
  el.quickDirector.addEventListener('change',()=>saveQuickRoleProfile('directorProfileId',el.quickDirector.value));

  el.quickProfile.addEventListener("change", async () => {
    if(storyRoleProfiles())return saveQuickRoleProfile('narratorProfileId',el.quickProfile.value);
    const s = structuredClone(state.settings);
    if (!s) return;
    s.activeProfileId = el.quickProfile.value;
    normalizeProfiles(s);
    mirrorFromActiveProfile(s); // load the chosen profile's connection fields
    try {await saveSettings(s);}catch(error){showTransientError(error.message);refreshQuickControls();}
  });

  el.quickThinking.addEventListener("change", async () => {
    const s = structuredClone(state.settings);
    if (!s) return;
    const selected=state.storySettings?.values?.narratorProfileId;
    let connection;
    try{connection=resolveModelProfile(s,selected,{role:'Narrator'});}catch(error){showTransientError(error.message);refreshQuickControls();return;}
    const v = el.quickThinking.value;
    if (v === "off") {
      connection.reasoning = { ...connection.reasoning, enabled: false };
    } else if (v === "max_tokens") {
      connection.reasoning = { ...connection.reasoning, enabled: true, mode: "max_tokens" };
    } else {
      connection.reasoning = { ...connection.reasoning, enabled: true, mode: "effort", effort: v };
    }
    normalizeProfiles(s);
    if(selected && selected!==s.activeProfileId)s.profiles.find(p=>p.id===selected).reasoning=connection.reasoning;
    else{s.reasoning=connection.reasoning;mirrorToActiveProfile(s);}
    try {await saveSettings(s);}catch(error){showTransientError(error.message);refreshQuickControls();}
  });

  document.addEventListener('story-settings-changed',async e=>{const sid=state.sessionId;if(e.detail?.sessionPatch){await chatLoading;if(sid!==state.sessionId)return;}if(session && state.storySettings){session={...session,...e.detail?.sessionPatch,storySettingsRevision:state.storySettings.revision};const local=storyStore(state.sessionId);if(local && !local.status.pending)local.adopt({session,messages:historyMessages ?? local.view.messages,turns:local.view.turns});}refreshQuickControls();refreshContextIndicator();});
  document.addEventListener("settings-changed", refreshQuickControls);
  document.addEventListener("settings-changed", updateIndicator);
  refreshQuickControls();
}

function fillQuickProfileSelect(s) {
  if (!s) return;
  el.quickProfile.replaceChildren(
    ...s.profiles.map((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${storyRoleProfiles()?'Narrator · ':''}${p.modelId || 'No model'} · ${p.name}`;
      return o;
    })
  );
  if(storyRoleProfiles()){
    const option=document.createElement('option');option.value='';option.textContent='Narrator · Active profile';el.quickProfile.replaceChildren(option,...Array.from(el.quickProfile.children));
    const id=state.storySettings.values.narratorProfileId ?? '';
    if(id&&!s.profiles.some(p=>p.id===id)){const missing=document.createElement('option');missing.value=id;missing.textContent='Missing Narrator profile';el.quickProfile.append(missing);}el.quickProfile.value=id;
  }else el.quickProfile.value = s.activeProfileId;
}

function quickThinkingValue(s) {
  const r = s?.reasoning;
  if (!r?.enabled) return "off";
  return r.mode === "max_tokens" ? "max_tokens" : r.effort ?? "medium";
}

function refreshQuickControls() {
  const s = state.settings;
  if (!s) return;
  normalizeProfiles(s);
  let connection=s;
  try{connection=resolveModelProfile(s,state.storySettings?.values?.narratorProfileId,{role:'Narrator'});}catch{}
  const p = activeProfile(connection);
  fillQuickProfileSelect(s);
  el.quickThinking.value = quickThinkingValue(connection);
  el.quickProfile.title = p?.name
    ? `Narrator: ${p.name} · ${connection.modelId || "no model"}`
    : connection.modelId || "Model not set";
  const thinkingMode = quickThinkingValue(connection);
  const thinkingLabel = `Thinking: ${Array.from(el.quickThinking.options || []).find(option=>option.value===thinkingMode)?.textContent || thinkingMode}`;
  el.quickThinking.title = thinkingLabel;
  el.quickThinking.setAttribute('aria-label', thinkingLabel);
  const thinkingGlyph = document.getElementById('quick-thinking-icon');
  if (thinkingGlyph) {
    thinkingGlyph.innerHTML = thinkingIcon(thinkingMode);
    thinkingGlyph.parentElement?.setAttribute('title', thinkingLabel);
  }
  const director=state.storySettings?.values?.narrationMode==='director',id=state.storySettings?.values?.directorProfileId ?? '';
  document.getElementById('quick-director-control').classList.toggle('hidden',!director);
  el.quickDirector.replaceChildren();
  const choice=document.createElement('option');choice.value='';choice.textContent='Director · Choose profile';el.quickDirector.append(choice);
  for(const profile of s.profiles){const option=document.createElement('option');option.value=profile.id;option.textContent='Director · '+(profile.name || profile.modelId);el.quickDirector.append(option);}
  if(id&&!s.profiles.some(p=>p.id===id)){const missing=document.createElement('option');missing.value=id;missing.textContent='Missing Director profile';el.quickDirector.append(missing);}el.quickDirector.value=id;
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
  tokenUsageCache.cancelPending(owner,state.sessionId);
  clearChatRetry();chatRetry=0;chatStatus='ok';
  indicatorRefresh.invalidate();clearTimeout(loreRetryTimer);loreRetry=0;loreStatus='ok';
  loreUnsub?.(); loreUnsub = null; loreSessionId = null; loreEntries = []; lastMemoryReport = null; lastSentContext = null; lastProviderUsage = null; tokenUsageError=null;tokenDisplayMeta=null;
  msgUnsub?.();
  sessUnsub?.();
  msgUnsub = sessUnsub = null;
  const loadEpoch=++dataEpoch;++loreLoadVersion;loreReloading=Promise.resolve();
  state.sessionId = sessionId;syncStatus={pending:0,error:null,durable:true};updateSyncStatus();
  storySettingsReady=selectStorySettings(sessionId);void storySettingsReady.catch(error=>showTransientError(error.message));
  session = null;
  streamState = null;
  editingState = null;clearOriginalDraft();
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
  expandedSummaries.clear();
  indicatorRefresh.invalidate();
  el.list.innerHTML = "";
  const emptyRing = contextRingPresentation({used:0, max:0});
  el.contextFill.style.strokeDasharray = emptyRing.dash;
  el.contextFill.style.stroke = emptyRing.color;
  el.contextLabel.textContent = "No session selected";
  document.getElementById('context-indicator').setAttribute('aria-label', 'View context: No session selected');
  document.getElementById('context-indicator').title = 'No session selected';
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session: null } }));
  updateWelcome();
  updateMemoryChip();
  if (!sessionId) return true;
  const unsavedVersion=unsavedRevisions.get(unsavedKey(owner,sessionId)) ?? 0;
  void loadUnsavedReply(owner,sessionId).then(reply=>{if(reply && (unsavedRevisions.get(unsavedKey(owner,sessionId)) ?? 0)===unsavedVersion && !unsavedReplies.has(unsavedKey(owner,sessionId)))unsavedReplies.set(unsavedKey(owner,sessionId),reply);if(state.sessionId===sessionId && currentUid()===owner)renderUnsavedReply();});
  el.contextLabel.textContent = "Loading chat…";
  document.getElementById('context-indicator').setAttribute('aria-label', 'View context: Loading chat');
  if (cachedHistory) {
    restoreCachedChat(sessionId, cachedHistory);
    subscribeChat(sessionId);
    return true;
  }
  void loadChatCache(currentUid(), sessionId).then((saved) => {
    if (state.sessionId !== sessionId || currentUid() !== owner || loadEpoch!==dataEpoch) return;
    if(saved?.tokenUsage)tokenUsageCache.restore(owner,sessionId,saved.tokenUsage);
    if (saved?.session && Array.isArray(saved.recent)) {
      historyCache.set(currentUid()+':'+sessionId, saved);
      if (historyCache.size > 3) historyCache.delete(historyCache.keys().next().value);
      restoreCachedChat(sessionId, saved);
      subscribeChat(sessionId);
    } else {
      subscribeChat(sessionId);
    }
  }).catch(() => {
    if (state.sessionId === sessionId && owner===currentUid() && loadEpoch===dataEpoch) subscribeChat(sessionId);
  });
  return true;
}

function chatSnapshot() {
  const local=storyStore(state.sessionId);
  if(local?.status.pending){const base=local.confirmed;return structuredClone({tokenUsage:tokenUsageCache.serialize(currentUid(),state.sessionId),session:base.session,recent:base.messages.slice(-Math.max(visibleCount,PAGE_SIZE)),hasEarlier:false,history:base.messages,historyRevision:base.session.historyRevision ?? 0});}
  return structuredClone({ tokenUsage:tokenUsageCache.serialize(currentUid(),state.sessionId),session, recent: lastMessages, hasEarlier, history: historyMessages,historyRevision });
}

function saveLocalCache(owner, sid, snapshot) {
  if (cacheWritesPaused || refreshingStory?.owner===owner && refreshingStory.sid===sid) return;
  const pending = saveChatCache(owner, sid, snapshot);
  pendingCacheWrites.add(pending);
  void pending.then(() => pendingCacheWrites.delete(pending), error => {
    pendingCacheWrites.delete(pending);
    console.error('Could not save chat cache:', error);
  });
}

export async function prepareChatLogout() {
  void selectStorySettings(null);
  cacheWritesPaused = true;indicatorRefresh.invalidate();clearChatRetry();
  clearTimeout(cacheSaveTimer); cacheSaveTimer = null;
  busyGate.active?.abort?.();
  rewriteController?.abort();
  memoryUpdater.stopAll();
  historyCache.clear(); memoryStories.clear();tokenUsageCache.clear();persistedTokenUsage=new WeakSet();tokenKeyMemo=null;tokenDisplayMeta=null;closeStoryStores();
  await Promise.allSettled([...pendingCacheWrites]);
}

function queueCacheSave() {
  if (cacheWritesPaused) return;
  const scheduledSid=state.sessionId,scheduledOwner=currentUid();
  if(refreshingStory?.owner===scheduledOwner && refreshingStory.sid===scheduledSid)return;
  if (!session || !latestReady) return;
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    if(cacheWritesPaused || state.sessionId!==scheduledSid || currentUid()!==scheduledOwner)return;
    saveLocalCache(scheduledOwner, scheduledSid, chatSnapshot());
  }, 1000);
}

function restoreCachedChat(sessionId, saved) {
  if(saved.tokenUsage)tokenUsageCache.restore(currentUid(),sessionId,saved.tokenUsage);
  session = saved.session;
  syncLore(); rememberMemoryStory();
  historyMessages = saved.history ?? null;
  // A single history read may finish after newer metadata; retain its own revision.
  historyRevision = Object.hasOwn(saved,'historyRevision') ? saved.historyRevision : saved.session.historyRevision ?? 0;
  hasEarlier = saved.hasEarlier;
  latestReady = true;
  renderMessages(saved.recent);
  document.dispatchEvent(new CustomEvent("session-changed", { detail: { sessionId, session } }));
  updateIndicator();
  queueCacheSave(); // refresh recency for the three-entry device cache
}

function subscribeChat(sessionId) {
  const owner=currentUid(),epoch=historyEpoch;
  const active=()=>state.sessionId===sessionId && currentUid()===owner && epoch===historyEpoch;
  msgUnsub?.();sessUnsub?.();msgUnsub=sessUnsub=null;
  chatLoading=(async()=>{
    await storySettingsReady;if(!active())return;
    const [outbox,aux]=await Promise.all([storyQueueStorage.load(owner,sessionId),loadStoryData(owner,sessionId)]);
    if(!active())return;
    const recovered=outbox?.base ?? aux?.confirmed;
    if(recovered && (outbox || !session || (recovered.session.historyRevision ?? 0)>(session.historyRevision ?? 0))){session=recovered.session;historyMessages=recovered.messages;historyRevision=session.historyRevision ?? 0;lastMessages=historyMessages.slice(-PAGE_SIZE);hasEarlier=false;latestReady=true;}
    if(!session){await messagesApi.ensureContinuityMetadata(sessionId);if(!active())return;session=await getSessionFromServer(sessionId);if(!active())return;if(!session || session.deleting)throw new Error('Story no longer exists.');}
    if(session.storageVersion!==2 || session.continuityVersion!==2 || session.lookupVersion!==1){await messagesApi.ensureContinuityMetadata(sessionId);if(!active())return;session=await getSessionFromServer(sessionId);if(!active())return;historyMessages=null;historyRevision=null;}
    latestReady=true;syncLore();
    await ensureLocalStory();if(!active())return;
    // if(refreshOnReload){refreshOnReload=false;await refreshStoryFromServer();if(!active())return;}
    document.dispatchEvent(new CustomEvent('session-changed',{detail:{sessionId,session}}));
    void updateIndicator();
  })().catch(error=>{if(active())showTransientError(error);}).finally(()=>{if(active())requestStoryFreshness();});
}

export function forgetChatSession(sessionId) {
  forgetStoryStore(sessionId);
  memoryUpdater.stop(sessionId); memoryStories.delete(sessionId);clearUnsaved(currentUid(),sessionId);
  historyCache.delete(currentUid()+':'+sessionId);
  void deleteChatCache(currentUid(), sessionId);
  void loreStore.forgetLoreCache(currentUid(),sessionId);
}

// ---------- rendering ----------

let lastMessages = [];

function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) { const previous = byId.get(m.id); if (!previous || (m.revision ?? 0) >= (previous.revision ?? 0)) byId.set(m.id, m); }
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
    // Disabled repeated bulk downloads: for (let attempt = 0; attempt < 4; attempt++) {
    {
      const revision = session?.historyRevision ?? 0;
      const messages = await messagesApi.getMessages(sessionId);
      checkScope();
      // A subscription or a local save may arrive while the read is in flight.
      // Keep a newly bridged/loaded cache if it already matches that revision;
      // otherwise keep this single read tagged with its captured revision.
      if (revision !== (session?.historyRevision ?? 0)) {
        if (historyMessages && historyRevision === (session?.historyRevision ?? 0)) return historyMessages;
        // continue; // Disabled: retain the single fetched history instead of downloading again.
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
    // throw new Error('History is updating repeatedly. Try again after the current writes finish.');
  })().finally(() => {
    // A session switch can start another read before this one settles.
    if (historyLoading === pending) {historyLoading = null;updateRewriteControls();}
  });
  historyLoading = pending;
  updateRewriteControls();
  return pending;
}

function applySummaryResult(result) {
  if(result?.lintWarnings?.length)showTransientInfo(`Summary has ${result.lintWarnings.length} suspect lines — review it in the summary editor.`);
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

function sameHistoryRendering(a,b) {
  return a===b || !!a && a.length===b.length && a.every((m,i)=>m===b[i] ||
    m.id===b[i].id && m.order===b[i].order && m.narratorTurn===b[i].narratorTurn && m.planThread===b[i].planThread && sameRenderedMessage(m,b[i]));
}
function renderMessages(msgs) {
  const savedStream = streamState?.savedId && msgs.some(m => m.id === streamState.savedId) ? streamState : null;
  // Optimistic store snapshots may arrive before saveNarration returns. Keep
  // the stream until finalization instead of laying out two full-size replies.
  if(savedStream && !savedStream.saveCompleted){lastMessages=msgs;return;}
  const position = captureListPosition();
  const renderHistory=historyMessages ?? msgs;
  const timeline=timelineFor(renderHistory,session?.memory?.startingScene);
  const lastUserOrder=lastUserOrderOf(renderHistory);
  const latestAssistant=renderHistory.filter(m => m.role==='assistant').at(-1)?.id;
  const latestStory = msgs.filter(m => m.role !== 'summary').at(-1);
  const turnLabels=anyMemory(normalizeMemory(session?.memory)) ? turnsFor(renderHistory).turnById : null;
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
  el.list.querySelectorAll('.checkpoint-divider').forEach(node=>node.remove());
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
    if(streamState?.continuationId===m.id && !streamState.saveCompleted){anchor=streamState.wrap;continue;}
    let entry = renderedMessages.get(m.id);
    const turnLabel=turnLabels?.get(m.id) ?? null;
    const sceneState=timeline.get(m.id),renderedScene=sceneState?.effective;
    const pending=m.id===latestAssistant && !isAcceptedTurn(m,{lastUserOrder,sceneOn:session?.memory?.scene === true});
    const retry = m.role === 'user' && m.id === latestStory?.id;
    const activeSummary=isActiveSummary(m);
    if (!entry || !entry.message || entry.activeSummary!==activeSummary || entry.retry !== retry || entry.turnLabel!==turnLabel || entry.renderedScene!==renderedScene || entry.pending!==pending || !sameRenderedMessage(entry.message, m)) {
      const node = renderMessage(m, retry, sceneState, pending);
      node.dataset.messageId = m.id;
      const replaced=entry?.node?.parentNode===el.list ? entry.node
        : savedStream?.saveCompleted && savedStream.savedId===m.id && savedStream.wrap.parentNode===el.list ? savedStream.wrap : null;
      if(replaced){
        replaced.replaceWith(node);
        if(anchor===replaced)anchor=node.nextSibling;
      }
      entry = { node, message: m, retry, turnLabel, renderedScene, pending, activeSummary };
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
  renderCheckpointDivider(renderHistory,visible);
  renderUnsavedReply();
  updateWelcome();
  if (savedStream && renderedMessages.has(savedStream.savedId)) {
    if (savedStream.saveCompleted) {
      if (savedStream.frame) cancelAnimationFrame(savedStream.frame);
      savedStream.wrap.remove(); streamState = null;
    }
    restoreListPosition(position, savedStream.saveCompleted ? savedStream.savedId : undefined);
    refreshPetPlacement();
  } else restoreListPosition(position);
  queueCacheSave();
  updateRewriteControls();
}

function renderCheckpointDivider(history,visible) {
  const breakpoint=session?.breakpointOrder ?? 0,summaryId=session?.activeSummaryMessageId;
  if(!summaryId || breakpoint<=0 || history.find(m=>m.id===summaryId)?.retired)return;
  const firstRetained=history.find(m=>m.role!=='summary' && m.order>breakpoint);
  // Do not place a misleading breakpoint in the middle of a paginated window.
  const target=firstRetained ? visible.find(m=>m.id===firstRetained.id) : visible.find(m=>m.order>breakpoint);
  if(!target)return;
  const row=renderedMessages.get(target.id)?.node;if(!row)return;
  const covered=history.filter(m=>m.role==='assistant' && m.order<=breakpoint).at(-1);
  const turn=covered && turnsFor(history).turnById.get(covered.id);
  const divider=document.createElement('div');divider.className='checkpoint-divider';
  divider.setAttribute('role','separator');
  const label='Current checkpoint · summarized through '+(turn?'T'+turn:'message #'+breakpoint);
  divider.setAttribute('aria-label',label);divider.textContent=label;
  el.list.insertBefore(divider,row);
}

export function sameRenderedMessage(a,b) {
  return a.directorTurnId===b.directorTurnId && a.directorIncomplete===b.directorIncomplete && a.retired===b.retired && a.role===b.role && a.content===b.content && a.thinking===b.thinking && a.scene===b.scene &&
    (a.revision ?? 0)===(b.revision ?? 0) && a.acceptance===b.acceptance &&
    Boolean(a.editedAt)===Boolean(b.editedAt) && Boolean(a.ooc)===Boolean(b.ooc) && Boolean(a.truncated)===Boolean(b.truncated) &&
    JSON.stringify(a.planJump ?? null)===JSON.stringify(b.planJump ?? null) &&
    JSON.stringify(a.sceneMeta ?? null)===JSON.stringify(b.sceneMeta ?? null) && JSON.stringify(a.sceneCandidate ?? null)===JSON.stringify(b.sceneCandidate ?? null) &&
    (a.reviewWarnings ?? []).join('\n')===(b.reviewWarnings ?? []).join('\n');
}
let timelineMemo={src:null,start:null,value:null};
function timelineFor(messages,start){if(!sameHistoryRendering(timelineMemo.src,messages) || timelineMemo.start!==start)timelineMemo={src:messages,start,value:sceneTimeline(messages,{startingScene:start})};timelineMemo.src=messages;return timelineMemo.value;}
let turnsMemo={src:null,value:null};
export function turnsFor(list) { if (!sameHistoryRendering(turnsMemo.src,list)) turnsMemo={src:list,value:computeTurns(list)}; turnsMemo.src=list;return turnsMemo.value; }

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
  updateMessageControls();
  refreshPetPlacement();
}

function renderMessage(m, retry = false, sceneState = null, pending = false) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const label = document.createElement("span");
  label.textContent =
    m.role === "user" ? "You" : m.role === "summary" ? (m.retired ? "Retired summary" : isActiveSummary(m) ? "Current summary checkpoint" : "Summary checkpoint") : "Assistant";
  if (m.role !== 'summary' && anyMemory(normalizeMemory(session?.memory))) label.textContent += ' · T'+(turnsFor(historyMessages ?? lastMessages).turnById.get(m.id) ?? '?');
  if (m.editedAt) label.textContent += " (edited)";
  if (m.truncated) label.textContent += " · cut off";
  meta.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "msg-actions msg-header-actions";
  if (m.role === "user" || m.role === "assistant") {
    const createCopy = actionBtn("Create story copy", "create-copy", async () => {
      if (busy || state.busy || createCopy.disabled) return;
      const sourceId = state.sessionId;
      createCopy.disabled = true;
      createCopy.textContent = "Creating…";
      try {
        await flushStory(sourceId);const newId = await duplicateSession(sourceId, null, m.id);
        if (state.sessionId === sourceId && setSession(newId)) {
          document.dispatchEvent(new CustomEvent("sidebar:close"));
        }
      } catch (error) {
        showTransientError("Copy failed: " + (error.message || error));
      } finally {
        createCopy.disabled = false;
        createCopy.textContent = "Create story copy";
      }
    });
    createCopy.title = "Create a new session with settings and all messages through this message";
    actions.appendChild(createCopy);
  }

  if (m.role === "user" || m.role === "assistant" || m.role === "summary") {
    actions.appendChild(actionBtn("Edit", null, () => startEdit(m, wrap)));
    if(m.role==='assistant' && m.directorTurnId)actions.appendChild(actionBtn('Re-plan',()=>{if(!busy)void regenerateMessage(m,true);}));
  }
  actions.appendChild(actionBtn("Delete", "del", async () => {
    if (busy) return;
    if ((isFolded(m) || isActiveSummary(m)) && !confirm('Deleting this will invalidate the summary. The next summary must rebuild it from history. Continue?')) return;
    if (!confirm("Delete this message permanently?")) return;
    try {
      const store=await ensureLocalStory();
      if(m.directorTurnId && store.view.session.directorCheckpoint===m.directorTurnId){let id=m.directorTurnId,steps=0;while(id && steps++<100){const turn=await store.getTurn(state.sessionId,id);if(!turn || turn.assistantId!==m.id)break;id=turn.previousCheckpoint;}}
      store.enqueue('delete',{id:m.id,order:m.order});reconcileDeletedMemory(m);
    }catch(error){showTransientError(error);}
  }));
  if (retry) actions.appendChild(actionBtn('Retry reply', 'retry', () => retryReply(m)));
  if (m.role === "assistant") {
    actions.appendChild(actionBtn("Regenerate", "regen", () => {
      if (busy) return;
      void regenerateMessage(m);
    }));
  }
  wrap.appendChild(meta);

  if (m.role === "assistant" && m.thinking) {
    wrap.appendChild(buildThinking(m.thinking, false));
  }

  const content = document.createElement("div");
  content.className = "msg-content";
  content.textContent = m.content;
  if(m.role==='summary'){
    const details=document.createElement('details');details.className='summary-details';details.open=expandedSummaries.has(m.id);
    const toggle=document.createElement('summary');toggle.textContent=details.open?'Hide summary':'Show summary';
    details.addEventListener('toggle',()=>{
      if(wrap.parentNode!==el.list)return;
      if(details.open)expandedSummaries.add(m.id);else expandedSummaries.delete(m.id);
      toggle.textContent=details.open?'Hide summary':'Show summary';
    });
    details.append(toggle,content);wrap.appendChild(details);
  }else wrap.appendChild(content);
  if(m.role==='user' && m.planJump){const note=document.createElement('p');note.className='muted';note.textContent='Confirmed time skip: '+m.planJump.from+' → '+m.planJump.to;wrap.append(note);}
  if (pending) {
    const review = document.createElement('div');review.className = 'muted';
    review.textContent = 'Needs review: '+(m.reviewWarnings?.length ? m.reviewWarnings : lintPlayerAgency(m.content,normalizeMemory(session?.memory).protagonist)).join(' ')+' Memory and summaries wait for acceptance.';
    const accept=actionBtn('Accept reply',()=>historyAction('accept',async token=>{
      await flushStory(token.sid);assertActive(token);const result=await messagesApi.acceptMessage(token.sid,m.id,m.order,m.revision ?? 0);
      applyLocalChange(token,result,list=>list.map(x=>x.id===m.id ? result.replacement : x));renderMessages(lastMessages);void updateIndicator();
    }));
    if (m.sceneCandidate?.scene) { const candidate=document.createElement('p'); candidate.textContent=m.sceneCandidate.scene;review.append(candidate); }
    review.append(accept,actionBtn('Regenerate',() => { if (!busy) void regenerateMessage(m); }));wrap.append(review);
  }

  if (m.role==='assistant' && m.reviewWarnings?.length) { const note=document.createElement('p');note.className='muted';note.textContent='Note: '+m.reviewWarnings.join(' ');wrap.append(note); }
  const latestNarrative=(historyMessages ?? lastMessages).filter(x=>x.role==='assistant' && !x.ooc).at(-1)?.id;
  const staleKey=state.sessionId+':'+m.id+':'+(m.revision ?? 0);
  const confirmStale=m.id===latestNarrative && sceneState?.missingStreak>=2 && !dismissedStaleScenes.has(staleKey);
  if (m.role === 'assistant' && !m.ooc && normalizeMemory(session?.memory).scene && (getPref('nera.memory.showScene') !== '0' || confirmStale)) {
    const chip = document.createElement('button'); chip.className = 'scene-chip'; chip.type = 'button'; chip.textContent = sceneState?.effective ? formatSceneForDisplay(sceneState.effective) : '+ Add scene'; chip.title = 'Edit scene line';
    if (!sceneState?.own && sceneState?.effective) chip.textContent += ' (carried forward · stale)';
    if (m.sceneMeta?.kind === 'inferred') chip.textContent += ' (inferred)';
    if (m.sceneMeta?.provenance?.time === 'declared') chip.textContent += ' (model-declared time)';
    let staleNotice=null;
    if(confirmStale){staleNotice=document.createElement('div');staleNotice.className='scene-stale-confirm';const label=document.createElement('span');label.textContent='Scene is stale after '+sceneState.missingStreak+' replies. ';staleNotice.append(label,actionBtn('Confirm scene',()=>chip.click()),actionBtn('Dismiss',()=>{dismissedStaleScenes.add(staleKey);staleNotice.remove();}));wrap.append(staleNotice);}
    chip.addEventListener('click', () => {
      staleNotice?.remove();
      const row = document.createElement('div'), field = document.createElement('input'); field.value = sceneState?.effective ?? ''; field.maxLength = MAX_SCENE_LENGTH;
      const save = actionBtn('Save', async () => {
        const token=acquireBusy('scene');if(!token){showTransientInfo('Wait for the current reply to finish.');return;}save.disabled=true;
        try {
          const raw = field.value.trim() || null;
          await saveStoryState(confirmed=>messagesApi.updateMessageScene(token.sid,m.id,m.order,raw,sceneState,{session:confirmed.session}),applySceneSave,{token});
        } catch (e) {if(!(e instanceof StaleTurn))showTransientError(e);} finally {save.disabled=false;releaseBusy(token);}
      });
      row.append(field, save, actionBtn('Cancel', () => row.replaceWith(chip))); chip.replaceWith(row); field.focus();
    }); wrap.append(chip);
  }
  const copy = actionBtn('Copy', 'copy message-copy', () => copyDisplayedMessage(wrap, copy).catch(error=>showToast(error,false)));
  setIcon(copy, 'copy', 'Copy');
  copy.addEventListener('pointerdown', event => event.preventDefault());
  const menu = messageMenu([...actions.children]);
  actions.replaceChildren(copy, menu);
  meta.appendChild(actions);
  wrap.dataset.copyReady = 'true';
  attachHoldToCopy(wrap, () => content.innerText ?? content.textContent);
  return wrap;
}

function actionBtn(text, cls, onClick) {
  // Tolerate a 2-arg call: actionBtn("Edit", () => …) — callback shifts into `cls`.
  if (typeof cls === "function") { onClick = cls; cls = null; }
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (cls) b.className = cls;
  if(cls==='retry')b.hidden=busy;
  b.addEventListener("click", (e) => { e.stopPropagation(); if(!b.disabled)return onClick?.(); });
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

async function startEdit(m, wrap) {
  if (busy) return;
  const details=wrap.querySelector('.summary-details');
  if(details){details.open=true;expandedSummaries.add(m.id);details.querySelector('summary').textContent='Hide summary';}
  const contentEl = wrap.querySelector(".msg-content");
  if (!contentEl || editingState) return;
  const source = {sid:state.sessionId, owner:currentUid(), epoch:historyEpoch};
  const wrapRect = wrap.getBoundingClientRect(), contentRect = contentEl.getBoundingClientRect();
  const meta = wrap.querySelector(".msg-meta"), actions = wrap.querySelector(".msg-actions");
  const scrollTop = el.list.scrollTop;
  wrap.style.width = wrapRect.width + "px";
  wrap.style.height = "";
  meta.style.height = meta.getBoundingClientRect().height + "px";
  wrap.classList.add('editing');
  const ta = document.createElement("textarea");
  ta.className = "msg-editor"; ta.value = m.content; ta.rows = 1;
  ta.setAttribute('aria-label', 'Edit message');
  ta.setAttribute('autocomplete', 'off'); ta.setAttribute('inputmode', 'text');
  ta.setAttribute('enterkeyhint', 'enter'); ta.setAttribute('autocapitalize', 'sentences');
  ta.spellcheck = true; ta.style.height = contentRect.height + "px";
  const status = document.createElement('div'); status.className = 'msg-edit-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const editor = editingState = {id:m.id, ta, base:m, ready:false};
  const active = () => editingState === editor && source.sid === state.sessionId && source.owner === currentUid() && source.epoch === historyEpoch;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(contentRect.height, ta.scrollHeight) + 'px'; };
  const rememberFresh = fresh => {
    lastMessages = lastMessages.map(item => item.id === fresh.id ? fresh : item);
    if (!sameRenderedMessage(m, fresh)) {
      historyMessages = null; historyRevision = null; historyCache.delete(source.owner+':'+source.sid);
    }
    queueCacheSave();
  };
  const finish = () => {
    if (!active()) return;
    editingState = null; clearOriginalDraft();
    const entry = renderedMessages.get(m.id); if (entry) entry.message = null;
    renderMessages(lastMessages);
    refreshFloatingCopy(); void updateIndicator();void checkActiveStoryFreshness();
  };
  const loadLatest = async () => {
    // Keep the field editable after gesture-time focus so iOS keeps its keyboard.
    save.disabled = true; status.textContent = 'Loading latest message…';
    try {
      const store=await ensureLocalStory();
      const fresh = store.view.messages.find(item=>item.id===m.id);
      if (!active()) return false;
      if (!fresh) throw new Error('This message was deleted. Cancel to return to the conversation.');
      // A draft typed after a failed read must not silently overwrite a change.
      if (ta.value !== editor.base.content && fresh.content !== editor.base.content) { conflict(fresh); return false; }
      if (ta.value === editor.base.content) ta.value = fresh.content;
      editor.base = fresh; editor.ready = true; rememberFresh(fresh);
      status.textContent = fresh.content !== m.content ? 'Latest version loaded.' : '';
      fit(); return true;
    } catch (error) {
      if (active()) status.textContent = friendlyError(error) + ' Your draft is kept. Save will retry loading.';
      return false;
    } finally { if (active()) { save.disabled = !editor.ready && status.querySelector('details') !== null; } }
  };
  const conflict = fresh => {
    editor.ready = false; rememberFresh(fresh);
    status.textContent = 'This message changed while you were editing. Your draft is kept.';
    const preview = document.createElement('details'), heading = document.createElement('summary'), body = document.createElement('div');
    heading.textContent = 'Latest saved version'; body.className = 'msg-edit-latest'; body.textContent = fresh.content; preview.append(heading, body);
    const useLatest = actionBtn('Use latest', () => { editor.base = fresh; editor.ready = true; ta.value = fresh.content; status.replaceChildren(); save.disabled = false; fit(); ta.focus({preventScroll:true}); });
    const keepDraft = actionBtn('Keep my draft over latest', () => { editor.base = fresh; editor.ready = true; status.textContent = 'Your draft is ready to replace the latest version. Press Save to confirm.'; save.disabled = false; });
    status.append(preview, useLatest, keepDraft); save.disabled = true;
  };
  const save = actionBtn("Save", "small", async () => {
    if (!active() || save.disabled) return;
    if (!editor.ready && !await loadLatest()) return;
    if (!active()) return;
    if(busy){status.textContent='Wait for the current reply to finish.';return;}
    save.disabled = true; cancel.disabled = true; status.textContent = 'Saving…';
    let conflicted = false;
    try {
      const store=await ensureLocalStory();if(!active())return;
      store.enqueue('edit',{id:m.id,order:editor.base.order,content:ta.value,expectedRevision:editor.base.revision ?? 0});
      finish();
    } catch (error) {
      if (!active()) return;
      if (error.name === 'MessageEditConflict' && error.currentMessage) { conflict(error.currentMessage); conflicted = true; }
      else status.textContent = friendlyError(error) + ' Your draft is kept. Try Save again.';
    } finally {
      if (active()) { save.disabled = conflicted; cancel.disabled = false; }
    }
  });
  const cancel = actionBtn("Cancel", "small", finish);
  save.classList.add("btn"); cancel.classList.add("btn");
  // Keep editor saving and feedback together below the draft.
  actions.classList.remove('msg-header-actions');
  wrap.appendChild(actions);
  actions.replaceChildren(save, cancel); contentEl.replaceWith(ta);
  wrap.insertBefore(status, actions);
  fit(); ta.addEventListener('input', fit);
  refreshFloatingCopy(); updateRewriteControls();
  ta.focus({preventScroll:true}); el.list.scrollTop = scrollTop;
  await loadLatest();
}

// ---------- hold-to-copy ----------

// Long-press (mobile) / mouse-hold on a message copies its text to the
// clipboard and shows a toast. A >10px finger movement (scrolling) cancels it.
function attachHoldToCopy(target, getText) {
  const HOLD_MS = 500;
  let holding = false;   // press in progress
  let eligible = false;  // held ≥ HOLD_MS without scrolling
  let startX = 0, startY = 0, holdTimer = null;

  const cancel = () => {
    if(holdTimer!==null)clearTimeout(holdTimer);holdTimer=null;
    holding = false;
    eligible = false;
    target.classList.remove("holding");
  };

  target.addEventListener("contextmenu", (e) => e.preventDefault());
  target.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't hijack presses on the inline controls (Edit/Delete/Regenerate).
    if (e.target.closest("button, textarea, input, select, a, details")) return;
    cancel();
    startX = e.clientX; startY = e.clientY;
    holding = true;
    // iOS WebKit (Safari AND Chrome-on-iOS) drops the user gesture inside
    // setTimeout, so the clipboard write must NOT happen here — the timer
    // only marks the hold as long enough. The copy runs in pointerup.
    holdTimer=setTimeout(() => {
      holdTimer=null;
      if(holding){eligible=true;target.classList.add("holding");}
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
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

// ---------- context indicator ----------

const indicatorHint = 'Last completed request input; unsent input is excluded. Current context may differ.';
const indicatorRefresh = createIndicatorRefresh({
  focused: () => busy || !!editingState,
  key: () => JSON.stringify([tokenOwner(),state.sessionId,tokenContextKey()]),
  compute: async () => {
    if(cacheWritesPaused || !session || !state.settings || !latestReady || !state.storySettings)return null;
    const owner=currentUid(),sid=state.sessionId,key=tokenContextKey(),epoch=historyEpoch,settings=effectiveActiveSettings();
    const record=await tokenUsageCache.estimate(owner,sid,key,async check=>{
      const usage=await computeContextUsage(session,settings,historyMessages ?? lastMessages,{loreEntries,draftText:'',tokenCountMode:'estimate',check});
      return {tokens:usage.usedTokens,max:usage.max,reserved:settings.maxResponseTokens,modelId:settings.modelId,
        at:Date.now(),report:usage.report,droppedCount:usage.droppedCount,recentOnly:!historyMessages && hasEarlier};
    },()=>currentUid()===owner && state.sessionId===sid && historyEpoch===epoch && tokenContextKey()===key);
    tokenUsageError=null;return record;
  },
  apply: record => {if(record){applyIndicator(record);persistTokenUsage();tokenUsageChanged();}},
  onError: error => {const owner=tokenOwner();if(!owner)return;const record=tokenUsageCache.read(owner,state.sessionId);if(record?.kind && record.kind!=='estimate'){applyIndicator(record);return;}tokenUsageError=error.message;if(el.contextLabel)el.contextLabel.textContent=error.message;tokenUsageChanged();},
});
export function scheduledPlanDraftJump() {return null;}
export async function updateIndicator() {
  refreshTokenDisplayMeta();
  if (cacheWritesPaused || !session || !state.settings || !latestReady) return;
  clearTimeout(indicatorTimer);
  indicatorTimer=setTimeout(()=>{indicatorTimer=null;void indicatorRefresh.request();},300);
}
function applyIndicator(record) {
  refreshTokenDisplayMeta();
  const view=tokenUsageSnapshot(),max=view.max,settings=effectiveActiveSettings();
  const lastSent=record.kind!=='estimate',estimated=record.kind!=='provider';
  el.contextLabel.title=(lastSent ? indicatorHint : 'Cached context estimate, excluding unsent input.')+(view.contextChanged ? ' Context changed since last send.' : '')+
    (record.droppedCount>0 && !settings.autoSummarizationEnabled ? ' Older turns no longer fit. Turn on auto-summary or run Summarize to keep them in memory.' : '');
  const ring=contextRingPresentation({used:record.tokens,max});
  el.contextFill.style.strokeDasharray=ring.dash;el.contextFill.style.stroke=ring.color;
  el.contextFill.classList.toggle('over',record.tokens>=max*settings.autoSummaryThresholdPercent/100);
  el.contextThreshold.style.left=settings.autoSummaryThresholdPercent+'%';
  el.contextLabel.textContent=`${record.tokens.toLocaleString()} input / ${max.toLocaleString()} tokens`+
    (lastSent ? ' · last sent' : '')+(estimated ? ' · estimate' : ' · provider')+
    (record.droppedCount>0 ? ` · ${record.droppedCount} ${settings.autoSummarizationEnabled ? 'out of window' : 'turns not sent'}` : '')+
    (view.contextChanged ? ' · context changed' : '')+(record.recentOnly ? ' · recent history only' : '');
  const indicator=document.getElementById('context-indicator');
  indicator.setAttribute('aria-label','View context: '+el.contextLabel.textContent+'. '+el.contextLabel.title);
  indicator.title=el.contextLabel.textContent+'. '+el.contextLabel.title;updateMemoryChip();
}
export const refreshContextIndicator = updateIndicator;

// ---------- send / stream / summarize ----------

function clearLocalSummary() {
  session = { ...session, activeSummaryMessageId: null, breakpointOrder: 0 };
  updateIndicator();
  queueCacheSave();
}

async function regenerateMessage(message, replan = false) {
  if(busy)return;
  const token=acquireBusy('regenerate');if(!token)return;
  try {
    await waitForPendingChanges(token);assertActive(token);
    await reconcileStory();assertActive(token);
    const all = await ensureHistory();assertActive(token);
    const latest = all.filter((m) => m.role !== "summary").at(-1);
    if (latest?.id !== message.id || message.order <= (session.breakpointOrder ?? 0)) {
      throw new Error("Only the latest, unsummarized reply can be regenerated. Later story turns depend on older replies.");
    }
    assertActive(token);
    const target=all.find(m=>m.id===message.id);
    if(target.lastContinuation!=null && !replan) {
      const prefix=continuationPrefix(target);
      await runAssistantTurn({reconciled:true,continuationId:target.id,continuationPrefix:prefix,overwriteId:target.id,...(target.directorTurnId ? {directorReuseId:target.directorTurnId} : {})},token);
    } else await runAssistantTurn({reconciled:true,messages:all,upToOrder:target.order,overwriteId:target.id,replan},token);
  } catch (err) {
    if(!(err instanceof StaleTurn))showTransientError(err);
  } finally {releaseBusy(token);}
}

function setComposerText(text) {
  el.input.value = text; indicatorRefresh.invalidate(); sizeComposer({scroll:true});
}
function clearOriginalDraft() {
  originalDraft = null;
  if (el.restoreDraftBtn && !el.restoreDraftBtn.hidden) el.restoreDraftBtn.hidden = true;
}

function updateRewriteControls() {
  if (!el.rewriteBtn) return;
  const empty=!el.input.value.trim();
  let eligible=false;
  try { if(empty && session) {continuationTarget(session,lastMessages);eligible=true;} } catch {}
  const write=(node,key,value)=>{if(node[key]!==value)node[key]=value;};
  const presentation = rewritePresentation({rewriting:!!rewriteController, empty});
  setIcon(el.rewriteBtn, presentation.icon, presentation.label);
  write(el.rewriteBtn,'disabled', !rewriteController && (busy || state.busy || !session || !!editingState || (empty && !!historyLoading) || (empty && (!eligible || unsavedReplies.has(unsavedKey(currentUid(),state.sessionId))))));
  write(el.restoreDraftBtn,'disabled',busy);
  write(el.input,'readOnly',!!rewriteController);
  write(el.restoreDraftBtn,'hidden',originalDraft === null);
}

async function handleContinue() {
  if(unsavedReplies.has(unsavedKey(currentUid(),state.sessionId)))return;
  const sid=state.sessionId;
  if(busy || editingState || sid!==state.sessionId)return;
  const token=acquireBusy('continue');if(!token)return;
  try {
    await waitForPendingChanges(token);assertActive(token);
    await reconcileStory(token);assertActive(token);
    const all=await ensureHistory();assertActive(token);
    const target=continuationTarget(session,all);
    await runAssistantTurn({reconciled:true,continuationId:target.id,overwriteId:target.id},token);
  }catch(error){if(!(error instanceof StaleTurn))showTransientError(error);}
  finally{releaseBusy(token);}
}

async function handleRewrite() {
  if (rewriteController) {busyGate.active?.abort?.();return;}
  if (busy || state.busy || !session || editingState) return;
  if(!el.input.value.trim()){await handleContinue();return;}
  let settings;
  try{settings=effectiveActiveSettings();}catch(error){showTransientError(error.message);return;}
  if (!settings?.modelId || !settings?.apiKey) {
    showTransientError("Set your API key and Model ID in Settings first.");
    return;
  }
  const draft = el.input.value;
  const requestedSession = state.sessionId;
  const requestedUid = currentUid();
  const token=acquireBusy('rewrite');if(!token)return;
  clearOriginalDraft();
  const controller = rewriteController = new AbortController();
  const vibration = createStreamVibration(settings.streamVibrationMode ?? "spaces");
  let accumulated = "", frame = null;
  token.abort=()=>{
    if(!busyGate.stillActive(token))return;
    token.cancelled=true;controller.abort('user');vibration.stop();
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    if(rewriteController===controller)rewriteController=null;
    setComposerText(draft);releaseBusy(token);updateRewriteControls();
  };
  const active = () => busyGate.stillActive(token) && !controller.signal.aborted && requestedSession === state.sessionId && requestedUid === currentUid();
  const paint = () => { frame = null; if (active()) setComposerText(storyText(accumulated)); };
  // History and prompt loading also respond to Stop, even before fetch begins.
  const waitFor = (promise) => new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Rewrite stopped."));
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  controller.signal.addEventListener("abort", () => vibration.stop(), { once: true });
  updateRewriteControls();
  try {
    await waitFor(waitForPendingChanges(token));if(!active())return;settings=effectiveActiveSettings();
    const history = settings.rewriteRecentMessages === 0 ? [] : await waitFor(ensureHistory());
    const messages = await waitFor(buildRewriteMessages(settings, history, draft));
    if (!active()) throw new Error("Rewrite stopped because the account or story changed.");
    const result = await waitFor(chatCompletion({
      settings: { ...settings, streaming: true }, messages, signal: controller.signal,
      onDelta: (text) => {
        if (!active()) { controller.abort(); return; }
        vibration.feed(text);
        accumulated += text;
        if (frame === null) frame = requestAnimationFrame(paint);
      },
      onReasoning: (text) => { if (active()) vibration.feed(text); },
    }));
    if (result.finishReason === "length") throw new Error("Rewrite hit the output limit. Raise Max response tokens or lower the reasoning budget.");
    if (!active()) throw new Error("Rewrite stopped because the account or story changed.");
    const clean = storyText(result.content);
    if (!clean.trim()) throw new Error("The model returned no rewritten reply.");
    setComposerText(clean);
    originalDraft = draft;
  } catch (error) {
    if (busyGate.stillActive(token))setComposerText(draft);
    if (busyGate.stillActive(token) && !controller.signal.aborted)showTransientError(error.message || String(error));
  } finally {
    if (frame !== null) cancelAnimationFrame(frame);
    vibration.stop();
    if(rewriteController===controller)rewriteController=null;
    releaseBusy(token);
    updateRewriteControls();
  }
}

async function refreshStoryFromServer(token=null,{pendingStateSave=false,discardConflicts=false,saveHold=null}={}){
  const sid=state.sessionId,owner=currentUid(),epoch=historyEpoch;
  const refreshScope={sid,owner};refreshingStory=refreshScope;
  const hold=saveHold ?? token?.loreHold ?? holdLoreWrites(sid);
  const check=()=>{if(token)assertActive(token);if(sid!==state.sessionId || owner!==currentUid() || epoch!==historyEpoch || cacheWritesPaused)throw new StaleTurn();};
  // Invalidate earlier async cache/lore loads even if this refresh later fails.
  ++dataEpoch;++loreLoadVersion;invalidateStorySettingsLoads();indicatorRefresh.invalidate();
  clearTimeout(cacheSaveTimer);cacheSaveTimer=null;
  let store=null,discardPending=false;
  try {
    await memoryUpdater.stopAndWait(sid);check();
    if(!pendingStateSave){if(token)token.waitingSettings=true;try{await waitForPendingSettings(owner,sid);}finally{if(token)token.waitingSettings=false;}}check();
    await hold.ready;check();
    store=storyStore(sid);
    if(store)await store.pause();check();
    try{if(store)await store.flush({whilePaused:true});else await flushStory(sid);}
    catch(error){
      if(!discardConflicts || error.code!=='story-conflict')throw error;
      const unsavedReply=unsavedReplies.get(unsavedKey(owner,sid)) ?? await loadUnsavedReply(owner,sid);check();
      const localBackup={format:'nera-chat-backup',version:1,deviceHistoryComplete:true,exportedAt:new Date().toISOString(),session:store.view.session,messages:store.view.messages,
        storySettings:state.storySettings,lore:loreEntries,loreSnapshot:{initialized:loreStatus==='ok',entries:loreEntries,schemaVersion:session.loreSchemaVersion ?? 2,generation:session.loreGeneration ?? null},directorTurns:Object.values(store.view.turns),...(unsavedReply?{unsavedReply}:{})};
      if(!await deviceCache.saveDeviceRecoveryBackup(owner,sid,localBackup))throw new Error('Unsynced changes could not be backed up on this device. Use Force upload this device to download a backup before Sync.');
      check();discardPending=true;
    }
    check();
    if(historyLoading)await historyLoading;check();
    await Promise.all([...pendingCacheWrites]);check();
    // Revisions bracket the dependent reads, so a remote write cannot produce
    // a mixed story snapshot. Nothing displayed is cleared on read failure.
    // Disabled repeated bulk Sync: for(let attempt=0;attempt<3;attempt++){
    {
      const fresh=await getSessionFromServer(sid);check();
      if(!fresh || fresh.deleting)throw new Error('Story no longer exists.');
      const [account,prompts,messageData,loreSnapshot,turns]=await Promise.all([
        readSettingsRefresh(),readStorySettingsRefresh(sid),messagesApi.readMessageSnapshot(sid),loreStore.getLoreSnapshot(sid,{source:'server',publish:false}),
        Promise.all([...new Set([fresh.directorPending,fresh.directorCheckpoint].filter(Boolean))].map(async id=>[id,await directorStore.getDirectorTurn(sid,id)])),
      ]);check();
      const latest=await getSessionFromServer(sid);check();
      // if(preparationKey(latest)!==preparationKey(fresh) || latest?.directorCheckpoint!==fresh.directorCheckpoint || prompts.revision!==(latest.storySettingsRevision ?? 0))continue;
      // A manual Sync keeps the previous local snapshot if this one is inconsistent.
      if(preparationKey(latest)!==preparationKey(fresh) || latest?.directorCheckpoint!==fresh.directorCheckpoint || prompts.revision!==(latest.storySettingsRevision ?? 0))throw new Error('Story changed during Sync. Local data was kept.');
      account.check();
      const entries=loreSnapshot.entries;
      const messages=messageData.messages,view={session:latest,messages,turns:Object.fromEntries(turns.filter(([,turn])=>turn))};
      const snapshot={session:latest,recent:messages.slice(-Math.max(visibleCount,PAGE_SIZE)),history:messages,hasEarlier:false,tokenUsage:tokenUsageCache.serialize(owner,sid)};
      await loreStore.publishLoreSnapshot({uid:owner,id:sid},loreSnapshot,{persist:false,commit:()=>replaceStoryCache(owner,sid,snapshot,{confirmed:view,requiresReconciliation:false,turns:view.turns,storySettings:prompts,loreSnapshot,chunkRanges:messageData.chunkRanges},{discardPending})});
      // Keep the queue aligned with the committed cache even if navigation
      // changes while IndexedDB finishes. Its scoped observer publishes later.
      store?.adopt(view,{persist:false,reconciled:true,discardPending,serverConfirmed:true,notify:false});
      if(discardPending){
        if(pendingMaintenance?.sid===sid && pendingMaintenance.owner===owner)pendingMaintenance=null;
        await clearUnsaved(owner,sid);
      }
      check();
      account.apply();applyStorySettingsRefresh(sid,prompts);messagesApi.applyMessageSnapshot(sid,messageData);
      session=latest;historyMessages=messages;historyRevision=latest.historyRevision ?? 0;historyStartOrder=0;
      loreEntries=entries;verifiedLoreRevision=latest.loreRevision ?? 0;loreSessionId=sid;loreStatus='ok';
      loreReady=Promise.resolve();loreReloading=Promise.resolve();latestReady=true;hasEarlier=false;
      historyCache.set(owner+':'+sid,snapshot);memoryStories.delete(sid);
      renderMessages(snapshot.recent);rememberMemoryStory();
      document.dispatchEvent(new CustomEvent('settings-changed'));
      document.dispatchEvent(new CustomEvent('story-settings-changed'));
      document.dispatchEvent(new CustomEvent('lore-changed',{detail:{sessionId:sid,entries}}));
      document.dispatchEvent(new CustomEvent('session-changed',{detail:{sessionId:sid,session}}));
      void updateIndicator();return {preservedLocal:discardPending};
    }
    // throw new Error('Story changed during Sync. Try again when the other device is idle.');
  }finally{if(refreshingStory===refreshScope)refreshingStory=null;store?.resume();if(!token && !saveHold)hold.release();}
}
export async function syncChatData({pendingStateSave=false}={}){
  if(editingState){showTransientInfo('Finish editing before Sync.');return false;}
  // A dismissed live-state save can finish while Send waits on that save.
  if(pendingStateSave && hasPendingSettings(currentUid(),state.sessionId)){
    if(busy && !busyGate.active?.waitingSettings)throw new Error('Finish the current reply before refreshing live state.');
    await refreshStoryFromServer(busyGate.active,{pendingStateSave:true});return true;
  }
  return historyAction('sync',async token=>{await chatLoading;assertActive(token);const result=await refreshStoryFromServer(token,{discardConflicts:true});showTransientInfo('Latest story data loaded.'+(result?.preservedLocal?' Your unsynced device copy was kept in recovery backups.':''));});
}

function deviceUploadFingerprint() {
  const view=storyStore(state.sessionId)?.view;
  return JSON.stringify([state.sessionId,preparationKey(session),state.storySettings,
    (view?.messages ?? historyMessages ?? lastMessages).map(m=>[m.id,m.order,m.role,m.revision,m.content,m.scene,m.sceneMeta]),loreEntries]);
}
export async function openDeviceStoryUpload() {
  if(!session){showTransientInfo('Open a story first.');return;}
  if(busy || editingState || directStorySaves.size){showTransientInfo('Finish the current reply or edit first.');return;}
  const sid=state.sessionId,owner=currentUid(),epoch=historyEpoch;
  let closed=false,uploading=false,downloadedCopy=null,cloudCopy=null;
  const dialog=subSheet('Force upload this device',{close:()=>{if(uploading)return false;closed=true;return true;}});
  const body=node('div',null,'memory-content'),status=node('p','Reading copies stored on this device…','muted');body.append(status);dialog.dialog.append(body);
  const active=()=>!closed && sid===state.sessionId && owner===currentUid() && epoch===historyEpoch;
  try {
    const loaded=await Promise.allSettled([loadChatCache(owner,sid),loadStoryData(owner,sid),storyQueueStorage.load(owner,sid),cachedLoreSnapshot(owner,sid),loadUnsavedReply(owner,sid)]);
    const [cached,aux,outbox,lore,savedReply]=loaded.map(result=>result.status==='fulfilled'?result.value:null);
    if(!active()){dialog.hide();return;}
    const store=storyStore(sid),current=store?.view ?? (historyMessages && historyRevision===(session.historyRevision ?? 0)?{session,messages:historyMessages,turns:aux?.turns}:null);
    const localLore=lore ?? (loreStatus==='ok' && loreSessionId===sid?{initialized:true,entries:loreEntries,schemaVersion:session.loreSchemaVersion ?? 2,generation:session.loreGeneration ?? null}:null);
    const unsavedReply=unsavedReplies.get(unsavedKey(owner,sid)) ?? savedReply;
    const copies=deviceStoryCopies({sid,current,cached,aux,outbox,storySettings:state.storySettings,loreSnapshot:localLore,unsavedReply:unsavedReply?.sid===sid && (!unsavedReply.owner || unsavedReply.owner===owner)?unsavedReply:null});
    if(!copies.length){status.textContent='No complete story copy was found on this device. Recent messages alone cannot safely replace Firebase.';return;}
    status.textContent='Choose the chat history to upload with this device’s memory, lorebooks, and prompts. This replaces the current Firebase story. It cannot recreate turns that are no longer stored here.';
    const picker=node('select');picker.setAttribute('aria-label','Device story copy');for(const [index,copy]of copies.entries()){const option=node('option',copy.label+' · '+copy.snapshot.messages.length+' messages · '+copy.snapshot.lore.length+' lore cards');option.value=String(index);picker.append(option);}picker.value='0';
    const preview=node('p','','muted'),selected=()=>copies[Number(picker.value)]?.snapshot;
    const render=()=>{const copy=selected(),last=copy?.messages.at(-1);preview.textContent=last?'Last saved text: '+String(last.content).slice(0,240):'';};picker.addEventListener('change',render);render();
    const baseline=deviceUploadFingerprint();
    const backupButton=button('Download device backup',()=>{if(!active())throw new Error('Story changed; reopen this dialog.');const copy=selected();download(JSON.stringify(copy,null,2)+'\n',(copy.session.title || 'story').replace(/[^\w\- ]+/g,'').trim()+'-device-backup.json','application/json');downloadedCopy=copy;});
    const cloudButton=button('Download previous cloud backup',()=>{if(!active())throw new Error('Story changed; reopen this dialog.');if(!cloudCopy)return;download(JSON.stringify(cloudCopy,null,2)+'\n','previous-cloud-story-backup.json','application/json');});cloudButton.hidden=true;
    const uploadButton=button('Replace Firebase with this copy',async()=>{
      if(!active())throw new Error('Story changed; reopen this dialog.');
      const copy=structuredClone(selected());validateDeviceStory(copy);
      if(!confirm(`Replace this Firebase story with ${copy.messages.length} messages and ${copy.lore.length} lore cards from this device, including memory and prompts? The previous cloud copy will be backed up. Changes from other devices will not be merged.`))return;
      uploading=true;picker.disabled=true;backupButton.disabled=true;
      try{const done=await forceUploadDeviceStory(copy,{baseline,owner,epoch,backupDownloaded:downloadedCopy===selected(),onProgress:text=>{if(active())status.textContent=text;},onComplete:result=>{cloudCopy=result.cloudBackup;cloudButton.hidden=false;uploadButton.hidden=true;}});if(done)status.textContent='Uploaded to Firebase. Your previous cloud copy is kept in recovery backups. Use Sync latest data on other devices.';}
      finally{uploading=false;picker.disabled=false;backupButton.disabled=false;}
    });
    body.append(picker,preview,backupButton,uploadButton,cloudButton,node('p','A local backup and a cloud recovery backup are saved before replacement. No AI calls are made.','muted'));
    if(loaded.some(result=>result.status==='rejected'))body.append(node('p','Some device storage could not be read. Only the complete copies listed above are available.','memory-warning'));
    for(const warning of copies.warnings ?? [])body.append(node('p',warning,'memory-warning'));
  }catch(error){if(active())status.textContent=error.message;}
}
export async function forceUploadDeviceStory(snapshot,{baseline=deviceUploadFingerprint(),owner=currentUid(),epoch=historyEpoch,backupDownloaded=false,onProgress=()=>{},onComplete=()=>{}}={}) {
  const sid=state.sessionId;
  if(snapshot?.session?.id!==sid || owner!==currentUid() || epoch!==historyEpoch)throw new Error('Story changed; device upload cancelled.');
  validateDeviceStory(snapshot);
  return historyAction('device-upload',async token=>{
    const scope={owner,sid};let store=null,committed=false,cacheSaved=false;
    try{
      await memoryUpdater.stopAndWait(sid);assertActive(token);await token.loreHold.ready;assertActive(token);
      if(hasPendingSettings(owner,sid))throw new Error('Wait for settings to finish saving, then reopen device upload.');
      if(deviceUploadFingerprint()!==baseline)throw new Error('This device’s story changed after the preview opened. Reopen device upload to include the latest changes.');
      store=storyStore(sid);if(store)await store.pause();assertActive(token);
      if(deviceUploadFingerprint()!==baseline)throw new Error('This device’s story changed after the preview opened. Reopen device upload to include the latest changes.');
      await Promise.all([...pendingCacheWrites]);assertActive(token);
      if(!await deviceCache.saveDeviceRecoveryBackup(owner,sid,snapshot) && !backupDownloaded)throw new Error('The device could not save a recovery backup. Download the device backup before retrying; Firebase has not been changed.');
      refreshingStory=scope;clearTimeout(cacheSaveTimer);cacheSaveTimer=null;
      const result=await uploadDeviceStory(snapshot,{owner,check:()=>assertActive(token),onProgress});committed=true;assertActive(token);
      const view={session:result.session,messages:result.messages,turns:result.turns},saved={session:result.session,recent:result.messages.slice(-Math.max(visibleCount,PAGE_SIZE)),history:result.messages,historyRevision:result.session.historyRevision,hasEarlier:false};
      await loreStore.publishLoreSnapshot({uid:owner,id:sid},result.loreSnapshot,{persist:false,commit:()=>replaceStoryCache(owner,sid,saved,{confirmed:view,turns:view.turns,storySettings:result.storySettings,loreSnapshot:result.loreSnapshot,chunkRanges:result.messageSnapshot.chunkRanges,requiresReconciliation:false},{discardPending:true})});cacheSaved=true;
      store?.adopt(view,{persist:false,reconciled:true,discardPending:true,serverConfirmed:true,notify:false});assertActive(token);
      if(snapshot.unsavedReply && result.messages.some(m=>m.id===(snapshot.unsavedReply.overwriteId ?? snapshot.unsavedReply.id) && m.content===snapshot.unsavedReply.message?.content)){
        const currentReply=unsavedReplies.get(unsavedKey(owner,sid)) ?? await loadUnsavedReply(owner,sid);assertActive(token);
        if(currentReply?.id===snapshot.unsavedReply.id && currentReply.message?.content===snapshot.unsavedReply.message?.content)await clearUnsaved(owner,sid);
      }
      ++dataEpoch;++loreLoadVersion;invalidateStorySettingsLoads();indicatorRefresh.invalidate();
      session=result.session;historyMessages=result.messages;historyRevision=result.session.historyRevision;historyStartOrder=0;hasEarlier=false;latestReady=true;
      loreEntries=result.loreSnapshot.entries;loreSessionId=sid;verifiedLoreRevision=session.loreRevision;loreStatus='ok';loreReady=Promise.resolve();loreReloading=Promise.resolve();
      applyStorySettingsRefresh(sid,result.storySettings);messagesApi.applyMessageSnapshot(sid,result.messageSnapshot);
      historyCache.set(owner+':'+sid,saved);rememberMemoryStory();renderMessages(saved.recent);updateMemoryChip();void updateIndicator();
      document.dispatchEvent(new CustomEvent('story-settings-changed'));
      document.dispatchEvent(new CustomEvent('lore-changed',{detail:{sessionId:sid,entries:loreEntries}}));
      document.dispatchEvent(new CustomEvent('memory-refresh',{detail:{sessionId:sid}}));
      document.dispatchEvent(new CustomEvent('session-changed',{detail:{sessionId:sid,session}}));
      onComplete(result);
      showTransientInfo('This device’s story was uploaded to Firebase.');
    }catch(error){
      if(error.uploadUncertain){committed=true;store?.invalidate();onProgress(error.message);throw error;}
      if(committed){store?.invalidate();const savedError=new Error('The upload reached Firebase, but this device could not finish updating its cache. Your local backup was kept. Reload and Sync to load the uploaded copy.');onProgress(savedError.message);throw savedError;}
      onProgress(friendlyError(error));throw error;
    }
    finally{if(refreshingStory===scope)refreshingStory=null;if(!committed || cacheSaved)store?.resume();}
  });
}

async function retryReply(message) {
  if (busy || editingState || !session) return;
  await runAssistantTurn({ expectLatestUserId:message.id });
}

async function handleSend(e) {
  e.preventDefault();
  if (busy || !session || editingState) return;
  if(unsavedReplies.has(unsavedKey(currentUid(),state.sessionId))){showTransientInfo('Save or discard the unsaved reply before sending another turn.');return;}
  const requestedSessionId = state.sessionId, requestedOwner = currentUid();
  const draft = el.input.value;
  let saved = false;
  const text = draft.trim();
  if (!text) return;
  if (busy || !session || requestedSessionId !== state.sessionId || requestedOwner !== currentUid()) return;
  pendingMaintenance=null;const token=acquireBusy('send');if(!token)return;
  try {
    indicatorRefresh.invalidate();
    setPreparing(true);
    // Capture pending settings now: a dismissed save may settle during the paint.
    const pendingChanges=waitForPendingChanges(token);
    void pendingChanges.catch(()=>{});
    await afterUiPaint();assertActive(token);
    await pendingChanges;assertActive(token);
    const settings=effectiveActiveSettings();
    if(!settings?.modelId || !settings?.apiKey)throw new Error('Set your API key and Model ID in the Settings tab first.');
    await chatLoading;assertActive(token);const store=await ensureLocalStory();assertActive(token);
    // Missing lore must leave the composer draft intact until Sync can retry.
    await loreReady;assertActive(token);validateSavedStorySettings();
    if(session.directorPending)store.enqueue('discardDirector',{});
    const id=messagesApi.newMessageId();
    const mem=normalizeMemory(session.memory);const initializeMemory=mem.autoUpdate && session.memoryState?.extractedThroughOrder==null && computeTurns(store.view.messages).lastTurn<=mem.lagTurns;
    store.enqueue('add',{id,message:{role:'user',content:text},...(initializeMemory?{sessionUpdate:{memoryState:{...session.memoryState,extractedThroughOrder:0}}}:{})});
    saved=true;
    if(el.input.value===draft)setComposerText('');
    const userMsg=store.view.messages.find(m=>m.id===id);
    await afterUiPaint();assertActive(token);
    await runAssistantTurn({messages:historyMessages,reconciled:true,savedUserId:userMsg.id},token);
  } catch (err) {
    if (!saved && requestedOwner===currentUid() && requestedSessionId === state.sessionId && !el.input.value) setComposerText(draft);
    if(!(err instanceof StaleTurn) && requestedOwner===currentUid() && requestedSessionId===state.sessionId)showTransientError(err);
  } finally {
    checkpointTurn(token);
    releaseBusy(token);
  }
}

async function runAssistantTurn(opts = {},suppliedToken=null) {
  if(unsavedReplies.has(unsavedKey(currentUid(),state.sessionId))){showTransientInfo('Save or discard the unsaved reply first.');return;}
  const token=suppliedToken ?? acquireBusy('reply');if(!token)return;
  const ownsToken=!suppliedToken;
  let settings;
  try{settings=effectiveActiveSettings();}catch(error){showTransientError(error.message);if(ownsToken)releaseBusy(token);return;}
  const sid = state.sessionId;
  if (!settings) {if(ownsToken)releaseBusy(token);return;}
  const controller=new AbortController();el.stopBtn.classList.remove('hidden');el.sendBtn.hidden=true;
  const vibration=createStreamVibration(settings.streamVibrationMode ?? 'spaces');
  const petTurn = startPetTurn();token.abort=()=>cancelGeneration(token,controller,vibration,petTurn);
  let maintenanceUsed = false,turnStream=null;
  try {
    await waitForPreparation(chatLoading,controller);assertActive(token);
    await waitForPreparation(waitForPendingChanges(token),controller);assertActive(token);settings=effectiveActiveSettings();
    if(!opts.reconciled)await waitForPreparation(reconcileStory(token),controller);assertActive(token);
    if (opts.expectLatestUserId) {
      const latest = (historyMessages ?? []).filter(m => m.role !== 'summary').at(-1);
      if (latest?.role !== 'user' || latest.id !== opts.expectLatestUserId) throw new Error('The latest story turn changed. Review it before retrying.');
    }
    if(opts.savedUserId){validateSavedStorySettings();settings=effectiveActiveSettings();}
    if(!settings.modelId || !settings.apiKey)throw new Error('Set your API key and Model ID in Settings first.');
    let sourceMessages = structuredClone(historyMessages);
    let prefix=null;
    if(opts.continuationId) {
      const target=continuationTarget(session,sourceMessages,opts.continuationId);
      prefix=opts.continuationPrefix ?? target;
      sourceMessages=sourceMessages.map(m=>m.id===target.id ? prefix : m);
      opts={...opts,upToOrder:undefined};
    }
    let sourceSession = structuredClone(session);
    if(settings._storySettingsRevision!=null)sourceSession.storySettingsRevision=settings._storySettingsRevision;
    const directorMode=settings.narrationMode==='director';
    let directorTurn=null,lastDirectorRequest=null;
    if(directorMode){
      showTransientInfo('Directing…');
      directorTurn=await waitForPreparation(prepareDirectorTurn(sourceSession,settings,sourceMessages,structuredClone(loreEntries),opts,{signal:controller.signal,getTurn:(...args)=>storyStore(sid).getTurn(...args),saveTurn:(...args)=>{assertActive(token);return storyStore(sid).saveTurn(...args);},check:()=>assertActive(token),onRequest:serialized=>{if(!busyGate.stillActive(token))return;lastDirectorRequest={requestBody:JSON.parse(serialized),sentAt:Date.now()};}}),controller);
      assertActive(token);
      if(directorTurn.contract.action==='wait'){showTransientInfo(directorTurn.contract.objective);finishPetTurn('ready',petTurn);return;}
      opts={...opts,directorTurn};
      showTransientInfo('Narrating…');
    }
    let built = await waitForPreparation(buildContextForRequest(sourceSession,settings,{ ...opts,messages:sourceMessages,requireLatestUser:true,loreEntries:structuredClone(loreEntries),signal:controller.signal,check:()=>assertActive(token) }),controller);
    assertActive(token);
    if(opts.savedUserId){
      validateSavedStorySettings();
      // Disabled: build from the captured context without cancelling for background changes.
      // if(preparationKey({...session,directorPending:sourceSession.directorPending})!==preparationKey(sourceSession) || JSON.stringify(effectiveActiveSettings())!==JSON.stringify(settings))
      //   throw new Error('Story or settings changed while building context. Your message was saved. Refresh and use Retry reply.');
    }
    startStreamUI(prefix);turnStream=streamState;
    let result,stopReason=null;const narratorStarted=Date.now();
    try {
      result=await chatCompletion({ settings,messages:built.apiMessages,onRequest:serialized => {
        if(!busyGate.stillActive(token))return;const requestBody=JSON.parse(serialized);
        lastSentContext=structuredClone({report:built.report,apiMessages:requestBody.messages,requestBody,sentAt:Date.now(),...(directorTurn ? {director:{...lastDirectorRequest,report:directorTurn.report,usage:directorTurn.usage,elapsedMs:directorTurn.elapsedMs,timings:directorTurn.timings,reused:!lastDirectorRequest,contract:directorTurn.contract}} : {})});
      },allowTruncated:true,signal:controller.signal,onDelta:t => { if(controller.signal.aborted || !busyGate.stillActive(token))return;vibration.feed(t); updatePetPhase('writing',petTurn); if (streamState) appendStream('content',t); },onReasoning:t => { if(controller.signal.aborted || !busyGate.stillActive(token))return;vibration.feed(t); updatePetPhase('thinking',petTurn); if (streamState) appendStream('thinking',t); } });
    } catch(error) {
      assertActive(token);
      if(error.classification==='cancelled' || !['transport_loss','timeout'].includes(error.classification) || !error.partial?.content?.trim() || !confirm('Keep the partial reply? It will be marked as cut off.'))throw error;
      stopReason=error.aborted==='timeout' ? 'timeout' : error.aborted==='dropped' ? 'dropped' : 'stopped';
      result={...error.partial,finishReason:'length',originalFinishReason:error.finishReason ?? null,failureClassification:error.classification,originalError:error.message,usage:null};
    }
    vibration.stop();
    const {content,thinking,finishReason,usage}=result;
    assertActive(token);
    if(directorMode && lastSentContext){lastSentContext.narratorElapsedMs=Date.now()-narratorStarted;lastSentContext.narratorUsage=usage ?? null;}
    const truncated = finishReason === 'length';
    const fresh=session;
    const mem=normalizeMemory(sourceSession.memory),sceneEnabled=directorMode || mem.scene;
    const out=readSceneOutput(content,{sceneEnabled}),clean=out.clean;
    let planThread=!directorMode && sceneEnabled && sourceSession.longTermPlan?.trim() ? out.planThread : null;
    if (truncated && !clean) throw new Error('The output limit left no narrative reply. Raise Max response tokens or lower the reasoning budget.');
    if (!clean) throw new Error('The model returned no reply; nothing was saved.');
    const userText=opts.continuationId ? '' : normalizeAdDirective(sourceMessages.filter(m => m.role==='user' && m.order < (opts.upToOrder ?? Infinity)).at(-1)?.content ?? '');
    const inputKind=classifyUserInput(userText),ooc=directorMode ? directorTurn.contract.action==='answer' : opts.continuationId ? false : inputKind==='ooc' || inputKind==='question' && !out.scene;
    const prior=latestScene(sourceMessages,opts.upToOrder ?? Infinity,mem.startingScene);
    let acceptedScene={scene:null,sceneMeta:null},sceneWarning=null;
    if (directorMode) {
      acceptedScene={scene:directorScene(truncated ? directorTurn.before : directorTurn.after),sceneMeta:{kind:'director',stale:false,source:'director',turnId:directorTurn.id},warnings:directorSceneWarnings(out.scene,directorTurn.after)};
    } else if (sceneEnabled && !ooc) {
      acceptedScene=carryScene(prior);
      if (!truncated && out.scene) acceptedScene=validateSceneValues(out.scene,{narration:clean,userText,prior:prior.scene,calendar:mem.calendar});
      else if (!truncated) {
        const candidate=sceneFromThinking(thinking);
        if(candidate){acceptedScene=validateSceneValues(candidate,{narration:clean,userText,prior:prior.scene,calendar:mem.calendar});acceptedScene.sceneMeta.source='thinking';sceneWarning="Scene taken from the model's reasoning.";}
      }
      if (!truncated && acceptedScene.sceneMeta?.kind==='carried' && mem.sceneFallback && !maintenanceUsed) {
        try {
          const recovered=await recoverScene(settings,{narration:clean,userText,prior,calendar:mem.calendar,
            names:loreEntries.filter(e => e.book==='characters').map(e => e.name),protagonist:mem.protagonist,plan:sourceSession.longTermPlan,model:mem.sceneFallbackModel},{signal:controller.signal,onStart:()=>{maintenanceUsed=true;}});
          assertActive(token);
          if (recovered) { acceptedScene=recovered; planThread ||= sourceSession.longTermPlan?.trim() ? recovered.planThread : null; }
        } catch (error) {if(error instanceof StaleTurn)throw error; sceneWarning=String(error?.message ?? 'Scene recovery failed.'); }
      }
    }
    const reviewWarnings=sceneEnabled && !ooc && !truncated ? [
      ...lintPlayerAgency(clean,mem.protagonist),
      ...(directorMode ? [...lintDirectorGestures(clean,{protagonist:mem.protagonist,userText}),...lintDirectorHistory(clean,{userText}),...lintDirectorResponseBoundary(clean)] : []),
      ...(!prior.scene?.time && !parseScene(acceptedScene.scene).time ? lintUnestablishedTime(clean,{prior:prior.scene,userText}) : []),
      ...(acceptedScene.warnings ?? []),...(out.count > 1 ? ['Several scene tags; the last one was used.'] : []),
      ...(sceneWarning ? [sceneWarning] : []),
      ...(acceptedScene.sceneMeta?.kind==='carried' ? ['No scene tag; previous scene carried.'] : [])] : [];
    let message={role:'assistant',content:clean,thinking,truncated,planThread,planBefore:sourceSession.longTermPlan ?? '',
      scene:acceptedScene.scene,sceneMeta:acceptedScene.sceneMeta,ooc,
      ...(directorMode ? {directorTurnId:directorTurn.id,directorIncomplete:truncated} : {}),
      responseDiagnostics:{finishReason:result.originalFinishReason ?? finishReason,classification:result.failureClassification ?? null,error:result.originalError ?? null},
      ...(sceneEnabled ? {acceptance:'accepted',reviewWarnings} : {})};
    if(prefix) {
      if(!sceneEnabled || acceptedScene.sceneMeta?.kind==='carried') {
        message.scene=prefix.scene ?? null;message.sceneMeta=prefix.sceneMeta ?? null;
      }
      if(!planThread)message.planThread=prefix.planThread ?? null;
      message=appendContinuation(prefix,message);
      if(directorMode){message.truncated=truncated;message.directorIncomplete=truncated;}
    }
    updatePetPhase('saving',petTurn);
    let saved;
    const pendingReply={sid,minOrder:(sourceSession.nextOrder ?? 0)+1,owner:currentUid(),message,id:opts.overwriteId ?? messagesApi.newMessageId(),overwriteId:opts.overwriteId ?? null,order:prefix?.order ?? opts.upToOrder ?? null,continuation:!!prefix,sourceRevision:sourceSession.historyRevision ?? 0,...(opts.replan || opts.replanReplacement ? {replanReplacement:true} : {}),...(directorMode ? {expectedSource:requestSource(sourceSession)} : {})};
    if(streamState)streamState.savedId=pendingReply.id;
    try {
      assertActive(token);const result=await saveNarration(pendingReply,false,token);
      saved=result.message;
      assertActive(token);const committed=result.session ?? {...fresh,historyRevision:result.historyRevision};
      if((committed.historyRevision ?? 0)>=(session.historyRevision ?? 0))session=committed;
      clearUnsaved(pendingReply.owner,sid);
    } catch(error) {
      if(error instanceof StaleTurn || token.cancelled || !busyGate.stillActive(token))throw new StaleTurn();
      pendingReply.conflict=error.name==='HistoryConflict';pendingReply.error=error.message;
      const key=unsavedKey(pendingReply.owner,sid);unsavedRevisions.set(key,(unsavedRevisions.get(key) ?? 0)+1);
      unsavedReplies.set(key,pendingReply);
      void storeUnsavedReply(pendingReply.owner,sid,pendingReply);
      restoreStreamUI();renderUnsavedReply();finishPetTurn('ready',petTurn);
      showTransientInfo('Reply not saved. Your text is available below — Save again or Copy.');
      return;
    }
    // Save completed narration even if inputs changed during generation. Reload
    // changed history before the next request instead of caching the old snapshot.
    const historyChanged = session.historyRevision !== (sourceSession.historyRevision ?? 0) + 1;
    historyMessages = historyChanged ? null : mergeMessages(sourceMessages,[saved]);
    historyRevision = historyChanged ? null : session.historyRevision;
    if (streamState) { streamState.savedId = saved.id; streamState.saveCompleted = true; }
    const promptTokens=usage?.prompt_tokens ?? usage?.input_tokens;
    const providerCount=Number.isSafeInteger(promptTokens) && promptTokens>=0;
    lastProviderUsage=providerCount ? {sessionId:sid,promptTokens,estimate:built.usedTokens} : null;
    const usageRecord=tokenUsageCache.remember(currentUid(),sid,{kind:providerCount ? 'provider' : 'sent-estimate',
      tokens:providerCount ? promptTokens : built.usedTokens,max:built.report.totals.max,reserved:settings.maxResponseTokens,
      at:lastSentContext?.sentAt ?? Date.now(),modelId:settings.modelId,contextKey:tokenContextKey(),report:built.report,droppedCount:built.droppedCount ?? 0});
    tokenUsageError=null;applyIndicator(usageRecord);persistTokenUsage();tokenUsageChanged();
    renderMessages(mergeMessages(lastMessages,[saved])); queueCacheSave(); rememberMemoryStory();
    if (truncated) {if(stopReason)showTransientInfo(stopReason==='timeout' ? 'Partial reply saved (timed out after 120 s).' : stopReason==='dropped' ? 'Partial reply saved (connection dropped).' : 'Partial reply saved (stopped).');else showTransientError('Reply saved but cut off at the output limit. Raise Max response tokens or use Regenerate.');}
    else if (sceneEnabled && !ooc && acceptedScene.sceneMeta?.kind==='carried') showTransientInfo('No scene tag in this reply; the previous scene was kept.');
    lastMemoryReport = built.report;
    if(directorMode && truncated)return;
    finishPetTurn('ready',petTurn);
    pendingMaintenance={sid,owner:currentUid(),key:preparationKey(session),settings,opts,maintenanceUsed,petTurn};
    scheduleIdleMaintenance();

  } catch (err) {
    if(err instanceof StaleTurn || token.cancelled || !busyGate.stillActive(token))return;
    finishPetTurn('blocked',petTurn); restoreStreamUI(); refreshPetPlacement(); clampListScroll(); showTransientError(err);
  } finally {vibration.stop();if(streamState===turnStream && streamState?.continuationId && !streamState.saveCompleted)restoreStreamUI();checkpointTurn(token);if(ownsToken)releaseBusy(token);}
}

async function runIdleMaintenance({sid,settings,opts,maintenanceUsed,petTurn}){
  // Disabled as a global blocker: storyStore(sid)?.requiresReconciliation
  if(busy || turnCheckpoints.has(storyStore(sid)) || storyStore(sid)?.status.pending || storyStore(sid)?.status.running || storyStore(sid)?.status.paused || storyStore(sid)?.status.error)return;
  const token=acquireBusy('maintenance');if(!token)return;
  try {
    try {
    const backoff=summaryBackoff.get(sid) ?? 0;if(backoff)summaryBackoff.set(sid,backoff-1);
    const due=memoryUpdater.dueRangeFor?.(sid) ?? (memoryUpdater.maybeStartAfterTurn && null);
    const hist=settings.autoSummarizationEnabled===true ? historyMessages ?? await ensureHistory() : historyMessages ?? lastMessages;assertActive(token);
    const contextUsage=settings.autoSummarizationEnabled===true ? await computeContextUsage(session,settings,hist,{loreEntries}) : null;assertActive(token);
    const planned=settings.autoSummarizationEnabled===true && !backoff && (contextUsage.overThreshold || contextUsage.droppedCount>0) ? planSummary(session,settings,hist,{maxChunks:1,urgent:contextUsage.droppedCount>0}) : null;
    const summary=planned && !planned.skip ? planned : null;
    const pick=maintenanceUsed ? null : pickMaintenance({overwrite:!!opts.overwriteId,summary,memoryDue:!!due,memoryRunning:memoryUpdater.isRunning(sid),memoryDeferrals:memoryDeferrals.get(sid) ?? 0});
    if(due && pick!=='memory')memoryDeferrals.set(sid,(memoryDeferrals.get(sid) ?? 0)+1);
    if(pick==='memory'){memoryUpdater.maybeStartAfterTurn(sid);memoryDeferrals.set(sid,0);}
    else if(pick==='summary') {
      const summaryController=new AbortController();token.abort=()=>summaryController.abort('user');
      const ui=streamSummaryUI('Context near limit — summarizing…');
      try {const summaryResult=await runSummarization(structuredClone(session),settings,{signal:summaryController.signal,maxChunks:1,messages:structuredClone(hist),loreEntries:structuredClone(loreEntries),onDelta:ui.onDelta});assertActive(token);applySummaryResult(summaryResult);}
      catch(error){if(error instanceof StaleTurn)throw error;assertActive(token);if(summaryController.signal.reason==='user')showTransientInfo('Summary stopped.');else{summaryBackoff.set(sid,3);showTransientInfo('Summary skipped: '+error.message);}}
      finally {ui.done();}
    }
    } catch(error){if(!(error instanceof StaleTurn))showTransientInfo('Reply saved. Background memory was skipped: '+error.message);}
  }finally{releaseBusy(token);}
}

async function saveNarration(reply,asNew=false,token=null) {
  if(reply.owner!==currentUid() || reply.sid!==state.sessionId)throw new StaleTurn();
  const store=await ensureLocalStory();if(token)assertActive(token);
  assertSource(store.view.session,reply.expectedSource ?? {historyRevision:reply.sourceRevision});
  if(reply.replanReplacement && reply.message.truncated)throw new Error('Replacement is incomplete. Continue it before saving.');
  if(asNew && (reply.message.directorTurnId || reply.continuation))throw new Error('This reply must replace its original turn.');
  const view=reply.overwriteId && !asNew
    ? store.enqueue('overwrite',{id:reply.overwriteId,order:reply.order,message:reply.message})
    : store.enqueue('add',{id:reply.id,message:reply.message});
  return {message:view.messages.find(m=>m.id===(reply.overwriteId && !asNew?reply.overwriteId:reply.id)),session:view.session,historyRevision:view.session.historyRevision};
}

function clearUnsaved(owner,sid) {
  const key=unsavedKey(owner,sid);unsavedRevisions.set(key,(unsavedRevisions.get(key) ?? 0)+1);
  unsavedReplies.delete(key);const persisted=storeUnsavedReply(owner,sid,null);
  if(owner===currentUid() && sid===state.sessionId){unsavedNode?.remove();unsavedNode=null;updateRewriteControls();}
  return persisted;
}
function renderUnsavedReply() {
  unsavedNode?.remove();unsavedNode=null;
  const reply=unsavedReplies.get(unsavedKey(currentUid(),state.sessionId));if(!reply || !el.list)return;
  const wrap=document.createElement('div');wrap.className='msg assistant unsaved';
  const label=document.createElement('div');label.className='msg-meta';label.textContent=(reply.replanReplacement ? 'Replacement cut off · original reply kept' : 'Not saved')+(reply.conflict ? ' · story changed on another device' : '');
  const body=document.createElement('div');body.className='msg-content';body.textContent=reply.message.content;
  const controls=document.createElement('div');controls.className='msg-actions';
  const retry=asNew=>historyAction('save-reply',async token=>{
    const pending=unsavedReplies.get(unsavedKey(reply.owner,reply.sid));if(pending!==reply)return;
    const found=await messagesApi.findSavedMessage(reply.sid,reply.id,reply.overwriteId ? reply.order : reply.minOrder,{overwrite:!!reply.overwriteId});assertActive(token);
    if(found && (!reply.overwriteId || found.content===reply.message.content)){
      const fresh=await getSessionFromServer(reply.sid);assertActive(token);if(!fresh || fresh.deleting)throw new Error('This story was deleted.');
      session=fresh;historyMessages=null;historyRevision=null;clearUnsaved(reply.owner,reply.sid);renderMessages(mergeMessages(lastMessages,[found]));queueCacheSave();void updateIndicator();showTransientInfo('Reply saved.');return;
    }
    if(asNew){const fresh=await getSessionFromServer(reply.sid);assertActive(token);if(!fresh || fresh.deleting)throw new Error('This story was deleted.');reply.sourceRevision=fresh.historyRevision ?? 0;reply.id=messagesApi.newMessageId();reply.minOrder=(fresh.nextOrder ?? 0)+1;reply.overwriteId=null;reply.order=null;}
    try {
      const result=await saveNarration(reply,asNew);assertActive(token);
      session=result.session ?? {...session,historyRevision:result.historyRevision};historyMessages=null;historyRevision=null;
      clearUnsaved(reply.owner,reply.sid);renderMessages(mergeMessages(lastMessages,[result.message]));queueCacheSave();void updateIndicator();showTransientInfo('Reply saved.');
    }catch(error){if(error.name==='HistoryConflict'){reply.conflict=true;void storeUnsavedReply(reply.owner,reply.sid,reply);renderUnsavedReply();}throw error;}
  });
  if(reply.replanReplacement && reply.message.truncated)controls.append(actionBtn('Continue replacement',()=>historyAction('continue-replacement',async token=>{await reconcileStory(token);assertActive(token);const all=await ensureHistory();assertActive(token);const target=all.find(m=>m.id===reply.overwriteId);if(!target)throw new Error('The original reply was deleted. Copy the replacement text.');clearUnsaved(reply.owner,reply.sid);await runAssistantTurn({reconciled:true,continuationId:target.id,continuationPrefix:{...target,...reply.message},overwriteId:target.id,directorReuseId:reply.message.directorTurnId,replanReplacement:true},token);})));
  if(!(reply.replanReplacement && reply.message.truncated))controls.append(actionBtn('Save again',()=>retry(false)));
  controls.append(actionBtn('Copy',()=>copyClipboard(reply.message.content)),actionBtn('Discard',()=>{if(!confirm('Discard this unsaved reply?'))return;if(reply.replanReplacement)return historyAction('discard-replacement',async token=>{const local=await ensureLocalStory();assertActive(token);local.enqueue('discardDirector',{});await local.flush();assertActive(token);clearUnsaved(reply.owner,reply.sid);await reconcileStory(token);updateWelcome();});clearUnsaved(reply.owner,reply.sid);updateWelcome();}));
  if(reply.conflict && !reply.continuation && !reply.message.directorTurnId)controls.append(actionBtn('Save as new reply at the end',()=>retry(true)));
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
  const controller=new AbortController();token.abort=()=>controller.abort('user');el.stopBtn.classList.remove('hidden');el.sendBtn.hidden=true;
  const ui = streamSummaryUI("Summarizing…");
  try {
    await waitForPreparation(waitForPendingChanges(token),controller);assertActive(token);
    const settings=effectiveActiveSettings();
    await waitForPreparation(flushStory(token.sid),controller);assertActive(token);
    await waitForPreparation(reconcileStory(token),controller);assertActive(token);
    const r = await runSummarization(session, settings, {
      signal:controller.signal,
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
    if(controller.signal.aborted)showTransientInfo('Summary stopped. Previous checkpoint kept.');
    else showTransientError("Summarization failed: " + (err.message || String(err)));
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
  const controller=new AbortController();token.abort=()=>controller.abort('user');el.stopBtn.classList.remove('hidden');el.sendBtn.hidden=true;
  const ui = streamSummaryUI("Summarizing full history…");
  try {
    await waitForPreparation(waitForPendingChanges(token),controller);assertActive(token);
    const settings=effectiveActiveSettings();
    await waitForPreparation(flushStory(token.sid),controller);assertActive(token);
    await waitForPreparation(reconcileStory(token),controller);assertActive(token);
    const r = await runSummarization(session, settings, {
      signal:controller.signal,
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
    if(controller.signal.aborted)showTransientInfo('Summary stopped. Previous checkpoint kept.');
    else showTransientError("Summarization failed: " + (err.message || String(err)));
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
    renderMessages(lastMessages);
    updateIndicator();
    queueCacheSave();
    setStatus("Summary checkpoint reset.", true);
  } catch (err) {
    showTransientError("Reset failed: " + (err.message || String(err)));
  } finally {releaseBusy(token);}
}

// ---------- streaming UI ----------

function restoreStreamUI() {
  const current=streamState;streamState=null;
  if(!current)return;
  if(current.frame)cancelAnimationFrame(current.frame);
  current.wrap.remove();
  if(current.continuationId){const entry=renderedMessages.get(current.continuationId);if(entry)entry.message=null;renderMessages(lastMessages);}
}

function startStreamUI(prefix=null) {
  const sticky=wasNearBottom && isNearBottom();
  setPreparing(false);
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

  if(prefix) {
    const existing=renderedMessages.get(prefix.id)?.node;
    if(!existing)throw new Error('The continuation reply is no longer visible.');
    existing.replaceWith(wrap);wrap.dataset.messageId=prefix.id;
    renderedMessages.get(prefix.id).node=wrap;
    content.textContent=prefix.content;
  }else el.list.appendChild(wrap);
  if(sticky) scrollToEnd();

  streamState = {
    wrap, thinking, thinkingBody: thinking.querySelector(".thinking-body"), content,
    thinkingText: prefix?.thinking ?? "", contentText: "", prefix:prefix?.content ?? "",continuationId:prefix?.id ?? null, frame: 0,
  };
  updateWelcome();
}

function updateStreamText(node,text) {
  const previous=node.textContent;
  if(previous===text)return;
  const child=node.firstChild;
  if(child?.nodeType===3 && child===node.lastChild && text.startsWith(previous))child.appendData(text.slice(previous.length));
  else node.textContent=text;
}
function setPreparing(active) {
  const node=document.getElementById('composer-preparing');
  if(node)node.hidden=!active;
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
      const sticky = wasNearBottom && isNearBottom();
      const visible = current.prefix ? current.prefix+'\n\n'+stripPlan(current.contentText) : stripPlan(current.contentText);
      updateStreamText(current.content,visible);
      updateStreamText(current.thinkingBody,current.thinkingText.slice(-4000));
      if (sticky) scrollToEnd();
    });
  }
}

// ---------- helpers ----------

function updateMessageControls() {
  for(const [id,{node}] of renderedMessages){
    if(editingState?.id===id)continue;
    for(const button of node.querySelectorAll('button')){
    if(button.className?.includes('message-copy'))continue;
    button.disabled=busy;
    if(button.className==='retry')button.hidden=busy;
    }
  }
}
let busyUiQueued=false;
function applyBusyUi(b) {
  busy = state.busy = b;
  if(!b)setPreparing(false);
  if(el.sendBtn)el.sendBtn.disabled=b;
  if(!b){if(el.sendBtn)el.sendBtn.hidden=false;el.stopBtn?.classList.add('hidden');if(el.stopBtn)el.stopBtn.disabled=false;}
  if(el.quickProfile)el.quickProfile.disabled=b;
  if(el.quickDirector)el.quickDirector.disabled=b;
  if(el.quickThinking)el.quickThinking.disabled=b;
  if(el.summarizeBtn)el.summarizeBtn.disabled=b;
  if(busyUiQueued)return;
  busyUiQueued=true;
  requestAnimationFrame(()=>{
    busyUiQueued=false;updateRewriteControls();updateMemoryChip();updateMessageControls();
  });
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
  const next=Math.max(0,Math.min(el.list.scrollTop,Math.max(0,el.list.scrollHeight-el.list.clientHeight)));
  if(el.list.scrollTop!==next)el.list.scrollTop=next;
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
    const delta=node.getBoundingClientRect().top-position.top;
    if(delta)el.list.scrollTop+=delta;
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

function reconcileDeletedMemory(deleted) {
  if (!session || !normalizeMemory(session.memory).autoUpdate && !loreEntries.length) return;
  const messages = historyMessages;
  const orders = messages ? new Set(messages.filter(m => m.role === 'assistant').map(m => m.order)) : null;
  const lastOrder = messages ? Math.max(0,maxOf(messages.map(m => m.order))) : 0;
  const fromDeletedTurn = line => line.src != null && (
    deleted?.role === 'assistant' && line.src === deleted.order ||
    orders && line.src <= lastOrder && !orders.has(line.src)
  );
  const count = loreEntries.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+s.lines.filter(fromDeletedTurn).length,0),0);
  if (count) document.dispatchEvent(new CustomEvent('memory-toast', { detail: { text: `${count} memory notes came from deleted turns.`, action: 'Review', event: 'lorebooks', options: { filter: 'deleted' } } }));
  rememberMemoryStory();
}
