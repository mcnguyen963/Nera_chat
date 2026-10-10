import { cardFingerprint } from './lore-card-state.js';
import { minOf, maxOf } from './math-utils.js';
import { limitSkippedNotes } from './memory-skipped.js';
import { assertStory } from './errors.js';
import { assertSource, noteNeedsReview, sectionMeta, assertExtractionSource } from './continuity.js';
import { doc, collection, getDocFromServer, getDocsFromServer, onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, increment } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from './db.js';
import { getMessages } from './messages.js';
import { currentUid } from './auth.js';
import { newLoreId, normalizeName } from './lore-lines.js';
let waitForNarrator = () => Promise.resolve(), activeWrites = 0;
const writeWaiters = new Set(), storyWrites = new Map(), storyWaiters = new Map();
export function waitForStoryWrites(sid) { if (!storyWrites.get(sid)) return Promise.resolve(); return new Promise(resolve => { if (!storyWaiters.has(sid)) storyWaiters.set(sid,new Set()); storyWaiters.get(sid).add(resolve); }); }
export function configureLoreWrites(waitIdle) { waitForNarrator = waitIdle; }
export function loreWritesPending() { return activeWrites > 0; }
export function waitForLoreWrites() { return activeWrites ? new Promise(resolve => writeWaiters.add(resolve)) : Promise.resolve(); }
function gateWrite(action) {
  return async (...args) => {
    const owner = args[0]?.uid ?? currentUid();
    const sid = typeof args[0] === 'object' ? args[0].id : args[0]; storyWrites.set(sid,(storyWrites.get(sid) ?? 0)+1);
    activeWrites++;
    try { await waitForNarrator(); if (owner !== currentUid()) throw new Error('Account changed; this memory action was cancelled.'); return await action({ id:sid,uid:owner },...args.slice(1)); }
    finally { const remaining = storyWrites.get(sid)-1; if (remaining) storyWrites.set(sid,remaining); else { storyWrites.delete(sid); for (const resolve of storyWaiters.get(sid) ?? []) resolve(); storyWaiters.delete(sid); } if (--activeWrites === 0) { for (const resolve of writeWaiters) resolve(); writeWaiters.clear(); } }
  };
}
const root = (sid,tree) => collection(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid,tree);
const ref = (sid,id,tree = 'lore') => doc(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid,tree,id);
const sessionRef = sid => doc(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid);
function storyTransaction(sid,action,source = null) {
  return runTransaction(db,async tx => {
    const session=assertStory((await tx.get(sessionRef(sid))).data());
    if (source) assertStory((await tx.get(sessionRef(source))).data());
    let loreChanged=false,revisionWritten=false;
    const tracked=Object.create(tx);tracked.get=tx.get.bind(tx);
    for(const method of ['set','update','delete'])tracked[method]=(target,...args)=>{
      if(target.path?.includes('/lore/'))loreChanged=true;
      if(target.path===sessionRef(sid).path && args[0] && 'loreRevision' in args[0])revisionWritten=true;
      return tx[method](target,...args);
    };
    return Promise.resolve(action(tracked,session)).then(result=>{if(loreChanged && !revisionWritten)tx.update(sessionRef(sid),{loreRevision:increment(1)});return result;});
  });
}
const clean = entry => {
  const { id, ...data } = entry;
  // Pure planners clone documents; restore Firestore timestamp types at the boundary.
  for (const key of ['createdAt','updatedAt']) if (data[key]?.seconds != null && !data[key].toDate) data[key] = new Timestamp(data[key].seconds, data[key].nanoseconds ?? 0);
  return data;
};
export function guardSize(data, automatic = false) { const bytes = new TextEncoder().encode(JSON.stringify(data)).length; if (bytes > 900000) throw new Error(automatic ? 'card storage full' : 'Too big to store much longer — reorganize it'); return bytes; }
export function subscribeLore(sid, callback, onError) { return onSnapshot(root(sid,'lore'), snap => callback(snap.docs.map(d => ({ id:d.id,...d.data() }))),onError); }
async function createEntryImpl(sid,entry) { guardSize(entry); const id = entry.id || newLoreId(); await storyTransaction(sid,async tx=>tx.set(ref(sid,id),{ ...clean(entry),createdAt:serverTimestamp(),updatedAt:serverTimestamp() })); return id; }
export function mergeEntryEdits(current, staged, base) {
  const out = { ...current };
  for (const key of ['name','aliases','alwaysLoad','draft','status']) out[key] = staged[key];
  out.sections = { ...current.sections };
  for (const [key,section] of Object.entries(staged.sections)) {
    const baseLines = base.sections[key]?.lines ?? [], ids = new Set(baseLines.map(l => l.id));
    const edited = new Map(section.lines.map(l => [l.id,l]));
    const deleted = new Set(baseLines.filter(l => !edited.has(l.id)).map(l => l.id));
    const lines = (current.sections[key]?.lines ?? []).filter(l => !deleted.has(l.id)).map(l => ids.has(l.id) && edited.has(l.id) ? edited.get(l.id) : l);
    for (const l of section.lines) if (!ids.has(l.id) && !lines.some(x => x.id === l.id)) lines.push(l);
    out.sections[key] = { ...current.sections[key],...section,lines };
  }
  return out;
}
async function saveEntryImpl(sid,staged,base = staged) {
  return storyTransaction(sid,async tx => {
    const target = ref(sid,staged.id), snap = await tx.get(target);
    if (!snap.exists()) throw new Error('This card was deleted. Reopen the manager.');
    const merged = mergeEntryEdits(snap.data(),staged,base); guardSize(merged);
    tx.update(target,{ ...clean(merged),updatedAt:serverTimestamp() });
  });
}
export async function getLore(sid) { const snap = await getDocsFromServer(root(sid,'lore')); return snap.docs.map(d => ({ id:d.id,...d.data() })); }

const initializedBackupIndexes=new Set();
const backupIndexRef = sid => ref(sid,'backups','loreMeta');
const backupPendingWindow = 60 * 60 * 1000;
const backupBase = (reason,label) => ({id:newLoreId('backup'),reason,label,createdMs:Date.now()});
const activePending = index => (index.pending ?? []).filter(p => Date.now()-p.createdMs<backupPendingWindow);
const referencedParts = index => new Set([...(index.groups ?? []).flatMap(g=>g.parts),...activePending(index).flatMap(p=>p.parts)]);
export async function listBackups(sid) {
  let index=await getDocFromServer(backupIndexRef(sid));
  const snap=await getDocsFromServer(root(sid,'loreBackups'));
  if(!index.exists()) {
    const groups=new Map();
    for(const d of snap.docs){const b=d.data(),id=b.partOf ?? d.id,g=groups.get(id) ?? {id,label:b.label,reason:b.reason,createdMs:b.createdMs ?? 0,parts:[],count:0};g.parts.push(d.id);g.count+=(b.entries ?? []).length;groups.set(id,g);}
    const result=[...groups.values()].sort((a,b)=>b.createdMs-a.createdMs);
    await storyTransaction(sid,async tx=>{const target=backupIndexRef(sid),fresh=await tx.get(target);if(!fresh.exists())tx.set(target,{groups:result});});
    index=await getDocFromServer(backupIndexRef(sid));
  }
  // A failed oversized backup may leave unpublished parts. Re-read the index
  // transactionally so a concurrently published backup is never swept.
  const known=referencedParts(index.data() ?? {groups:[]}),orphans=snap.docs.filter(d=>!known.has(d.id));
  for(let i=0;i<orphans.length;i+=450)await storyTransaction(sid,async tx=>{
    const fresh=await tx.get(backupIndexRef(sid)),data=fresh.data() ?? {groups:[]},keep=referencedParts(data);
    for(const part of orphans.slice(i,i+450))if(!keep.has(part.id))tx.delete(ref(sid,part.id,'loreBackups'));
    const pending=activePending(data);if(pending.length!==(data.pending ?? []).length)tx.set(backupIndexRef(sid),{...data,pending});
  });
  return index.data()?.groups ?? [];
}
async function ensureBackupIndex(sid) {
  const key=(sid?.uid ?? currentUid())+'/'+(sid?.id ?? sid);
  if(!initializedBackupIndexes.has(key)){await listBackups(sid);initializedBackupIndexes.add(key);}
}
export async function loadBackupGroup(sid,id) {
  const group=(await listBackups(sid)).find(g=>g.id===id);
  if(!group)throw new Error('Backup not found.');
  const docs=await Promise.all(group.parts.map(part=>getDocFromServer(ref(sid,part,'loreBackups'))));
  if(docs.some(d=>!d.exists()))throw new Error('Backup is incomplete.');
  return docs.map(d=>({id:d.id,...d.data()}));
}
function backupParts(base,entries,createdIds=[],sequence=0) {
  const parts=[];let part=[];
  for(const e of entries){const item={id:e.id,data:clean(e)};if(new TextEncoder().encode(JSON.stringify([...part,item])).length>800000 && part.length){parts.push(part);part=[];}part.push(item);}
  parts.push(part);
  return parts.map((entries,i)=>({id:sequence || i ? base.id+'_'+sequence+'_'+i : base.id,data:{reason:base.reason,label:base.label,entries,createdIds:i ? [] : createdIds,createdAt:serverTimestamp(),createdMs:base.createdMs,partOf:base.id,part:i+1}}));
}
function publishBackup(tx,sid,index,base,parts,entryCount,{writeParts=true}={}) {
  const previous=(index.groups ?? []).find(g=>g.id===base.id);
  const group={...base,parts:[...(previous?.parts ?? []),...parts.map(p=>p.id)],count:(previous?.count ?? 0)+entryCount};
  const groups=[group,...(index.groups ?? []).filter(g=>g.id!==base.id)];
  if(writeParts)for(const p of parts)tx.set(ref(sid,p.id,'loreBackups'),p.data);
  tx.set(backupIndexRef(sid),{...index,groups:groups.slice(0,20),pending:(index.pending ?? []).filter(p=>p.id!==base.id)});
  for(const dropped of groups.slice(20))for(const id of dropped.parts)tx.delete(ref(sid,id,'loreBackups'));
}
function backupInTransaction(tx,sid,index,base,entries,createdIds=[],sequence=0) {
  publishBackup(tx,sid,index,base,backupParts(base,entries,createdIds,sequence),entries.length);
}
async function writeBackupImpl(sid,reason,label,entries,createdIds = []) {
  await ensureBackupIndex(sid);
  const base=backupBase(reason,label),parts=backupParts(base,entries,createdIds);
  const bytes=new TextEncoder().encode(JSON.stringify(parts)).length;
  if(bytes<8*1024*1024)await storyTransaction(sid,async tx=>{
    const index=await tx.get(backupIndexRef(sid));
    publishBackup(tx,sid,index.data() ?? {groups:[]},base,parts,entries.length);
  });
  else {
    // Protect live staged parts from the listing sweep. Expired preparation
    // leases are eligible for cleanup if a client dies before publication.
    await storyTransaction(sid,async tx=>{
      const index=await tx.get(backupIndexRef(sid)),data=index.data() ?? {groups:[]};
      tx.set(backupIndexRef(sid),{...data,pending:[...activePending(data),{id:base.id,createdMs:base.createdMs,parts:parts.map(p=>p.id)}]});
    });
    for(const part of parts)await storyTransaction(sid,async tx=>tx.set(ref(sid,part.id,'loreBackups'),part.data));
    await storyTransaction(sid,async tx=>{
      const index=await tx.get(backupIndexRef(sid)),data=index.data() ?? {groups:[]};
      if(!activePending(data).some(p=>p.id===base.id))throw new Error('Backup preparation expired. Try the action again.');
      publishBackup(tx,sid,data,base,parts,entries.length,{writeParts:false});
    });
  }
  return base.id;
}
async function batches(sid,writes,{ preserveTimestamps = false, source = null } = {}) {
  // Six maximum-size cards remain below Firestore's request-size ceiling.
  for (let i=0;i<writes.length;i+=6) {
    await storyTransaction(sid,async tx => {
      for (const w of writes.slice(i,i+6)) { const target = ref(sid,w.id); if (w.delete) tx.delete(target); else { guardSize(w.data); tx.set(target,{ ...clean(w.data), ...(!preserveTimestamps ? { createdAt:clean(w.data).createdAt ?? serverTimestamp(),updatedAt:serverTimestamp() } : {}) }); } }
    },source);
  }
}
function millisOf(value) {
  if(value?.toMillis)return value.toMillis();
  if((value?.seconds ?? value?._seconds)!=null)return (value.seconds ?? value._seconds)*1000;
  if(value instanceof Date)return value.getTime();
  const result=typeof value==='number' ? value : Date.parse(value);return Number.isFinite(result) ? result : null;
}
function lostSource(current,restored) {
  let maxRestored=0,lost=null;
  for(const section of Object.values(restored?.sections ?? {}))for(const line of section.lines ?? []) {
    const order=Number(line.src);
    if(Number.isFinite(order) && order>maxRestored)maxRestored=order;
  }
  for(const section of Object.values(current?.sections ?? {}))for(const line of section.lines ?? []) {
    const order=Number(line.src);
    if(Number.isFinite(order) && order>maxRestored && (lost==null || order<lost))lost=order;
  }
  return lost;
}
async function restoreBackupImpl(sid,id,_currentEntries) {
  const group=await loadBackupGroup(sid,id);
  if(!group.length)throw new Error('Backup not found.');
  const saved=new Map(group.flatMap(b=>b.entries).map(e=>[e.id,e.data])),created=new Set(group.flatMap(b=>b.createdIds ?? []));
  const ids=[...new Set([...saved.keys(),...created])],base=backupBase('restore','Before restore');
  await ensureBackupIndex(sid);
  for(const [sequence,cardId] of ids.entries())await storyTransaction(sid,async(tx,session)=>{
    const target=ref(sid,cardId),current=await tx.get(target),index=await tx.get(backupIndexRef(sid));
    const restored=saved.get(cardId),currentData=current.data();
    if(restored)guardSize(restored);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,current.exists() ? [{id:cardId,...current.data()}] : [],!current.exists() && restored ? [cardId] : [],sequence);
    if(restored)tx.set(target,clean({id:cardId,...restored}));else tx.delete(target);
    const restoredAt=millisOf(restored?.updatedAt) ?? minOf(group.map(b=>b.createdMs ?? 0));
    const lastUpdate=millisOf(session.memoryState?.lastUpdateAt);
    const lost=lostSource(currentData,restored);
    if(lastUpdate!=null && restoredAt<lastUpdate && lost!=null)tx.update(sessionRef(sid),{'memoryState.needsRebuild':true,'memoryState.rebuildFromOrder':Math.min(session.memoryState?.rebuildFromOrder ?? Infinity,lost)});
  });
}
async function deleteEntryImpl(sid,entry) {
  await ensureBackupIndex(sid);const base=backupBase('delete','Deleted '+entry.name);
  await storyTransaction(sid,async tx=>{
    const target=ref(sid,entry.id),current=await tx.get(target),index=await tx.get(backupIndexRef(sid));
    if(!current.exists())throw new Error('This card was deleted.');
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,[{id:entry.id,...current.data()}]);
    tx.delete(target);
  });return base.id;
}
async function mergeEntriesImpl(sid,source,target,threadStatus=null) {
  await ensureBackupIndex(sid);const base=backupBase('merge','Merged '+source.name+' into '+target.name);
  await storyTransaction(sid,async tx => {
    const a=await tx.get(ref(sid,source.id)),b=await tx.get(ref(sid,target.id)),index=await tx.get(backupIndexRef(sid));
    if(!a.exists() || !b.exists())throw new Error('A card no longer exists.');
    const from=a.data(),into=b.data();
    const names=new Map([into.name,...(into.aliases ?? []),from.name,...(from.aliases ?? [])].map(n=>[normalizeName(n),n]));names.delete(normalizeName(into.name));into.aliases=[...names.values()];
    for(const [key,s] of Object.entries(from.sections)) {
      const dest=into.sections[key] ?? {text:'',lines:[]};
      if(s.text){if(!dest.text)dest.text=s.text;else dest.lines.push({id:newLoreId('ln'),text:'From '+from.name+': '+s.text,turn:null,when:null,src:null,by:'user',at:Date.now()});}
      dest.lines.push(...(s.lines ?? []).filter(l=>!dest.lines.some(x=>x.id===l.id)));into.sections[key]=dest;
    }
    if(into.kind==='thread'){if(!['open','closed'].includes(threadStatus))throw new Error('Choose the surviving thread status.');into.status=threadStatus;into.statusSource=null;}
    guardSize(into);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,[{id:source.id,...a.data()},{id:target.id,...b.data()}]);
    tx.update(ref(sid,target.id),{...into,updatedAt:serverTimestamp()});tx.delete(ref(sid,source.id));
  });return base.id;
}
async function reconcileBackgroundImpl(sid,entry,key,text,expectedText) {
  if(typeof text!=='string')throw new Error('Enter replacement background text.');
  await ensureBackupIndex(sid);const base=backupBase('reconcile','Reconciled '+entry.name+' · '+key);
  await storyTransaction(sid,async tx=>{
    const target=ref(sid,entry.id),saved=await tx.get(target),index=await tx.get(backupIndexRef(sid));
    if(!saved.exists())throw new Error('This card was deleted.');
    const data=saved.data(),section=data.sections[key];
    if(!section || section.text!==expectedText)throw new Error('This background changed on another device. Reopen it and review.');
    const previous={id:entry.id,...structuredClone(data)};
    data.sections[key]={...section,text,origin:'user',kind:'canon',cutoff:null};guardSize(data);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,[previous]);
    tx.update(target,{sections:data.sections,updatedAt:serverTimestamp()});
  });return base.id;
}
export const reconcileBackground=gateWrite(reconcileBackgroundImpl);
async function commitExtractionImpl(sid,changes,range) {
  return runTransaction(db,async tx=>{
    const target=sessionRef(sid),snap=await tx.get(target),session=assertStory(snap.data());
    if(range.guard){assertExtractionSource(session,range.guard);if(range.guard.loreRevision!=null && (session.loreRevision ?? 0)!==range.guard.loreRevision)throw new Error('Lorebooks changed during the update. Retry memory extraction.');}else assertSource(session,range.expectedSource);
    const existing=new Map(),skipped=[],written=[];let notes=0;
    for(const id of new Set([...changes.appends,...changes.aliases,...changes.statusChanges].map(a=>a.entryId))) {
      if(changes.creates.some(e=>e.id===id))continue;
      const card=await tx.get(ref(sid,id));if(card.exists())existing.set(id,{id,...card.data()});else skipped.push({entryId:id,reason:'card deleted'});
    }
    const norm=t=>normalizeName(t).replace(/[.!?]+$/,'');
    for(const [id,data] of existing) {
      let cardNotes=0;
      for(const a of changes.appends.filter(a=>a.entryId===id)) {
        const lines=data.sections[a.section]?.lines;if(!lines){skipped.push({entryId:id,reason:'section deleted'});continue;}
        const twin=lines.find(l=>norm(l.text)===norm(a.line.text));
        if(twin){if(twin.by==='auto' && (twin.needsReview || noteNeedsReview(twin,range.messages ?? [],session))){Object.assign(twin,a.line,{id:twin.id,needsReview:false});cardNotes++;}}
        else{lines.push(a.line);cardNotes++;}
      }
      for(const al of changes.aliases.filter(a=>a.entryId===id))if(!(data.aliases ?? []).some(x=>normalizeName(x)===normalizeName(al.alias)))(data.aliases ??= []).push(al.alias);
      for(const st of changes.statusChanges.filter(a=>a.entryId===id)){data.status=st.status;if(st.source)data.statusSource=st.source;}
      // A full card drops its proposed edits; other cards and the checkpoint still commit.
      try { guardSize(data,true); } catch (error) {
        if(error.message!=='card storage full')throw error;
        skipped.push({entryId:id,card:data.name,reason:'card full'});continue;
      }
      tx.update(ref(sid,id),{sections:data.sections,aliases:data.aliases ?? [],status:data.status ?? null,...(data.statusSource ? {statusSource:data.statusSource} : {}),updatedAt:serverTimestamp()});written.push(data);notes+=cardNotes;
    }
    for(const e of changes.creates){
      try {guardSize(e,true);}catch(error){if(error.message!=='card storage full')throw error;skipped.push({entryId:e.id,card:e.name,reason:'card full'});continue;}
      tx.set(ref(sid,e.id),{...clean(e),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});written.push(e);notes+=Object.values(e.sections).reduce((n,s)=>n+(s.lines?.length ?? 0),0);}
    const loreRevision=(session.loreRevision ?? 0)+1;
    const lastSkipped=limitSkippedNotes([...(range.skipped ?? []),...skipped]);
    tx.update(target,{loreRevision,'memoryState.lastSkipped':lastSkipped,'memoryState.extractedThroughOrder':range.endOrder,'memoryState.lastUpdateAt':serverTimestamp(),'memoryState.lastUpdateTurns':range.fromTurn+'–'+range.toTurn,'memoryState.failureStreak':0,'memoryState.lastError':null,'memoryState.paused':false});
    return {entries:written,skipped,lastSkipped,loreRevision,notes};
  });
}
async function replaceLinesImpl(sid,previews,snapshotAt) {
  const cards=await Promise.all(previews.map(p=>getDocFromServer(ref(sid,p.entry.id))));
  const current=cards.filter(d=>d.exists()).map(d=>({id:d.id,...d.data()}));
  const backup = await writeBackupImpl(sid,'reorganize','Reorganized '+(previews.length === 1 ? previews[0].entry.name : previews.length+' cards'),current.filter(e => previews.some(p => p.entry.id === e.id)));
  for (const p of previews) await storyTransaction(sid,async tx => {
    const target = ref(sid,p.entry.id), snap = await tx.get(target); if (!snap.exists()) throw new Error('Card was deleted.');
    const data = snap.data(), fields = { updatedAt:serverTimestamp() };
    for (const [key,newLines] of Object.entries(p.sections)) {
      const keep=data.sections[key].lines,byId=new Map(keep.map(l=>[l.id,l]));
      for(const old of p.sent?.[key] ?? [])if(!byId.has(old.id) || byId.get(old.id).text!==old.text)throw new Error('This card changed since the preview. Reorganize again.');
      const snapshot=new Set(p.snapshot?.[key] ?? keep.map(l=>l.id)),sentIds=new Set((p.sent?.[key] ?? []).map(l=>l.id));
      fields['sections.'+key+'.lines']=[...keep.filter(l=>l.by==='user'),...newLines.filter(l=>l.by!=='user').flatMap(l=>snapshot.has(l.id) && !sentIds.has(l.id) ? (byId.has(l.id) ? [byId.get(l.id)] : []) : [l]),...keep.filter(l=>l.by!=='user' && !snapshot.has(l.id))];
      data.sections[key].lines = fields['sections.'+key+'.lines'];
    }
    guardSize(data); tx.update(target,fields);
  }); return backup;
}
async function importLoreImpl(sid,plan,_existing) {
  await ensureBackupIndex(sid);const base=backupBase('import','Imported lorebooks');
  const writes=[...new Map(plan.writes.map(w=>[w.id,w])).values()];
  // Three before/after maximum-size cards plus their backup fit in one request.
  for(let i=0;i<writes.length;i+=3)await storyTransaction(sid,async tx=>{
    const batch=writes.slice(i,i+3),cards=await Promise.all(batch.map(w=>tx.get(ref(sid,w.id)))),index=await tx.get(backupIndexRef(sid));
    for(const w of batch)if(!w.delete)guardSize(w.data);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,cards.filter(d=>d.exists()).map(d=>({id:d.id,...d.data()})),batch.filter((w,n)=>!w.delete && !cards[n].exists()).map(w=>w.id),i);
    for(const w of batch)if(w.delete)tx.delete(ref(sid,w.id));else tx.set(ref(sid,w.id),{...clean(w.data),createdAt:clean(w.data).createdAt ?? serverTimestamp(),updatedAt:serverTimestamp()});
  });return base.id;
}
// The preview is the authority for the destination. Imported IDs never select a write path.
async function importCardImpl(sid,plan,{isCurrent=()=>true}={}) {
  const check=()=>{if (!isCurrent() || sid.uid!==currentUid()) throw new Error('Navigation or account changed; card import cancelled.');};
  check();guardSize(plan.data);
  if(!plan.expected && plan.data.kind==='timeline'){const cards=await getLore(sid);check();if(cards.some(e=>e.kind==='timeline'))throw new Error('A Timeline already exists. Choose Update existing card and refresh the preview.');}
  if(!plan.id || plan.id.includes('/') || plan.data.id!==plan.id)throw new Error('Invalid card destination.');
  await ensureBackupIndex(sid);check();
  const base=backupBase('card-import','Imported '+plan.data.name);
  await storyTransaction(sid,async(tx,session)=>{
    check();
    const saved=await tx.get(ref(sid,plan.id)),index=await tx.get(backupIndexRef(sid));
    const current=saved.exists() ? {id:plan.id,...saved.data()} : null;
    if(cardFingerprint(current)!==(plan.expected ?? 'null'))throw new Error('This card changed or was deleted after the preview. Refresh the preview before importing.');
    // A revision barrier also guards creation of the singleton Timeline.
    if(!current && (session.loreRevision ?? 0)!==plan.loreRevision)throw new Error('Lorebooks changed after the preview. Refresh the preview before creating this card.');
    if(current && (current.book!==plan.data.book || current.kind!==plan.data.kind))throw new Error('Incompatible card destination.');
    check();
    const data=clean(plan.data);guardSize(data);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,current ? [current] : [],current ? [] : [plan.id]);
    tx.set(ref(sid,plan.id),{...data,createdAt:current?.createdAt ?? serverTimestamp(),updatedAt:serverTimestamp()});
  });
  return base.id;
}
export const importCard=gateWrite(importCardImpl);
async function copyLoreImpl(src,dst,maxOrder) {
  assertStory((await getDocFromServer(sessionRef(src))).data());
  const snap = await getDocsFromServer(root(src,'lore'));
  if (src?.uid) dst = { id:dst,uid:src.uid };
  await batches(dst,snap.docs.map(d => { const data = d.data(); for (const s of Object.values(data.sections)) { s.lines = s.lines.filter(l => (l.src == null || l.src <= maxOrder) && !(l.evidence ?? []).some(e => e.order > maxOrder)); if (sectionMeta(s,data).kind === 'snapshot' && (s.cutoff?.order == null || s.cutoff.order > maxOrder)) s.unavailable = true; } return { id:d.id,data }; }),{ preserveTimestamps:true,source:src });
}
async function markGeneratedForReviewImpl(sid,fromOrder=0) {
  const entries = await getLore(sid);
  await writeBackupImpl(sid,'rebuild','Before explicit memory rebuild',entries);
  const updated=[];
  for (const e of entries) await storyTransaction(sid,async tx => {
    const target=ref(sid,e.id),snap=await tx.get(target);if(!snap.exists())return;
    const data=snap.data();for(const section of Object.values(data.sections))for(const l of section.lines)if(!['user','import'].includes(l.by) && (l.src ?? -Infinity)>=fromOrder)l.needsReview=true;
    tx.update(target,{sections:data.sections,updatedAt:serverTimestamp()});updated.push({id:e.id,...data});
  });
  return updated;
}
export class DeletedNotesChanged extends Error {
  constructor(count) {
    super('The number of notes from deleted turns changed to '+count+'. Confirm again before removing them.');
    this.name = 'DeletedNotesChanged'; this.count = count;
  }
}
async function removeDeletedLinesImpl(sid,entries,_callerOrders,shownCount) {
  // A window of recent chunks cannot establish that an older source was deleted.
  const history = await getMessages(sid.id);
  if (sid.uid !== currentUid()) throw new Error('Account changed; this memory action was cancelled.');
  const orders = new Set(history.map(m => Number(m.order)).filter(Number.isFinite));
  const maxOrder = Math.max(0,maxOf(orders));
  const deleted = l => l.src != null && Number(l.src) <= maxOrder && !orders.has(Number(l.src));
  // Count current server cards, including notes that arrived after the view opened.
  const cards = await Promise.all(entries.map(e => getDocFromServer(ref(sid,e.id))));
  const current = cards.filter(d => d.exists()).map(d => ({id:d.id,...d.data()}));
  const countDeleted = e => Object.values(e.sections ?? {}).reduce((n,s) => n+(s.lines ?? []).filter(deleted).length,0);
  const count = current.reduce((n,e) => n+countDeleted(e),0);
  if (shownCount != null && count !== shownCount) throw new DeletedNotesChanged(count);
  const affected = current.filter(e => countDeleted(e)>0);
  if (!affected.length) return null;
  await ensureBackupIndex(sid);const base=backupBase('remove-deleted','Removed notes from deleted turns');
  for(const [sequence,e] of affected.entries())await storyTransaction(sid,async tx => {
    const target=ref(sid,e.id),snap=await tx.get(target),index=await tx.get(backupIndexRef(sid));if(!snap.exists())return;
    const data=snap.data();
    const freshCount=countDeleted(data);if(freshCount!==countDeleted(e))throw new DeletedNotesChanged(count-countDeleted(e)+freshCount);
    backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,[{id:e.id,...snap.data()}],[],sequence);
    for(const section of Object.values(data.sections ?? {}))section.lines=(section.lines ?? []).filter(l=>!deleted(l));
    tx.update(target,{sections:data.sections,updatedAt:serverTimestamp()});
  });return base.id;
}
async function removeReviewedLinesImpl(sid,entries,fromOrder,throughOrder) {
  const removable=l=>l.needsReview && !['user','import'].includes(l.by) && l.src!=null && l.src>=fromOrder && l.src<=throughOrder;
  const affected=entries.filter(e=>Object.values(e.sections).some(s=>(s.lines ?? []).some(removable)));
  if(!affected.length)return null;
  await ensureBackupIndex(sid);const base=backupBase('rebuild-cleanup','Removed unreproduced notes');
  let changed=0;
  for(const [sequence,e] of affected.entries()) {
    try {
      const removed=await storyTransaction(sid,async tx=>{
        const target=ref(sid,e.id),card=await tx.get(target),index=await tx.get(backupIndexRef(sid));
        if(!card.exists())return false;
        const data=card.data();
        if(!Object.values(data.sections ?? {}).some(s=>(s.lines ?? []).some(removable)))return false;
        backupInTransaction(tx,sid,index.data() ?? {groups:[]},base,[{id:e.id,...card.data()}],[],sequence);
        for(const section of Object.values(data.sections ?? {}))section.lines=(section.lines ?? []).filter(l=>!removable(l));
        tx.update(target,{sections:data.sections,updatedAt:serverTimestamp()});
        return true;
      });
      if(removed)changed++;
    } catch(error) {
      throw new Error('Removed notes from '+changed+' of '+affected.length+' cards. Undo in Backups restores those '+changed+'.',{cause:error});
    }
  }
  return base.id;
}
async function deleteLoreTreesImpl(sid) { for (const name of ['lore','loreBackups','loreMeta']) { const snap = await getDocsFromServer(root(sid,name)); for (let i=0;i<snap.docs.length;i+=450) await storyTransaction(sid,async tx=>{for (const d of snap.docs.slice(i,i+450)) tx.delete(d.ref);}); } }

export const createEntry = gateWrite(createEntryImpl);
export const saveEntry = gateWrite(saveEntryImpl);
export const writeBackup = gateWrite(writeBackupImpl);
export const restoreBackup = gateWrite(restoreBackupImpl);
export const deleteEntry = gateWrite(deleteEntryImpl);
export const mergeEntries = gateWrite(mergeEntriesImpl);
export const commitExtraction = gateWrite(commitExtractionImpl);
export const replaceLines = gateWrite(replaceLinesImpl);
export const importLore = gateWrite(importLoreImpl);
export const copyLore = gateWrite(copyLoreImpl);
export const removeDeletedLines = gateWrite(removeDeletedLinesImpl);
export const deleteLoreTrees = gateWrite(deleteLoreTreesImpl);

export const markGeneratedForReview = gateWrite(markGeneratedForReviewImpl);

export const removeReviewedLines = gateWrite(removeReviewedLinesImpl);
