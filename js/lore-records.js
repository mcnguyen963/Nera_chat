import {normalizeThreadMeta} from './thread-lifecycle.js';
import { validateSchedule } from './scheduled-plan.js';
import { cardFingerprint } from './lore-card-state.js';
import { SECTION_KEYS, newLoreId } from './lore-lines.js';
import { sectionMeta } from './continuity.js';

export const RECORD_CATEGORIES = ['characterization','appearance','constraint','state','relationship','world_rule','event','thread','background'];
// Change detector, not an authorization token. Hash complete sources, including
// qualifications and provenance, rather than just the selected quotation.
export function fingerprint(value) {
  const text=cardFingerprint(value), h=[2166136261,2246822519,3266489917,668265263];
  for(let i=0;i<text.length;i++)for(let j=0;j<h.length;j++)h[j]=Math.imul(h[j]^text.charCodeAt(i),16777619+j*2)>>>0;
  return h.map(n=>n.toString(16).padStart(8,'0')).join('');
}
export function recordSources(entry) {
  return Object.entries(entry.sections ?? {}).flatMap(([section,s])=>[
    {id:'s:'+section,section,lineId:null,data:{...Object.fromEntries(Object.entries(s).filter(([k])=>k!=='lines')),text:s.text ?? '',...sectionMeta(s,entry)}},
    ...(s.lines ?? []).map(l=>({id:'l:'+section+':'+l.id,section,lineId:l.id,data:{...l}}))
  ]);
}
export function sourceCategory(entry,section) {
  if(entry.book==='facts')return 'world_rule';
  if(entry.book==='events')return entry.kind==='thread' ? 'thread' : 'event';
  return ({personality:'characterization',appearance:'appearance',description:'appearance',status:'state',state:'state',bond:'relationship',relations:'relationship'})[section] ?? 'background';
}
export function resolveRecord(entry,record) {
  try {
    if(!RECORD_CATEGORIES.includes(record.category) || !record.sources?.length)throw new Error('Invalid record');
    const sources=recordSources(entry),resolved=record.sources.map(ref=>{
      const source=sources.find(s=>s.id===ref.sourceId),text=source?.data.text;
      if(!source || fingerprint(source)!==ref.fingerprint)throw new Error('Source changed, moved, or unavailable');
      if(!Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<=ref.start||ref.end>text.length)throw new Error('Invalid source range');
      if(source.lineId!=null && (ref.start!==0||ref.end!==text.length))throw new Error('Update notes are indivisible');
      return {...ref,section:source.section,lineId:source.lineId,text:text.slice(ref.start,ref.end),source};
    });
    return {valid:true,sources:resolved,text:resolved.map(s=>s.text).join('\n')};
  }catch(error){return {valid:false,reason:error.message,sources:[],text:''};}
}
export function archivedRecord(entry,record) {
  const sources=record.sources.map(ref=>{
    const source=(entry.recordLayout?.sourceArchive ?? []).find(s=>s.id===ref.sourceId&&fingerprint(s)===ref.fingerprint);
    return source ? {...ref,section:source.section,lineId:source.lineId,text:source.data.text.slice(ref.start,ref.end),source} : null;
  });return sources.filter(Boolean);
}
function approvalPayload(entry,record) {
  return {entryId:entry.id,category:record.category,sources:record.sources,relatedEntryIds:record.relatedEntryIds ?? [],triggers:record.triggers ?? [],supersedes:record.supersedes ?? []};
}
export function approvedRecord(entry,record) { return record.coreCandidate===true && record.approval?.fingerprint===fingerprint(approvalPayload(entry,record)) && resolveRecord(entry,record).valid; }
export function approveRecord(entry,record,now=Date.now()) {
  const resolved=resolveRecord(entry,record);if(!resolved.valid)throw new Error(resolved.reason);
  record.coreCandidate=true;record.approval={fingerprint:fingerprint(approvalPayload(entry,record)),at:now};return record;
}
export function approveSupersession(entry,record) {
  if(!(record.supersedes ?? []).length)throw new Error('Choose records replaced by this record');
  const records=entry.recordLayout?.records ?? [];
  const targets=record.supersedes.map(id=>records.find(r=>r.id===id));
  if(targets.some(r=>!r || r.id===record.id || !resolveRecord(entry,r).valid))throw new Error('Invalid replacement target');
  const visits=(id,seen=new Set())=>{if(id===record.id)return true;if(seen.has(id))return false;seen.add(id);return (records.find(r=>r.id===id)?.supersedes ?? []).some(next=>visits(next,seen));};
  if(targets.some(r=>visits(r.id)))throw new Error('Replacement links cannot form a cycle');
  record.replacementApproval=fingerprint({record:approvalPayload(entry,record),targets:targets.map(r=>approvalPayload(entry,r))});
}
export function validSupersession(entry,record) {
  const targets=(record.supersedes ?? []).map(id=>entry.recordLayout?.records?.find(r=>r.id===id));
  return !!record.replacementApproval && resolveRecord(entry,record).valid && targets.length>0 && targets.every(r=>r && r.id!==record.id && resolveRecord(entry,r).valid) && record.replacementApproval===fingerprint({record:approvalPayload(entry,record),targets:targets.map(r=>approvalPayload(entry,r))});
}
export function reconcileRecords(entry) {
  if(entry.book==='plan')validateSchedule(entry.schedule);
  if(entry.recordLayout)validateRecords(entry);
  const records=structuredClone(entry.recordLayout?.records ?? []),sources=recordSources(entry);
  if(!entry.recordLayout)for(const bundle of entry.coreReferences ?? []) {
    if(bundle.reviewed!==true||!bundle.sources?.length)continue;
    const refs=bundle.sources.map(ref=>{
      const source=sources.find(s=>s.section===ref.section&&s.lineId===(ref.lineId ?? null)),section=entry.sections[ref.section];
      const original=ref.lineId==null ? {text:section?.text,...sectionMeta(section ?? {},entry),unavailable:!!section?.unavailable,sourceRevision:section?.sourceRevision ?? 0} : source?.data;
      if(!source||cardFingerprint(original)!==ref.fingerprint||ref.start<0||ref.end>source.data.text.length)return null;
      return {sourceId:source.id,start:ref.start,end:ref.end,fingerprint:fingerprint(source)};
    });
    if(refs.every(Boolean)){const record={id:bundle.id,category:'constraint',coreCandidate:true,relatedEntryIds:[],triggers:[],sources:refs};approveRecord(entry,record);records.push(record);}
  }
  for(const record of records){if(record.approval&&!approvedRecord(entry,record))delete record.approval;if(record.replacementApproval&&!validSupersession(entry,record))delete record.replacementApproval;}
  for(const source of sources) {
    const text=source.data.text;if(!text?.trim())continue;
    // A bundle with an unavailable qualifier must not spill its unchanged claim
    // into an independent fallback. Only genuinely new/edited source text is new.
    const spans=records.flatMap(r=>r.sources.filter(s=>s.sourceId===source.id&&s.fingerprint===fingerprint(source)&&s.start>=0&&s.end<=text.length).map(s=>[s.start,s.end])).sort((a,b)=>a[0]-b[0]);
    let cursor=0;
    const hash=fingerprint(source);
    const add=(start,end)=>{if(text.slice(start,end).trim())records.push({id:'record_auto_'+fingerprint({entryId:entry.id,sourceId:source.id,start,end,hash}),category:sourceCategory(entry,source.section),coreCandidate:false,relatedEntryIds:[],triggers:[],sources:[{sourceId:source.id,start,end,fingerprint:hash}]});};
    for(const [start,end] of spans){if(start>cursor)add(cursor,start);cursor=Math.max(cursor,end);}
    if(cursor<text.length)add(cursor,text.length);
  }
  return {...entry,schemaVersion:3,recordLayout:{...entry.recordLayout,records}};
}
export function toRecordDocument(entry,previous=null) {
  const e=reconcileRecords(entry),{sections,recordLayout,schemaVersion,...subject}=e;
  validateRecords(e);
  const sources=recordSources(e),archivedSources=[...(previous?.recordLayout?.sourceArchive ?? []),...(recordLayout.sourceArchive ?? [])];
  if(previous)for(const source of recordSources(previous))if(source.data.text?.trim()&&!sources.some(s=>s.id===source.id&&fingerprint(s)===fingerprint(source)))archivedSources.push(source);
  const unique=[...new Map(archivedSources.map(s=>[s.id+':'+fingerprint(s),s])).values()];
  return {schemaVersion:3,subject,sources,archivedSources:unique,records:recordLayout.records};
}
export function fromRecordDocument(doc) {
  if(doc?.schemaVersion!==3 || !doc.subject || !Array.isArray(doc.sources)||!Array.isArray(doc.records))throw new Error('Invalid version 3 lorebook');
  if(!SECTION_KEYS[doc.subject.book]||typeof doc.subject.id!=='string'||!doc.subject.id||typeof doc.subject.name!=='string'||!doc.subject.name.trim())throw new Error('Invalid version 3 subject');
  const sections=Object.fromEntries(SECTION_KEYS[doc.subject.book].map(key=>[key,{text:'',lines:[]}]));
  const ids=new Set();
  for(const s of doc.sources) {
    if(!s || ids.has(s.id)||!sections[s.section]||typeof s.data?.text!=='string'||s.id!==(s.lineId==null ? 's:'+s.section : 'l:'+s.section+':'+s.lineId))throw new Error('Invalid version 3 source');
    ids.add(s.id);if(s.lineId==null)sections[s.section]={...s.data,lines:sections[s.section].lines};else {if(s.data.id!==s.lineId)throw new Error('Source note ID mismatch');sections[s.section].lines.push({...s.data});}
  }
  if(doc.archivedSources!=null&&(!Array.isArray(doc.archivedSources)||doc.archivedSources.some(s=>typeof s.id!=='string'||typeof s.data?.text!=='string')))throw new Error('Invalid source archive');
  const entry={...doc.subject,schemaVersion:3,sections,recordLayout:{records:structuredClone(doc.records),sourceArchive:structuredClone(doc.archivedSources ?? [])}};
  validateRecords(entry);if(entry.book==='plan')validateSchedule(entry.schedule);return entry;
}
export function validateRecords(entry) {
  if(entry.kind==='thread' && entry.threadMeta!=null)normalizeThreadMeta(entry.threadMeta);
  const records=entry.recordLayout?.records;if(!Array.isArray(records))throw new Error('Invalid records');
  const ids=new Set();
  for(const r of records) {
    if(!r || typeof r.coreCandidate!=='boolean'||r.pinned!=null&&typeof r.pinned!=='boolean'||typeof r.id!=='string'||!r.id||ids.has(r.id)||!RECORD_CATEGORIES.includes(r.category)||!Array.isArray(r.sources)||!r.sources.length||!Array.isArray(r.relatedEntryIds)||r.relatedEntryIds.some(id=>typeof id!=='string')||!Array.isArray(r.triggers)||r.triggers.some(t=>typeof t!=='string'||!t.trim())||r.supersedes!=null && (!Array.isArray(r.supersedes)||r.supersedes.some(id=>typeof id!=='string')))throw new Error('Invalid selection record');
    ids.add(r.id);
    for(const s of r.sources)if(typeof s.sourceId!=='string'||typeof s.fingerprint!=='string'||!Number.isSafeInteger(s.start)||!Number.isSafeInteger(s.end)||s.start<0||s.end<=s.start)throw new Error('Invalid record source');
  }
}
export function convertLayout(entries,input) {
  if(typeof input==='string'&&new TextEncoder().encode(input).length>2*1024*1024)throw new Error('The layout is larger than 2 MB. Convert complete subjects in smaller groups.');
  const layout=typeof input==='string' ? JSON.parse(input.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) : input;
  if(layout?.format!=='nera-lorebook-layout'||layout.version!==1||!Array.isArray(layout.entries))throw new Error('Expected a version 1 nera-lorebook-layout');
  const known=new Set(entries.map(e=>e.id)),seen=new Set(),converted=new Map(),warnings=[];
  for(const proposed of layout.entries) {
    const original=entries.find(e=>e.id===proposed.entryId);if(!original||seen.has(original.id)||!Array.isArray(proposed.records))throw new Error('Unknown or repeated entry ID');seen.add(original.id);
    const entry=reconcileRecords(original);
    const sources=recordSources(entry),keys=new Set();
    const records=proposed.records.map(p=>{
      if(typeof p.key!=='string'||!p.key||keys.has(p.key)||!RECORD_CATEGORIES.includes(p.category)||typeof p.coreCandidate!=='boolean'||!Array.isArray(p.relatedEntryIds)||!Array.isArray(p.triggers)||p.relatedEntryIds.some(id=>!known.has(id))||p.triggers.some(t=>typeof t!=='string'||!t.trim())||!p.sources?.length)throw new Error('Invalid proposed record');keys.add(p.key);
      if('approval' in p || 'reviewed' in p || 'supersedes' in p)throw new Error('External layouts cannot approve or replace information');
      const refs=p.sources.map(r=>{
        const s=sources.find(s=>s.section===r.section && s.lineId===(r.lineId ?? null));
        if(!s||typeof r.quote!=='string'||!r.quote.length||!Number.isSafeInteger(r.occurrence)||r.occurrence<1)throw new Error('Invalid exact quotation reference');
        let start=-1,next=0;for(let i=0;i<r.occurrence;i++){start=s.data.text.indexOf(r.quote,next);if(start<0)throw new Error('Quotation does not match its source');next=start+r.quote.length;}
        if(s.lineId!=null && (start!==0||r.quote!==s.data.text))throw new Error('Quote the complete update note');
        return {sourceId:s.id,start,end:start+r.quote.length,fingerprint:fingerprint(s)};
      });
      const record={id:newLoreId('record'),category:p.category,coreCandidate:p.coreCandidate,relatedEntryIds:[...new Set(p.relatedEntryIds)],triggers:[...new Set(p.triggers)],sources:refs};
      // Existing approvals survive only an identical source/grouping proposal.
      const old=(entry.recordLayout?.records ?? []).find(r=>fingerprint(approvalPayload(entry,r))===fingerprint(approvalPayload(entry,record)));
      if(old){record.id=old.id;if(approvedRecord(entry,old))record.approval=old.approval;}
      return record;
    });
    const partial={...entry,recordLayout:{...entry.recordLayout,records}},full=reconcileRecords(partial);
    if(full.recordLayout.records.length>records.length)warnings.push(entry.name+': unassigned passages retained as fallback records');
    converted.set(entry.id,full);
  }
  return {entries:entries.map(e=>converted.get(e.id) ?? reconcileRecords(e)),warnings,reviewNotes:Array.isArray(layout.reviewNotes)?layout.reviewNotes.map(String):[]};
}
