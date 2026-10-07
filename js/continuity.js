import { prompts } from './system-prompts.js';
// Shared provenance and chronology contract. Classification is additive for old data.
export const CONTINUITY_RULE = prompts.continuity;
export const revisionOf = m => m.revision ?? 0;
export function evidenceFor(messages) { return messages.map(m => ({ id:m.id, revision:revisionOf(m), order:m.order })); }
export function sectionMeta(section, entry) {
  return { origin:section.origin ?? (entry?.createdFrom === 'user' ? 'user' : 'import'), kind:section.kind ?? (entry?.createdFrom === 'user' ? 'canon' : 'background'), cutoff:section.cutoff ?? null };
}
export function cutoffLabel(cutoff) {
  if (!cutoff) return 'unknown cutoff';
  return [cutoff.turn != null ? `T${cutoff.turn}` : null, cutoff.order != null ? `message order ${cutoff.order}` : null, cutoff.when].filter(Boolean).join(' · ') || 'unknown cutoff';
}
export function noteNeedsReview(line, messages, session = {}, upToOrder = Infinity) {
  if (line.needsReview || line.kind === 'snapshot' && snapshotNeedsReview(line,null,session,upToOrder)) return true;
  if (line.by === 'user' || line.by === 'import') return false;
  if (!line.evidence?.length) return true;
  const byId = new Map(messages.map(m => [m.id,m]));
  if (line.evidence.some(e => !byId.has(e.id) || revisionOf(byId.get(e.id)) !== e.revision || byId.get(e.id).order >= upToOrder)) return true;
  return false;
}
export function snapshotNeedsReview(section, entry, session = {}, upToOrder = Infinity) {
  const meta = sectionMeta(section,entry);
  return !!(section.unavailable || meta.kind === 'snapshot' && (meta.cutoff?.order >= upToOrder));
}
export function usableLore(entries, messages, session, upToOrder = Infinity) {
  const skipped = [], available = entries.map(entry => ({ ...entry,...(entry.statusSource && noteNeedsReview(entry.statusSource,messages,session,upToOrder) ? { status:'open' } : {}),sections:Object.fromEntries(Object.entries(entry.sections).map(([key,s]) => {
    const meta = sectionMeta(s,entry);
    const unavailable = snapshotNeedsReview(s,entry,session,upToOrder);
    if (unavailable && s.text) skipped.push({ entryId:entry.id,book:entry.book,name:entry.name,reason:`${key}: snapshot needs review` });
    const lines = (s.lines ?? []).filter(l => {
      const stale = noteNeedsReview(l,messages,session,upToOrder);
      if (stale) skipped.push({ entryId:entry.id,book:entry.book,name:entry.name,lineId:l.id,reason:'Needs review: stale or unverified evidence' });
      return !stale;
    });
    return [key,{ ...s,...meta,text:unavailable ? '' : s.text,lines }];
  })) }));
  return { entries:available, skipped };
}
export function requestSource(session) {
  return { historyRevision:session.historyRevision ?? 0, longTermPlan:session.longTermPlan ?? '', memory:JSON.stringify(session.memory ?? null), loreRevision:session.loreRevision ?? 0, activeSummaryMessageId:session.activeSummaryMessageId ?? null, breakpointOrder:session.breakpointOrder ?? 0 };
}
export function assertSource(session, expected) {
  if (!expected) return;
  if (!session || JSON.stringify(requestSource(session)) !== JSON.stringify(expected)) throw new Error('Story history or author inputs changed. The generated result was discarded; try again.');
}

export class StaleSourceError extends Error {constructor(message){super(message);this.name='StaleSourceError';}}
export class SupersededError extends Error {constructor(message){super(message);this.name='SupersededError';}}
export function effectivelyPaused(ms={}) {return !!ms.paused && !(String(ms.lastError ?? '').startsWith('History changed') && (ms.failureStreak ?? 0)<3);}
export function trimInvalidations(list,cap=50) {
  if(list.length<=cap)return list;
  const old=list.slice(0,list.length-cap+1);
  return [{fromOrder:Math.min(...old.map(i=>i.fromOrder)),revision:Math.max(...old.map(i=>i.revision))},...list.slice(-(cap-1))];
}
export function assertExtractionSource(s,guard) {
  if(!s)throw new SupersededError('Story deleted.');
  if((s.memoryState?.extractedThroughOrder ?? 0)!==guard.startPointer)throw new SupersededError('Another update already covered these turns.');
  if((s.contentEditsFloor ?? 0)>guard.startRevision || (s.contentEdits ?? []).some(e=>e.revision>guard.startRevision && e.order>=guard.fromOrder && e.order<=guard.endOrder))throw new StaleSourceError('Messages in this range were edited during the update.');
}
