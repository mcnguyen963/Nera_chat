// Optional, device-local semantic index. The index stores vectors and source
// fingerprints, never card text. Canonical lore remains in the story store.
import { capLoreNotes } from './lore-note-window.js';
import { recordUnits } from './lore-record-select.js';
import { archivedThread } from './thread-archive.js';
import {getEmbeddingKey} from './embedding-credentials.js';

const database='nera-lore-semantic-v1', memory=new Map();
let opened;
function open() {
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return opened ??= new Promise(resolve=>{
    let done=false;
    const finish=db=>{if(done){db?.close();return;}done=true;clearTimeout(timer);resolve(db);};
    const timer=setTimeout(()=>finish(null),3000);
    try {const r=indexedDB.open(database,1);r.onupgradeneeded=()=>r.result.createObjectStore('indexes',{keyPath:'key'});r.onerror=r.onblocked=()=>finish(null);r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();opened=null;};finish(r.result);};}catch{finish(null);}
  });
}
async function transaction(mode,action) {
  const db=await open();if(!db)return null;
  return new Promise(resolve=>{try{let result=null;const tx=db.transaction('indexes',mode);action(tx.objectStore('indexes'),value=>result=value);tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>resolve(null);}catch{resolve(null);}});
}
const store={
  async load(key){if(memory.has(key))return memory.get(key);const result=await transaction('readonly',(s,set)=>{const r=s.get(key);r.onsuccess=()=>set(r.result ?? null);});if(result)memory.set(key,result);return result;},
  async findStory(owner,sid){
    let best=null;const consider=value=>{if(!value?.staging && value?.owner===owner && value.sid===sid && (!best || (value.updatedAt ?? 0)>(best.updatedAt ?? 0)))best=value;};
    for(const value of memory.values())consider(value);
    await transaction('readonly',(s,set)=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c){set(true);return;}consider(c.value);c.continue();};});
    return best;
  },
  async save(value,check=()=>{}){const saved=await transaction('readwrite',(s,set)=>{check();s.put(value);set(true);});if(saved)memory.set(value.key,value);return !!saved;},
  async loadStage(key){return this.load(key);},
  async saveStage(value,check){return this.save(value,check);},
  async removeStage(key){memory.delete(key);return transaction('readwrite',(s,set)=>{s.delete(key);set(true);});},
  async removeOwner(owner){const clear=()=>{for(const [key,value] of memory)if(value.owner===owner)memory.delete(key);};clear();const result=await transaction('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(c.value.owner===owner)c.delete();c.continue();};});clear();return result;},
  async removeStory(owner,sid){const clear=()=>{for(const [key,value] of memory)if(value.owner===owner && value.sid===sid)memory.delete(key);};clear();const result=await transaction('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(c.value.owner===owner && c.value.sid===sid)c.delete();c.continue();};});clear();return result;},
};
export async function clearLoreSemanticAccount(owner){await store.removeOwner(owner);}
export async function deleteLoreSemanticStory(owner,sid){await store.removeStory(owner,sid);}
export function semanticConnection(mem,owner){
  let url;try{url=new URL(String(mem.semanticEndpoint ?? '').trim());}catch{throw new Error('Enter a valid embedding URL.');}
  const host=url.hostname,parts=host.split('.').map(Number);
  const privateIPv4=/^\d+\.\d+\.\d+\.\d+$/.test(host) && parts.every(n=>n>=0 && n<=255) && (parts[0]===10 || parts[0]===127 || parts[0]===192 && parts[1]===168 || parts[0]===172 && parts[1]>=16 && parts[1]<=31 || parts[0]===169 && parts[1]===254);
  const local=host==='localhost' || host==='[::1]' || host.endsWith('.local') || privateIPv4 || /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(host);
  if((url.protocol!=='https:' && !(url.protocol==='http:' && local)) || url.username || url.password || url.search || url.hash)throw new Error('Use an HTTPS embedding URL or a local HTTP address, without credentials, query parameters or a fragment.');
  const model=String(mem.semanticModel ?? '').trim();if(!model || model.length>200)throw new Error('Enter an embedding model.');
  return {endpoint:url.href,model,apiKey:getEmbeddingKey(owner,url.href),key:JSON.stringify([url.href,model])};
}
function textFor(entry,limit) {
  if(!['characters','locations','facts','events'].includes(entry.book) || archivedThread(entry) || entry.kind==='timeline' || entry.book==='events' && entry.status==='closed')return '';
  let fragments;
  if(entry.schemaVersion===3){
    const records=recordUnits(entry,{loreNotesPerSection:limit}).units;
    fragments=records.filter(r=>!r.blocked && !r.fallback).map(r=>r.resolved.text);
  }else{
    const capped=capLoreNotes(entry,limit);
    fragments=Object.values(capped.sections ?? {}).flatMap(s=>[s.text,...(s.lines ?? []).map(l=>l.text)]);
  }
  const body=fragments.filter(t=>typeof t==='string' && t.trim()).join('\n').slice(0,12000);
  return body ? [entry.book,entry.name,...(entry.aliases ?? []),body].join('\n') : '';
}
async function digest(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');}
function validateVector(v){if(!Array.isArray(v) || !v.length || v.length>8192 || v.some(n=>!Number.isFinite(n)))throw new Error('Invalid embedding vector.');let norm=0;for(const n of v)norm+=n*n;if(!norm)throw new Error('Empty embedding vector.');return Float32Array.from(v,n=>n/Math.sqrt(norm));}
async function embed(connection,texts,{signal,timeout=15000}={}) {
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,timeout);
  let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Object.assign(new Error('Embedding request stopped or timed out.'),{name:'AbortError'}));controller.signal.addEventListener('abort',onAbort,{once:true});});
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  try{
    return await Promise.race([(async()=>{
      const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(connection.apiKey ? {Authorization:'Bearer '+connection.apiKey} : {})},body:JSON.stringify({model:connection.model,input:texts,encoding_format:'float'}),signal:controller.signal});
      if(!response.ok)throw new Error('Embedding server returned HTTP '+response.status+'.');
      const json=await response.json();if(!Array.isArray(json.data) || json.data.length!==texts.length)throw new Error('Invalid embedding response.');
      const rows=[...json.data].sort((a,b)=>a.index-b.index);return rows.map((row,i)=>{if(row.index!==i)throw new Error('Invalid embedding response order.');return validateVector(row.embedding);});
    })(),aborted]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',onAbort);}
}
const keyFor=(owner,sid,connection)=>JSON.stringify([owner,sid,connection.key,'records-v2']);
function documentsFor(entries,mem) {
  return entries.filter(e=>mem.books?.[e.book]?.on!==false).flatMap(entry=>{
    if(!textFor(entry,0))return [];
    if(entry.schemaVersion!==3)return [{id:entry.id,recordId:null,text:textFor(entry,mem.loreNotesPerSection)}];
    return recordUnits(entry,{loreNotesPerSection:0}).units.filter(r=>!r.blocked&&!r.fallback && r.resolved.text.trim()).map(r=>({id:entry.id,recordId:r.id,text:[entry.book,entry.name,...(entry.aliases ?? []),r.resolved.text].join('\n')}));
  });
}
export function createLoreSemantic({storage=store,embedder=embed}={}) {
  async function index({owner,sid,mem,entries,signal,check=()=>{},progress=()=>{},force=false}){
    if(!owner || !sid)throw new Error('Open a signed-in story first.');
    const connection=semanticConnection(mem,owner),key=keyFor(owner,sid,connection),rows=[];
    const documents=documentsFor(entries,mem),old=await storage.load(key);check();
    const stageKey=JSON.stringify([key,'lore-stage-v1',!!force]);
    const staged=await storage.loadStage?.(stageKey);check();
    if(documents.length>20000)throw new Error('The local index supports up to 20,000 lore records.');
    const previous=new Map((old?.rows ?? []).map(row=>[JSON.stringify([row.id,row.recordId,row.hash]),row]));
    const stagedRows=new Map((staged?.rows ?? []).map(row=>[JSON.stringify([row.id,row.recordId,row.hash]),row]));
    for(let i=0;i<documents.length;i+=8){
      check();if(signal?.aborted)throw new Error('Indexing stopped.');
      const batch=documents.slice(i,i+8),hashes=await Promise.all(batch.map(x=>digest(x.text)));
      const cached=batch.map((x,j)=>{const k=JSON.stringify([x.id,x.recordId,hashes[j]]),ready=stagedRows.get(k);if(ready?.modelKey===connection.key)return ready;const row=previous.get(k);return !force && row && (row.modelKey ?? old?.connection)===connection.key ? row : null;});
      const missing=batch.filter((_,j)=>!cached[j]);
      const vectors=missing.length ? await embedder(connection,missing.map(x=>x.text),{signal}) : [];check();if(signal?.aborted)throw new Error('Indexing stopped.');
      if(vectors.length!==missing.length || vectors.some(v=>v.length!==vectors[0].length))throw new Error('Incompatible embedding dimensions.');
      let k=0;for(let j=0;j<batch.length;j++)rows.push({id:batch[j].id,recordId:batch[j].recordId,hash:hashes[j],vector:cached[j]?.vector ?? vectors[k++],modelKey:cached[j]?.modelKey ?? connection.key,modelId:cached[j]?.modelId ?? connection.model});
      if(storage.saveStage){for(const row of rows.slice(-batch.length))stagedRows.set(JSON.stringify([row.id,row.recordId,row.hash]),row);if(!await storage.saveStage({key:stageKey,owner,sid,connection:connection.key,staging:true,rows:[...stagedRows.values()]},check))throw new Error('Could not save embedding progress on this device.');}
      progress({done:rows.length,total:documents.length});
    }
    check();if(signal?.aborted)throw new Error('Indexing stopped.');
    if(rows.some(r=>r.vector.length!==rows[0].vector.length))throw new Error('Incompatible embedding dimensions.');
    if(!await storage.save({key,owner,sid,connection:connection.key,updatedAt:Date.now(),rows},check))throw new Error('Device storage is unavailable or the story changed; index was not saved.');
    await storage.removeStage?.(stageKey);
    return {count:new Set(rows.map(row=>row.id)).size,records:rows.length};
  }
  async function search({owner,sid,mem,entries,query,signal,check}){
    const guard=check ?? (()=>{});
    if(!mem.semanticLore || !owner || !sid || !String(query ?? '').trim())return {ids:[],status:'off'};
    try{
      const connection=semanticConnection(mem,owner),key=keyFor(owner,sid,connection);let saved=await storage.load(key);guard();
      if(!saved && storage.findStory)saved=await storage.findStory(owner,sid);guard();
      if(!saved)return {ids:[],status:'index missing'};
      const documents=documentsFor(entries,mem),docs=new Map();
      for(const doc of documents)docs.set(JSON.stringify([doc.id,doc.recordId]),await digest(doc.text));
      const valid=saved.rows.filter(row=>docs.get(JSON.stringify([row.id,row.recordId]))===row.hash);
      guard();
      if(!documents.length)return {ids:[],records:{},candidates:[],status:'ready'};
      if(!valid.length)return {ids:[],records:{},candidates:[],status:'index out of date'};
      const [vector]=await embedder(connection,[String(query).slice(-4000)],{signal,timeout:1500});guard();
      const ranked=valid.filter(row=>row.vector.length===vector.length).map(row=>{let score=0;for(let i=0;i<vector.length;i++)score+=row.vector[i]*vector[i];return {id:row.id,recordId:row.recordId,score};}).sort((a,b)=>b.score-a.score);
      if(!ranked.length)return {ids:[],modelMismatch:valid.some(row=>(row.modelKey ?? saved.connection)!==connection.key),incompatibleDimensions:valid.filter(row=>row.vector.length!==vector.length).length,status:'index out of date'};
      const matches=ranked.filter(r=>r.score>=0.4),ids=[...new Set(matches.map(r=>r.id))].slice(0,3),records={};
      for(const match of matches)if(ids.includes(match.id)&&match.recordId!=null && (records[match.id]?.length ?? 0)<3)(records[match.id] ??= []).push(match.recordId);
      return {ids,records,candidates:matches.filter(r=>ids.includes(r.id)),modelMismatch:valid.some(row=>(row.modelKey ?? saved.connection)!==connection.key),status:valid.length<documents.length?'partial index':'ready'};
    }catch(error){if(signal?.aborted)throw error;guard();return {ids:[],status:'unavailable'};}
  }
  async function exportVectors({owner,sid,mem}) {
    const connection=semanticConnection(mem,owner);let saved=await storage.load(keyFor(owner,sid,connection));
    if(!saved && storage.findStory)saved=await storage.findStory(owner,sid);
    return (saved?.rows ?? []).map(row=>({...row,modelKey:row.modelKey ?? saved.connection}));
  }
  async function importVectors({owner,sid,mem,entries,rows,check=()=>{}}) {
    const connection=semanticConnection(mem,owner),key=keyFor(owner,sid,connection),existing=await storage.load(key),docs=new Map();
    for(const doc of documentsFor(entries,mem))docs.set(JSON.stringify([doc.id,doc.recordId]),await digest(doc.text));
    const merged=new Map((existing?.rows ?? []).map(r=>[JSON.stringify([r.id,r.recordId]),r]));let restored=0,skipped=0;
    for(const row of rows) {
      check();const id=JSON.stringify([row.id,row.recordId]);
      if(docs.get(id)!==row.hash){skipped++;continue;}
      try {const v=validateVector(Array.from(row.vector ?? [])),local=merged.get(id);if(!local || local.hash!==row.hash){merged.set(id,{...row,vector:v});restored++;}}catch{skipped++;}
    }
    check();if(!await storage.save({key,owner,sid,connection:connection.key,updatedAt:Date.now(),rows:[...merged.values()]},check))throw new Error('Device storage is unavailable.');
    return {restored,skipped};
  }
  return {index,search,exportVectors,importVectors};
}
export const loreSemantic=createLoreSemantic();
