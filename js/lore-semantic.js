// Optional, device-local semantic index. The index stores vectors and source
// fingerprints, never card text. Canonical lore remains in the story store.
import { capLoreNotes } from './lore-note-window.js';
import { recordUnits } from './lore-record-select.js';
import { archivedThread } from './thread-archive.js';

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
  async save(value,check=()=>{}){const saved=await transaction('readwrite',(s,set)=>{check();s.put(value);set(true);});if(saved)memory.set(value.key,value);return !!saved;},
  async removeOwner(owner){const clear=()=>{for(const [key,value] of memory)if(value.owner===owner)memory.delete(key);};clear();const result=await transaction('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(c.value.owner===owner)c.delete();c.continue();};});clear();return result;},
  async removeStory(owner,sid){const clear=()=>{for(const [key,value] of memory)if(value.owner===owner && value.sid===sid)memory.delete(key);};clear();const result=await transaction('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(c.value.owner===owner && c.value.sid===sid)c.delete();c.continue();};});clear();return result;},
};
export async function clearLoreSemanticAccount(owner){await store.removeOwner(owner);}
export async function deleteLoreSemanticStory(owner,sid){await store.removeStory(owner,sid);}
export function semanticConnection(mem){
  const url=new URL(String(mem.semanticEndpoint ?? '').trim());
  if(url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)throw new Error('Use a local Ollama HTTP endpoint on this device, without credentials or query parameters.');
  const model=String(mem.semanticModel ?? '').trim();if(!model || model.length>200)throw new Error('Enter an embedding model.');
  return {endpoint:url.href,model,key:JSON.stringify([url.href,model])};
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
      const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:connection.model,input:texts,encoding_format:'float'}),signal:controller.signal});
      if(!response.ok)throw new Error('Embedding server returned HTTP '+response.status+'.');
      const json=await response.json();if(!Array.isArray(json.data) || json.data.length!==texts.length)throw new Error('Invalid embedding response.');
      const rows=[...json.data].sort((a,b)=>a.index-b.index);return rows.map((row,i)=>{if(row.index!==i)throw new Error('Invalid embedding response order.');return validateVector(row.embedding);});
    })(),aborted]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',onAbort);}
}
const keyFor=(owner,sid,connection)=>JSON.stringify([owner,sid,connection.key]);
export function createLoreSemantic({storage=store,embedder=embed}={}) {
  async function index({owner,sid,mem,entries,signal,check=()=>{},progress=()=>{}}){
    if(!owner || !sid)throw new Error('Open a signed-in story first.');
    const connection=semanticConnection(mem),key=keyFor(owner,sid,connection),rows=[];
    const documents=entries.map(entry=>({id:entry.id,text:textFor(entry,mem.loreNotesPerSection)})).filter(e=>e.text);
    if(documents.length>2000)throw new Error('The local index supports up to 2,000 lore cards.');
    for(let i=0;i<documents.length;i+=8){
      check();if(signal?.aborted)throw new Error('Indexing stopped.');
      const batch=documents.slice(i,i+8),vectors=await embedder(connection,batch.map(x=>x.text),{signal});check();if(signal?.aborted)throw new Error('Indexing stopped.');
      if(vectors.length!==batch.length || vectors.some(v=>v.length!==vectors[0].length))throw new Error('Incompatible embedding dimensions.');
      for(let j=0;j<batch.length;j++)rows.push({id:batch[j].id,hash:await digest(batch[j].text),vector:vectors[j]});
      progress({done:rows.length,total:documents.length});
    }
    check();if(signal?.aborted)throw new Error('Indexing stopped.');
    if(rows.some(r=>r.vector.length!==rows[0].vector.length))throw new Error('Incompatible embedding dimensions.');
    if(!await storage.save({key,owner,sid,connection:connection.key,rows},check))throw new Error('Device storage is unavailable or the story changed; index was not saved.');
    return {count:rows.length};
  }
  async function search({owner,sid,mem,entries,query,signal,check=()=>{}}){
    if(!mem.semanticLore || !owner || !sid || !String(query ?? '').trim())return {ids:[],status:'off'};
    try{
      const connection=semanticConnection(mem),saved=await storage.load(keyFor(owner,sid,connection));check();
      if(!saved)return {ids:[],status:'index missing'};
      const docs=new Map(entries.filter(e=>mem.books?.[e.book]?.on!==false).map(e=>[e.id,textFor(e,mem.loreNotesPerSection)]));
      const eligible=[...docs.values()].filter(Boolean).length;
      if(!eligible)return {ids:[],status:'ready'};
      const valid=[];for(const row of saved.rows){const text=docs.get(row.id);if(text && row.hash===await digest(text))valid.push(row);}
      check();if(!valid.length)return {ids:[],status:'index out of date'};
      const [vector]=await embedder(connection,[String(query).slice(-4000)],{signal,timeout:1500});check();
      const ranked=valid.filter(row=>row.vector.length===vector.length).map(row=>{let score=0;for(let i=0;i<vector.length;i++)score+=row.vector[i]*vector[i];return {id:row.id,score};}).sort((a,b)=>b.score-a.score);
      if(!ranked.length)return {ids:[],status:'index out of date'};
      // Conservative experimental gate; a similarity score is not proof of relevance.
      return {ids:ranked.filter(r=>r.score>=0.4).slice(0,3).map(r=>r.id),status:valid.length<eligible?'partial index':'ready'};
    }catch(error){if(signal?.aborted)throw error;check();return {ids:[],status:'unavailable'};}
  }
  return {index,search};
}
export const loreSemantic=createLoreSemantic();
