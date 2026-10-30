import {RECALL_VERSION,RECALL_MAX_ROWS,RECALL_LIMIT,passages,recallText,contentHash,rankPassages,recallQuery,recallCutoff,vector} from './history-recall-core.js';

export function createRecallEngine({storage,embed}) {
  const cache=new Map(),loads=new Map(),queues=new Map();
  let generation=0;
  const keyOf=(owner,sid)=>JSON.stringify([owner,sid]);
  async function load(owner,sid) {
    const key=keyOf(owner,sid);
    if(cache.has(key))return cache.get(key);
    if(loads.has(key))return loads.get(key);
    const epoch=generation;
    const promise=(async()=>{
      let saved;try{saved=await storage.load(key);}catch{}
      const record=saved?.version===RECALL_VERSION && saved.owner===owner && saved.sid===sid ? saved : {key,owner,sid,version:RECALL_VERSION,rows:[],indexedMessages:0};
      record.rows=(record.rows ?? []).filter(r=>typeof r.text==='string' && typeof r.messageId==='string' && Number.isFinite(r.order) && Number.isInteger(r.start) && r.start>=0 && Number.isInteger(r.end) && r.end>r.start).slice(-RECALL_MAX_ROWS).map(r=>{if(r.vector)try{vector(r.vector);}catch{return {...r,vector:null,modelKey:null};}return r;});
      if(epoch!==generation)return {key,owner,sid,version:RECALL_VERSION,rows:[],indexedMessages:0};
      cache.set(key,record);return record;
    })().finally(()=>{if(loads.get(key)===promise)loads.delete(key);});
    loads.set(key,promise);return promise;
  }
  function assertActive(signal,check) {if(signal?.aborted || check && !check())throw new Error('Recall operation cancelled.');}
  async function indexImpl({owner,sid,messages,session={},connection=null,signal,check,onProgress=()=>{},force=false,replaceAll=false}) {
    const old=await load(owner,sid);assertActive(signal,check);
    const ids=new Set(messages.map(m=>m.id)),rows=old.rows.filter(r=>!replaceAll && !ids.has(r.messageId) && (r.sourceRevision ?? -1)>=(session.contentEditsFloor ?? -1) && !(session.contentEdits ?? []).some(e=>e.order===r.order && e.revision>(r.sourceRevision ?? -1))).map(r=>({...r})),prior=new Map(old.rows.map(r=>[r.id,r]));
    for(const message of messages) {
      assertActive(signal,check);
      const pieces=passages(message);if(!pieces.length)continue;
      const hash=await contentHash(recallText(message));
      for(const piece of pieces) {
        const before=prior.get(piece.id),same=before?.sourceHash===hash && before.role===piece.role;
        const unchanged=same && before.revision===piece.revision && before.order===piece.order && (before.sourceRevision ?? -1)>=(session.contentEditsFloor ?? -1) && !(session.contentEdits ?? []).some(e=>e.order===piece.order && e.revision>(before.sourceRevision ?? -1));
        rows.push(unchanged ? {...before} : {...piece,sourceHash:hash,sourceRevision:session.historyRevision ?? 0,...(same ? {vector:before.vector,modelKey:before.modelKey,modelId:before.modelId} : {})});
      }
    }
    const record={...old,rows:rows.sort((a,b)=>a.order-b.order || a.start-b.start).slice(-RECALL_MAX_ROWS),updatedAt:Date.now()};
    record.indexedMessages=new Set(record.rows.map(r=>r.messageId)).size;
    onProgress({messages:record.indexedMessages,passages:record.rows.length,embedded:0});
    if(connection) {
      const stageKey=JSON.stringify([owner,sid,'embedding-stage-v1',connection.key,session.historyRevision ?? 0,!!force]);
      const staged=new Map((await storage.loadStage?.(stageKey) ?? []).map(row=>[row.id,row]));assertActive(signal,check);
      const missing=record.rows.filter(row=>{
        // A scheduled batch only embeds its own source messages. Switching the
        // configured model must not silently rebuild the rest of the story.
        if(!replaceAll && !ids.has(row.messageId))return false;
        const saved=staged.get(row.id);
        if(saved?.sourceHash===row.sourceHash && saved.revision===row.revision && saved.modelKey===connection.key && saved.vector){row.vector=saved.vector;row.modelKey=saved.modelKey;row.modelId=saved.modelId;return false;}
        return force || row.modelKey!==connection.key || !row.vector;
      });
      let embedded=0;
      for(let i=0;i<missing.length;i+=8) {
        assertActive(signal,check);
        const batch=missing.slice(i,i+8),vectors=await embed(connection,batch.map(r=>r.text),{signal});
        assertActive(signal,check);
        for(const [j,row]of batch.entries()){row.vector=vector(Float32Array.from(vectors[j]));row.modelKey=connection.key;row.modelId=connection.model;}
        assertActive(signal,check);await storage.saveStage?.(stageKey,owner,batch);assertActive(signal,check);
        embedded+=batch.length;
        assertActive(signal,check);onProgress({messages:record.indexedMessages,passages:record.rows.length,embedded,total:missing.length});
      }
    }
    assertActive(signal,check);
    try{record.persisted=!!await storage.save({...record,persisted:true});}catch{record.persisted=false;}
    assertActive(signal,check);cache.set(record.key,record);
    if(record.persisted && connection)await storage.removeStage?.(JSON.stringify([owner,sid,'embedding-stage-v1',connection.key,session.historyRevision ?? 0,!!force]));
    return record;
  }
  async function index(options) {
    const key=keyOf(options.owner,options.sid),previous=queues.get(key) ?? Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>indexImpl(options));queues.set(key,job);
    try{return await job;}finally{if(queues.get(key)===job)queues.delete(key);}
  }
  async function search({owner,sid,messages,opts={},excludeIds=[],connection=null,signal,check,resolveMessage,timeoutMs=1500,passageLimit=RECALL_LIMIT}) {
    const started=Date.now(),controller=new AbortController(),cancel=()=>controller.abort();
    let timer;signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    let fallback={passages:[],status:'unavailable',coverage:0,omitted:[]};
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();const cancelled=signal?.aborted || check && !check();resolve({...fallback,...(cancelled ? {passages:[]} : {}),status:cancelled ? 'cancelled' : 'timeout-keyword'});},timeoutMs);});
    try {
      return await Promise.race([(async()=>{
        const record=await load(owner,sid);assertActive(controller.signal,check);
        const query=recallQuery(messages,{...opts,queryMessageIds:excludeIds}),cutoff=recallCutoff(messages,opts),excluded=new Set(excludeIds),byId=new Map(messages.map(m=>[m.id,m]));
        // Rebuild captured messages for keyword fallback, even when storage fails.
        const local=messages.slice(-200).flatMap(m=>passages(m)).slice(-RECALL_MAX_ROWS),localIds=new Set(local.map(r=>r.messageId)),priorById=new Map(record.rows.map(r=>[r.id,r]));
        const rows=[...record.rows.filter(r=>!localIds.has(r.messageId)),...local.map(row=>{
          const cached=priorById.get(row.id),prior=cached?.text===row.text && cached?.revision===row.revision ? cached : null;
          return {...row,...(prior ? {vector:prior.vector,modelKey:prior.modelKey} : {})};
        })].filter(r=>r.order<cutoff && !excluded.has(r.messageId)).slice(-RECALL_MAX_ROWS);
        const coverage=record.indexedMessages,omitted=[];
        const valid=(row,m)=>m && m.id===row.messageId && (m.revision ?? 0)===row.revision && m.order===row.order && m.role===row.role && recallText(m).slice(row.start,row.end).trim()===row.text;
        const select=async(ranked,remote=false)=>{
          const selected=[],seen=new Set(),resolved=new Map();let reads=0;
          for(const hit of ranked) {
            assertActive(controller.signal,check);
            const row=hit.row;if(seen.has(row.text))continue;
            let source=byId.get(row.messageId);
            if(!source && remote && resolveMessage) {
              if(!resolved.has(row.messageId)) {
                if(reads>=RECALL_LIMIT)continue;reads++;
                try{resolved.set(row.messageId,await resolveMessage(row));}catch{resolved.set(row.messageId,null);}
                assertActive(controller.signal,check);
              }
              source=resolved.get(row.messageId);
            }
            if(!valid(row,source)){if(remote)omitted.push({messageId:row.messageId,reason:'source unavailable or changed'});continue;}
            selected.push({...row,vector:undefined,modelKey:undefined,methods:hit.methods,score:hit.score,similarity:hit.similarity,lexical:hit.lexical});seen.add(row.text);
            if(selected.length>=Math.max(1,Math.min(20,passageLimit)))break;
          }
          return selected;
        };
        const lexical=rankPassages(rows,query);
        fallback={passages:await select(lexical),status:'keyword',coverage,omitted};
        let queryVector=null,status='keyword';
        if(connection && query && rows.some(r=>r.vector)) {
          try {queryVector=(await embed(connection,[query],{signal:controller.signal,timeoutMs:Math.max(1,timeoutMs-(Date.now()-started)-50)}))[0];status='hybrid';}
          catch {status='keyword-fallback';}
        } else if(connection)status='keyword-index-incomplete';
        assertActive(controller.signal,check);
        const hits=await select(queryVector ? rankPassages(rows,query,queryVector,connection.key) : lexical,true);
        const modelMismatch=!!connection && rows.some(r=>r.vector && r.modelKey!==connection.key);
        const incompatibleDimensions=!!queryVector && rows.filter(r=>r.vector && r.vector.length!==queryVector.length).length;
        return {passages:hits,status,coverage,indexedPassages:record.rows.length,persisted:record.persisted ?? false,modelMismatch,incompatibleDimensions,omitted};
      })().catch(()=>{const cancelled=signal?.aborted || check && !check();return {...fallback,...(cancelled ? {passages:[]} : {}),status:cancelled ? 'cancelled' : 'keyword-fallback'};}),deadline]);
    } finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',cancel);}
  }
  async function clear(owner,sid) {const key=keyOf(owner,sid);generation++;loads.delete(key);await queues.get(key)?.catch(()=>{});cache.delete(key);await storage.remove(key);}
  async function importRows({owner,sid,messages,rows,check=()=>true}) {
    const current=await load(owner,sid),sources=new Map(messages.map(m=>[m.id,m])),merged=new Map(current.rows.map(r=>[r.id,r]));let restored=0,skipped=0;
    for(const row of rows) {
      assertActive(null,check);
      const message=sources.get(row.messageId),text=recallText(message);
      if(!message || message.order!==row.order || message.role!==row.role || (message.revision ?? 0)!==row.revision || await contentHash(text)!==row.sourceHash){skipped++;continue;}
      const piece=passages(message).find(p=>p.id===row.id && p.start===row.start && p.end===row.end);
      if(!piece){skipped++;continue;}
      try{vector(row.vector);}catch{skipped++;continue;}
      const local=merged.get(row.id);
      if(!local || local.sourceHash!==row.sourceHash || local.revision!==row.revision || local.text!==piece.text){merged.set(row.id,{...piece,sourceHash:row.sourceHash,sourceRevision:row.sourceRevision,modelKey:row.modelKey,modelId:row.modelId ?? '',vector:Float32Array.from(row.vector)});restored++;}
    }
    const next={...current,rows:[...merged.values()].sort((a,b)=>a.order-b.order || a.start-b.start)};
    next.indexedMessages=new Set(next.rows.map(r=>r.messageId)).size;
    assertActive(null,check);next.persisted=!!await storage.save({...next,persisted:true});assertActive(null,check);cache.set(next.key,next);
    return {restored,skipped,persisted:next.persisted};
  }
  function forget(owner){generation++;for(const key of loads.keys())if(JSON.parse(key)[0]===owner)loads.delete(key);for(const[key,record]of cache)if(record.owner===owner)cache.delete(key);}
  return {index,search,load,clear,forget,importRows};
}
