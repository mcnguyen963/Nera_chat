import * as sessionsApi from './sessions.js';
import * as messagesApi from './messages.js';
import {currentUid} from './auth.js';
import {normalizeLoreEntry} from './lore-format.js';
import {download} from './ui/memory-ui.js';
import { getLore, importLore } from './lore-store.js';
import { normalizeMemory } from './memory-settings.js';
// SillyTavern JSONL import/export (spec §10). Chat log only, no character cards.
// Line 1 is a metadata header ({user_name, character_name, create_date}); every
// subsequent line is one message {name, is_user, send_date, mes}.

import { createSession, getSession, updateSession, deleteSession, listSessions } from "./sessions.js";
import { getMessages, addMessagesBulk } from "./messages.js";

const importReports=new Map();
export const importReport=sid=>importReports.get(sid) ?? null;
export function parseSillyTavernJsonl(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("File is empty.");

  let title = null, metadata = null;
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // skip malformed lines
    }
    if(!obj || typeof obj!=='object' || Array.isArray(obj))continue;
    if(obj.neraStorySeparator || obj.neraAccount)throw new Error('This is an account backup. Split it at neraStorySeparator records and import each story separately.');
    if (obj.mes === undefined) {
      // Metadata header line
      if (i === 0 && obj.character_name) title = obj.character_name;
      if (i === 0 && obj.nera?.version === 2) metadata = obj.nera;
      continue;
    }
    messages.push({
      ...(obj.nera?.message ?? {}),
      role:obj.nera?.message?.role ?? (obj.is_user === true ? "user" : "assistant"),content:String(obj.mes),
    });
  }

  if (messages.length === 0) throw new Error("No messages found in file.");
  return { title,messages,metadata };
}

export async function importSillyTavern(file) {
  if(file.size>20*1024*1024)throw new Error('The story file is larger than 20 MB.');
  const text=await file.text();if(new TextEncoder().encode(text).length>20*1024*1024)throw new Error('The story file is larger than 20 MB.');
  const {title,messages,metadata}=parseSillyTavernJsonl(text);
  const lore=[];let droppedLore=0;
  for(const e of Array.isArray(metadata?.lore) ? metadata.lore : []){try{lore.push(normalizeLoreEntry(e));}catch{droppedLore++;}}
  const sessionId=await createSession(title || file.name.replace(/\.jsonl$/i,'') || 'Imported chat',{importing:true});
  try {
    await addMessagesBulk(sessionId,messages);
    if(lore.length)await importLore(sessionId,{writes:lore.map(e=>({id:e.id,data:e}))},[]);
    const source=metadata?.session ?? {},memory=normalizeMemory(source.memory);
    memory.autoUpdate=false;memory.sceneFallback=false;memory.updateMaxTokens=normalizeMemory().updateMaxTokens;
    const maxOrder=Math.max(0,...messages.map((m,i)=>m.order ?? i+1));
    const summary=messages.find(m=>m.id===source.activeSummaryMessageId && m.role==='summary');
    const pointer=source.memoryState?.extractedThroughOrder;
    const patch={longTermPlan:typeof source.longTermPlan==='string'?source.longTermPlan:'',memory,
      memoryState:{extractedThroughOrder:Number.isSafeInteger(pointer)?Math.max(0,Math.min(maxOrder,pointer)):null,failureStreak:0,paused:false,lastError:null},
      activeSummaryMessageId:summary?.id ?? null,breakpointOrder:summary ? Math.max(0,Math.min(maxOrder,Number(source.breakpointOrder)||0)) : 0,
      importing:false};
    await updateSession(sessionId,patch);
    const report={sessionId,droppedLore,message:'Imported. Background memory is off — turn it on in Memory settings.'+(droppedLore ? ' '+droppedLore+' invalid lore cards were skipped.' : '')};
    importReports.set(sessionId,report);if(importReports.size>3)importReports.delete(importReports.keys().next().value);
    if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('import-report',{detail:report}));
    return sessionId;
  }catch(error){try{await deleteSession(sessionId);}catch(cleanup){console.error('Incomplete import cleanup will resume:',cleanup);}throw error;}
}

export async function serializeStory(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("No active session to export.");
  const msgs = await getMessages(sessionId);
  const lore = await getLore(sessionId);

  const lines = [
    JSON.stringify({
      user_name: "You",
      character_name: session.title,
      create_date: new Date().toISOString(),
      nera:{ version:2,session:Object.fromEntries(["longTermPlan","memory","memoryState","activeSummaryMessageId","breakpointOrder","memoryInvalidations","historyRevision","nextNarratorTurn"].filter(k => k in session).map(k => [k,session[k]])),lore },
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

  return {text:lines.join('\n')+'\n',title:session.title};
}
export async function exportSillyTavern(sessionId){const {text,title}=await serializeStory(sessionId);download(text,(title || 'session').replace(/[^\w\- ]+/g,'').trim()+'.jsonl','application/x-ndjson');}
export async function exportAllStories({signal,onProgress=()=>{},save=download}={}){
 const sessions=(await listSessions()).filter(s=>!s.deleting && !s.importing),blocks=[JSON.stringify({neraAccount:{version:1,exportedAt:new Date().toISOString(),stories:sessions.length}})];
 const check=()=>{if(signal?.aborted)throw Object.assign(new Error('Export cancelled.'),{name:'AbortError'});};
 for(const [i,s] of sessions.entries()){check();onProgress({done:i,total:sessions.length,title:s.title});const story=await serializeStory(s.id);check();blocks.push(JSON.stringify({neraStorySeparator:{index:i+1,id:s.id,title:story.title}}),story.text.trimEnd());}
 check();onProgress({done:sessions.length,total:sessions.length});const text=blocks.join('\n')+'\n';save(text,'nera-all-stories-'+new Date().toISOString().slice(0,10)+'.jsonl','application/x-ndjson');return sessions.length;
}

// Preserve MAIN's full JSON backup alongside the v2 story/account exports.
export async function buildFullBackup(sessionId){
 const owner=currentUid(),check=()=>{if(owner!==currentUid())throw new Error('Account changed while exporting. Try again.');};
 await messagesApi.ensureChunked(sessionId);check();
 const before=await sessionsApi.getSessionFromServer(sessionId);check();
 if(!before || before.deleting || before.importing)throw new Error('This story no longer exists on the server.');
 const messages=await getMessages(sessionId),lore=await getLore(sessionId);check();
 const after=await sessionsApi.getSessionFromServer(sessionId);check();
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('The story changed while exporting. Try again when both devices are idle.');
 return {format:'nera-chat-backup',version:1,exportedAt:new Date().toISOString(),session:after,messages,lore};
}
export async function exportFullBackup(sessionId){const backup=await buildFullBackup(sessionId);download(JSON.stringify(backup,null,2)+'\n',(backup.session.title || 'session').replace(/[^\w\- ]+/g,'').trim()+'-backup.json','application/json');}
