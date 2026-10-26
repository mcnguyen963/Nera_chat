import {assertSource,noteNeedsReview,requestSource,snapshotNeedsReview} from './continuity.js';
import {coreSource} from './character-core.js';
import {approvedRecord,approveRecord,approveSupersession,fingerprint,recordSources,resolveRecord,validSupersession} from './lore-records.js';
import {packMessages} from './message-chunks.js';

export function validateImportedMessages(messages) {
  if(!Array.isArray(messages))throw new Error('Invalid story messages.');
  const ids=new Set(),ordered=[];let previous=0;
  for(const [index,m] of messages.entries()) {
    const order=m?.order ?? previous+1;
    if(!m || !['user','assistant','summary'].includes(m.role) || typeof m.content!=='string')throw new Error(`Invalid message ${index+1}: expected a role and text.`);
    if(m.id!=null && (typeof m.id!=='string' || !m.id || m.id.includes('/') || /^__.*__$|^\.{1,2}$/.test(m.id) || ids.has(m.id)))throw new Error(`Invalid or duplicate message ID at message ${index+1}.`);
    if(!Number.isSafeInteger(order) || order<=previous)throw new Error(`Invalid message order at message ${index+1}.`);
    if(m.revision!=null && (!Number.isSafeInteger(m.revision) || m.revision<0))throw new Error(`Invalid revision at message ${index+1}.`);
    if(m.id!=null)ids.add(m.id);previous=order;ordered.push({...m,order});
  }
  packMessages(messages);
  return ordered;
}

// Imported history starts a new revision lineage. Freeze the old lineage's
// review decisions before rebasing provenance to the destination's origin (0).
export function rebaseImportedLore(entries,messages,session) {
  const byId=new Map(messages.map(m=>[m.id,m]));
  const needsReview=line=>noteNeedsReview(line,(line.evidence ?? []).flatMap(e=>byId.has(e.id)?[byId.get(e.id)]:[]),session);
  const freshSource=(entry,source)=>source.lineId==null
    ? !snapshotNeedsReview(entry.sections[source.section],entry,session)
    : !needsReview(source.source.data);
  const rebase=line=>{
    const next=structuredClone(line);
    if(needsReview(line))next.needsReview=true;
    if(!['user','import'].includes(line.by))next.sourceRevision=0;
    return next;
  };
  return entries.map(original=>{
    const entry=structuredClone(original);
    for(const section of Object.values(entry.sections))section.lines=section.lines.map(rebase);
    for(const key of ['statusSource','threadMetaSource'])if(entry[key])entry[key]=rebase(original[key]);
    // Preserve exact reviewed passages across provenance-only changes. References
    // that were already invalid must never acquire a new matching fingerprint.
    for(const [i,bundle] of (original.coreReferences ?? []).entries())for(const [j,ref] of bundle.sources.entries()) {
      try {
        if(coreSource(original,ref.section,ref.lineId,ref.start,ref.end).fingerprint===ref.fingerprint)
          entry.coreReferences[i].sources[j]=coreSource(entry,ref.section,ref.lineId,ref.start,ref.end);
      }catch{/* Existing invalid references remain invalid. */}
    }
    if(!entry.recordLayout)return entry;
    const oldSources=new Map(recordSources(original).map(s=>[s.id,s])),newSources=new Map(recordSources(entry).map(s=>[s.id,s]));
    const safe=new Set(original.recordLayout.records.filter(r=>{
      const resolved=resolveRecord(original,r);return resolved.valid && resolved.sources.every(s=>freshSource(original,s));
    }).map(r=>r.id));
    for(const [i,r] of entry.recordLayout.records.entries()) {
      const before=original.recordLayout.records[i];
      for(const ref of r.sources)if(oldSources.has(ref.sourceId) && fingerprint(oldSources.get(ref.sourceId))===ref.fingerprint)
        ref.fingerprint=fingerprint(newSources.get(ref.sourceId));
      delete r.approval;delete r.replacementApproval;
      if(safe.has(r.id) && approvedRecord(original,before))approveRecord(entry,r,before.approval.at);
    }
    for(const [i,r] of entry.recordLayout.records.entries()) {
      const before=original.recordLayout.records[i];
      if(safe.has(r.id) && (r.supersedes ?? []).every(id=>safe.has(id)) && validSupersession(original,before))approveSupersession(entry,r);
    }
    return entry;
  });
}

export function validateRecoveredReply(reply) {
  if(reply==null)return;
  if(!reply || typeof reply!=='object' || !reply.message || reply.message.role!=='assistant' || typeof reply.message.content!=='string' || !reply.message.content.trim() || reply.message.thinking!=null && typeof reply.message.thinking!=='string')throw new Error('The backup contains an invalid unsaved reply. Nothing was imported.');
  for(const key of ['id','overwriteId'])if(reply[key]!=null && (typeof reply[key]!=='string' || !reply[key] || reply[key].includes('/') || /^__.*__$|^\.{1,2}$/.test(reply[key])))throw new Error('The backup contains an invalid unsaved reply ID. Nothing was imported.');
  packMessages([reply.message]);
}

// Recovery surfaces share the same provenance decision. Moving paid text into
// another local backup must not turn a copy-only reply into accepted history.
export function recoveredReplyIssue(reply,{messages,source,directorMode=false}) {
  const last=messages.filter(m=>['user','assistant'].includes(m.role)).at(-1);
  let reason='';
  if(reply.recoveryCopyOnly)reason=typeof reply.recoveryReason==='string' && reply.recoveryReason || 'The original story state for this recovered reply could not be confirmed.';
  else if(directorMode || reply.message.directorTurnId || reply.replanReplacement)reason='This reply needs a Director contract that cannot be resumed from an import.';
  else if(reply.continuation && !reply.overwriteId)reason='The original continuation target is missing.';
  else if(reply.overwriteId && (last?.id!==reply.overwriteId || last.role!=='assistant' || last.order!==reply.order))reason='The original replacement target is missing or changed.';
  else if(!reply.overwriteId && last?.role!=='user')reason='The saved history no longer ends at this reply’s original action.';
  else {
    try {
      if(!Number.isSafeInteger(reply.sourceRevision) || !Number.isSafeInteger(source?.historyRevision))throw new Error('Missing original revision.');
      assertSource(source,{historyRevision:reply.sourceRevision});assertSource(source,reply.expectedSource);
      if(reply.id && messages.some(m=>m.id===reply.id && m.id!==reply.overwriteId))throw new Error('Conflicting reply ID.');
    }catch{reason='The reply’s original story state cannot be confirmed.';}
  }
  return reason;
}

export function recoveredReplyForImport(reply,{messages,source,destination,owner,sid,newId,directorMode=false}) {
  if(!reply)return null;
  const targetId=reply.overwriteId ?? reply.id;
  const allocated=new Set(['id','order','revision','narratorTurn','tokenCount','createdAt','editedAt','historyRevision']);
  const semanticKeys=Object.keys(reply.message).filter(k=>!allocated.has(k));
  const sameReply=m=>fingerprint(Object.fromEntries(semanticKeys.map(k=>[k,m[k] ?? null])))===fingerprint(Object.fromEntries(semanticKeys.map(k=>[k,reply.message[k] ?? null])));
  if(targetId && messages.some(m=>m.id===targetId && m.role==='assistant' && sameReply(m)))return null;
  const reason=recoveredReplyIssue(reply,{messages,source,directorMode}) || (!destination || !Number.isSafeInteger(destination.historyRevision) ? 'The reply’s original story state cannot be confirmed.' : '');
  return {...structuredClone(reply),id:reply.overwriteId ?? newId(),sid,owner,recoveredFromBackup:true,
    recoveryCopyOnly:!!reason,recoveryReason:reason,conflict:false,
    sourceRevision:destination?.historyRevision ?? 0,expectedSource:destination?requestSource(destination):null,
    minOrder:(destination?.nextOrder ?? 0)+1};
}
