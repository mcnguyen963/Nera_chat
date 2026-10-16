// Prepare freezes both variants without paid calls. Run requires fresh confirmation.
import {readFile,writeFile,mkdir,readdir,open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {appHarness} from '../app-harness.mjs';
import {promptFetch} from '../prompt-files.mjs';
import {countTokens,tokenizerStatus} from './production-tokenizer.mjs';
import {EvaluationBudget,inputBounds} from './lorebook-eval-core.mjs';
import {eligible,LIMITS,MODEL,API,assertPaidApproval} from './director-eval.mjs';
export const BASELINE_COMMIT='86b910f148ead0a983e9d26ee486d3a55915c3cc';
const CATALOG='https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints';
const json=x=>JSON.stringify(x,null,2),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const save=(path,value)=>writeFile(path,json(value)+'\n',{mode:0o600});
const redact=(text,key)=>text.replaceAll(key,'[REDACTED]');
function flags(args){const out={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw Error('Expected --name value options');out[args[i].slice(2)]=args[++i];}return out;}
export async function codeFingerprint(root){
 const files=[];async function walk(dir){for(const e of (await readdir(resolve(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.isDirectory())await walk(dir+'/'+e.name);else if(e.name.endsWith('.js')||e.name.endsWith('.md'))files.push([dir+'/'+e.name,await readFile(resolve(root,dir,e.name),'utf8')]);}}
 await walk('js');await walk('system prompts');for(const file of ['tests/app-harness.mjs','tests/prompt-files.mjs'])files.push([file,await readFile(resolve(root,file),'utf8')]);return hash(files);
}
async function catalog(file){const data=file?JSON.parse(await readFile(resolve(file),'utf8')):await(await fetch(CATALOG,{signal:AbortSignal.timeout(30000)})).json();if(!eligible(data.data).length)throw Error('No eligible high-effort provider within approved price ceilings');return data.data;}
function harness(factory=appHarness){return factory({stubs:{'tokenizer.js':{countTokens,tokenizerStatus},'messages.js':{getMessages:async()=>{throw Error('External story reads forbidden');}}}});}
export async function comparisonFixture(use){
 const lore=await use('lore-lines.js'),recordApi=await use('lore-records.js'),stateApi=await use('director-state.js');
 const entry=(book,id,name,text)=>{const e=lore.makeEntry(book,name);e.id=id;Object.values(e.sections)[0].text=text;return e;};
 const entries=[entry('characters','nera','Nera','The player character. The user controls all voluntary actions, speech, thoughts and gestures.'),entry('characters','dara','Dara Vale','Reserved, precise, and dry-spoken. Dara remains at Stone Inn during the journey. Dara knows Nera concealed a lost letter for two days; she has not forgiven that breach of trust. She knows the letter was recovered, but does not know who stole it. She values honest answers and does not demand physical proof of affection.'),entry('characters','lysia','Lysia Solenne','Patient, concise, and practical. The established healer. Lysia has not heard about Nera’s lost letter or its recovery.'),entry('locations','inn','Stone Inn','A quiet stone inn. The departure doorway is narrow and its iron latch sticks. Dara stays here. Crownspire infirmary is exactly one game hour away along an unobstructed route.'),entry('locations','clinic','Crownspire infirmary','A quiet infirmary, with a blue door and brass bell. Entering, greeting the healer, or seeking treatment each requires authorization beyond arriving outside.'),entry('locations','bridge','South Bridge','The only bridge to Northgate is physically closed. No alternate crossing or ferry exists.'),entry('locations','north','Northgate','Across the closed South Bridge.'),entry('facts','clinic-options','Infirmary options','Lysia may offer Observation only (observe without an examination) or Consultation (a discussion). Choosing an option does not begin it. No fee, deadline, expectation of arrival or appointment has been established. Missing fees remain unknown.'),entry('facts','letter','Letter knowledge','Nera concealed the missing letter for two days. Dara later learned it was recovered and is still hurt by the concealment. Neither Dara nor Lysia knows the thief’s identity. The privately established thief is Captain Vale, but no character in these scenes learned this. Avoid giving NPCs that secret.')];
 const scene={date:'21/10/738',time:'20:00',location:'Stone Inn',present:['Nera','Dara Vale']},base={version:2,scene,event:null,decisions:[],threads:[],commitments:[]};
 const row=(name,input,{before=base,updates={},transition='unchanged',objective,stop,records=false,long=false,memoryIds=[]})=>{
  const history=[{id:'u1',order:1,role:'user',content:'I am at Stone Inn. The recovered letter is secure.'},{id:'a1',order:2,role:'assistant',content:'The recovered letter is secure. The evening continues.'}];
  if(long)for(let i=0;i<6;i++)history.push({id:'old-u'+i,order:history.length+1,role:'user',content:'I listen to another account from the archive.'},{id:'old-a'+i,order:history.length+2,role:'assistant',content:'Historical background only: '+('An old traveler described the weather at a distant coastal market. The account contains no new fact about the present scene, letter, healer or relationship. '.repeat(11))});
  const messages=[...history,{id:name+'-user',order:history.length+1,role:'user',content:input}];
  const contract={version:1,action:'narrate',transition,objective,stopCondition:stop,memoryIds,requiredMemoryIds:[],updates};
  const turn={id:name+'-turn',before,...stateApi.parseDirectorContract(JSON.stringify(contract),before,entries),playerBoundary:stateApi.playerStopBoundary(input)};
  return {name,records,entries:records?entries.map(e=>recordApi.reconcileRecords(structuredClone(e))):structuredClone(entries),messages,turn,session:{id:'synthetic-'+name,historyRevision:1,loreSchemaVersion:records?3:2,directorState:before,memory:{scene:true,lorebooks:true,memoryBlock:true,protagonist:'Nera',loreLookbackMessages:2,books:{characters:{budget:3500,maxCards:8},locations:{budget:2400,maxCards:5},facts:{budget:2200}}}}};
 };
 const clinic={...base,scene:{...scene,location:'Crownspire infirmary',present:['Nera','Lysia Solenne']}};
 return [row('arrival','I walk to Crownspire infirmary. Stop when we arrive.',{transition:'completed',updates:{scene:{time:'21:00',location:'Crownspire infirmary',present:['Nera']}},objective:'Describe the departure and one-hour journey, ending outside the blue door.',stop:'Arrival itself, before ringing, entering, greeting or registration.',memoryIds:['clinic']}),row('pending-choice','I ask Lysia what forms of help are available.',{before:clinic,records:true,updates:{decisions:{upsert:[{id:'choice',text:'Observation only or Consultation?',status:'open'}],close:[]}},objective:'Lysia offers the established two options, without inventing control facts.',stop:'After the offer, before Nera chooses.',memoryIds:['clinic-options','lysia']}),row('blocked','I try to cross the bridge to Northgate.',{before:{...base,scene:{...scene,location:'South Bridge',present:['Nera']}},records:true,transition:'blocked',objective:'Show the established impassable bridge preventing the crossing.',stop:'The blocked attempt; do not add gestures, another route, fees or a new voluntary action.',memoryIds:['bridge','north']}),row('emotional-history','I tell Dara, "I should have told you about the letter sooner. I understand if you still do not trust me."',{long:true,objective:'Dara responds in her established voice, retaining unresolved hurt. Keep the thief’s identity unknown to her.',stop:'After Dara’s response, before Nera reacts or reconciliation is resolved.',memoryIds:['dara','letter']})];
}
export async function buildComparisonRequests(baselineUse,candidateUse){
 const {prompts}=await candidateUse('system-prompts.js'),settingsApi=await candidateUse('story-settings.js');
 const settings={...settingsApi.defaultStorySettings(),endpoint:API,modelId:MODEL,apiKey:'offline-preview-key',streaming:true,narrationMode:'director',maxContextTokens:80000,maxResponseTokens:8192,keepRecentMessagesAfterSummary:120,maxOutputPrice:.4,reasoning:{enabled:true,mode:'effort',effort:'high'}};
 const fixture=await comparisonFixture(candidateUse),requests=[];
 for(const [index,row] of fixture.entries())for(const variant of index%2?['candidate','baseline']:['baseline','candidate']){
  const builder=await (variant==='baseline'?baselineUse:candidateUse)('context-builder.js');
  const built=await builder.buildContextForRequest(row.session,settings,{messages:row.messages,loreEntries:row.entries,directorTurn:row.turn,requireLatestUser:true,includeInspection:true});
  const client=await candidateUse('llm-client.js'),body={...client.buildRequestBody(settings,built.apiMessages),stream:true},bound=inputBounds(body,built.usedTokens);
  requests.push({scenario:row.name,variant,body,inputTokens:built.usedTokens,inputBound:bound.inputBound,contract:row.turn.contract,before:row.turn.before,after:row.turn.after,userText:row.messages.at(-1).content,report:built.report});
 }
 return {settings,requests};
}
export async function prepare(options){
 const root=resolve(options['baseline-root']??''),candidateRoot=fileURLToPath(new URL('../../',import.meta.url));
 if(!options['baseline-root'])throw Error('Provide the frozen --baseline-root extracted from '+BASELINE_COMMIT);
 const dir=resolve(options.out??'investigate/narrator-comparison');await mkdir(dir,{recursive:true});
 try{if(JSON.parse(await readFile(resolve(dir,'ledger.json'),'utf8')).length)throw Error('Never replace a prepared paid run');}catch(e){if(e.code!=='ENOENT')throw e;}
 const baselineFingerprint=await codeFingerprint(root);
 if(baselineFingerprint!==EXPECTED_BASELINE_FINGERPRINT)throw Error('Baseline snapshot differs from the frozen commit');
 const baseline=await import(pathToFileURL(resolve(root,'tests/app-harness.mjs')).href),candidateUse=harness();
 const built=await buildComparisonRequests(harness(baseline.appHarness),candidateUse),data=await catalog(options['providers-file']);
 const suite=options.suite??'paired';if(!['paired','candidate'].includes(suite))throw Error('Use --suite paired or candidate');
 if(suite==='candidate')built.requests=built.requests.filter(r=>r.variant==='candidate');
 const limits={...LIMITS,calls:built.requests.length};
 const maximumUSD=built.requests.reduce((n,r)=>n+(r.inputBound*LIMITS.prompt+r.body.max_tokens*LIMITS.completion)/1e6,0);
 if(maximumUSD>LIMITS.budget)throw Error('Prepared conservative bound exceeds $0.10; revise fixtures before requesting approval');
 if(built.requests.some(r=>!eligible(data,r.inputBound,r.body.max_tokens).length))throw Error('Prepared request cannot fit an eligible provider');
 const prepared={version:1,model:MODEL,suite,limits,baselineCommit:BASELINE_COMMIT,baselineRoot:root,baselineFingerprint,candidateFingerprint:await codeFingerprint(candidateRoot),runnerFingerprint:hash(await readFile(new URL('./narrator-comparison.mjs',import.meta.url),'utf8')),...built};
 await save(resolve(dir,'prepared.json'),prepared);
 const preflight={model:MODEL,reasoningEffort:'high',suite,limits,baselineCommit:BASELINE_COMMIT,preparedFingerprint:hash(prepared),maximumUSD,synthetic:true,completionCalls:0,paidApprovalRequired:true,tokenizer:tokenizerStatus(),providers:eligible(data).map(e=>({tag:e.tag,pricing:e.pricing})),requests:built.requests.map(({scenario,variant,inputTokens,inputBound})=>({scenario,variant,inputTokens,inputBound}))};
 await save(resolve(dir,'preflight.json'),preflight);console.log(json(preflight));return preflight;
}
function rawMetadata(raw){try{return JSON.parse(raw);}catch{}const data={};for(const line of raw.split(/\r?\n/)){if(line.startsWith('data: ')&&line!=='data: [DONE]'){try{const part=JSON.parse(line.slice(6));for(const key of ['model','provider','usage','id'])if(part[key]!=null)data[key]=part[key];}catch{}}}return data;}
// Fixture-specific warnings supplement manual review; they are not a general
// prose validator and never alter application canon or reject live narration.
export function comparisonWarnings(text,scenario) {
 const patterns={
  arrival:[/\b(?:palace|tannery|inner wall|checkpoints?|gates?|plank bridge)\b/i,'Unsourced route or city topology in the arrival fixture'],
  blocked:[/\b(?:welded|keyhole|flood|watchman|padlock|middle span|unusable key|ferry landing)\b/i,'Unsourced obstruction mechanism, cause or speaker in the blocked fixture'],
  'emotional-history':[/you asked me how the road|said the weather|since you put it down|you put (?:it|the letter)|you lost it|you stood in front of me|you said that[\s\S]{0,180}two days ago|choice you made twice a day|trust you the way I did on the eighteenth/i,'Unsourced past player conduct in the emotional-history fixture']
  ,'pending-choice':[/I don't charge|no fee|free of charge|ask for time in return/i,'Unsourced fee policy in the offer fixture']
 };
 const rule=patterns[scenario];return rule&&rule[0].test(text)?[rule[1]]:[];
}
export async function run(options){
 assertPaidApproval(options);
 const dir=resolve(options.out??'investigate/narrator-comparison'),prepared=JSON.parse(await readFile(resolve(dir,'prepared.json'),'utf8')),preflight=JSON.parse(await readFile(resolve(dir,'preflight.json'),'utf8'));
 const candidateRoot=fileURLToPath(new URL('../../',import.meta.url));
 if(hash(prepared)!==preflight.preparedFingerprint||prepared.candidateFingerprint!==await codeFingerprint(candidateRoot)||prepared.runnerFingerprint!==hash(await readFile(new URL('./narrator-comparison.mjs',import.meta.url),'utf8'))||prepared.baselineFingerprint!==await codeFingerprint(prepared.baselineRoot))throw Error('Prepared code or requests changed; prepare and confirm again');
 if(prepared.model!==MODEL||!['paired','candidate'].includes(prepared.suite)||JSON.stringify(prepared.limits)!==JSON.stringify({...LIMITS,calls:prepared.suite==='candidate'?4:8})||prepared.requests.length!==prepared.limits.calls||prepared.suite==='candidate'&&prepared.requests.some(r=>r.variant!=='candidate')||prepared.baselineCommit!==BASELINE_COMMIT||prepared.baselineFingerprint!==EXPECTED_BASELINE_FINGERPRINT)throw Error('Prepared comparison violates the fixed model, baseline or limits');
 const lock=await open(resolve(dir,'run.lock'),'wx',0o600),budget=new EvaluationBudget([],prepared.limits),results=[];let key='';
 try{
  try{if(JSON.parse(await readFile(resolve(dir,'ledger.json'),'utf8')).length)throw Error('This run already contains paid calls; never replay it');}catch(e){if(e.code!=='ENOENT')throw e;}
  const metadata=await catalog(),providers=eligible(metadata),tags=providers.map(e=>e.tag),provider={only:tags,require_parameters:true,max_price:{prompt:.25,completion:.4,request:0}};
  key=(await readFile(resolve(options['key-file']),'utf8')).trim();if(!key)throw Error('API key file is empty');
  const use=appHarness({globals:{fetch:async(url,opts)=>{
   if(String(url)!==API)return promptFetch(url,opts);
   const body=JSON.parse(opts.body);if(body.model!==MODEL||body.reasoning?.effort!=='high'||body.provider?.require_parameters!==true||JSON.stringify(body.provider?.only)!==JSON.stringify(tags)||body.provider?.max_price?.prompt!==.25||body.provider?.max_price?.completion!==.4||body.provider?.max_price?.request!==0)throw Error('Request violated routing or reasoning limits');
   const expected=prepared.requests[budget.rows.length];if(!expected||hash({...body,provider:undefined})!==hash({...expected.body,provider:undefined}))throw Error('Serialized request differs from the approved frozen request');
   const bound=inputBounds(body,expected.inputTokens);if(!eligible(metadata,bound.inputBound,body.max_tokens).length)throw Error('No eligible provider can fit this request');
   const row=budget.reserve({scenario:expected.scenario+'-'+expected.variant,inputBound:bound.inputBound,maxTokens:body.max_tokens});await save(resolve(dir,'ledger.json'),budget.rows);await writeFile(resolve(dir,row.number+'-request.json'),redact(json(body),key),{mode:0o600});
   const start=Date.now();try{
    const response=await fetch(url,opts),raw=await response.clone().text();await writeFile(resolve(dir,row.number+'-response.txt'),redact(raw,key),{mode:0o600});const info=rawMetadata(raw);budget.settle(row,info.usage);row.responseModel=info.model??null;row.provider=info.provider??null;row.reasoningTokens=info.usage?.completion_tokens_details?.reasoning_tokens??null;row.elapsedMs=Date.now()-start;await save(resolve(dir,'ledger.json'),JSON.parse(redact(json(budget.rows),key)));
    if(row.status!=='received')throw Error('Provider cost accounting is unresolved');
    if(info.model!==MODEL.split(':')[0]&&!info.model?.startsWith(MODEL.split(':')[0]+'-'))throw Error('Provider returned a different model');
    const names=new Set(providers.map(e=>(e.provider_name??e.name.split('|')[0].trim()).toLowerCase()));if(!names.has(String(info.provider??'').toLowerCase()))throw Error('Response provider is not in the eligible listing');return response;
   }catch(error){if(row.status==='started')row.status='unresolved';await save(resolve(dir,'ledger.json'),budget.rows);throw error;}
  }}}),client=await use('llm-client.js'),scene=await use('scene.js'),agency=await use('turn-review.js'),state=await use('director-state.js');
  for(const request of prepared.requests){
   const result=await client.chatCompletion({settings:{...prepared.settings,apiKey:key},messages:request.body.messages,provider});
   const text=scene.readSceneOutput(result.content).clean;if(!text.trim()||result.finishReason==='length')throw Error('Empty or truncated narration; comparison stopped');
   const warnings=[...comparisonWarnings(text,request.scenario),...agency.lintPlayerAgency(text,'Nera'),...agency.lintDirectorGestures(text,{protagonist:'Nera',userText:request.userText}),...agency.lintDirectorHistory(text,{userText:request.userText}),...state.directorSceneWarnings(scene.readSceneOutput(result.content).scene,request.after)];
   results.push({scenario:request.scenario,variant:request.variant,narration:text,warnings,usage:result.usage,finishReason:result.finishReason});await save(resolve(dir,'results.json'),{results,chargedUSD:budget.charged/1e6,reviewRequired:true,releaseReady:false});
  }
  const reviewOrder=[...results].sort((a,b)=>a.scenario.localeCompare(b.scenario)||hash(a.narration).localeCompare(hash(b.narration)));
  await save(resolve(dir,'blind-review.json'),reviewOrder.map((r,i)=>({label:'Output '+(i+1),scenario:r.scenario,narration:r.narration})));
  await save(resolve(dir,'review-key.json'),reviewOrder.map((r,i)=>({label:'Output '+(i+1),scenario:r.scenario,variant:r.variant})));
  console.log(json({model:MODEL,calls:budget.rows.length,chargedUSD:budget.charged/1e6,humanReviewRequired:true}));return results;
 }catch(error){await save(resolve(dir,'results.json'),JSON.parse(redact(json({results,error:error.message,chargedUSD:budget.charged/1e6,reviewRequired:true,releaseReady:false}),key||'__no_key__')));throw Error(redact(error.message,key||'__no_key__'));}
 finally{await lock.close();await unlink(resolve(dir,'run.lock'));}
}
export async function main(args=process.argv.slice(2)){const [command,...rest]=args,options=flags(rest);if(command==='prepare')return prepare(options);if(command==='run')return run(options);throw Error('Use prepare or run');}
const EXPECTED_BASELINE_FINGERPRINT='757d1532f0d8f7fbfc638db8cfbdee80f185c223de59973ff920d61c97ed68f9';
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
