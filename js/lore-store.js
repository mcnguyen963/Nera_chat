import { assertSource, noteNeedsReview, sectionMeta } from './continuity.js';
import { doc, collection, getDocsFromServer, setDoc, deleteDoc, onSnapshot, runTransaction, writeBatch, arrayUnion, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from './db.js';
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
    try { await waitForNarrator(); if (owner !== currentUid()) throw new Error('Account changed; this memory action was cancelled.'); if (![commitExtractionImpl,copyLoreImpl,writeBackupImpl,deleteLoreTreesImpl].includes(action)) await runTransaction(db,async tx => { const target = sessionRef({ id:sid,uid:owner }), snap = await tx.get(target); if (snap.exists()) tx.update(target,{ loreRevision:(snap.data().loreRevision ?? 0)+1 }); }); return await action({ id:sid,uid:owner },...args.slice(1)); }
    finally { const remaining = storyWrites.get(sid)-1; if (remaining) storyWrites.set(sid,remaining); else { storyWrites.delete(sid); for (const resolve of storyWaiters.get(sid) ?? []) resolve(); storyWaiters.delete(sid); } if (--activeWrites === 0) { for (const resolve of writeWaiters) resolve(); writeWaiters.clear(); } }
  };
}
const root = (sid,tree) => collection(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid,tree);
const ref = (sid,id,tree = 'lore') => doc(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid,tree,id);
const sessionRef = sid => doc(db,'users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid);
const clean = entry => {
  const { id, ...data } = entry;
  // Pure planners clone documents; restore Firestore timestamp types at the boundary.
  for (const key of ['createdAt','updatedAt']) if (data[key]?.seconds != null && !data[key].toDate) data[key] = new Timestamp(data[key].seconds, data[key].nanoseconds ?? 0);
  return data;
};
export function guardSize(data, automatic = false) { const bytes = new TextEncoder().encode(JSON.stringify(data)).length; if (bytes > 900000) throw new Error(automatic ? 'card storage full' : 'Too big to store much longer — reorganize it'); return bytes; }
export function subscribeLore(sid, callback, onError) { return onSnapshot(root(sid,'lore'), snap => callback(snap.docs.map(d => ({ id:d.id,...d.data() }))),onError); }
async function createEntryImpl(sid,entry) { guardSize(entry); const id = entry.id || newLoreId(); await setDoc(ref(sid,id),{ ...clean(entry),createdAt:serverTimestamp(),updatedAt:serverTimestamp() }); return id; }
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
  return runTransaction(db,async tx => {
    const target = ref(sid,staged.id), snap = await tx.get(target);
    if (!snap.exists()) throw new Error('This card was deleted. Reopen the manager.');
    const merged = mergeEntryEdits(snap.data(),staged,base); guardSize(merged);
    tx.update(target,{ ...clean(merged),updatedAt:serverTimestamp() });
  });
}
export async function getLore(sid) { const snap = await getDocsFromServer(root(sid,'lore')); return snap.docs.map(d => ({ id:d.id,...d.data() })); }

export async function listBackups(sid) {
  const snap = await getDocsFromServer(root(sid,'loreBackups'));
  return snap.docs.map(d => ({ id:d.id,...d.data() })).sort((a,b) => (b.createdMs ?? 0)-(a.createdMs ?? 0));
}
async function writeBackupImpl(sid,reason,label,entries,createdIds = []) {
  const id = newLoreId('backup'), parts = []; let part = [];
  for (const e of entries) { const item = { id:e.id,data:clean(e) }; if (new TextEncoder().encode(JSON.stringify([...part,item])).length > 800000 && part.length) { parts.push(part); part = []; } part.push(item); }
  parts.push(part);
  for (let i=0;i<parts.length;i++) await setDoc(ref(sid,i ? id+'_'+i : id,'loreBackups'),{ reason,label,entries:parts[i],createdIds:i ? [] : createdIds,createdAt:serverTimestamp(),createdMs:Date.now(),partOf:id,part:i+1 });
  const backups = await listBackups(sid), groups = [...new Set(backups.map(b => b.partOf ?? b.id))];
  for (const b of backups.filter(b => groups.slice(20).includes(b.partOf ?? b.id))) await deleteDoc(ref(sid,b.id,'loreBackups'));
  return id;
}
async function batches(sid,writes,{ preserveTimestamps = false } = {}) {
  for (let i=0;i<writes.length;i+=450) {
    const batch = writeBatch(db);
    for (const w of writes.slice(i,i+450)) { const target = ref(sid,w.id); if (w.delete) batch.delete(target); else { guardSize(w.data); batch.set(target,{ ...clean(w.data), ...(!preserveTimestamps ? { createdAt:clean(w.data).createdAt ?? serverTimestamp(),updatedAt:serverTimestamp() } : {}) }); } }
    await batch.commit();
  }
}
async function restoreBackupImpl(sid,id,currentEntries) {
  const backups = await listBackups(sid), group = backups.filter(b => (b.partOf ?? b.id) === id);
  if (!group.length) throw new Error('Backup not found.');
  const saved = group.flatMap(b => b.entries), created = group.flatMap(b => b.createdIds ?? []), affected = new Set([...saved.map(e => e.id),...created]);
  const missing = saved.filter(e => !currentEntries.some(x => x.id === e.id)).map(e => e.id);
  await writeBackup(sid,'restore','Before restore',currentEntries.filter(e => affected.has(e.id)),missing);
  await batches(sid,[...created.map(id => ({ id,delete:true })),...saved.map(e => ({ id:e.id,data:e.data }))],{ preserveTimestamps:true });
}
async function deleteEntryImpl(sid,entry) { const backup = await writeBackup(sid,'delete','Deleted '+entry.name,[entry]); await deleteDoc(ref(sid,entry.id)); return backup; }
async function mergeEntriesImpl(sid,source,target) {
  const backup = await writeBackup(sid,'merge','Merged '+source.name+' into '+target.name,[source,target]);
  await runTransaction(db,async tx => {
    const a = await tx.get(ref(sid,source.id)), b = await tx.get(ref(sid,target.id));
    if (!a.exists() || !b.exists()) throw new Error('A card no longer exists.');
    const from = a.data(), into = b.data();
    const names = new Map([into.name,...(into.aliases ?? []),from.name,...(from.aliases ?? [])].map(n => [normalizeName(n),n])); names.delete(normalizeName(into.name)); into.aliases = [...names.values()];
    for (const [key,s] of Object.entries(from.sections)) {
      const dest = into.sections[key] ?? { text:'',lines:[] };
      if (s.text) { if (!dest.text) dest.text = s.text; else dest.lines.push({ id:newLoreId('ln'),text:'From '+from.name+': '+s.text,turn:null,when:null,src:null,by:'user',at:Date.now() }); }
      dest.lines.push(...s.lines.filter(l => !dest.lines.some(x => x.id === l.id))); into.sections[key] = dest;
    }
    guardSize(into); tx.update(ref(sid,target.id),{ ...into,updatedAt:serverTimestamp() }); tx.delete(ref(sid,source.id));
  }); return backup;
}
async function commitExtractionImpl(sid,changes,range) {
  return runTransaction(db,async batch => {
  const target = sessionRef(sid), sessionSnap = await batch.get(target);
  assertSource(sessionSnap.data(),range.expectedSource);
  const existing = new Map();
  for (const id of new Set([...changes.appends,...changes.aliases,...changes.statusChanges].map(a => a.entryId))) { if (!changes.creates.some(e => e.id === id)) { const snap = await batch.get(ref(sid,id)); if (!snap.exists()) throw new Error("A memory card changed or was deleted; retry."); existing.set(id,snap.data()); } }
  for (const e of changes.creates) { guardSize(e,true); batch.set(ref(sid,e.id),{ ...clean(e),createdAt:serverTimestamp(),updatedAt:serverTimestamp() }); }
  const patches = new Map();
  for (const a of changes.appends) { if (!patches.has(a.entryId)) patches.set(a.entryId,{}); const p = patches.get(a.entryId); (p[a.section] ??= []).push(a.line); }
  const updates = new Map();
  for (const [id,p] of patches) { const fields = { updatedAt:serverTimestamp() }; for (const [key,lines] of Object.entries(p)) fields['sections.'+key+'.lines'] = arrayUnion(...lines); updates.set(id,fields); }
  for (const { entryId,alias } of changes.aliases) { if (changes.creates.some(e => e.id === entryId)) continue; const p = updates.get(entryId) ?? { updatedAt:serverTimestamp() }; p.aliases = arrayUnion(...changes.aliases.filter(a => a.entryId === entryId).map(a => a.alias)); updates.set(entryId,p); }
  for (const { entryId,status,source } of changes.statusChanges) { if (changes.creates.some(e => e.id === entryId)) continue; const p = updates.get(entryId) ?? { updatedAt:serverTimestamp() }; p.status = status; if (source) p.statusSource = source; updates.set(entryId,p); }
  for (const [id,p] of updates) {
    const data = structuredClone(existing.get(id));
    for (const [key,value] of Object.entries(p)) {
      if (key.startsWith('sections.') && key.endsWith('.lines')) { const section = key.split('.')[1]; data.sections[section].lines.push(...patches.get(id)[section]); }
    }
    guardSize(data,true); batch.update(ref(sid,id),p);
  }
  batch.update(sessionRef(sid),{ loreRevision:(sessionSnap.data().loreRevision ?? 0)+1,'memoryState.extractedThroughOrder':range.endOrder,'memoryState.lastUpdateAt':serverTimestamp(),'memoryState.lastUpdateTurns':range.fromTurn+'–'+range.toTurn,'memoryState.failureStreak':0,'memoryState.lastError':null,'memoryState.paused':false });
  });
}
async function replaceLinesImpl(sid,previews,snapshotAt) {
  const snap = await getDocsFromServer(root(sid,'lore')), current = snap.docs.map(d => ({ id:d.id,...d.data() }));
  const backup = await writeBackup(sid,'reorganize','Reorganized '+(previews.length === 1 ? previews[0].entry.name : previews.length+' cards'),current.filter(e => previews.some(p => p.entry.id === e.id)));
  for (const p of previews) await runTransaction(db,async tx => {
    const target = ref(sid,p.entry.id), snap = await tx.get(target); if (!snap.exists()) throw new Error('Card was deleted.');
    const data = snap.data(), fields = { updatedAt:serverTimestamp() };
    for (const [key,newLines] of Object.entries(p.sections)) {
      // User-authored lines are canon too; only model/import lines may be rewritten.
      // Reorganization is additive: omitted and original lines remain available.
      const keep = data.sections[key].lines;
      fields['sections.'+key+'.lines'] = [...keep,...newLines.filter(l => !keep.some(x => x.id === l.id))];
      data.sections[key].lines = fields['sections.'+key+'.lines'];
    }
    guardSize(data); tx.update(target,fields);
  }); return backup;
}
async function importLoreImpl(sid,plan,existing) {
  const ids = new Set(plan.writes.map(w => w.id)), createdIds = plan.writes.filter(w => !w.delete && !existing.some(e => e.id === w.id)).map(w => w.id);
  const backup = await writeBackup(sid,'import','Imported lorebooks',existing.filter(e => ids.has(e.id)),createdIds);
  await batches(sid,plan.writes); return backup;
}
async function copyLoreImpl(src,dst,maxOrder) {
  const snap = await getDocsFromServer(root(src,'lore'));
  if (src?.uid) dst = { id:dst,uid:src.uid };
  await batches(dst,snap.docs.map(d => { const data = d.data(); for (const s of Object.values(data.sections)) { s.lines = s.lines.filter(l => (l.src == null || l.src <= maxOrder) && !(l.evidence ?? []).some(e => e.order > maxOrder)); if (sectionMeta(s,data).kind === 'snapshot' && (s.cutoff?.order == null || s.cutoff.order > maxOrder)) s.unavailable = true; } return { id:d.id,data }; }),{ preserveTimestamps:true });
}
async function markGeneratedForReviewImpl(sid) {
  const entries = await getLore(sid);
  await writeBackup(sid,'rebuild','Before explicit memory rebuild',entries);
  for (const e of entries) await runTransaction(db,async tx => {
    const target = ref(sid,e.id), snap = await tx.get(target); if (!snap.exists()) return;
    const data = snap.data();
    for (const s of Object.values(data.sections)) for (const l of s.lines) if (!['user','import'].includes(l.by)) l.needsReview = true;
    tx.update(target,{ sections:data.sections,updatedAt:serverTimestamp() });
  });
}
async function removeDeletedLinesImpl(sid,entries,orders) {
  const affected = entries.filter(e => Object.values(e.sections).some(s => s.lines.some(l => l.src != null && !orders.has(l.src))));
  const backup = await writeBackup(sid,'remove-deleted','Removed notes from deleted turns',affected);
  for (const e of affected) await runTransaction(db,async tx => { const target = ref(sid,e.id), snap = await tx.get(target); if (!snap.exists()) return; const data = snap.data(); for (const s of Object.values(data.sections)) s.lines = s.lines.filter(l => l.src == null || orders.has(l.src)); tx.update(target,{ sections:data.sections,updatedAt:serverTimestamp() }); });
  return backup;
}
async function deleteLoreTreesImpl(sid) { for (const name of ['lore','loreBackups']) { const snap = await getDocsFromServer(root(sid,name)); for (let i=0;i<snap.docs.length;i+=450) { const batch = writeBatch(db); for (const d of snap.docs.slice(i,i+450)) batch.delete(d.ref); await batch.commit(); } } }

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
