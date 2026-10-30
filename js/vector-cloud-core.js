// Derived indexes are independent of canonical story documents. Cloud adapters
// provide immutable chunk writes and an atomic, revision-checked manifest update.
const MAX_BYTES=180000;
const encoder=new TextEncoder();
const bytes=s=>encoder.encode(s).length;
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function packVector(vector){
  const raw=new Uint8Array(vector.length*4),view=new DataView(raw.buffer);for(let i=0;i<vector.length;i++)view.setFloat32(i*4,vector[i],true);
  let out='';for(let i=0;i<raw.length;i+=3){const n=(raw[i]<<16)|((raw[i+1]??0)<<8)|(raw[i+2]??0);out+=alphabet[(n>>18)&63]+alphabet[(n>>12)&63]+(i+1<raw.length?alphabet[(n>>6)&63]:'=')+(i+2<raw.length?alphabet[n&63]:'=');}return out;
}
function unpackVector(text){
  if(typeof text!=='string' || text.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw new Error('Invalid encoded vector.');
  const size=text.length/4*3-(text.endsWith('==')?2:text.endsWith('=')?1:0);if(!size || size%4 || size>8192*4)throw new Error('Invalid encoded vector.');
  const raw=new Uint8Array(size);let offset=0;for(let i=0;i<text.length;i+=4){const n=(alphabet.indexOf(text[i])<<18)|(alphabet.indexOf(text[i+1])<<12)|((text[i+2]==='='?0:alphabet.indexOf(text[i+2]))<<6)|(text[i+3]==='='?0:alphabet.indexOf(text[i+3]));if(offset<size)raw[offset++]=(n>>16)&255;if(offset<size)raw[offset++]=(n>>8)&255;if(offset<size)raw[offset++]=n&255;}
  const view=new DataView(raw.buffer);return Array.from({length:size/4},(_,i)=>view.getFloat32(i*4,true));
}
async function digest(text) {
  const value=await crypto.subtle.digest('SHA-256',encoder.encode(text));
  return Array.from(new Uint8Array(value),v=>v.toString(16).padStart(2,'0')).join('');
}
function storedRow(row,kind) {
  const vector=typeof row.vector==='string' ? unpackVector(row.vector) : Array.from(row.vector ?? []);
  if(!vector.length || vector.length>8192 || vector.some(n=>typeof n!=='number' || !Number.isFinite(n) || !Number.isFinite(Math.fround(n))) || !vector.some(n=>Math.fround(n)!==0))throw new Error('Invalid embedding vector.');
  if(row.modelKey!=null && (typeof row.modelKey!=='string' || row.modelKey.length>1000) || row.modelId!=null && (typeof row.modelId!=='string' || row.modelId.length>200))throw new Error('Invalid embedding model metadata.');
  let inferredModel='';try{const parsed=JSON.parse(row.modelKey ?? '');if(Array.isArray(parsed) && typeof parsed[1]==='string')inferredModel=parsed[1];}catch{}
  if(kind==='history') {
    const {id,messageId,revision,order,role,start,end,sourceHash,sourceRevision,modelKey,modelId}=row;
    if(typeof id!=='string' || !id || id.length>500 || typeof messageId!=='string' || !messageId || messageId.length>500 || !Number.isSafeInteger(order) || order<0 || !['user','assistant'].includes(role) || !Number.isInteger(start) || start<0 || !Number.isInteger(end) || end<=start || !Number.isSafeInteger(revision ?? 0) || (revision ?? 0)<0 || !Number.isSafeInteger(sourceRevision ?? 0) || (sourceRevision ?? 0)<0 || !/^[a-f0-9]{64}$/.test(sourceHash ?? ''))throw new Error('Invalid historical vector source.');
    return {id,messageId,revision:revision ?? 0,order,role,start,end,sourceHash,sourceRevision:sourceRevision ?? 0,modelKey:modelKey ?? '',modelId:modelId || inferredModel,vector};
  }
  const {id,recordId,hash,modelKey,modelId}=row;
  if(typeof id!=='string' || !id || id.length>500 || recordId!=null && (typeof recordId!=='string' || recordId.length>500) || !/^[a-f0-9]{64}$/.test(hash ?? ''))throw new Error('Invalid lore vector source.');
  return {id,recordId:recordId ?? null,hash,modelKey:modelKey ?? '',modelId:modelId || inferredModel,vector};
}
export async function encodeVectorChunks(kind,rows) {
  if(!['history','lore'].includes(kind))throw new Error('Invalid vector index type.');
  const groups=new Map(),seen=new Set();
  for(const row of rows) {
    const source=storedRow(row,kind),clean={...source,vector:packVector(source.vector)};
    const key=kind==='history' ? `${String(clean.order).padStart(16,'0')}:${String(clean.start).padStart(10,'0')}:${clean.id}` : JSON.stringify([clean.id,clean.recordId]);
    const identity=kind==='history' ? clean.id : key;if(seen.has(identity))throw new Error('Duplicate vector source.');seen.add(identity);
    const bucket=kind==='history' ? String(Math.floor(clean.order/100)).padStart(12,'0') : (await digest(key)).slice(0,1);
    if(!groups.has(bucket))groups.set(bucket,[]);
    groups.get(bucket).push({key,row:clean});
  }
  const chunks=[];
  for(const [bucket,entries] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    entries.sort((a,b)=>a.key.localeCompare(b.key));let current=[];
    const flush=async()=>{if(!current.length)return;const payload=JSON.stringify(current.map(x=>x.row)),hash=await digest(payload);chunks.push({id:hash,bucket,payload,count:current.length});current=[];};
    for(const item of entries) {
      if(bytes(JSON.stringify([item.row]))>MAX_BYTES)throw new Error('An embedding record is too large to sync.');
      if(current.length && bytes(JSON.stringify([...current.map(x=>x.row),item.row]))>MAX_BYTES)await flush();
      current.push(item);
    }
    await flush();
  }
  return chunks;
}
export async function uploadVectorIndex({adapter,kind,rows,previousManifest=null,check=()=>{},onProgress=()=>{},force=false}) {
  const chunks=await encodeVectorChunks(kind,rows);check();
  const known=new Set(previousManifest?.chunks?.map(c=>c.id) ?? []),pending=chunks.filter(c=>force || !known.has(c.id));
  if(!force && previousManifest?.kind===kind && previousManifest.count===rows.length && previousManifest.chunks?.length===chunks.length && chunks.every((chunk,i)=>previousManifest.chunks[i].id===chunk.id))
    return {manifest:previousManifest,writes:0,reused:chunks.length,unchanged:true};
  for(let i=0;i<pending.length;i++){check();await adapter.writeChunk(pending[i].id,pending[i].payload);check();onProgress({written:i+1,total:pending.length});}
  const manifest={version:1,kind,revision:(previousManifest?.revision ?? 0)+1,count:rows.length,chunks:chunks.map(({id,bucket,count})=>({id,bucket,count}))};
  check();await adapter.commitManifest(kind,previousManifest?.revision ?? 0,manifest);check();
  return {manifest,writes:pending.length+1,reused:chunks.length-pending.length};
}
export async function downloadVectorIndex({adapter,kind,cache=new Map(),check=()=>{},onProgress=()=>{}}) {
  const manifest=await adapter.loadManifest(kind);check();
  if(!manifest)return {manifest:null,rows:[],reads:1};
  if(manifest.version!==1 || manifest.kind!==kind || !Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.count) || manifest.count<0 || manifest.chunks.some(c=>!c || !/^[a-f0-9]{64}$/.test(c.id ?? '') || !Number.isSafeInteger(c.count) || c.count<1))throw new Error('Unsupported vector index manifest.');
  const rows=[];let reads=1;
  for(const [i,chunk] of manifest.chunks.entries()) {
    check();let payload=cache.get(chunk.id);
    if(typeof payload!=='string' || await digest(payload)!==chunk.id){payload=await adapter.readChunk(chunk.id);reads++;}
    if(typeof payload!=='string' || await digest(payload)!==chunk.id)throw new Error('Cloud vector chunk is missing or damaged.');
    const part=JSON.parse(payload);if(!Array.isArray(part) || part.length!==chunk.count)throw new Error('Cloud vector chunk has an invalid record count.');
    rows.push(...part.map(row=>storedRow(row,kind)));cache.set(chunk.id,payload);check();onProgress({read:i+1,total:manifest.chunks.length});
  }
  if(rows.length!==manifest.count)throw new Error('Cloud vector index is incomplete.');
  return {manifest,rows,reads};
}
