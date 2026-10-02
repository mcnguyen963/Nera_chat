import { requestSource, usableLore } from './continuity.js';
import { normalizeMemory } from './memory-settings.js';
import { dueRange } from './turns.js';
import { buildExtractionMessages } from './memory-prompts.js';
import { parseMemoryLines, applyOps } from './lore-lines.js';
import { chatCompletion } from './llm-client.js';
import { countTokens } from './tokenizer.js';
import { commitExtraction, markGeneratedForReview } from './lore-store.js';
import { updateSession } from './sessions.js';
import { currentUid } from './auth.js';
const inFlight = new Map(), rawAnswers = new Map();
let runtime = null;
export function configureMemoryUpdater(value) { runtime = value; }
export function isRunning(sid) { return inFlight.has(sid); }
export function lastRawAnswer(sid) { return rawAnswers.get(sid) ?? ''; }
export function stop(sid) { inFlight.get(sid)?.abort(); }
export function stopAll() { for (const controller of inFlight.values()) controller.abort(); }
const emit = detail => document.dispatchEvent(new CustomEvent('memory-status',{ detail }));
const editTime = value => value?.toMillis?.() ?? (typeof value?.seconds === 'number' ? value.seconds*1000+Math.floor((value.nanoseconds ?? 0)/1e6) : value instanceof Date ? value.getTime() : value ?? null);
const stamp = messages => JSON.stringify(messages.map(m => ({ id:m.id,order:m.order,editedAt:editTime(m.editedAt),content:m.content,scene:m.scene })));
export function rangeUnchanged(range,messages,snapshot) { return stamp(messages.filter(m => range.messages.some(r => r.id === m.id))) === snapshot; }
export function shouldSkipAutoSummary(mem, running, due) { return running || mem.autoUpdate && !!due; }
export function maybeStartAfterTurn(sid) {
  const live = runtime?.get(sid); if (!live) return false;
  const mem = normalizeMemory(live.session.memory);
  if (!mem.autoUpdate || live.session.memoryState?.needsRebuild || live.session.memoryState?.paused || isRunning(sid)) return false;
  const range = dueRange(live.messages,live.session.memoryState,mem);
  if (!range) return false;
  void start(sid,range,false).catch(e => console.error('Memory update:',e)); return true;
}
export async function updateNow(sid,{ retry = false } = {}) {
  if (isRunning(sid) || runtime?.busy()) return false;
  await runtime?.prepare?.(sid);
  const live = runtime?.get(sid); if (!live) throw new Error('Open the story first.');
  if (retry) { await updateSession(sid,{ 'memoryState.paused':false,'memoryState.failureStreak':0 }); runtime.patch(sid,{ paused:false,failureStreak:0 }); }
  const range = dueRange(live.messages,live.session.memoryState,normalizeMemory(live.session.memory),{ manual:true });
  if (!range) { emit({ sessionId:sid,status:'idle',message:'Waiting for more eligible turns.',manual:true }); return false; }
  return start(sid,range,true);
}
export async function rebuild(sid, options = {}) {
  if (isRunning(sid) || runtime?.busy()) return false;
  await runtime?.prepare?.(sid);
  await markGeneratedForReview(sid);
  await runtime?.prepare?.(sid);
  await updateSession(sid,{ 'memoryState.extractedThroughOrder':0,'memoryState.paused':false,'memoryState.needsRebuild':false,'memoryState.failureStreak':0 });
  runtime.patch(sid,{ extractedThroughOrder:0,paused:false,needsRebuild:false,failureStreak:0 });
  await catchUp(sid,options);
  return true;
}
export async function catchUp(sid,{ signal,onProgress } = {}) {
  await runtime?.prepare?.(sid);
  let i = 0;
  while (!signal?.aborted) {
    const live = runtime?.get(sid), mem = normalizeMemory(live?.session.memory);
    if (!live) break;
    const range = dueRange(live.messages,live.session.memoryState,mem,{ manual:true }); if (!range) break;
    onProgress?.({ range,index:++i });
    const cancel = () => stop(sid); signal?.addEventListener('abort',cancel,{ once:true });
    try { if (!await start(sid,range,true)) break; } finally { signal?.removeEventListener('abort',cancel); }
  }
}
async function start(sid,range,manual) {
  if (isRunning(sid)) return false;
  const controller = new AbortController(),owner = currentUid();
  let live,mem,settings,source,entries;
  inFlight.set(sid,controller); emit({ sessionId:sid,status:'running' });
  try {
    await runtime?.prepare?.(sid);
    if (controller.signal.aborted || currentUid() !== owner) return false;
    live = runtime.get(sid); if (!live) return false;
    mem = normalizeMemory(live.session.memory); settings = structuredClone(live.settings); source = structuredClone(live.messages); entries = structuredClone(live.entries);
    range = dueRange(source,live.session.memoryState,mem,{ manual }); if (!range) return false;
    const built = await buildExtractionMessages({ settings,mem,entries:usableLore(entries,source,live.session).entries,messages:source,range,count:countTokens }); range = built.range;
    const snapshot = stamp(range.messages);
    const expectedSource = requestSource(live.session);
    const result = await chatCompletion({ settings:{ ...settings,reasoning:{ ...settings.reasoning,enabled:false },maxResponseTokens:mem.updateMaxTokens },messages:built.messages,onDelta:() => {},signal:controller.signal });
    rawAnswers.set(sid,result.content);
    const parsed = parseMemoryLines(result.content,{ range,mem,messages:source,protagonist:mem.protagonist });
    if (!parsed.valid) throw new Error("The model's answer wasn't in the note format.");
    await runtime.waitIdle(controller.signal);
    if (controller.signal.aborted || currentUid() !== owner) return false;
    const latest = runtime.get(sid);
    if (!latest || JSON.stringify(requestSource(latest.session)) !== JSON.stringify(expectedSource) || !rangeUnchanged(range,latest.messages,snapshot)) { console.info('Discarded stale memory update for',sid); return false; }
    // Reapply against current cards so a manual edit or alias change wins.
    const changes = applyOps(latest.entries,parsed.ops,{ mem:normalizeMemory(latest.session.memory),protagonist:mem.protagonist,sourceRevision:expectedSource.historyRevision,messages:latest.messages,session:latest.session });
    if (changes.skipped.length) throw new Error(changes.skipped[0].reason);
    await commitExtraction(sid,changes,{ ...range,expectedSource });
    runtime.patch(sid,{ extractedThroughOrder:range.endOrder,lastUpdateTurns:range.fromTurn+'–'+range.toTurn,failureStreak:0,lastError:null,paused:false },changes.entries);
    const notes = changes.appends.length+changes.creates.reduce((n,e) => n+Object.values(e.sections).reduce((n,s) => n+s.lines.length,0),0);
    emit({ sessionId:sid,status:'success',range,notes,drafts:changes.creates.filter(e => e.book === 'characters').length,manual,skipped:[...parsed.skipped,...changes.skipped] }); return true;
  } catch (error) {
    if (controller.signal.aborted || currentUid() !== owner) return false;
    await runtime.waitIdle(controller.signal);
    if (controller.signal.aborted || !runtime.get(sid)) return false;
    const failureStreak = (runtime.get(sid).session.memoryState?.failureStreak ?? 0)+1;
    const lastError = /output limit|cut off/i.test(error.message) ? "The update was cut off. Raise 'Max response tokens for updates' in Memory settings." : String(error.message).slice(0,240);
    await updateSession(sid,{ 'memoryState.failureStreak':failureStreak,'memoryState.lastError':lastError,'memoryState.paused':failureStreak>=3 });
    runtime.patch(sid,{ failureStreak,lastError,paused:failureStreak>=3 }); emit({ sessionId:sid,status:'failed',failureStreak,lastError,manual }); return false;
  } finally { inFlight.delete(sid); emit({ sessionId:sid,status:'idle' }); }
}
