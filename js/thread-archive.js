import {parseStoryDate,parseClock} from './story-calendar.js';

export function validateThreadHistory(history) {
  if(history==null)return;
  if(history.version!==1 || !history.opened || typeof history.restored!=='boolean')throw new Error('Invalid thread history.');
  for(const source of [history.opened,history.resolved,history.archive?.source].filter(Boolean)) {
    if(!Number.isSafeInteger(source.turn) || !Number.isFinite(source.src) || !Array.isArray(source.evidence) || source.evidence.some(e=>!e || typeof e.id!=='string' || !Number.isSafeInteger(e.revision) || !Number.isFinite(e.order)) || source.date!==null && !parseStoryDate(source.date)?.valid || source.time!==null && parseClock(source.time)===null)throw new Error('Invalid thread history source.');
  }
  if(history.archive && (!history.archive.source || !['short-lived','incidental'].includes(history.archive.reason)))throw new Error('Invalid thread archive reason.');
}
export function importedThreadHistory(history) {
  if(!history)return null;
  const imported=source=>source ? {...source,by:'import',evidence:[],sourceRevision:0} : null;
  return {...history,opened:imported(history.opened),resolved:imported(history.resolved),archive:history.archive ? {...history.archive,source:imported(history.archive.source)} : null};
}
export const archivedThread = entry => entry.book==='events' && entry.kind==='thread' && !!entry.threadHistory?.archive;
export function threadMatchesFilter(entry,filter) {
  if(entry.kind!=='thread')return false;
  if(filter==='archived')return archivedThread(entry);
  return !archivedThread(entry) && (filter==='all' || entry.status===filter);
}
export function restoreThreadArchive(entry) {
  return {...entry,threadHistory:{...entry.threadHistory,archive:null,restored:true}};
}
// Compare the largest possible duration. Unknown precision must not cause archival.
export function shortThreadDuration(opened,resolved) {
  const start=parseStoryDate(opened?.date),end=parseStoryDate(resolved?.date);
  if(!start?.valid || !end?.valid)return false;
  const a=parseClock(opened.time),b=parseClock(resolved.time);
  const earliest=start.ordinal*1440+(a ?? 0),latest=end.ordinal*1440+(b ?? 1439);
  const latestStart=start.ordinal*1440+(a ?? 1439),earliestEnd=end.ordinal*1440+(b ?? 0);
  return latest>=earliest && (end.ordinal>start.ordinal || a===null || b===null || earliestEnd>=latestStart) && latest-earliest<=3*1440;
}
export function updateThreadHistory(entry,tag,source,{fresh=false,valid=()=>true}={}) {
  if(entry.book!=='events' || entry.kind!=='thread' || entry.createdFrom!=='auto' || entry.sections.text?.text?.trim() || entry.sections.text?.lines?.some(l=>l.by==='user'))return entry.threadHistory;
  let history=entry.threadHistory;
  if(!history && fresh && tag==='open')history={version:1,opened:source,resolved:null,archive:null,restored:false};
  if(!history)return history; // No silent migration of existing cards.
  history={...history};
  if(tag==='open' && (history.archive || history.resolved && source.src>history.resolved.src))history={...history,opened:source,resolved:null,archive:null};
  if(tag==='closed') {
    history.resolved=source;
    if(!history.restored && valid(history.opened) && valid(source) && shortThreadDuration(history.opened,source))history.archive={reason:'short-lived',source};
  }
  if(tag==='background' && !history.restored && valid(source))history.archive={reason:'incidental',source};
  return history;
}
