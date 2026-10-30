import { allocateCharacterPools } from './character-budget.js';
import { reconcileRecords, resolveRecord, archivedRecord, approvedRecord, validSupersession } from './lore-records.js';
import { renderEntry, findMentions, sortLines } from './lore-select.js';
import { normalizeName } from './lore-lines.js';
import { detailMatches } from './character-select.js';
import { capLoreNotes, noteOmissions, cappedRecordReason, supersededBeforeCap, fittedNoteStats } from './lore-note-window.js';

const overlaps=(a,b)=>a.sourceId===b.sourceId && a.start<b.end && b.start<a.end;
const phraseMatch=(text,phrase)=>{
  const hay=normalizeName(text),needle=normalizeName(phrase);if(!needle)return false;
  let start=hay.indexOf(needle);
  while(start>=0){const before=[...hay.slice(0,start)].at(-1) ?? '',after=[...hay.slice(start+needle.length)][0] ?? '';if(!/[\p{L}\p{N}_]/u.test(before)&&!/[\p{L}\p{N}_]/u.test(after))return true;start=hay.indexOf(needle,start+needle.length);}return false;
};
export function relevantSubjects(index,selection,currentText,recentText) {
  const ids=new Set();
  for(const book of ['characters','locations','facts','events']) {
    for(const id of findMentions(currentText,index,book))ids.add(id);
    for(const id of findMentions(recentText,index,book))ids.add(id);
    for(const item of selection.selected[book])if(['always','protagonist','in scene','current place','pinned record','semantic match'].includes(item.reason))ids.add(item.entry.id);
  }
  return ids;
}
export function renderRecordSelection(entry,records,protagonist='') {
  const sources=records.flatMap(r=>r.resolved.sources),sections=Object.fromEntries(Object.entries(entry.sections).map(([key,s])=>{
    const spans=sources.filter(r=>r.section===key&&r.lineId==null).map(r=>[r.start,r.end]).sort((a,b)=>a[0]-b[0]),merged=[];
    for(const [a,b] of spans){const last=merged.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);}
    const ids=new Set(sources.filter(r=>r.section===key&&r.lineId!=null).map(r=>r.lineId));
    return [key,{...s,text:merged.map(([a,b])=>s.text.slice(a,b)).join('\n'),lines:(s.lines ?? []).filter(l=>ids.has(l.id))}];
  }));return renderEntry({...entry,sections},null,protagonist);
}
export function recordUnits(entry,{currentText='',recentText='',anchors=new Set(),index,loreNotesPerSection=3,semanticRecords={}}={}) {
  const complete=reconcileRecords(entry);
  const matched=new Set(semanticRecords[entry.id] ?? []);
  entry=capLoreNotes(complete,loreNotesPerSection,[...matched]);
  const direct=new Set(noteOmissions(entry).map(n=>JSON.stringify([n.section,n.lineId]))),companions=new Map();
  for(const record of complete.recordLayout.records) {
    const reason=cappedRecordReason(entry,record.id);if(!reason)continue;
    for(const source of resolveRecord(complete,record).sources) {
      const key=JSON.stringify([source.section,source.lineId]);
      if(source.lineId==null || direct.has(key))continue;
      companions.set(key,{entryId:entry.id,book:entry.book,name:entry.name,section:source.section,lineId:source.lineId,text:source.text,reason:'complete record omitted: '+reason,kind:reason.startsWith('pinned')?'pinned':'ordinary',limit:loreNotesPerSection});
    }
  }
  const resolved=entry.recordLayout.records.map(record=>({...record,resolved:resolveRecord(entry,record)}));
  const replaced=new Set([...supersededBeforeCap(entry),...resolved.filter(r=>validSupersession(entry,r)).flatMap(r=>r.supersedes)]);
  const units=resolved.map(r=>{
    const capReason=cappedRecordReason(entry,r.id),core=approvedRecord(entry,r),matches=detailMatches(r.resolved.text,currentText,recentText,entry);
    const explicitCurrent=(r.triggers ?? []).filter(t=>phraseMatch(currentText,t)),explicitRecent=(r.triggers ?? []).filter(t=>phraseMatch(recentText,t));
    const literalLinks=index ? ['characters','locations','facts','events'].flatMap(book=>findMentions(r.resolved.text,index,book)) : [];
    const linked=[...new Set([...(r.relatedEntryIds ?? []),...literalLinks])].filter(id=>id!==entry.id && anchors.has(id));
    const current=matches.current.length+explicitCurrent.length,recent=matches.recent.length+explicitRecent.length;
    const activeState=r.category==='state'&&anchors.has(entry.id);
    const round=r.pinned||core ? 1 : current||activeState ? 2 : recent||linked.length||matched.has(r.id) ? 3 : ['characterization','appearance','relationship','constraint'].includes(r.category)&&anchors.has(entry.id) ? 4 : 5;
    const recency=Math.max(0,...r.resolved.sources.map(s=>s.source.data.turn ?? s.source.data.cutoff?.order ?? s.source.data.at ?? 0));
    return {...r,core,round,current,recent,linked,recency,author:Number(r.resolved.sources.some(s=>s.source.data.by==='user'||s.source.data.origin==='user')),currentMatches:[...matches.current,...explicitCurrent],recentMatches:[...matches.recent,...explicitRecent],reason:capReason ?? (!r.resolved.valid ? r.resolved.reason : replaced.has(r.id) ? 'explicitly superseded' : r.pinned ? 'pinned' : core ? 'approved core' : current ? 'current input match' : activeState ? 'state of relevant subject' : recent ? 'recent conversation match' : linked.length ? 'related subject' : matched.has(r.id) ? 'semantic match' : round===4 ? 'selected subject detail' : 'background'),blocked:!!capReason||!r.resolved.valid||replaced.has(r.id)};
  });
  const cores=units.filter(u=>u.core&&!u.blocked);
  for(const u of units.filter(u=>!u.blocked)) {
    let changed=true;const attached=new Set();
    while(changed){changed=false;for(const c of cores)if(!attached.has(c.id)&&u.resolved.sources.some(a=>c.resolved.sources.some(b=>overlaps(a,b)))){attached.add(c.id);u.resolved={...u.resolved,sources:[...u.resolved.sources,...c.resolved.sources.filter(b=>!u.resolved.sources.some(a=>a.sourceId===b.sourceId&&a.start===b.start&&a.end===b.end))]};changed=true;}}
  }
  // Match the existing complete-section fallback when no approved core exists.
  if(entry.book==='characters'&&!cores.length)for(const key of ['personality','appearance']) {
    const group=units.filter(u=>!u.blocked&&u.resolved.sources.some(s=>s.section===key));
    if(group.length)units.push({id:'fallback:'+key,category:key==='personality'?'characterization':'appearance',resolved:{valid:true,sources:group.flatMap(u=>u.resolved.sources),text:group.map(u=>u.resolved.text).join('\n')},round:1,core:false,fallback:true,current:0,recent:0,author:1,recency:0,reason:'unreviewed complete '+key+' fallback',linked:[],currentMatches:[],recentMatches:[]});
  }
  return {entry,capCompanions:[...companions.values()],units:units.sort((a,b)=>a.round-b.round||b.current-a.current||b.recent-a.recent||b.author-a.author||b.recency-a.recency||a.id.localeCompare(b.id))};
}
export async function fitRecords(selected,budget,count,options={}) {
  const cap=Math.max(0,budget),records=selected.map(item=>({...item,...recordUnits(item.entry,options),chosen:[],identity:false}));
  const render=()=>records.filter(r=>r.identity).map(r=>renderRecordSelection(r.entry,r.chosen,options.protagonist)).join('\n\n');
  const renderOne=r=>r.identity&&r.chosen.length ? renderRecordSelection(r.entry,r.chosen,options.protagonist) : '';
  const fill=async(active,fits,protectedOnly=false)=>{
    for(let round=1;round<=5;round++) {
      const queues=new Map(active.map(r=>[r,r.units.filter(u=>!u.blocked&&u.round===round&&!r.chosen.includes(u))]));
      let pending=true;while(pending){pending=false;for(const r of active){const q=queues.get(r);while(q.length){
        const u=q.shift();if(protectedOnly && u.round!==1 && r.identity)continue;
        pending=true;const identity=r.identity;r.identity=true;r.chosen.push(u);
        if(await fits())break;r.chosen.pop();r.identity=identity;
      }}}
    }
  };
  const characterBudget=selected.length && selected.every(item=>item.entry.book==='characters')
    ? await allocateCharacterPools(records,cap,count,renderOne,fill,options)
    : (await fill(records,async()=>await count(render())<=cap),null);
  const included=[],skipped=[],report=[];
  for(const r of records) {
    const chosen=new Set(r.chosen.map(u=>u.id)),lineIds=new Set(r.chosen.flatMap(u=>u.resolved.sources.filter(s=>s.lineId!=null).map(s=>s.lineId)));
    r.capCompanions=r.capCompanions.filter(n=>!lineIds.has(n.lineId));
    const text=r.identity ? renderRecordSelection(r.entry,r.chosen,options.protagonist) : '';
    const selectedEntry=r.identity ? {...r.entry,sections:Object.fromEntries(Object.entries(r.entry.sections).map(([key,s])=>{
      const refs=r.chosen.flatMap(u=>u.resolved.sources).filter(v=>v.section===key),spans=refs.filter(v=>v.lineId==null).sort((a,b)=>a.start-b.start),merged=[];
      for(const v of spans){const last=merged.at(-1);if(last&&v.start<=last[1])last[1]=Math.max(last[1],v.end);else merged.push([v.start,v.end]);}
      return [key,{...s,text:merged.map(([a,b])=>s.text.slice(a,b)).join('\n'),lines:sortLines((s.lines ?? []).filter(l=>lineIds.has(l.id)))}];
    }))} : r.entry;
    if(r.identity&&r.chosen.length)included.push({...r,entry:selectedEntry,lineIds,...fittedNoteStats(r.entry,lineIds,r.capCompanions),tokens:await count(text)});
    else skipped.push({entryId:r.entry.id,book:r.entry.book,name:r.entry.name,ranking:r.ranking,reason:r.identity?'no information fits':'identity over budget'});
    report.push({entryId:r.entry.id,book:r.entry.book,name:r.entry.name,text,identity:r.identity,records:r.units.map(u=>({id:u.id,category:u.category,selected:chosen.has(u.id),core:u.core,pinned:!!u.pinned,coreCandidate:!!u.coreCandidate,reason:u.blocked ? u.reason : chosen.has(u.id) ? u.reason : 'over budget',currentMatches:u.currentMatches,recentMatches:u.recentMatches,linked:u.linked,linkedSubjects:u.linked.map(id=>({entryId:id,name:options.index?.entries.find(e=>e.id===id)?.name ?? id})),sources:(u.resolved.valid?u.resolved.sources:archivedRecord(r.entry,u)).map(s=>({section:s.section,lineId:s.lineId,start:s.start,end:s.end,text:s.text}))}))});
  }
  const text=records.filter(r=>r.identity&&r.chosen.length).map(r=>renderRecordSelection(r.entry,r.chosen,options.protagonist)).join('\n\n');
  const userLinesCut=selected.reduce((n,item)=>n+Object.values(item.entry.sections).flatMap(s=>s.lines ?? []).filter(l=>l.by==='user'&&!included.find(e=>e.entry.id===item.entry.id)?.lineIds.has(l.id)).length,0);
  return {text,tokens:await count(text),included,skipped,userLinesCut,noteOmissions:records.flatMap(r=>[...noteOmissions(r.entry),...r.capCompanions]),cut:included.reduce((n,r)=>n+r.linesCut,0),...(characterBudget ? {characterBudget} : {}),recordReport:{budget:cap,entries:report}};
}
