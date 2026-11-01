// Local-only evaluation. Never imports an app credential store or calls Firebase/LLMs.
import {readFile,writeFile,mkdir,readdir,appendFile,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve,join,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {appHarness} from '../app-harness.mjs';
import {promptFetch} from '../prompt-files.mjs';
import {countTokens as exactCountTokens,tokenizerStatus} from './production-tokenizer.mjs';
import {qualityDigest,QUALITY_RUBRIC,summarizeQuality,assertEmbeddingModelAllowed,createEvaluationLoreProxy} from './embedding-quality-core.mjs';
// The encoder is unchanged. Cache exact repeated messages to keep offline replay
// bounded without recounting the entire saved conversation for every question.
const tokenCounts=new Map();let tokenCacheBytes=0;
async function countTokens(text){
  if(tokenCounts.has(text))return tokenCounts.get(text);
  const count=await exactCountTokens(text);
  if(text.length<=1000000 && tokenizerStatus()==='ok'){
    const bytes=text.length*2;while(tokenCacheBytes+bytes>64*1024*1024 && tokenCounts.size){const key=tokenCounts.keys().next().value;tokenCacheBytes-=key.length*2;tokenCounts.delete(key);}
    tokenCounts.set(text,count);tokenCacheBytes+=bytes;
  }
  return count;
}
const args=process.argv.slice(2),command=args.shift(),option=(key,fallback)=>args.includes('--'+key)?args[args.indexOf('--'+key)+1]:fallback;
const root=resolve(option('fixture','production-reports/2026-11-01-embedding-quality')),readJSON=async path=>JSON.parse(await readFile(path,'utf8'));
const fixtureNames=['private-snapshot.json','history-cases.json','lore-cases.json'];
async function readRequests(run,directory){const requests={};for(const hash of new Set(run.results.map(r=>r.baseRequestHash).filter(Boolean))){const messages=await readJSON(join(directory,'requests',hash+'.json'));if(qualityDigest(messages)!==hash)throw Error('Captured base request changed.');requests[hash]=messages;}return requests;}
async function archive(value,directory){await mkdir(directory,{recursive:true});const hash=qualityDigest(value);await writeFile(join(directory,hash+'.json'),JSON.stringify(value),{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});return hash;}
const recordPassages=report=>Object.values(report.recordSelection??{}).flatMap(book=>(book.entries??[]).flatMap(entry=>(entry.records??[]).filter(r=>r.selected).map(record=>({entryId:entry.entryId,recordId:record.id,text:record.sources.map(s=>s.text).join('\n')}))));
if(command==='freeze'){
  const files={};for(const name of fixtureNames)files[name]=qualityDigest(await readFile(join(root,name),'utf8'));
  await writeFile(join(root,'fixture-lock.json'),JSON.stringify({rubric:QUALITY_RUBRIC,files},null,2),{flag:'wx',mode:0o600});
  console.log('Frozen snapshot, questions and rubric.');
}else if(command==='score'){
  const run=await readJSON(resolve(option('run'))),reviews=option('reviews')?await readJSON(resolve(option('reviews'))):[];
  const report=summarizeQuality(run,reviews,await readRequests(run,dirname(resolve(option('run')))));await writeFile(resolve(option('out')),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report.summary.map(s=>({budget:s.budget,passed:s.passed,groups:s.groups.map(({failures,...g})=>g)})),null,2));
}else if(command==='run'){
  const lock=await readJSON(join(root,'fixture-lock.json'));
  if(JSON.stringify(lock.rubric)!==JSON.stringify(QUALITY_RUBRIC))throw Error('Frozen quality rubric changed.');
  for(const [name,hash] of Object.entries(lock.files))if(qualityDigest(await readFile(join(root,name),'utf8'))!==hash)throw Error('Frozen fixture changed: '+name);
  const model=option('model','qwen3-embedding:0.6b');
  const authorization=option('authorization')?await readJSON(resolve(option('authorization'))):null;
  const batchSize=Number(option('batch-size','8'));
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>8)throw Error('Embedding batch size must be between 1 and 8.');
  const ollamaContext=Number(option('ollama-context','0')),ollamaBatch=Number(option('ollama-compute-batch','32'));
  if(!Number.isInteger(ollamaContext)||ollamaContext<0||ollamaContext>16384||ollamaContext>0&&ollamaContext<512||!Number.isInteger(ollamaBatch)||ollamaBatch<1||ollamaBatch>512)throw Error('Invalid local Ollama memory options.');
  const zeroSixRun=option('zero-six-run')?await readJSON(resolve(option('zero-six-run'))):null;
  if(zeroSixRun && zeroSixRun.fixtureHash!==qualityDigest(lock))throw Error('0.6b gate belongs to a different frozen fixture.');
  assertEmbeddingModelAllowed(model,zeroSixRun,option('zero-six-reviews')?await readJSON(resolve(option('zero-six-reviews'))):[],zeroSixRun?await readRequests(zeroSixRun,dirname(resolve(option('zero-six-run')))):{},authorization);
  const system=option('system','both'),split=option('split','development'),variant=option('variant','raw'),sourceMode=option('sources','current');
  if(!['both','lore','history'].includes(system) || !['development','fresh','all'].includes(split) || !['raw','instructed','focused','focused-instructed'].includes(variant))throw Error('Invalid evaluation option.');
  // A durable exposure log prevents a previously run validation being called unseen.
  if(split!=='development')await appendFile(join(root,'validation-exposure.jsonl'),JSON.stringify({at:new Date().toISOString(),sourceMode,variant,model,system,split})+'\n',{mode:0o600});
  const d=await readJSON(join(root,'private-snapshot.json')),sourceFiles={};
  if(sourceMode==='baseline'){
    async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isDirectory())await walk(join(dir,e.name),prefix+e.name+'/');else if(e.name.endsWith('.js'))sourceFiles[prefix+e.name]=await readFile(join(dir,e.name),'utf8');}}
    await walk(join(root,'baseline-js'));
  }else if(sourceMode!=='current')throw Error('Invalid source mode.');
  const sourceHashes={};
  async function fingerprintSources(dir,prefix='') {for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='firebase-config.js'||e.name.startsWith('gpt-tokenizer-'))continue;const name=prefix+e.name;if(e.isDirectory())await fingerprintSources(join(dir,e.name),name+'/');else if(e.name.endsWith('.js')){sourceFiles[name]??=await readFile(join(dir,e.name),'utf8');sourceHashes[name]=qualityDigest(sourceFiles[name]);}}}
  await fingerprintSources(sourceMode==='baseline'?join(root,'baseline-js'):resolve('js'));
  const sharedQueryProcessing=args.includes('--shared-query-processing');
  if(sharedQueryProcessing){
    const name='history-recall-engine.js',needle='/qwen3[\\-_]embedding.*0[._]6b/i';
    if(!sourceFiles[name]?.includes(needle))throw Error('Cannot apply shared query processing to these sources.');
    sourceFiles[name]=sourceFiles[name].replace(needle,'/qwen3[\\-_]embedding.*(?:0[._]6b|4b)/i');
    sourceHashes[name]=qualityDigest(sourceFiles[name]);
  }
  const sourceFingerprint=qualityDigest(Object.fromEntries(Object.entries(sourceHashes).sort(([a],[b])=>a.localeCompare(b))));
  const endpoint='http://127.0.0.1:11434/v1/embeddings',cacheFile=option('cache-file')?resolve(option('cache-file')):join(root,'embedding-cache-'+model.split(':')[1]+'.jsonl'),cache=new Map();
  try{for await(const line of createInterface({input:createReadStream(cacheFile),crlfDelay:Infinity})){if(line){const row=JSON.parse(line);cache.set(row.hash,Float32Array.from(row.vector));}}}catch(error){if(error.code!=='ENOENT')throw error;}
  let queryKind=null,networkCalls=0,indexPhase='lore-index';const providerMeasurements=[];
  const localFetch=async(url,options)=>{
    const value=String(url);if(!/^https?:/.test(value))return promptFetch(url,options);if(value!==endpoint)throw Error('Blocked nonlocal evaluation request');
    if(!ollamaContext)return fetch(url,options);
    const body=JSON.parse(options.body);if(body.model!==model)throw Error('Wrong model in local comparison request.');
    const started=performance.now(),response=await fetch('http://127.0.0.1:11434/api/embed',{...options,body:JSON.stringify({model,input:body.input,truncate:false,options:{num_ctx:ollamaContext,num_batch:ollamaBatch},keep_alive:'5m'})});
    if(!response.ok)throw Error('Local Ollama request failed: '+await response.text());
    const result=await response.json();if(!Array.isArray(result.embeddings))throw Error('Invalid local Ollama embeddings.');
    providerMeasurements.push({phase:queryKind??indexPhase,inputs:body.input.length,characters:body.input.reduce((n,t)=>n+t.length,0),ms:performance.now()-started,promptTokens:result.prompt_eval_count,totalNs:result.total_duration,loadNs:result.load_duration});
    return new Response(JSON.stringify({data:result.embeddings.map((embedding,index)=>({index,embedding}))}),{headers:{'Content-Type':'application/json'}});
  };
  const use=appHarness({sources:sourceFiles,globals:{fetch:localFetch}}),rec=await use('lore-records.js'),continuity=await use('continuity.js'),ss=await use('story-settings.js'),profiles=await use('model-profiles.js'),memmod=await use('memory-settings.js'),loremod=await use('lore-semantic.js'),core=await use('history-recall-core.js'),engmod=await use('history-recall-engine.js'),transport=await use('history-embeddings.js'),integration=await use('history-recall-context.js');
  const embed=async(connection,texts,options={})=>{
    const inputs=texts.map(text=>queryKind && variant.includes('instructed') ? `Instruct: Retrieve ${queryKind==='lore'?'canonical lore records':'historical story passages'} that directly answer the question, including corrections to false assumptions.\nQuery: ${text}` : text);
    const hashes=inputs.map(t=>qualityDigest([model,t])),missing=[...new Map(inputs.map((text,i)=>[hashes[i],text]).filter(([hash])=>!cache.has(hash)))];
    for(let offset=0;offset<missing.length;offset+=batchSize){const batch=missing.slice(offset,offset+batchSize),vectors=await transport.embedTexts({...connection,endpoint,model},batch.map(([,text])=>text),{...options,timeoutMs:Math.max(options.timeoutMs??0,120000)});networkCalls++;for(const [i,[hash]] of batch.entries()){cache.set(hash,Float32Array.from(vectors[i]));await appendFile(cacheFile,JSON.stringify({hash,vector:Array.from(cache.get(hash))})+'\n',{mode:0o600});}}
    return hashes.map(hash=>Float32Array.from(cache.get(hash)));
  };
  const messages=d.chunks.flatMap(c=>c.messages??[]).sort((a,b)=>a.order-b.order),entries=d.lore.map(({id,data})=>data.schemaVersion===3?rec.fromRecordDocument(data):{id,...data}),session=structuredClone(d.session),resolved=ss.resolveStorySettings(d.account,d.storySettings),settings={...profiles.resolveModelProfile(resolved,resolved.narratorProfileId,{role:'Narrator'}),providerCooldownAccount:'embedding-eval'};
  delete settings.apiKey;
  const mem=memmod.normalizeMemory({...session.memory,semanticLore:true,semanticModel:model,semanticEndpoint:endpoint}),connection={endpoint,model,key:JSON.stringify([endpoint,model])},safe=continuity.usableLore(entries,messages,session).entries;
  const store=new Map(),lore=loremod.createLoreSemantic({storage:{load:async key=>store.get(key),save:async(value,check)=>{check();store.set(value.key,value);return true;}},embedder:embed});
  const started=performance.now();await lore.index({owner:'embedding-eval',sid:session.id,mem,entries:safe,progress:({done,total})=>{if(done%256===0||done===total)console.log(`Lore index ${done}/${total}`);}});const loreIndexMs=performance.now()-started;
  const historyStore=new Map(),engine=engmod.createRecallEngine({storage:{load:async key=>historyStore.get(key),save:async record=>{historyStore.set(record.key,record);return true;}},embed});
  indexPhase='history-index';const historyStarted=performance.now();if(system!=='lore')await engine.index({owner:'embedding-eval',sid:session.id,messages,session,connection,replaceAll:true,onProgress:({embedded,total})=>{if(total&&(embedded%256===0||embedded===total))console.log(`History index ${embedded}/${total}`);}});const historyIndexMs=performance.now()-historyStarted;
  const proxy=createEvaluationLoreProxy(lore,'embedding-eval',()=>{queryKind='lore';},()=>{queryKind=null;});
  const harness=appHarness({sources:sourceFiles,globals:{fetch:localFetch},stubs:{'lore-semantic.js':{loreSemantic:proxy},'messages.js':{getMessages:async()=>{throw Error('Unexpected database read');}},'tokenizer.js':{countTokens,tokenizerStatus,tokenizerReady:()=>true,tokenizerMode:()=> 'accurate'}}}),builder=await harness('context-builder.js');
  const out=resolve(option('out',join(root,`${sourceMode}-${variant}-${system}-${split}.json`)));
  const previous=args.includes('--resume')?await readJSON(out):null;
  if(previous && (previous.model!==model||previous.variant!==variant||previous.sourceMode!==sourceMode||previous.fixtureHash!==qualityDigest(lock)))throw Error('Resume requires the same frozen fixture, model, sources and query variant.');
  if(previous && previous.sourceFingerprint!==sourceFingerprint)throw Error('Application sources changed or were not fingerprinted; start a separate candidate run.');
  const caseManifest=[];for(const kind of ['lore','history'])for(const c of await readJSON(join(root,kind+'-cases.json')))caseManifest.push({...c,system:kind});
  const run=previous??{model,variant,sourceMode,fixtureHash:qualityDigest(lock),results:[],networkCalls:0};
  run.comparisonAuthorization=authorization;run.embeddingBatchSize=batchSize;run.sharedQueryProcessing=sharedQueryProcessing;
  run.ollamaMemoryOptions=ollamaContext?{num_ctx:ollamaContext,num_batch:ollamaBatch,truncate:false}:null;
  const savedNetworkCalls=run.networkCalls??0;
  run.archiveVersion=2;run.caseManifest=caseManifest.map(({id,system,split,group})=>({id,system,split,group}));
  run.tokenCountsMemoized=true;run.measurementVersion=3;
  run.sourceFingerprint=sourceFingerprint;run.sourceHashes=sourceHashes;
  run.indexMeasurements=[...(run.indexMeasurements??[]),{loreIndexMs,historyIndexMs,cachedEmbeddings:cache.size,networkCalls}];
  const allCases=caseManifest.filter(c=>(system==='both'||system===c.system)&&(split==='all'||(split==='fresh'?c.split==='fresh':c.split!=='fresh')));
  const save=async()=>{run.networkCalls=savedNetworkCalls+networkCalls;run.providerMeasurements=providerMeasurements;await writeFile(out+'.tmp',JSON.stringify(run),{mode:0o600});await rename(out+'.tmp',out);};
  for(const c of allCases){
    if(!(args.includes('--refresh-lore-audit')&&c.system==='lore') && run.results.filter(r=>r.system===c.system&&r.id===c.id).length===(c.system==='lore'?1:5))continue;
    run.results=run.results.filter(r=>r.system!==c.system||r.id!==c.id);
    const all=[...messages,{id:'__eval',order:(messages.at(-1)?.order??0)+1,role:'user',content:c.query,revision:0}],evaluationSession={...session,memory:{...mem,semanticLore:c.system==='lore'}};
    const buildStarted=performance.now(),base=await builder.buildContextForRequest(evaluationSession,settings,{messages:all,loreEntries:entries,requireLatestUser:true,includeInspection:true}),buildMs=performance.now()-buildStarted;
    const ordinary=c.system==='lore'?await builder.buildContextForRequest({...evaluationSession,memory:{...evaluationSession.memory,semanticLore:false}},settings,{messages:all,loreEntries:entries,requireLatestUser:true,includeInspection:true}):null;
    let recall=null,searchMs=buildMs;
    if(c.system==='history'){
      queryKind='history';const now=performance.now();
      // A focused variant changes query construction, never the test question.
      try{recall=await engine.search({owner:'embedding-eval',sid:session.id,messages:all,excludeIds:(base.inspection?.messages??[]).map(m=>m.id),opts:variant.includes('focused')?{queryOnly:true}: {},connection,passageLimit:20,timeoutMs:1500});}finally{queryKind=null;}
      searchMs=performance.now()-now;
    }
    for(const [budget,limit] of c.system==='history'?[[1200,4],[2000,8],[4000,12],[6000,20],[15000,20]]:[[0,0]]){
      const built=recall ? await integration.addHistoricalRecall(base,recall,{...settings,historyRecallBudget:budget,historyRecallPassages:limit},countTokens):base;
      const before=new Set(ordinary?recordPassages(ordinary.report).map(qualityDigest):[]);
      const addedPassages=recall ? (built.report.recall?.selected??[]).map(s=>recall.passages.find(p=>p.messageId===s.messageId&&p.start===s.start)).filter(Boolean).map(({vector,modelKey,...p})=>p) : recordPassages(built.report).filter(p=>!before.has(qualityDigest(p)));
      // Record reports contain exactly fitted lore text. Legacy output falls back
      // to loaded-card metadata and the full final request for manual review.
      if(c.system==='lore' && !built.report.recordSelection)for(const loaded of built.report.loaded??[])if(!(ordinary?.report.loaded??[]).some(r=>r.entryId===loaded.entryId))addedPassages.push({entryId:loaded.entryId,name:loaded.name,lineIds:loaded.lineIds});
      const evidence=c.required??[],anchorHit=c.system==='lore' ? (c.targetId ? (built.report.loaded??[]).some(r=>r.entryId===c.targetId) && evidence.every(e=>built.apiMessages.some(m=>m.content.toLowerCase().includes(e.phrase.toLowerCase()))) : true) : evidence.every(e=>built.apiMessages.some(m=>m.content.toLowerCase().includes(e.phrase.toLowerCase())));
      const recallMessage=recall && built.apiMessages.length>base.apiMessages.length?built.apiMessages[1]:null;
      const reportHash=await archive(built.report,join(root,'request-reports'));
      const report=Object.fromEntries(['semanticLore','recall','loaded','totals','warnings'].filter(k=>k in built.report).map(k=>[k,built.report[k]]));
      run.results.push({id:c.id,system:c.system,split:c.split,group:c.group,query:c.query,budget,limit,unsupported:!!c.unsupported,anchorHit,baseRequestHash:await archive(base.apiMessages,join(root,'requests')),requestHash:qualityDigest(built.apiMessages),...(recallMessage?{recallMessage}:{}),addedPassages,report,reportHash,baseMessageIds:(base.inspection?.messages??[]).map(m=>m.id),searchMs,buildMs,recallStatus:recall?.status});
    }
    await save();console.log(`${c.system}: evaluated ${allCases.indexOf(c)+1}/${allCases.length}; ${Math.round(searchMs)} ms search`);
  }
  const cloud=await use('vector-cloud-core.js'),historyRows=(await engine.load('embedding-eval',session.id)).rows.filter(r=>r.vector),loreRows=await lore.exportVectors({owner:'embedding-eval',sid:session.id,mem});
  run.storage={historyVectors:historyRows.length,loreVectors:loreRows.length,historyBytes:(await cloud.encodeVectorChunks('history',historyRows)).reduce((n,c)=>n+Buffer.byteLength(c.payload),0),loreBytes:(await cloud.encodeVectorChunks('lore',loreRows)).reduce((n,c)=>n+Buffer.byteLength(c.payload),0)};
  await save();console.log('Saved private request captures and measurements.');
}else throw Error('Use freeze, run or score. See README-embedding-quality.md.');
