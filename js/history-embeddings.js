import {vector} from './history-recall-core.js';
export function embeddingConnection(settings) {
  const endpoint=String(settings.embeddingEndpoint ?? '').trim(),model=String(settings.embeddingModelId ?? '').trim();
  if(!endpoint || !model)throw new Error('Set the embedding endpoint and model in shared Settings.');
  const url=new URL(endpoint);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS for the embedding endpoint, or localhost for a local server.');
  if(url.username || url.password || url.hash || url.search)throw new Error('Use an embedding endpoint without credentials, query parameters or a fragment.');
  return {endpoint:url.href,model,apiKey:String(settings.embeddingApiKey ?? '').trim(),key:JSON.stringify([url.href,model])};
}
export async function embedTexts(connection,texts,{signal,timeoutMs=30000}={}) {
  if(!texts.length || texts.length>8 || texts.some(t=>typeof t!=='string' || !t.trim()))throw new Error('Invalid embedding batch.');
  const controller=new AbortController(),cancel=()=>controller.abort();
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(new Error('Embedding request stopped or timed out.'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  const timer=setTimeout(cancel,timeoutMs);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  try {
    if(controller.signal.aborted){rejectAbort();return await aborted;}
    return await Promise.race([(async()=>{
      const response=await fetch(connection.endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(connection.apiKey ? {Authorization:'Bearer '+connection.apiKey} : {})},body:JSON.stringify({model:connection.model,input:texts,encoding_format:'float'}),signal:controller.signal});
      if(!response.ok)throw new Error('Embedding request failed (HTTP '+response.status+').');
      const body=await response.json();
      if(!Array.isArray(body.data) || body.data.length!==texts.length)throw new Error('Invalid embedding response.');
      const rows=[...body.data].sort((a,b)=>a.index-b.index);
      const vectors=rows.map((row,i)=>{if(row.index!==i)throw new Error('Invalid embedding response order.');return vector(row.embedding);});
      if(vectors.some(v=>v.length!==vectors[0].length))throw new Error('Incompatible embedding dimensions.');
      return vectors;
    })(),aborted]);
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);}
}
