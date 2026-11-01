import {RECALL_VERSION,RECALL_MAX_ROWS,RECALL_LIMIT,passages,recallText,contentHash,rankPassages,recallQuery,recallCutoff,vector} from './history-recall-core.js';
import {compatibleEmbedding,HISTORY_VECTOR_FORMAT} from './embedding-space.js';

export function createRecallEngine({storage,embed}) {
  const cache=new Map(),loads=new Map(),queues=new Map();
  const ownerVersions=new Map(),storyVersions=new Map();
  const keyOf=(owner,sid)=>JSON.stringify([owner,sid]);
  const scopeVersion=(owner,sid)=>(ownerVersions.get(owner)??0)+':'+(storyVersions.get(keyOf(owner,sid))??0);
  function guarded(options){const version=scopeVersion(options.owner,options.sid),check=options.check;return {...options,check:()=>scopeVersion(options.owner,options.sid)===version && (!check||check())};}
  async function load(owner,sid) {
    const key=keyOf(owner,sid);
    if(cache.has(key))return cache.get(key);
    if(loads.has(key))return loads.get(key);
    const version=scopeVersion(owner,sid);
    const promise=(async()=>{
      let saved;try{saved=await storage.load(key);}catch{}
      const record=saved?.version===RECALL_VERSION && saved.owner===owner && saved.sid===sid ? saved : {key,owner,sid,version:RECALL_VERSION,rows:[],indexedMessages:0};
      record.rows=(record.rows ?? []).filter(r=>typeof r.text==='string' && typeof r.messageId==='string' && Number.isFinite(r.order) && Number.isInteger(r.start) && r.start>=0 && Number.isInteger(r.end) && r.end>r.start).slice(-RECALL_MAX_ROWS).map(r=>{if(r.vector)try{vector(r.vector);}catch{return {...r,vector:null,modelKey:null};}return r;});
      if(version!==scopeVersion(owner,sid))return {key,owner,sid,version:RECALL_VERSION,rows:[],indexedMessages:0};
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
        rows.push(unchanged ? {...before} : {...piece,sourceHash:hash,sourceRevision:session.historyRevision ?? 0,...(same ? {vector:before.vector,modelKey:before.modelKey,modelId:before.modelId,dimensions:before.dimensions,formatVersion:before.formatVersion} : {})});
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
        if(saved?.sourceHash===row.sourceHash && saved.revision===row.revision && saved.modelKey===connection.key && compatibleEmbedding(saved,connection,HISTORY_VECTOR_FORMAT)){row.vector=saved.vector;row.modelKey=saved.modelKey;row.modelId=saved.modelId;row.dimensions=saved.vector.length;row.formatVersion=saved.formatVersion??HISTORY_VECTOR_FORMAT;return false;}
        return force || row.modelKey!==connection.key || !compatibleEmbedding(row,connection,HISTORY_VECTOR_FORMAT);
      });
      let embedded=0;
      for(let i=0;i<missing.length;i+=8) {
        assertActive(signal,check);
        const batch=missing.slice(i,i+8),vectors=await embed(connection,batch.map(r=>r.text),{signal});
        assertActive(signal,check);
        for(const [j,row]of batch.entries()){row.vector=vector(Float32Array.from(vectors[j]));row.modelKey=connection.key;row.modelId=connection.model;row.dimensions=row.vector.length;row.formatVersion=HISTORY_VECTOR_FORMAT;}
        assertActive(signal,check);await storage.saveStage?.(stageKey,owner,batch);assertActive(signal,check);
        embedded+=batch.length;
        assertActive(signal,check);onProgress({messages:record.indexedMessages,passages:record.rows.length,embedded,total:missing.length});
      }
    }
    assertActive(signal,check);
    try{record.persisted=!!await storage.save({...record,persisted:true},()=>{assertActive(signal,check);return true;});}catch{record.persisted=false;}
    assertActive(signal,check);cache.set(record.key,record);
    if(record.persisted && connection)await storage.removeStage?.(JSON.stringify([owner,sid,'embedding-stage-v1',connection.key,session.historyRevision ?? 0,!!force]));
    return record;
  }
  async function index(options) {
    options=guarded(options);
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
        const linguistic=/qwen3[\-_]embedding.*0[._]6b/i.test(connection?.model??''),ranking={stem:linguistic};
        const query=recallQuery(messages,{preferStandalone:linguistic,...opts,queryMessageIds:excludeIds}),cutoff=recallCutoff(messages,opts),excluded=new Set(excludeIds),byId=new Map(messages.map(m=>[m.id,m]));
        // Rebuild captured messages for keyword fallback, even when storage fails.
        const local=messages.slice(-200).flatMap(m=>passages(m)).slice(-RECALL_MAX_ROWS),localIds=new Set(local.map(r=>r.messageId)),priorById=new Map(record.rows.map(r=>[r.id,r]));
        const rows=[...record.rows.filter(r=>!localIds.has(r.messageId)),...local.map(row=>{
          const cached=priorById.get(row.id),prior=cached?.text===row.text && cached?.revision===row.revision ? cached : null;
          return {...row,...(prior ? {vector:prior.vector,modelKey:prior.modelKey,modelId:prior.modelId,formatVersion:prior.formatVersion,dimensions:prior.dimensions} : {})};
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
        const lexical=rankPassages(rows,query,null,'','',ranking);
        fallback={passages:await select(lexical),status:'keyword',coverage,omitted};
        let queryVector=null,status='keyword';
        if(connection && query && rows.some(r=>r.vector && compatibleEmbedding(r,connection,HISTORY_VECTOR_FORMAT))) {
          try {queryVector=(await embed(connection,[query],{signal:controller.signal,timeoutMs:Math.max(1,timeoutMs-(Date.now()-started)-50)}))[0];status='hybrid';}
          catch {status='keyword-fallback';}
        } else if(connection)status='keyword-index-incomplete';
        assertActive(controller.signal,check);
        const hits=await select(queryVector ? rankPassages(rows,query,queryVector,connection.key,connection.model,ranking) : lexical,true);
        const modelMismatch=!!connection && rows.some(r=>r.vector && !compatibleEmbedding(r,connection,HISTORY_VECTOR_FORMAT));
        const incompatibleDimensions=!!queryVector && rows.filter(r=>r.vector && r.vector.length!==queryVector.length).length;
        return {passages:hits,status,coverage,indexedPassages:record.rows.length,persisted:record.persisted ?? false,modelMismatch,incompatibleDimensions,omitted};
      })().catch(()=>{const cancelled=signal?.aborted || check && !check();return {...fallback,...(cancelled ? {passages:[]} : {}),status:cancelled ? 'cancelled' : 'keyword-fallback'};}),deadline]);
    } finally {clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',cancel);}
  }
  async function clear(owner,sid) {const key=keyOf(owner,sid);storyVersions.set(key,(storyVersions.get(key)??0)+1);loads.delete(key);await queues.get(key)?.catch(()=>{});cache.delete(key);await storage.remove(key);}
  async function importRowsImpl({owner,sid,messages,rows,connection=null,check=()=>true}) {
    const current=await load(owner,sid),sources=new Map(messages.map(m=>[m.id,m])),merged=new Map();let restored=0,skipped=0;
    const hashes=new Map();
    for(const row of current.rows){const message=sources.get(row.messageId);if(!message || message.order!==row.order || message.role!==row.role || (message.revision ?? 0)!==row.revision)continue;
      if(!hashes.has(message.id))hashes.set(message.id,await contentHash(recallText(message)));
      if(hashes.get(message.id)===row.sourceHash && recallText(message).slice(row.start,row.end).trim()===row.text)merged.set(row.id,row);
    }
    for(const row of rows) {
      assertActive(null,check);
      if(connection && !compatibleEmbedding(row,connection,HISTORY_VECTOR_FORMAT)){skipped++;continue;}
      const message=sources.get(row.messageId),text=recallText(message);
      if(!message || message.order!==row.order || message.role!==row.role || (message.revision ?? 0)!==row.revision || await contentHash(text)!==row.sourceHash){skipped++;continue;}
      const piece=passages(message).find(p=>p.id===row.id && p.start===row.start && p.end===row.end);
      if(!piece){skipped++;continue;}
      try{vector(row.vector);}catch{skipped++;continue;}
      const local=merged.get(row.id);
      if(!local || local.sourceHash!==row.sourceHash || local.revision!==row.revision || local.text!==piece.text || connection && !compatibleEmbedding(local,connection,HISTORY_VECTOR_FORMAT)){merged.set(row.id,{...piece,sourceHash:row.sourceHash,sourceRevision:row.sourceRevision,modelKey:row.modelKey,modelId:row.modelId ?? '',dimensions:row.vector.length,formatVersion:row.formatVersion ?? HISTORY_VECTOR_FORMAT,vector:Float32Array.from(row.vector)});restored++;}
    }
    const next={...current,rows:[...merged.values()].sort((a,b)=>a.order-b.order || a.start-b.start)};
    next.indexedMessages=new Set(next.rows.map(r=>r.messageId)).size;
    assertActive(null,check);next.persisted=!!await storage.save({...next,persisted:true},()=>{assertActive(null,check);return true;});assertActive(null,check);cache.set(next.key,next);
    return {restored,skipped,persisted:next.persisted};
  }
  async function importRows(options) {
    options=guarded(options);
    const key=keyOf(options.owner,options.sid),previous=queues.get(key)??Promise.resolve(),job=previous.catch(()=>{}).then(()=>importRowsImpl(options));queues.set(key,job);
    try{return await job;}finally{if(queues.get(key)===job)queues.delete(key);}
  }
  function forget(owner,sid){if(sid==null)ownerVersions.set(owner,(ownerVersions.get(owner)??0)+1);else{const key=keyOf(owner,sid);storyVersions.set(key,(storyVersions.get(key)??0)+1);}for(const key of loads.keys()){const parts=JSON.parse(key);if(parts[0]===owner && (sid==null||parts[1]===sid))loads.delete(key);}for(const[key,record]of cache)if(record.owner===owner && (sid==null||record.sid===sid))cache.delete(key);}
  return {index,search,load,clear,forget,importRows};
}
