import {isDeepStrictEqual} from 'node:util';
// Prepare is free. Run requires the user's separate paid-test approval.
import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {appHarness} from '../app-harness.mjs';
import {promptFetch} from '../prompt-files.mjs';
import {countTokens,tokenizerStatus} from './production-tokenizer.mjs';
import {EVAL_MODEL,EVAL_LIMITS,EXPANDED_EVAL_LIMITS,followupProbes,EvaluationBudget,inputBounds,eligibleEndpoints,syntheticFixture,normalizeFixture} from './lorebook-eval-core.mjs';

const API='https://openrouter.ai/api/v1/chat/completions';
const catalogURL='https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints';
const json=value=>JSON.stringify(value,null,2);
const persist=(path,value)=>writeFile(path,json(value),{mode:0o600});
function flags(args) {
  const out={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Expected --name value options.');out[args[i].slice(2)]=args[++i];}return out;
}
function harness(fetchImpl=promptFetch) {
  return appHarness({stubs:{'messages.js':{getMessages:async()=>{throw new Error('Unexpected external history read.');}},'tokenizer.js':{countTokens,tokenizerStatus}},globals:{fetch:fetchImpl}});
}
async function catalog() {
  const response=await fetch(catalogURL,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Provider preflight failed: HTTP '+response.status);
  const data=(await response.json()).data;
  if(!eligibleEndpoints(data).length)throw new Error('No eligible V4.1 provider under the fixed input/output ceilings.');
  return data;
}
function settings(prompts,extraction=false,effort='none',fixture=null) {
  const values=fixture?.storySettings?.values??fixture?.storySettings??{};
  return {endpoint:API,modelId:EVAL_MODEL,maxOutputPrice:EVAL_LIMITS.completion,maxContextTokens:120000,maxResponseTokens:extraction?2048:8192,streaming:true,keepRecentMessagesAfterSummary:10,narratorSystemPrompt:values.narratorSystemPrompt??prompts.narrator,memoryExtractionPrompt:values.memoryExtractionPrompt??prompts.memoryExtraction,reasoning:extraction&&effort==='none'?{enabled:false,explicitDisable:true}:{enabled:true,mode:'effort',effort:extraction?effort:'high'}};
}
const constraintInput='Describe how Mira Vale responds after moonflower poison spills on her skin. Apply her established immunity and reserved demeanor without choosing the Traveler’s actions. The letter search remains closed.';
function appendUser(messages,content,id) {return [...messages,{id,role:'user',order:(messages.at(-1)?.order??0)+1,revision:0,content}];}
async function setupPrepared(options) {
  const use=harness(),prompts=(await use('system-prompts.js')).prompts;
  let raw;
  if(options.fixture) {
    const text=await readFile(resolve(options.fixture),'utf8');
    try {raw=JSON.parse(text);}catch {
      const rows=text.trim().split(/\r?\n/).map(JSON.parse),head=rows[0]?.nera;
      if(!head?.session||!Array.isArray(head.lore)||rows.some(r=>r.neraAccount||r.neraStorySeparator))throw new Error('Use a single full story backup or single-story JSONL export.');
      raw={...head,messages:rows.slice(1).filter(r=>r.nera?.message).map(r=>({...r.nera.message,content:r.mes??r.nera.message.content}))};
    }
    if(options.expectations)raw.expected=JSON.parse(await readFile(resolve(options.expectations),'utf8'));
    if(options.anchor)raw.session.memory={...raw.session.memory,calendar:{mode:'modern',anchor:options.anchor}};
  }
  const fixture=options.fixture?await normalizeFixture(raw,use):await syntheticFixture(use);
  const builder=await use('context-builder.js'),client=await use('llm-client.js'),record=await use('lore-records.js');
  const narrator=settings(prompts,false,'none',fixture),extractor=settings(prompts,true,'none',fixture);
  const messages=appendUser(fixture.messages,fixture.expected.constraintInput??constraintInput,'eval-constraint');
  const preview={};
  for(const [mode,session] of [['legacy',{...fixture.session,loreSchemaVersion:2}],['selective',{...fixture.session,loreSchemaVersion:3}]]) {
    const lore=mode==='legacy'?fixture.lore.map(({schemaVersion,recordLayout,...e})=>e):fixture.lore;
    const built=await builder.buildContextForRequest(session,narrator,{messages,loreEntries:lore,requireLatestUser:true});
    const body=client.buildRequestBody(narrator,built.apiMessages);
    preview[mode]={body,report:built.report,...inputBounds(body,built.usedTokens)};
  }
  const canonical=fixture.lore.map(e=>record.toRecordDocument(e));
  const restored=canonical.map(e=>record.fromRecordDocument(e));
  const exact=e=>JSON.stringify({id:e.id,book:e.book,name:e.name,kind:e.kind,status:e.status,sections:e.sections,coreReferences:e.coreReferences});
  if(fixture.lore.some((e,i)=>!isDeepStrictEqual(JSON.parse(exact(e)),JSON.parse(exact(restored[i])))))throw new Error('Source or metadata changed in migration rehearsal.');
  return {fixture,preview,narrator,extractor};
}
async function prepare(options) {
  const dir=resolve(options.out??'investigate/selective-eval');await mkdir(dir,{recursive:true,mode:0o700});
  const prepared=await setupPrepared(options),metadata=await catalog();
  const biggest=Math.max(...Object.values(prepared.preview).map(p=>p.inputBound));
  const eligible=eligibleEndpoints(metadata,biggest,8192);
  if(!eligible.length)throw new Error('No eligible provider can fit the prepared request.');
  const perNarrator=(biggest*EVAL_LIMITS.prompt+8192*EVAL_LIMITS.completion)/1e6;
  const summary={preparedAt:new Date().toISOString(),model:EVAL_MODEL,limits:EVAL_LIMITS,synthetic:prepared.fixture.synthetic===true,tokenizer:tokenizerStatus(),baseline:Object.fromEntries(Object.entries(prepared.preview).map(([k,p])=>[k,{estimatedTokens:p.estimatedTokens,inputBound:p.inputBound,maxTokens:8192,upperCostUSD:(p.inputBound*EVAL_LIMITS.prompt+8192*EVAL_LIMITS.completion)/1e6}])),eligibleProviders:eligible.map(e=>({name:e.name,tag:e.tag,inputPerMillion:Number(e.pricing.prompt)*1e6,outputPerMillion:Number(e.pricing.completion)*1e6})),baselineBasedEightCallEstimateUSD:perNarrator*6+((biggest*EVAL_LIMITS.prompt+2048*EVAL_LIMITS.completion)/1e6)*2,paidApprovalRequired:true};
  await persist(resolve(dir,'prepared.json'),prepared);await persist(resolve(dir,'providers.json'),metadata);await persist(resolve(dir,'preflight.json'),summary);
  for(const [name,p] of Object.entries(prepared.preview))await persist(resolve(dir,`${name}-preview.json`),p);
  console.log(json(summary));
}

async function run(options) {
  const expanded=options.followup||options.recovery||options.backend;
  const limits=expanded?EXPANDED_EVAL_LIMITS:EVAL_LIMITS;
  if(options['approved-budget']!==limits.budget.toFixed(2))throw new Error('Paid tests require explicit user approval and --approved-budget '+limits.budget.toFixed(2)+'.');
  if(!options['key-file'])throw new Error('Supply --key-file; keys are never read from exported story settings.');
  const dir=resolve(options.out??'investigate/selective-eval'),prepared=JSON.parse(await readFile(resolve(dir,'prepared.json'),'utf8'));
  const lock=await open(resolve(dir,'run.lock'),'wx',0o600);
  try {
    // Each prepared run is immutable and cannot be accidentally replayed.
    let previous=[];try{previous=JSON.parse(await readFile(resolve(dir,'ledger.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const resume=options['continue-reviewed'];
    if(previous.length&&!resume&&!expanded)throw new Error('This run already has paid calls. Review its ledger; do not replay completed scenarios.');
    if(resume&&resume!=='new-memory-missing-scene')throw new Error('Unsupported reviewed continuation.');
    let reviewedResults=null;
    if(expanded) {
      if(previous.length<8||previous.some(r=>r.status!=='received'||r.actualMicros==null))throw new Error('Follow-up requires the eight settled original calls and no unresolved usage.');
      if(previous.length>8&&Number(options['reviewed-through'])!==previous.at(-1).number)throw new Error('Review the interrupted follow-up before continuing; pass --reviewed-through with its last call number.');
      reviewedResults=JSON.parse(await readFile(resolve(dir,'results.json'),'utf8'));
    }
    if(resume) {
      reviewedResults=JSON.parse(await readFile(resolve(dir,'results.json'),'utf8'));
      const expected=['legacy-constraint','selective-constraint','midnight','new-memory'];
      const failed=reviewedResults.results?.at(-1);
      if(previous.length!==4||previous.some((r,i)=>r.scenario!==expected[i]||r.status!=='received'||r.actualMicros==null)||failed?.name!=='new-memory'||failed.hardPass!==false||!failed.content?.trim()||failed.scene||failed.warnings.some(w=>!['Missing scene tag.','The model omitted a readable scene tag.'].includes(w)))throw new Error('Continuation requires four settled calls and a reviewed missing-scene failure only.');
      // Original responses and failures stay intact. No call is repeated, and
      // all prior costs/counts remain in the same $0.10/eight-call budget.
    }
    const key=(await readFile(resolve(options['key-file']),'utf8')).trim();if(!key)throw new Error('Empty API key.');
    const redact=value=>String(value).split(key).join('[redacted]');
    const save=(path,value)=>writeFile(path,redact(json(value)),{mode:0o600});
    const metadata=await catalog(),budget=new EvaluationBudget(previous,limits);
    let currentScenario='',currentEstimate=0,capturePending=Promise.resolve();
    const flush=()=>save(resolve(dir,'ledger.json'),budget.rows);
    const use=harness(async(url,opts)=>{
      if(String(url)!==API)return promptFetch(url,opts);
      const body=JSON.parse(opts.body),bounds=inputBounds(body,currentEstimate);
      if(body.model!==EVAL_MODEL||body.provider?.max_price?.completion!==0.5||body.provider?.max_price?.prompt!==0.25)throw new Error('Test routing or price ceiling changed.');
      if(!eligibleEndpoints(metadata,bounds.inputBound,body.max_tokens).length)throw new Error('No eligible provider for this request size.');
      const row=budget.reserve({scenario:currentScenario,inputBound:bounds.inputBound,maxTokens:body.max_tokens});row.tokenizer=tokenizerStatus();await flush();
      await writeFile(resolve(dir,`${row.number}-request.json`),redact(opts.body),{mode:0o600});
      try {
        const started=Date.now(),response=await fetch(url,opts);row.http=response.status;row.firstHeadersMs=Date.now()-started;
        if(!response.body)throw new Error('Provider returned no response body.');
        const [modelStream,captureStream]=response.body.tee();
        capturePending=(async()=>{
          try {
            const raw=await new Response(captureStream).text();await writeFile(resolve(dir,`${row.number}-response.txt`),redact(raw),{mode:0o600});
            let events;
            if(body.stream)events=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).filter(l=>l&&l!=='[DONE]').map(l=>JSON.parse(l));
            else events=[JSON.parse(raw)];
            row.providers=[...new Set(events.map(e=>e.provider).filter(Boolean))];row.models=[...new Set(events.map(e=>e.model).filter(Boolean))];row.ids=[...new Set(events.map(e=>e.id).filter(Boolean))];
            row.finishReasons=[...new Set(events.flatMap(e=>e.choices??[]).map(c=>c.finish_reason).filter(Boolean))];
            budget.settle(row,events.findLast(e=>e.usage)?.usage);
          }catch(e){row.status=row.status==='started'?'unresolved':row.status;row.error=redact(e.message);throw e;}
          finally{row.finishedAt=new Date().toISOString();await flush();}
        })();
        capturePending.catch(()=>{});
        return new Response(modelStream,{status:response.status,headers:response.headers});
      }catch(e){row.status=row.status==='started'?'unresolved':row.status;row.error=redact(e.message);row.finishedAt=new Date().toISOString();await flush();throw e;}
    });
    const fixture=await normalizeFixture(prepared.fixture,use),{prompts}=await use('system-prompts.js'),builder=await use('context-builder.js'),client=await use('llm-client.js'),scene=await use('scene.js'),records=await use('lore-records.js'),lines=await use('lore-lines.js'),turns=await use('turns.js'),memory=await use('memory-settings.js'),extraction=await use('memory-prompts.js');
    const eligibleTags=eligibleEndpoints(metadata).map(e=>e.tag);
    if(options['provider-tag']&&!eligibleTags.includes(options['provider-tag']))throw new Error('Requested backend is not eligible within the unchanged price ceilings.');
    const provider={only:options['provider-tag']?[options['provider-tag']]:eligibleTags,require_parameters:true,max_price:{prompt:0.25,completion:0.5,request:0}};
    let lore=fixture.lore,history=fixture.messages;const results=reviewedResults?.results??[];
    if(resume) {
      const source=JSON.parse(await readFile(resolve(dir,'new-memory-context.json'),'utf8')),failed=results.at(-1);
      const carried=scene.carryScene(scene.latestScene(source.history,Infinity,fixture.session.memory.startingScene));
      history=[...source.history,{id:'eval-assistant-new-memory',role:'assistant',order:source.history.at(-1).order+1,revision:0,content:failed.content,scene:null,sceneMeta:carried.sceneMeta,ooc:false}];
      await save(resolve(dir,'reviewed-continuation.json'),{reason:'new-memory missing scene tag reviewed; carry previous scene as the app does',initialFailureRetained:true,paidCallsRepeated:0,priorChargedUSD:budget.charged/1e6,history});
    }
    async function narrate(name,input,{legacy=false,priorHistory=history,checkpoint=null,expected=null}={}) {
      currentScenario=name;const messages=appendUser(priorHistory,input,'eval-user-'+name),session={...fixture.session,loreSchemaVersion:legacy?2:3,...(checkpoint?{activeSummaryMessageId:checkpoint.id,breakpointOrder:checkpoint.coveredRange.toOrder}:{})};
      const entries=legacy?lore.map(({schemaVersion,recordLayout,...e})=>e):lore;
      const profile={...settings(prompts,false,'none',fixture),apiKey:key};
      const built=await builder.buildContextForRequest(session,profile,{messages,loreEntries:entries,requireLatestUser:true});currentEstimate=built.usedTokens;
      if(name==='after-extraction') {
        const selected=Object.values(built.report.recordSelection??{}).flatMap(book=>book.entries??[]).map(e=>e.text??'').join('\n').toLowerCase();
        if(!fixture.expected.noteTerms.every(term=>selected.includes(term.toLowerCase())))throw new Error('New extraction evidence was not selected into the next request.');
      }
      await save(resolve(dir,`${name}-context.json`),{report:built.report,history:messages});
      let reply;try{reply=await client.chatCompletion({settings:profile,messages:built.apiMessages,provider});}finally{await capturePending;}
      const ooc=scene.isPureOoc(input),out=scene.readSceneOutput(reply.content,{sceneEnabled:!ooc}),prior=scene.latestScene(messages,Infinity,session.memory.startingScene);
      const checked=ooc?{scene:null,sceneMeta:null,warnings:[]}:out.scene?scene.validateSceneValues(out.scene,{prior:prior.scene,userText:input,narration:out.clean,calendar:session.memory.calendar}):{scene:null,warnings:['Missing scene tag.']};
      const warnings=[...checked.warnings,...(!ooc&&out.warning?[out.warning]:[]),...(!out.clean.trim()?['No visible narration.']:[])];
      if(expected) {
        if(!ooc&&out.scene) {
          const declared=scene.parseScene(out.scene),actual=scene.parseScene(checked.scene);
          if(!/^\d{2}:\d{2}$/.test(declared.time??''))warnings.push('Modern scene time was not written as HH:mm.');
          if(!/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}\/\d{1,2}\/\d{1,4}$/.test(declared.when??''))warnings.push('Modern date format missing weekday or numeric date.');
          if(expected.when&&actual.when!==expected.when)warnings.push('Scene date differs from the expected boundary.');
          if(expected.time&&actual.time!==expected.time)warnings.push('Scene clock differs from the expected elapsed duration.');
          if(expected.present&&JSON.stringify([...actual.present].sort())!==JSON.stringify([...expected.present].sort()))warnings.push('Scene attendees differ from explicitly established physical presence.');
        }
        const visible=out.clean.replace(/[*_`]/g,'').toLowerCase();
        if(expected.visibleTerms&&!expected.visibleTerms.every(term=>visible.includes(term.toLowerCase())))warnings.push('OOC answer did not preserve the established date, clock and place.');
      }
      const result={name,content:out.clean,thinking:reply.thinking,scene:checked.scene,warnings,hardPass:warnings.length===0,semanticReviewRequired:true,...(expected?{expected}: {})};results.push(result);await save(resolve(dir,`${name}-parsed.json`),result);
      if(!result.hardPass)throw new Error(name+' failed output/scene validation. Review captured evidence before further calls.');
      return [...messages,{id:'eval-assistant-'+name,role:'assistant',order:messages.at(-1).order+1,revision:0,content:out.clean,scene:checked.scene,sceneMeta:checked.sceneMeta,ooc}];
    }
    async function extract(effort,sourceHistory) {
      currentScenario='extraction-'+effort;const mem=memory.normalizeMemory(fixture.session.memory),profile={...settings(prompts,true,effort,fixture),apiKey:key};mem.updateMaxTokens=2048;
      const t=turns.computeTurns(sourceHistory),assistants=t.assistants;
      const range={fromTurn:assistants[0].turn,toTurn:assistants.at(-1).turn,endOrder:assistants.at(-1).order,assistants,messages:sourceHistory};
      const built=await extraction.buildExtractionMessages({settings:profile,mem,entries:lore,messages:sourceHistory,range,count:countTokens});
      currentEstimate=(await Promise.all(built.messages.map(m=>countTokens(m.content)))).reduce((a,b)=>a+b,24);
      let reply;try{reply=await client.chatCompletion({settings:profile,messages:built.messages,provider});}finally{await capturePending;}
      const parsed=lines.parseMemoryLines(reply.content,{range:built.range,mem,messages:sourceHistory,protagonist:mem.protagonist});
      if(!parsed.valid||parsed.skipped.length)throw new Error('Extraction output failed note-format validation.');
      const changes=lines.applyOps(lore,parsed.ops,{mem,protagonist:mem.protagonist,messages:sourceHistory,session:fixture.session,sourceRevision:0});
      // Local canonical storage round trip. Production transactional commit is
      // separately covered by the store regression and rules emulator tests.
      const next=changes.entries.map(e=>records.fromRecordDocument(records.toRecordDocument(e,lore.find(old=>old.id===e.id))));
      const added=changes.appends.map(a=>a.line.text).concat(changes.creates.flatMap(e=>Object.values(e.sections).flatMap(s=>s.lines.map(l=>l.text)))).join('\n').toLowerCase();
      if(!fixture.expected.noteTerms.every(term=>added.includes(term.toLowerCase())))throw new Error('Extraction missed the fresh target event.');
      const result={name:currentScenario,parsed,changes,hardPass:changes.skipped.length===0,semanticReviewRequired:true};results.push(result);await save(resolve(dir,currentScenario+'-parsed.json'),result);
      if(!result.hardPass)throw new Error('Extraction application failed.');return next;
    }
    try {
      if(options.recovery) {
        if(previous.length<20)throw new Error('Finish the twelve calendar/attendance follow-ups before recovery probes.');
        const completed=previous.slice(20),targets=[['new-memory','recovery-original'],['followup-ampm','recovery-ampm']];
        if(completed.some((r,i)=>r.scenario!==targets[i]?.[1]))throw new Error('Unexpected recovery ledger order.');
        const recovery=await use('scene-recovery.js');
        for(const [sourceName,name] of targets.slice(completed.length)) {
          const source=JSON.parse(await readFile(resolve(dir,sourceName+'-context.json'),'utf8')),failed=JSON.parse(await readFile(resolve(dir,sourceName+'-parsed.json'),'utf8'));
          const prior=scene.latestScene(source.history,Infinity,fixture.session.memory.startingScene);
          const context={narration:failed.content,userText:source.history.at(-1).content,prior,names:fixture.lore.filter(e=>e.book==='characters').map(e=>e.name),protagonist:fixture.session.memory.protagonist,plan:'',calendar:fixture.session.memory.calendar};
          const messages=recovery.recoveryMessages(context),profile={...settings(prompts,true,'none',fixture),streaming:false,maxResponseTokens:1500,apiKey:key};
          currentScenario=name;currentEstimate=(await Promise.all(messages.map(m=>countTokens(m.content)))).reduce((a,b)=>a+b,24);
          await save(resolve(dir,name+'-context.json'),context);
          let reply;try{reply=await client.chatCompletion({settings:profile,messages,provider,responseFormat:recovery.SCENE_RECOVERY_FORMAT});}finally{await capturePending;}
          const checked=recovery.parseRecovery(reply.content,context),actual=checked?.scene?scene.parseScene(checked.scene):null;
          const warnings=[...(checked?.warnings??[]),...(!checked?['Recovery did not return usable structured state.']:[])];
          if(sourceName==='followup-ampm'&&actual?.time!=='15:55')warnings.push('Recovered elapsed clock was not 15:55.');
          if(sourceName==='new-memory'&&actual?.time!==prior.scene.time)warnings.push('Recovery invented unsupported new clock precision.');
          const result={name,sourceName,raw:reply.content,thinking:reply.thinking,scene:checked?.scene??null,sceneMeta:checked?.sceneMeta,warnings,hardPass:warnings.length===0,semanticReviewRequired:true};
          results.push(result);await save(resolve(dir,name+'-parsed.json'),result);
          if(!result.hardPass)throw new Error(name+' failed structured recovery validation. Review before continuing.');
        }
      }else if(options.backend) {
        if(previous.length<22||!options['provider-tag'])throw new Error('Backend comparison requires the completed recovery probes and an eligible --provider-tag.');
        const completed=previous.slice(22),targets=[['followup-absent-2','backend-absent'],['followup-entry','backend-entry']];
        if(completed.some((r,i)=>r.scenario!==targets[i]?.[1]))throw new Error('Unexpected backend comparison ledger order.');
        for(const [sourceName,name] of targets.slice(completed.length)) {
          const source=JSON.parse(await readFile(resolve(dir,sourceName+'-context.json'),'utf8')),original=JSON.parse(await readFile(resolve(dir,sourceName+'-parsed.json'),'utf8'));
          await narrate(name,source.history.at(-1).content,{priorHistory:source.history.slice(0,-1),expected:original.expected});
        }
      }else if(options.followup) {
        const calendar=await use('story-calendar.js'),source=JSON.parse(await readFile(resolve(dir,'new-memory-context.json'),'utf8'));
        const probes=followupProbes(fixture,calendar,scene,source),completed=previous.slice(8);
        if(completed.some((r,i)=>r.scenario!==probes[i]?.name))throw new Error('Unexpected follow-up ledger order; no calls repeated.');
        await save(resolve(dir,'followup-plan.json'),{limits,priorPaidCalls:8,priorCostsRetained:true,probes});
        for(const probe of probes.slice(completed.length))await narrate(probe.name,probe.input,{priorHistory:probe.history,expected:probe.expected});
      }else {
      if(!resume) {
      const input=fixture.expected.constraintInput??constraintInput;
      await narrate('legacy-constraint',input,{legacy:true});
      history=await narrate('selective-constraint',input);
      // An explicit local test seed isolates midnight arithmetic from how the
      // preceding model estimated elapsed time. It is recorded in the fixture.
      const latest=history.at(-1),midnightSeed={...latest,id:'eval-midnight-seed',content:'The NPCs wait in place at 23:50.',scene:scene.sceneLine({...scene.parseScene(latest.scene),when:fixture.session.memory.calendar.anchor,time:'23:50'})};
      history=await narrate('midnight','<ad>Twenty minutes pass while the NPCs wait in place. End at the resulting timestamp. Do not choose the protagonist’s actions.</ad>',{priorHistory:[...history.slice(0,-1),midnightSeed]});
      // Establish fresh evidence for the extraction→next-request loop.
      history=await narrate('new-memory','<ad>Establish this event now without choosing the protagonist’s actions: '+fixture.expected.newNote+'</ad>');
      }
      const extractHistory=structuredClone(history),originalLore=structuredClone(lore);
      lore=await extract('none',extractHistory);await save(resolve(dir,'local-stored-records.json'),lore.map(e=>records.toRecordDocument(e)));
      // A local checkpoint excludes the new event from recent conversation;
      // the original history remains available for source-evidence validation.
      const checkpoint={id:'eval-checkpoint',role:'summary',order:history.at(-1).order+1,coveredRange:{toOrder:history.at(-1).order},content:'The NPCs remain at the established inn. Continue from the current scene.'};
      history=await narrate('after-extraction',fixture.expected.followupInput??'Where did Mira Vale put the recovered letter? Continue with the established NPC state.',{priorHistory:[...history,checkpoint],checkpoint});
      const disabledLore=lore;lore=originalLore;await extract('low',extractHistory);lore=disabledLore;
      await narrate('ooc-freeze','<OOC>Recap the current date, time, and place without advancing events.</OOC>');
      }
      // A separate rollover probe is deferred if the eight-call ceiling is hit.
      // Other month/year boundaries have deterministic coverage in local tests.
    }finally{await save(resolve(dir,'results.json'),{results,chargedUSD:budget.charged/1e6,limits,releaseReady:false,reviewRequired:true,continuedAfterReviewedMissingTag:!!resume,initialTokenizer:prepared.preview.legacy.estimatedTokens===prepared.preview.legacy.inputBound?'unknown':JSON.parse(await readFile(resolve(dir,'preflight.json'),'utf8')).tokenizer,currentTokenizer:tokenizerStatus()});}
    console.log(json({calls:budget.rows.length,chargedUSD:budget.charged/1e6,results:results.map(r=>({name:r.name,hardPass:r.hardPass})),reviewRequired:true}));
  }finally{await lock.close();await unlink(resolve(dir,'run.lock'));}
}
export async function main(args=process.argv.slice(2)) {
  const [command,...rest]=args,options=flags(rest);
  if(command==='prepare')return prepare(options);
  if(command==='run')return run(options);
  if(command==='followup')return run({...options,followup:true});
  if(command==='recovery')return run({...options,recovery:true});
  if(command==='backend-check')return run({...options,backend:true});
  throw new Error('Use prepare [--fixture FILE] [--out DIR], or run --out DIR --key-file FILE --approved-budget 0.10 after user approval.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
