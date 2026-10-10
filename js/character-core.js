import { cardFingerprint } from './lore-card-state.js';
import { SECTION_KEYS, newLoreId } from './lore-lines.js';
import { sectionMeta, noteNeedsReview, snapshotNeedsReview } from './continuity.js';
export const CORE_COVERAGE = ['personality','constraints','appearance'];
// Fingerprint the complete source, not just a matching excerpt. A changed
// qualification, provenance or note must require a fresh human review.
export function coreSource(entry, section, lineId = null, start = 0, end = null) {
  if (entry.book !== 'characters' || !SECTION_KEYS.characters.includes(section)) throw new Error('Choose a character section.');
  const s = entry.sections[section], line = lineId == null ? null : s?.lines?.find(l => l.id === lineId);
  if (!s || lineId != null && !line) throw new Error('Core source no longer exists.');
  const text = line ? line.text : s.text;
  end ??= text.length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) throw new Error('Select a nonempty source passage.');
  // Notes are indivisible. Text passages are explicitly reviewed together.
  if (line && (start !== 0 || end !== text.length)) throw new Error('Include the complete note with its conditions.');
  return { section,lineId,start,end,fingerprint:cardFingerprint(line ?? {text:s.text,...sectionMeta(s,entry),unavailable:!!s.unavailable,sourceRevision:s.sourceRevision ?? 0}) };
}
export function reviewCore(entry, sources, coverage = CORE_COVERAGE) {
  if (!sources.length || !coverage.length || coverage.some(k => !CORE_COVERAGE.includes(k))) throw new Error('Choose sources and core coverage.');
  const refs = sources.map(r => {
    const current=coreSource(entry,r.section,r.lineId,r.start,r.end);
    if (r.fingerprint !== current.fingerprint) throw new Error('Core source changed during review. Select the passage again.');
    return current;
  });
  return { id:newLoreId('core'),reviewed:true,coverage:[...new Set(coverage)],sources:refs };
}
export function resolveCore(entry, bundle, evidenceContext = null) {
  if (bundle?.reviewed !== true || !Array.isArray(bundle.sources) || !bundle.sources.length || !Array.isArray(bundle.coverage) || !bundle.coverage.length || bundle.coverage.some(k => !CORE_COVERAGE.includes(k))) return {valid:false,reason:'Core bundle needs user review',sources:[]};
  try {
    const sources = bundle.sources.map(r => {
      const section=entry.sections[r.section],line=r.lineId==null ? null : section?.lines?.find(l=>l.id===r.lineId);
      if (evidenceContext && (r.lineId==null ? snapshotNeedsReview(section ?? {},entry,evidenceContext.session,evidenceContext.upToOrder) : !line || noteNeedsReview(line,evidenceContext.messages ?? [],evidenceContext.session,evidenceContext.upToOrder))) throw new Error('Core source has stale or unavailable evidence; review the source first');
      const current = coreSource(entry,r.section,r.lineId,r.start,r.end);
      if (current.fingerprint !== r.fingerprint) throw new Error('Core source changed or is unavailable; review the complete bundle');
      const s = entry.sections[r.section], text = r.lineId == null ? s.text : s.lines.find(l => l.id === r.lineId).text;
      return {...current,text:text.slice(r.start,r.end)};
    });
    return {valid:true,sources,coverage:[...bundle.coverage]};
  } catch (e) { return {valid:false,reason:e.message,sources:[]}; }
}
export function validateCoreReferences(references) {
  if (references == null) return;
  const ids=new Set();
  if (!Array.isArray(references)) throw new Error('Invalid reviewed core references.');
  for (const b of references) {
    if (!b || typeof b.id!=='string' || !b.id || ids.has(b.id) || b.reviewed!==true || !Array.isArray(b.coverage) || !b.coverage.length || b.coverage.some(k=>!CORE_COVERAGE.includes(k)) || !Array.isArray(b.sources) || !b.sources.length) throw new Error('Invalid reviewed core references.');
    ids.add(b.id);
    for (const r of b.sources) if (!r || !SECTION_KEYS.characters.includes(r.section) || r.lineId!=null && typeof r.lineId!=='string' || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start<0 || r.end<=r.start || typeof r.fingerprint!=='string') throw new Error('Invalid reviewed core source.');
  }
}
