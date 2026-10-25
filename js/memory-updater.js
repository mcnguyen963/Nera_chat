import { requestSource, usableLore, effectivelyPaused, StaleSourceError, SupersededError, assertExtractionSource } from './continuity.js';
import { normalizeMemory, memoryTaskSettings } from './memory-settings.js';
import { dueRange, alongsideTurnRange } from './turns.js';
import { buildExtractionMessages } from './memory-prompts.js';
import { parseMemoryLines, applyOps } from './lore-lines.js';
import { chatCompletion } from './llm-client.js';
import { countTokens } from './tokenizer.js';
import { commitExtraction, markGeneratedForReview } from './lore-store.js';
import { updateSession } from './sessions.js';
import { clearMemoryInvalidations, recordMemoryFailure } from './session-memory.js';
import { limitSkippedNotes } from './memory-skipped.js';
import { currentUid } from './auth.js';
const inFlight = new Map(), rawAnswers = new Map();
let runtime = null;
export function configureMemoryUpdater(value) { runtime = value; }
export function isRunning(sid) { return inFlight.has(sid); }
export function lastRawAnswer(sid) { return rawAnswers.get(sid) ?? ''; }
export function stop(sid) { inFlight.get(sid)?.abort(); }
export async function stopAndWait(sid) {
  const controller=inFlight.get(sid);controller?.abort();
  // A provider may ignore abort. Wait only for a write already underway.
  await controller?.committing?.catch(()=>{});
  if(controller && inFlight.get(sid)===controller){inFlight.delete(sid);emit({sessionId:sid,status:'idle'});}
}
export function stopAll() { for (const controller of inFlight.values()) controller.abort(); }
const emit = detail => document.dispatchEvent(new CustomEvent('memory-status',{ detail }));
const editTime = value => value?.toMillis?.() ?? (typeof value?.seconds === 'number' ? value.seconds*1000+Math.floor((value.nanoseconds ?? 0)/1e6) : value instanceof Date ? value.getTime() : value ?? null);
const stamp = messages => JSON.stringify(messages.map(m => ({ id:m.id,order:m.order,role:m.role,content:m.content,scene:m.scene,sceneMeta:m.sceneMeta,revision:m.revision })));
export function rangeUnchanged(range,messages,snapshot) { return stamp(messages.filter(m => range.messages.some(r => r.id === m.id))) === snapshot; }
export function shouldSkipAutoSummary(mem, running, due) { return running || mem.autoUpdate && !!due; }
export function maybeStartAfterTurn(sid) {
  const live = runtime?.get(sid); if (!live) return false;
  const mem = normalizeMemory(live.session.memory);
  if (!mem.autoUpdate || effectivelyPaused(live.session.memoryState) || isRunning(sid)) return false;
  const range = dueRange(live.messages,live.session.memoryState,mem);
  if (!range) return false;
  void start(sid,range,false).catch(e => console.error('Memory update:',e)); return true;
}
export function maybeStartAlongsideTurn(sid, snapshot) {
  const current = runtime?.get(sid);
  if (!snapshot || !current || snapshot.session.id !== sid || current.session.id !== sid || snapshot.storyEpoch !== current.storyEpoch || isRunning(sid)) return false;
  const mem = normalizeMemory(snapshot.session.memory);
  if (!mem.autoUpdate || effectivelyPaused(snapshot.session.memoryState)) return false;
  const range = alongsideTurnRange(snapshot.messages,snapshot.session.memoryState,mem);
  if (!range) return false;
  const captured = structuredClone({session:snapshot.session,settings:snapshot.settings,messages:snapshot.messages,entries:snapshot.entries,storyEpoch:snapshot.storyEpoch,range});
  void start(sid,captured.range,false,captured).catch(e => console.error('Memory update:',e)); return true;
}
const sameOwner=owner=>{try{return currentUid()===owner;}catch{return false;}};
// Manual maintenance keeps its initiating account/story across preparation and batches.
function maintenanceScope(sid) {
  const owner=currentUid(),epoch=runtime?.get(sid)?.storyEpoch;
  const activeAtStart=runtime?.get()?.session?.id===sid;
  const current=()=>sameOwner(owner) && (epoch==null || runtime?.get(sid)?.storyEpoch===epoch) && (!activeAtStart || runtime?.get()?.session?.id===sid);
  return {current,check(){if(!current())throw new StaleSourceError('Account or story changed; memory action cancelled.');}};
}
export async function updateNow(sid,{ retry = false } = {}) {
  if (isRunning(sid) || runtime?.busy()) return false;
  const scope=maintenanceScope(sid);
  await runtime?.prepare?.(sid);scope.check();
  if(isRunning(sid))return false;
  const live = runtime?.get(sid); if (!live) throw new Error('Open the story first.');
  if (retry) { await updateSession(sid,{ 'memoryState.paused':false,'memoryState.failureStreak':0 }); scope.check();runtime.patch(sid,{ paused:false,failureStreak:0 }); }
  const range = dueRange(live.messages,live.session.memoryState,normalizeMemory(live.session.memory),{ manual:true });
  if (!range) { emit({ sessionId:sid,status:'idle',message:'Waiting for more eligible turns.',manual:true }); return false; }
  return start(sid,range,true,null,scope);
}
export async function rebuild(sid, options = {}) {
  if (isRunning(sid) || runtime?.busy()) return false;
  const scope=maintenanceScope(sid);
  await runtime?.prepare?.(sid);scope.check();
  if(isRunning(sid))return false;
  const live=runtime?.get(sid);if(!live)return false;
  const seenRevision=live.session.historyRevision ?? 0;
  const changed=await markGeneratedForReview(sid);scope.check();
  const cleared=await clearMemoryInvalidations(sid,{seenRevision,fromOrder:0,pointer:0});scope.check();
  const latest=runtime?.get(sid);if(latest)latest.session.memoryInvalidations=cleared.memoryInvalidations;
  runtime.patch(sid,cleared.memoryState,changed);
  const finished=await catchUpScoped(sid,options,scope);scope.check();
  offerRebuildCleanup(sid,0,options);
  return finished;
}
export async function catchUp(sid,options = {}) {
  return catchUpScoped(sid,options,maintenanceScope(sid));
}
async function catchUpScoped(sid,{ signal,onProgress } = {},scope) {
  await runtime?.prepare?.(sid);scope.check();
  let i = 0;
  while (!signal?.aborted) {
    scope.check();
    const live = runtime?.get(sid), mem = normalizeMemory(live?.session.memory);
    if (!live) return false;
    const range = dueRange(live.messages,live.session.memoryState,mem,{ manual:true }); if (!range) return true;
    onProgress?.({ range,index:++i });scope.check();
    const cancel = () => stop(sid); signal?.addEventListener('abort',cancel,{ once:true });
    try { if (!await start(sid,range,true,null,scope)) return false; } finally { signal?.removeEventListener('abort',cancel); }
  }
  return false;
}
async function start(sid,range,manual,captured=null,scope=null) {
  scope?.check();
  if (isRunning(sid)) return false;
  const controller = new AbortController(),owner = currentUid();
  let live,mem,settings,source,entries,streamedAnswer='';
  const stillCurrent = () => {
    if (controller.signal.aborted || !sameOwner(owner) || scope && !scope.current()) return false;
    if (!captured) return true;
    const latest=runtime?.get(sid);
    return !!latest && latest.storyEpoch===captured.storyEpoch;
  };
  const waitForWrites = async () => {
    await runtime.waitIdle(controller.signal);
    if (!stillCurrent()) return;
    await runtime.flush?.(sid);
    if (stillCurrent()) await runtime.waitIdle(controller.signal);
  };
  inFlight.set(sid,controller); rawAnswers.delete(sid); emit({ sessionId:sid,status:'running' });
  try {
    if (!captured) await runtime?.prepare?.(sid);
    if (!stillCurrent()) return false;
    live = captured ?? runtime.get(sid); if (!live) return false;
    mem = normalizeMemory(live.session.memory); settings = structuredClone(memoryTaskSettings(live.settings,mem));
    source = captured ? live.messages : structuredClone(live.messages); entries = captured ? live.entries : structuredClone(live.entries);
    if (!captured) range = dueRange(source,live.session.memoryState,mem,{ manual });
    if (!range) return false;
    const built = await buildExtractionMessages({ settings,mem,entries:usableLore(entries,source,live.session,Infinity,null,{includeArchived:true}).entries,messages:source,range,count:countTokens }); range = built.range;
    if(!stillCurrent())return false;
    const snapshot = stamp(range.messages);
    const guard={storySettingsRevision:settings._storySettingsRevision,startPointer:live.session.memoryState?.extractedThroughOrder ?? 0,startRevision:live.session.historyRevision ?? 0,fromOrder:range.messages[0].order,endOrder:range.endOrder,owner};
    const result = await chatCompletion({ settings,messages:built.messages,onDelta:t => { streamedAnswer+=t; },signal:controller.signal });
    if(!stillCurrent())return false;
    rawAnswers.set(sid,result.content);
    const parsed = parseMemoryLines(result.content,{ range,mem,entries,messages:source,protagonist:mem.protagonist });
    if (!parsed.valid) throw new Error("The model's answer wasn't in the note format."+(parsed.skipped[0] ? ' Line '+parsed.skipped[0].line+': '+parsed.skipped[0].reason+'.' : ''));
    await waitForWrites();
    if (!stillCurrent()) return false;
    const latest = runtime.get(sid);
    if(!latest)return false;
    assertExtractionSource(latest.session,guard);
    if(!rangeUnchanged(range,latest.messages,snapshot))throw new StaleSourceError('Messages in this range were edited during the update.');
    const latestMem=normalizeMemory(latest.session.memory);
    if(!manual && !latestMem.autoUpdate)return false;
    guard.loreRevision=latest.session.loreRevision ?? 0;
    const changes=applyOps(latest.entries,parsed.ops,{mem:latestMem,protagonist:mem.protagonist,sourceRevision:guard.startRevision,messages:latest.messages,session:latest.session});
    const skipped=[...parsed.skipped,...changes.skipped,...(parsed.adjusted ?? [])].map(note=>({...note,card:note.card ?? note.name ?? latest.entries.find(e=>e.id===note.entryId)?.name ?? ''}));
    controller.committing=commitExtraction(sid,changes,{...range,guard,skipped,signal:controller.signal});
    const committed=await controller.committing;
    if(!stillCurrent())return false;
    const lastSkipped=committed?.lastSkipped ?? limitSkippedNotes([...skipped,...(committed?.skipped ?? [])]);
    const nextEntries=committed?.entries ? latest.entries.filter(e=>!committed.entries.some(w=>w.id===e.id)).concat(committed.entries) : changes.entries;
    // Real commits publish their canonical entries once through local-lore-saved.
    runtime.patch(sid,{extractedThroughOrder:range.endOrder,lastUpdateTurns:range.fromTurn+'–'+range.toTurn,failureStreak:0,lastError:null,paused:false,lastSkipped},committed?.cacheApplied ? undefined : nextEntries,committed?.loreRevision);
    const notes = committed?.notes ?? changes.appends.length+changes.creates.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+s.lines.length,0),0);
    emit({ sessionId:sid,status:'success',range,notes,drafts:changes.creates.filter(e => e.book === 'characters').length,manual,skipped:[...parsed.skipped,...changes.skipped,...(committed?.skipped ?? [])] }); return true;
  } catch (error) {
    if(!stillCurrent())return false;
    if(error instanceof StaleSourceError || error instanceof SupersededError){emit({sessionId:sid,status:'info',message:error.message,manual});return false;}
    if (error.partial?.content || streamedAnswer) rawAnswers.set(sid,error.partial?.content || streamedAnswer);
    try { await waitForWrites(); }
    catch(saveError) {
      if(stillCurrent())emit({sessionId:sid,status:'info',message:'Memory update could not be saved: '+String(saveError.message).slice(0,240),manual});
      return false;
    }
    if (!stillCurrent() || !runtime.get(sid)) return false;
    const lastError = /output limit|cut off/i.test(error.message) ? "The update was cut off. Raise 'Max response tokens for updates' in Memory settings." : /card storage full/i.test(error.message) ? 'A memory card is full. Reorganize it, then retry; no turns were marked updated.' : String(error.message).slice(0,240);
    controller.committing=recordMemoryFailure(sid,lastError);
    const failure=await controller.committing;
    if(!stillCurrent())return false;
    runtime.patch(sid,failure); emit({ sessionId:sid,status:'failed',...failure,manual }); return false;
  } finally { if(inFlight.get(sid)===controller){inFlight.delete(sid);emit({ sessionId:sid,status:'idle' });} }
}

export function dueRangeFor(sid) {
  const live=runtime?.get(sid);if(!live)return null;
  const mem=normalizeMemory(live.session.memory);
  return mem.autoUpdate && !effectivelyPaused(live.session.memoryState) ? dueRange(live.messages,live.session.memoryState,mem) : null;
}
export async function rebuildFrom(sid,fromOrder,options={}) {
  if(isRunning(sid) || runtime?.busy())return false;
  const scope=maintenanceScope(sid);
  await runtime?.prepare?.(sid);scope.check();
  if(isRunning(sid))return false;
  const live=runtime?.get(sid);if(!live)return false;
  const seenRevision=live.session.historyRevision ?? 0;
  const previous=live.messages.filter(m=>m.role==='assistant' && m.order<fromOrder).at(-1)?.order ?? 0;
  const changed=await markGeneratedForReview(sid,fromOrder);scope.check();
  const cleared=await clearMemoryInvalidations(sid,{seenRevision,fromOrder,pointer:previous});scope.check();
  const latest=runtime?.get(sid);if(latest)latest.session.memoryInvalidations=cleared.memoryInvalidations;
  runtime.patch(sid,cleared.memoryState,changed);
  const finished=await catchUpScoped(sid,options,scope);scope.check();offerRebuildCleanup(sid,fromOrder,options);return finished;
}

function offerRebuildCleanup(sid,fromOrder,options) {
  if(options.signal?.aborted)return;
  const live=runtime?.get(sid);if(!live)return;
  const throughOrder=live.session.memoryState?.extractedThroughOrder ?? 0;
  const count=live.entries.reduce((n,e)=>n+Object.values(e.sections).reduce((n,s)=>n+(s.lines ?? []).filter(l=>l.needsReview && !['user','import'].includes(l.by) && l.src!=null && l.src>=fromOrder && l.src<=throughOrder).length,0),0);
  if(count)emit({sessionId:sid,status:'rebuild-review',count,fromOrder,throughOrder});
}
