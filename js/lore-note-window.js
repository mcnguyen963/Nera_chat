import { sortLines } from './lore-lines.js';
import { resolveCore } from './character-core.js';
import { resolveRecord, approvedRecord, validSupersession } from './lore-records.js';

// Request-only metadata: symbols survive local spreads, but never enter JSON or
// persisted card documents. Resolve approvals against complete sources first.
const WINDOW = Symbol('lore note window');
const keyOf = (section,id) => JSON.stringify([section,id]);
const generated = line => line.by==='auto' || line.by==='reorganize';
export const noteOmissions = entry => entry[WINDOW]?.omitted ?? [];
export const cappedRecordReason = (entry,id) => entry[WINDOW]?.recordReasons.get(id);
export const supersededBeforeCap = entry => entry[WINDOW]?.replaced ?? new Set();

export function capLoreNotes(entry,limit=3) {
  if(!Number.isSafeInteger(limit) || limit<0)limit=3;
  if(entry.book==='plan' || entry[WINDOW]?.limit===limit)return entry;
  if(limit===0)return entry;
  const protectedIds=new Set(),pinnedIds=new Set(),records=entry.recordLayout?.records ?? [];
  const replaced=new Set(records.filter(r=>validSupersession(entry,r)).flatMap(r=>r.supersedes));
  if(entry.book==='characters')for(const bundle of entry.coreReferences ?? []) {
    const core=resolveCore(entry,bundle);
    if(core.valid)for(const s of core.sources)if(s.lineId!=null)protectedIds.add(keyOf(s.section,s.lineId));
  }
  const resolved=records.map(record=>({record,result:resolveRecord(entry,record)}));
  for(const {record,result} of resolved) {
    if(!result.valid || replaced.has(record.id))continue;
    const core=entry.book==='characters' && approvedRecord(entry,record);
    if(!core && !record.pinned)continue;
    for(const s of result.sources)if(s.lineId!=null)(core ? protectedIds : pinnedIds).add(keyOf(s.section,s.lineId));
  }
  const omitted=[],excluded=new Map();
  const sections=Object.fromEntries(Object.entries(entry.sections ?? {}).map(([section,s])=>{
    const lines=s.lines ?? [],ordinary=[],pinned=[];
    for(const line of sortLines(lines)) {
      const key=keyOf(section,line.id);
      if(generated(line) && !protectedIds.has(key))(pinnedIds.has(key) ? pinned : ordinary).push(line);
    }
    for(const [group,kind] of [[ordinary,'ordinary'],[pinned,'pinned']])for(const line of group.slice(0,Math.max(0,group.length-limit))) {
      const reason=kind==='pinned' ? 'pinned generated note limit' : 'generated note limit';
      const omission={entryId:entry.id,book:entry.book,name:entry.name,section,lineId:line.id,text:line.text,kind,reason,limit};
      excluded.set(keyOf(section,line.id),omission);omitted.push(omission);
    }
    return [section,{...s,lines:lines.filter(line=>!excluded.has(keyOf(section,line.id)))}];
  }));
  const recordReasons=new Map();
  for(const {record,result} of resolved)if(result.valid) {
    const omission=result.sources.map(s=>excluded.get(keyOf(s.section,s.lineId))).find(Boolean);
    if(omission)recordReasons.set(record.id,omission.reason);
  }
  return {...entry,sections,[WINDOW]:{limit,omitted,recordReasons,replaced}};
}

export function noteLimitStats(entry) {
  const omitted=noteOmissions(entry);
  return {noteLimitCut:omitted.filter(n=>n.kind==='ordinary').length,pinnedNoteLimitCut:omitted.filter(n=>n.kind==='pinned').length};
}

// Account for cap omissions separately from additional token-budget omissions.
export function fittedNoteStats(entry,lineIds,companions=[]) {
  const stats=noteLimitStats(entry),eligible=Object.values(entry.sections ?? {}).reduce((n,s)=>n+(s.lines?.length ?? 0),0);
  stats.noteLimitCut+=companions.filter(n=>n.kind==='ordinary').length;
  stats.pinnedNoteLimitCut+=companions.filter(n=>n.kind==='pinned').length;
  const budgetLinesCut=Math.max(0,eligible-lineIds.size-companions.length);
  return {...stats,budgetLinesCut,linesSent:lineIds.size,linesCut:budgetLinesCut+stats.noteLimitCut+stats.pinnedNoteLimitCut};
}
