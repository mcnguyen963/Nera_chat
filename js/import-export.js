import {flushStory} from './story-sync.js';
import { exportDirectorTurns, importDirectorTurns } from './director-store.js';
import { validateDirectorState } from './director-state.js';
import {ensureStorySettings,writeInitialStorySettings,preserveLegacyStorySeed} from './story-settings-store.js';
import {assertSnapshotRevisions,migrateStorySettings} from './story-settings.js';
import {state} from './state.js';
import { maxOf } from './math-utils.js';
import * as sessionsApi from './sessions.js';
import * as messagesApi from './messages.js';
import {currentUid} from './auth.js';
import {normalizeLoreEntry} from './lore-format.js';
import {download} from './ui/memory-ui.js';
import { getLore, importLore } from './lore-store.js';
import * as loreStore from './lore-store.js';
import { normalizeMemory } from './memory-settings.js';
import {rebaseImportedLore,recoveredReplyForImport,validateImportedMessages,validateRecoveredReply} from './import-recovery.js';
import {storeUnsavedReply} from './unsaved-replies.js';
// SillyTavern JSONL import/export (spec §10). Chat log only, no character cards.
// Line 1 is a metadata header ({user_name, character_name, create_date}); every
// subsequent line is one message {name, is_user, send_date, mes}.

import { createSession, getSession, updateSession, deleteSession, listSessions } from "./sessions.js";
import { getMessages, addMessagesBulk } from "./messages.js";

const importReports=new Map();
export const importReport=sid=>importReports.get(sid) ?? null;
export function parseSillyTavernJsonl(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (!lines.some(Boolean)) throw new Error("File is empty.");

  let title = null, metadata = null;
  const messages = [],damaged=[];let firstRecord=true;

  for (let i = 0; i < lines.length; i++) {
    if(!lines[i])continue;
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      damaged.push(i+1);continue;
    }
    if(!obj || typeof obj!=='object' || Array.isArray(obj))continue;
    if(obj.neraStorySeparator || obj.neraAccount)throw new Error('This is an account backup. Split it at neraStorySeparator records and import each story separately.');
    if (obj.mes === undefined) {
      // Metadata header line
      if (firstRecord && obj.character_name) title = obj.character_name;
      if (firstRecord && obj.nera?.version === 2) metadata = obj.nera;
      firstRecord=false;
      continue;
    }
    if(typeof obj.mes!=='string'){damaged.push(i+1);continue;}
    messages.push({
      ...(obj.nera?.message ?? {}),
      role:obj.nera?.message?.role ?? (obj.is_user === true ? "user" : "assistant"),content:String(obj.mes),
    });
    firstRecord=false;
  }

  if(damaged.length)throw Object.assign(new Error(`Damaged JSON on line${damaged.length===1?'':'s'} ${damaged.slice(0,20).join(', ')}${damaged.length>20?' (and more)':''}. No story was imported.`),{lineNumbers:damaged});
  if (messages.length === 0 && !metadata) throw new Error("No messages found in file.");
  return { title,messages,metadata };
}

export async function importSillyTavern(file) {
  // Full backups include lore and private reply metadata as well as messages.
  // Long stories can exceed 20 MB without any single document being oversized.
  const owner=currentUid(),maxBytes=64*1024*1024;
  if(file.size>maxBytes)throw new Error('The story file is larger than 64 MB.');
  const text=await file.text();if(new TextEncoder().encode(text).length>maxBytes)throw new Error('The story file is larger than 64 MB.');
  let parsed,full;
  try{full=JSON.parse(text);}catch(error){
    if(/\.json$/i.test(file.name ?? '') || /"format"\s*:\s*"nera-chat-backup"/.test(text))throw new Error('The JSON backup is damaged. No story was imported.');
  }
  if(full?.format==='nera-chat-backup'){
    if(!Array.isArray(full.messages) || !full.session || full.version!=null && full.version!==1)throw new Error('Invalid or unsupported story backup. No story was imported.');
    parsed={title:full.session.title,messages:full.messages,metadata:{session:full.session,lore:full.lore,storySettings:full.storySettings,directorTurns:full.directorTurns,unsavedReply:full.unsavedReply}};
  }
  const {title,messages:rawMessages,metadata}=parsed ?? parseSillyTavernJsonl(text);
  const hasUnorderedMessages=rawMessages.some(m=>m?.order==null),messages=validateImportedMessages(rawMessages);
  validateRecoveredReply(metadata?.unsavedReply);
  if(metadata?.session?.directorState)validateDirectorState(metadata.session.directorState);
  if(metadata?.directorTurns && (!Array.isArray(metadata.directorTurns) || metadata.directorTurns.some(t=>t.version!==1)))throw new Error('Unsupported Director backup.');
  for(const turn of metadata?.directorTurns ?? []){
    if(typeof turn.id!=='string' || !/^[\w-]+$/.test(turn.id))throw new Error('Unsupported Director backup.');
    validateDirectorState(turn.before);validateDirectorState(turn.after);
  }
  const normalizedLore=[];let droppedLore=0;
  for(const e of Array.isArray(metadata?.lore) ? metadata.lore : []){try{normalizedLore.push(normalizeLoreEntry(e));}catch{droppedLore++;}}
  const loreIds=new Set();
  for(const entry of normalizedLore){
    if(loreIds.has(entry.id))throw new Error(`Duplicate lore card ID "${entry.id}" in the backup. Each card must have a unique ID. No story was imported.`);
    loreIds.add(entry.id);
  }
  const source=metadata?.session ?? {},lore=rebaseImportedLore(normalizedLore,messages,source);
  const importedSettings=metadata?.storySettings?.values ?? metadata?.storySettings;
  const preparedSettings=importedSettings ? await migrateStorySettings(importedSettings) : null;
  const importedDirectorState=source.directorState ?? (metadata?.directorTurns ?? []).find(t=>t.id===source.directorPending)?.before;
  if(importedDirectorState)validateDirectorState(importedDirectorState);
  const checkOwner=()=>{if(owner!==currentUid())throw new Error('Account changed; import cancelled.');};
  checkOwner();
  const sessionId=await createSession(title || (file.name ?? '').replace(/\.(?:jsonl|json)$/i,'') || 'Imported chat',{importing:true});
  try {
    checkOwner();
    const values=preparedSettings ?? await preserveLegacyStorySeed(state.settings);
    checkOwner();await writeInitialStorySettings(sessionId,values);checkOwner();
    await addMessagesBulk(sessionId,messages);checkOwner();
    // Importing a full V3 backup explicitly creates a new selective story.
    // Existing destinations still require the separate migration action.
    if(lore.some(e=>e.schemaVersion===3)){await loreStore.migrateRecords(sessionId,[],{expectedRevision:0});checkOwner();}
    if(lore.length){await importLore(sessionId,{writes:lore.map(e=>({id:e.id,data:e}))},[]);checkOwner();}
    const memory=normalizeMemory(source.memory);
    memory.autoUpdate=false;memory.sceneFallback=false;memory.updateMaxTokens=normalizeMemory().updateMaxTokens;
    const maxOrder=Math.max(0,maxOf(messages.map((m,i)=>m.order ?? i+1)));
    const summary=messages.find(m=>m.id===source.activeSummaryMessageId && m.role==='summary');
    const pointer=source.memoryState?.extractedThroughOrder;
    const patch={longTermPlan:typeof source.longTermPlan==='string'?source.longTermPlan:'',memory,
      memoryState:{extractedThroughOrder:hasUnorderedMessages ? 0 : Number.isSafeInteger(pointer)?Math.max(0,Math.min(maxOrder,pointer)):null,failureStreak:0,paused:false,lastError:null,
        ...(source.memoryState?.needsRebuild ? {needsRebuild:true,rebuildFromOrder:hasUnorderedMessages?0:Math.max(0,Math.min(maxOrder,Number.isSafeInteger(source.memoryState.rebuildFromOrder)?source.memoryState.rebuildFromOrder:0))} : {})},
      activeSummaryMessageId:summary?.id ?? null,breakpointOrder:summary ? Math.max(0,Math.min(maxOrder,Number(source.breakpointOrder)||0)) : 0,
      importing:false};
    if(importedDirectorState){const turns=(metadata.directorTurns ?? []).filter(t=>t.status==='completed');await importDirectorTurns(sessionId,turns);Object.assign(patch,{directorState:validateDirectorState(importedDirectorState),directorRevision:0,directorPending:null,directorCheckpoint:turns.some(t=>t.id===source.directorCheckpoint)?source.directorCheckpoint:null,directorStateHistoryOrder:source.directorStateHistoryOrder ?? maxOrder,directorAbandonedTurnIds:[...(source.directorAbandonedTurnIds ?? []),...(metadata.directorTurns ?? []).filter(t=>t.status!=='completed').map(t=>t.id)],directorNeedsReview:!!source.directorNeedsReview || !!source.directorPending});}
    checkOwner();
    let recovered=null,replyPersisted=true;
    if(metadata?.unsavedReply){
      const destination={...await getSession(sessionId),...patch};checkOwner();
      recovered=recoveredReplyForImport(metadata.unsavedReply,{messages,source,destination,owner,sid:sessionId,newId:()=>messagesApi.newMessageId(),directorMode:values?.narrationMode==='director'});
      if(recovered){replyPersisted=await storeUnsavedReply(owner,sessionId,recovered);checkOwner();}
    }
    await updateSession(sessionId,patch);checkOwner();
    const report={sessionId,droppedLore,recoveredReply:!!recovered,replyPersisted,message:'Imported. Background memory is off — turn it on in Memory settings.'+(droppedLore ? ' '+droppedLore+' invalid lore cards were skipped.' : '')+(recovered?' An unsaved reply is available below the story.':'')+(!replyPersisted?' Keep this page open: the recovered reply could not be saved on this device.':'')};
    importReports.set(sessionId,report);if(importReports.size>3)importReports.delete(importReports.keys().next().value);
    if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('import-report',{detail:report}));
    return sessionId;
  }catch(error){try{if(owner===currentUid()){await storeUnsavedReply(owner,sessionId,null);await deleteSession(sessionId);}}catch(cleanup){console.error('Incomplete import cleanup will resume:',cleanup);}throw error;}
}

export async function serializeStory(sessionId) {
  const owner=currentUid(),check=()=>{if(owner!==currentUid())throw new Error('Account changed while exporting. Try again.');};
  await flushStory(sessionId);
  check();
  await messagesApi.ensureChunked(sessionId);check();
  const storySettings=await ensureStorySettings(sessionId,owner);check();
  const loreSnapshot=await loreStore.getLoreSnapshot(sessionId),lore=loreSnapshot.entries,loreInfo=loreStore.loreSnapshotInfo(loreSnapshot);check();
  const session = await sessionsApi.getSessionFromServer(sessionId);check();
  if (!session) throw new Error("No active session to export.");
  assertSnapshotRevisions({...session,storySettingsRevision:storySettings.revision},session);
  const msgs = await getMessages(sessionId);check();
  const directorTurns=session.directorState || session.directorPending ? await exportDirectorTurns(sessionId) : [];
  // Disabled: exports capture cached lore, rather than rereading the collection.
  // lore=await getLore(sessionId);
  assertSnapshotRevisions(session,await sessionsApi.getSessionFromServer(sessionId),{cachedLore:true});
  check();

  const lines = [
    JSON.stringify({
      user_name: "You",
      character_name: session.title,
      create_date: new Date().toISOString(),
      nera:{ version:2,storySettings,session:Object.fromEntries(["longTermPlan","memory","memoryState","activeSummaryMessageId","breakpointOrder","memoryInvalidations","historyRevision","nextNarratorTurn","directorState","directorRevision","directorCheckpoint","directorPending","directorNeedsReview","directorStateHistoryOrder","directorAbandonedTurnIds"].filter(k => k in session).map(k => [k,session[k]])),lore,loreSnapshot:loreInfo,...(directorTurns.length ? {directorTurns} : {}) },
    }),
  ];
  for (const m of msgs) {
    const created = m.createdAt?.toDate ? m.createdAt.toDate().toISOString() : new Date().toISOString();
    lines.push(
      JSON.stringify({
        name: m.role === "user" ? "You" : session.title,
        is_user: m.role === "user",
        send_date: created,
        mes: m.content,
        nera:{ message:m },
      })
    );
  }

  return {text:lines.join('\n')+'\n',title:session.title,source:session};
}
export async function exportSillyTavern(sessionId){const {text,title}=await serializeStory(sessionId);download(text,(title || 'session').replace(/[^\w\- ]+/g,'').trim()+'.jsonl','application/x-ndjson');}
export async function exportAllStories({signal,onProgress=()=>{},save=download}={}){
 const owner=currentUid(),captured=[];
 const sessions=(await listSessions()).filter(s=>!s.deleting && !s.importing),blocks=[JSON.stringify({neraAccount:{version:1,exportedAt:new Date().toISOString(),stories:sessions.length}})];
 const check=()=>{if(owner!==currentUid())throw new Error('Account changed while exporting. Try again.');if(signal?.aborted)throw Object.assign(new Error('Export cancelled.'),{name:'AbortError'});};
 for(const [i,s] of sessions.entries()){check();onProgress({done:i,total:sessions.length,title:s.title});const story=await serializeStory(s.id);captured.push({id:s.id,source:story.source});check();blocks.push(JSON.stringify({neraStorySeparator:{index:i+1,id:s.id,title:story.title}}),story.text.trimEnd());}
 for(const capture of captured){check();assertSnapshotRevisions(capture.source,await sessionsApi.getSessionFromServer(capture.id),{cachedLore:true});}
 check();onProgress({done:sessions.length,total:sessions.length});const text=blocks.join('\n')+'\n';save(text,'nera-all-stories-'+new Date().toISOString().slice(0,10)+'.jsonl','application/x-ndjson');return sessions.length;
}

// Preserve MAIN's full JSON backup alongside the v2 story/account exports.
export async function buildFullBackup(sessionId){
 const owner=currentUid(),check=()=>{if(owner!==currentUid())throw new Error('Account changed while exporting. Try again.');};
 await flushStory(sessionId);check();
 await messagesApi.ensureChunked(sessionId);check();
 const storySettings=await ensureStorySettings(sessionId);check();
 const loreSnapshot=await loreStore.getLoreSnapshot(sessionId),lore=loreSnapshot.entries;check();
 const before=await sessionsApi.getSessionFromServer(sessionId);check();
 if(!before || before.deleting || before.importing)throw new Error('This story no longer exists on the server.');
 assertSnapshotRevisions({...before,storySettingsRevision:storySettings.revision},before);
 // Disabled collection reload: const lore=await getLore(sessionId);
 const messages=await getMessages(sessionId);check();
 const directorTurns=before.directorState || before.directorPending ? await exportDirectorTurns(sessionId) : [];
 const after=await sessionsApi.getSessionFromServer(sessionId);check();
 assertSnapshotRevisions(before,after,{cachedLore:true});
 const stable=s=>Object.fromEntries(Object.entries(s).filter(([key])=>!['loreRevision','loreGeneration','loreSchemaVersion','loreMigration','updatedAt'].includes(key)));
 if(JSON.stringify(stable(before))!==JSON.stringify(stable(after)))throw new Error('The story changed while exporting. Try again when both devices are idle.');
 return {format:'nera-chat-backup',version:1,exportedAt:new Date().toISOString(),session:after,storySettings,messages,lore,loreSnapshot:loreStore.loreSnapshotInfo(loreSnapshot),...(directorTurns.length ? {directorTurns} : {})};
}
export async function exportFullBackup(sessionId){const backup=await buildFullBackup(sessionId);download(JSON.stringify(backup,null,2)+'\n',(backup.session.title || 'session').replace(/[^\w\- ]+/g,'').trim()+'-backup.json','application/json');}
