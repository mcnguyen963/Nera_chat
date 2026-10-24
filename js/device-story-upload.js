import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {db} from './db.js';
import {currentUid} from './auth.js';
import {assertStory} from './errors.js';
import {packMessages,chunkId,chunkRecord,summaryLookup} from './message-chunks.js';
import {computeTurns} from './turns.js';
import {applyStoryOperation} from './local-story.js';
import {requestSource} from './continuity.js';
import {validateDirectorState} from './director-state.js';
import {loreData} from './lore-cache.js';
import {toRecordDocument,fromRecordDocument,fingerprint} from './lore-records.js';
import {pickStorySettings,STORY_SETTINGS_VERSION} from './story-settings.js';

const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const clean=value=>value===undefined?null:JSON.parse(JSON.stringify(loreData(value)));
const validId=value=>typeof value==='string' && value.length>0 && value.length<1000 && !value.includes('/') && value!=='.' && value!=='..';
const MAX_REPLACEMENT_BYTES=7*1024*1024,MAX_REPLACEMENT_WRITES=400;

// Read device copies only. In particular, never flush a conflicted queue or Sync
// before giving the user a chance to rescue its working copy.
export function deviceStoryCopies({sid,current,cached,aux,outbox,storySettings,loreSnapshot,unsavedReply}) {
  const copies=[],seen=new Set();copies.warnings=[];
  const add=(label,view,backupSnapshot=null)=>{
    if(!view?.session || view.session.id!==sid || !Array.isArray(view.messages))return;
    const key=fingerprint({session:view.session,messages:view.messages});if(seen.has(key))return;seen.add(key);
    copies.push({label,snapshot:backupSnapshot?clean(backupSnapshot):{format:'nera-chat-backup',version:1,deviceHistoryComplete:true,exportedAt:new Date().toISOString(),session:clean(view.session),messages:clean(view.messages),
      storySettings:clean(storySettings),lore:clean(loreSnapshot?.entries ?? []),loreSnapshot:clean(loreSnapshot ?? {}),directorTurns:clean(Object.values({...aux?.turns,...view.turns})),...(unsavedReply?{unsavedReply:clean(unsavedReply)}:{})}});
  };
  const addUnsaved=(label,view,reply,backupSnapshot=null)=>{
  if(view && reply?.message && !view.messages.some(m=>m.id===reply.id && m.content===reply.message.content)){
    try{
      const overwrite=!!reply.overwriteId;
      const recovered=applyStoryOperation(view,{id:'recover-unsaved',createdAt:Date.now(),kind:overwrite?'overwrite':'add',payload:{id:overwrite?reply.overwriteId:reply.id,message:reply.message}});
      add(label+(overwrite?' + unsaved replacement':' + unsaved reply'),recovered,backupSnapshot?{...backupSnapshot,session:recovered.session,messages:recovered.messages}:null);
    }catch{copies.warnings.push('An unsaved reply is included in the download, but could not safely be added to the story automatically.');}
  }
  };
  add('Open story',current);addUnsaved('Open story',current,unsavedReply);
  if(outbox?.base){
    try{
    let view=structuredClone(outbox.base);
    for(const record of outbox.records ?? (outbox.operations ?? []).map(op=>({op}))){
      view=applyStoryOperation(view,record.op);
      if(record.acknowledged && record.result?.session)view.session=record.result.session;
      if(record.acknowledged && record.result?.message)view.messages=view.messages.map(m=>m.id===record.result.message.id?record.result.message:m);
    }
    add('Pending saves on this device',view);
    }catch{copies.warnings.push('Some pending saves could not be reconstructed. They have not been discarded.');}
  }
  add('Last saved device copy',aux?.confirmed);
  if(Array.isArray(cached?.history) && (cached.historyRevision ?? cached.session?.historyRevision)===(cached.session?.historyRevision ?? 0))add('Cached story', {session:cached.session,messages:cached.history,turns:aux?.turns});
  for(const backup of aux?.deviceRecoveryBackups ?? [])if(backup.snapshot?.session?.id===sid){
    const label='Device backup · '+backup.at,view={session:backup.snapshot.session,messages:backup.snapshot.messages,turns:Object.fromEntries((backup.snapshot.directorTurns ?? []).map(t=>[t.id,t]))};
    add(label,view,backup.snapshot);addUnsaved(label,view,backup.snapshot.unsavedReply,backup.snapshot);
  }
  return copies;
}

export function validateDeviceStory(snapshot) {
  if(!validId(snapshot?.session?.id) || snapshot.deviceHistoryComplete!==true || !Array.isArray(snapshot.messages) || !snapshot.messages.length)throw new Error('No complete local story is available to upload. The displayed recent messages alone are not a full backup.');
  const ids=new Set();let order=0;
  for(const message of snapshot.messages){
    if(!validId(message.id) || ids.has(message.id) || !Number.isSafeInteger(message.order) || message.order<=order || !['user','assistant','summary'].includes(message.role) || typeof message.content!=='string')throw new Error('The local history is incomplete or has conflicting message IDs. Download the device backup before continuing.');
    ids.add(message.id);order=message.order;
  }
  if(!snapshot.storySettings?.values || !snapshot.loreSnapshot?.initialized || !Array.isArray(snapshot.lore))throw new Error('Prompts or lorebooks have not loaded on this device. Download the local backup; do not Sync over a newer phone copy.');
  if(snapshot.session.activeSummaryMessageId && !snapshot.messages.some(m=>m.id===snapshot.session.activeSummaryMessageId && m.role==='summary'))throw new Error('The local summary checkpoint is missing from this copy. Download the backup instead of uploading incomplete history.');
  if(snapshot.session.directorState)validateDirectorState(snapshot.session.directorState);
  const loreIds=new Set();for(const entry of snapshot.lore){if(!validId(entry.id)||loreIds.has(entry.id))throw new Error('The local lorebook has conflicting IDs.');loreIds.add(entry.id);}
  packMessages(snapshot.messages);
  return snapshot;
}

// Every active-document write is in one transaction. The complete old cloud copy
// and the chosen device copy are backed up first, in small, retry-safe batches.
// Oversized replacements are refused before any write to the active story.
export async function uploadDeviceStory(snapshot,{owner=currentUid(),check=()=>{},onProgress=()=>{}}={}) {
  snapshot=clean(validateDeviceStory(snapshot));
  const sid=snapshot.session.id,id='device_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
  const ref=(tree,key)=>firestore.doc(db,'users',owner,'sessions',sid,tree,key);
  const parent=firestore.doc(db,'users',owner,'sessions',sid),backup=ref('storyRecovery',id);
  const guard=()=>{if(owner!==currentUid())throw new Error('Account changed; device upload cancelled.');check();};
  const read=async tree=>(await firestore.getDocsFromServer(firestore.collection(db,'users',owner,'sessions',sid,...tree))).docs;
  guard();
  const before=assertStory((await firestore.getDocFromServer(parent)).data());guard();
  if(before.importing || before.loreMigration?.active)throw new Error('Finish the current story import or lorebook migration before uploading.');
  const schema=snapshot.loreSnapshot.schemaVersion ?? snapshot.session.loreSchemaVersion ?? 2;
  if(![2,3].includes(schema) || before.loreSchemaVersion===3 && schema!==3)throw new Error('This device has an older lorebook format than Firebase. Download its backup first; an upload cannot silently downgrade the lorebook format.');
  onProgress('Reading the cloud copy for backup…');
  const lorePath=before.loreGeneration?['loreV3',before.loreGeneration,'entries']:['lore'];
  const [chunks,cloudLore,cloudTurns,promptSnap,legacy]=await Promise.all([read(['messageChunks']),read(lorePath),read(['directorTurns']),firestore.getDocFromServer(ref('storySettings','current')),before.storageVersion===2?Promise.resolve([]):read(['messages'])]);guard();
  const previousMessages=before.storageVersion===2?chunks.flatMap(d=>clean(d.data().messages ?? [])):legacy.map(d=>({id:d.id,...clean(d.data())}));previousMessages.sort((a,b)=>a.order-b.order);
  const after=assertStory((await firestore.getDocFromServer(parent)).data());guard();
  const baseline=fingerprint(clean(before));if(fingerprint(clean(after))!==baseline)throw new Error('Firebase changed while preparing the backup. Nothing was replaced; try again when the other device is idle.');
  const turns=new Map(cloudTurns.map(d=>[d.id,{id:d.id,...clean(d.data())}]));
  for(const turn of snapshot.directorTurns ?? [])turns.set(turn.id,turn);
  const required=new Set([snapshot.session.directorCheckpoint,snapshot.session.directorPending,...snapshot.messages.map(m=>m.directorTurnId)].filter(Boolean));
  for(const turnId of required){const turn=turns.get(turnId);if(!turn)throw new Error('A Director checkpoint needed by this device is missing. Download the backup; no cloud data was replaced.');if(turn.previousCheckpoint)required.add(turn.previousCheckpoint);}
  const localTurns=[...required].map(turnId=>turns.get(turnId));
  if(localTurns.some(t=>!validId(t?.id)||t.version!==1))throw new Error('This device has an unsupported Director checkpoint.');
  for(const turn of localTurns){validateDirectorState(turn.before);validateDirectorState(turn.after);}
  const groups=packMessages(snapshot.messages),last=groups.at(-1),turnNumbers=computeTurns(snapshot.messages);
  const generation=schema===3?id:null;
  const lore=schema===3?snapshot.lore.map(entry=>fromRecordDocument(toRecordDocument(entry))):snapshot.lore;
  const storySettings={version:STORY_SETTINGS_VERSION,revision:Math.max(before.storySettingsRevision ?? 0,snapshot.storySettings.revision ?? 0)+1,values:pickStorySettings(snapshot.storySettings.values)};
  const {id:omitId,createdAt:omitCreated,updatedAt:omitUpdated,...localSession}=snapshot.session;
  const session={...localSession,id:sid,createdAt:clean(before.createdAt ?? snapshot.session.createdAt ?? new Date()),updatedAt:clean(new Date()),
    historyRevision:Math.max(before.historyRevision ?? 0,localSession.historyRevision ?? 0)+1,loreRevision:Math.max(before.loreRevision ?? 0,localSession.loreRevision ?? 0)+1,
    directorRevision:Math.max(before.directorRevision ?? 0,localSession.directorRevision ?? 0)+1,storySettingsRevision:storySettings.revision,
    storageVersion:2,continuityVersion:2,lookupVersion:1,...summaryLookup(snapshot.messages),nextOrder:Math.max(localSession.nextOrder ?? 0,last.at(-1).order),
    nextNarratorTurn:Math.max(localSession.nextNarratorTurn ?? 1,turnNumbers.lastTurn+1),activeChunkId:chunkId(last[0].order),activeChunkBytes:chunkRecord(last).byteSize,activeChunkCount:last.length,
    loreSchemaVersion:schema,loreGeneration:generation,loreMigration:{active:false},importing:false,deleting:false,lastDeviceUpload:{id,at:Date.now()}};
  for(const turn of localTurns)if(turn.id===session.directorPending)turn.source=requestSource(session);
  const loreSnapshot={version:1,initialized:true,entries:lore,entryRevisions:{},loadedRevision:session.loreRevision,lastCommittedRevision:session.loreRevision,schemaVersion:schema,generation};
  const messageRecords=groups.map(group=>({id:chunkId(group[0].order),data:chunkRecord(group)}));
  const writes=messageRecords.map(record=>({target:ref('messageChunks',record.id),data:record.data}));
  const messageIds=new Set(messageRecords.map(record=>record.id));for(const chunk of chunks)if(!messageIds.has(chunk.id))writes.push({target:chunk.ref,remove:true});
  if(schema===3)writes.push({target:ref('loreV3',id),data:{state:'active',createdAt:Date.now()}});
  for(const entry of lore)writes.push({target:generation?firestore.doc(db,'users',owner,'sessions',sid,'loreV3',generation,'entries',entry.id):ref('lore',entry.id),data:schema===3?toRecordDocument(entry):clean(Object.fromEntries(Object.entries(entry).filter(([key])=>key!=='id')))});
  if(schema===2){const names=new Set(lore.map(entry=>entry.id));for(const entry of cloudLore)if(!names.has(entry.id))writes.push({target:entry.ref,remove:true});}
  for(const turn of localTurns)writes.push({target:ref('directorTurns',turn.id),data:turn});
  writes.push({target:ref('storySettings','current'),data:storySettings});
  const size=bytes(session)+writes.reduce((n,w)=>n+(w.data?bytes(w.data):0)+256,0)+chunks.reduce((n,d)=>n+bytes(d.data()),0)+(schema===2?cloudLore.reduce((n,d)=>n+bytes(d.data()),0):0);
  if(writes.length+2>MAX_REPLACEMENT_WRITES || size>MAX_REPLACEMENT_BYTES)throw new Error('This story is too large for one safe cloud overwrite. Download the device backup instead. Firebase and the phone copy were not changed.');
  for(const write of writes)if(write.data && bytes(write.data)>900000)throw new Error('A local card, prompt, or checkpoint is too large to upload. Download the backup; Firebase was not changed.');
  const parts=[{side:'cloud',tree:'session',key:sid,data:clean(before)},{side:'cloud',tree:'storySettings',key:'current',data:promptSnap.exists()?clean(promptSnap.data()):null},
    ...chunks.map(d=>({side:'cloud',tree:'messageChunks',key:d.id,data:clean(d.data())})),...legacy.map(d=>({side:'cloud',tree:'messages',key:d.id,data:clean(d.data())})),...cloudLore.map(d=>({side:'cloud',tree:lorePath.join('/'),key:d.id,data:clean(d.data())})),...cloudTurns.map(d=>({side:'cloud',tree:'directorTurns',key:d.id,data:clean(d.data())})),
    {side:'device',tree:'session',key:sid,data:snapshot.session},{side:'device',tree:'storySettings',key:'current',data:snapshot.storySettings},...messageRecords.map(r=>({side:'device',tree:'messageChunks',key:r.id,data:r.data})),...snapshot.lore.map(e=>({side:'device',tree:'lore',key:e.id,data:e})),...localTurns.map(t=>({side:'device',tree:'directorTurns',key:t.id,data:t})),...(snapshot.unsavedReply?[{side:'device',tree:'unsavedReply',key:'latest',data:snapshot.unsavedReply}]:[])];
  for(const part of parts)if(bytes(part)>950000)throw new Error('A backup document is too large. Download the device backup; Firebase was not changed.');
  for(let offset=0;offset<parts.length;offset+=6){guard();onProgress('Saving recovery backups… '+Math.min(offset+6,parts.length)+' / '+parts.length);
    await firestore.runTransaction(db,async tx=>{guard();const fresh=assertStory((await tx.get(parent)).data());guard();if(fingerprint(clean(fresh))!==baseline)throw new Error('Firebase changed during backup. Nothing was replaced.');
      if(offset===0)tx.set(backup,{state:'preparing',createdAt:firestore.serverTimestamp(),deviceMessages:snapshot.messages.length,cloudMessages:previousMessages.length,parts:parts.length});
      for(let n=offset;n<Math.min(offset+6,parts.length);n++)tx.set(firestore.doc(db,'users',owner,'sessions',sid,'storyRecovery',id,'parts',String(n).padStart(6,'0')),parts[n]);
    });
  }
  const previousLore=cloudLore.map(d=>({id:d.id,...(d.data().schemaVersion===3?fromRecordDocument(d.data()):clean(d.data()))}));
  const cloudBackup={format:'nera-chat-backup',version:1,deviceHistoryComplete:true,exportedAt:new Date().toISOString(),session:{id:sid,...clean(before)},
    messages:previousMessages,storySettings:promptSnap.exists()?clean(promptSnap.data()):null,lore:previousLore,
    loreSnapshot:{initialized:true,entries:previousLore,schemaVersion:before.loreSchemaVersion ?? 2,generation:before.loreGeneration ?? null},directorTurns:cloudTurns.map(d=>({id:d.id,...clean(d.data())}))};
  guard();onProgress('Replacing Firebase with this device’s copy…');
  try{await firestore.runTransaction(db,async tx=>{guard();const fresh=assertStory((await tx.get(parent)).data());guard();if(fingerprint(clean(fresh))!==baseline)throw new Error('Firebase changed during upload. Backups were kept; the active cloud story was not replaced.');
    for(const write of writes)if(write.remove)tx.delete(write.target);else tx.set(write.target,write.data);
    const {id:omit,...data}=session;tx.set(parent,{...data,createdAt:before.createdAt ?? firestore.serverTimestamp(),updatedAt:firestore.serverTimestamp()});tx.update(backup,{state:'completed',completedAt:firestore.serverTimestamp(),uploadedHistoryRevision:session.historyRevision});
  });}catch(error){
    let receipt;try{receipt=await firestore.getDocFromServer(backup);}catch{throw Object.assign(new Error('The upload result could not be confirmed. Your device backup was kept. Check Firebase before retrying.'),{uploadUncertain:true,cause:error});}
    if(receipt.data()?.state!=='completed' || receipt.data()?.uploadedHistoryRevision!==session.historyRevision)throw error;
  }
  return {session,messages:snapshot.messages,storySettings,loreSnapshot,turns:Object.fromEntries(localTurns.map(t=>[t.id,t])),messageSnapshot:{messages:snapshot.messages,records:messageRecords.map(r=>({id:r.id,data:()=>r.data})),chunkRanges:messageRecords.map(r=>({id:r.id,firstOrder:r.data.firstOrder,lastOrder:r.data.lastOrder}))},backupId:id,cloudBackup};
}
