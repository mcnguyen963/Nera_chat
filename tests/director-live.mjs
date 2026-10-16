import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main,eligible,LIMITS,MODEL,API,assertPaidApproval,checkTransition} from './tools/director-eval.mjs';
const endpoint={name:'Test | DeepSeek',provider_name:'Test',tag:'test/fp4',quantization:'fp4',pricing:{prompt:'0.00000009',completion:'0.0000003'},context_length:1048576,max_completion_tokens:943718,supported_parameters:['reasoning','reasoning_effort','max_tokens','response_format','structured_outputs']};
const listing={data:{id:'deepseek/deepseek-v4.1-flash',endpoints:[endpoint]}};
test('Director live evaluation requires separate explicit confirmation and an exact total budget',async()=>{
 for(const options of [{},{'approved-budget':'0.10'},{'confirm-live':'yes','approved-budget':'0.40'}])assert.throws(()=>assertPaidApproval(options),/separate user confirmation/);
 assert.doesNotThrow(()=>assertPaidApproval({'confirm-live':'yes','approved-budget':'0.10'}));
 await assert.rejects(main(['run','--key-file','/missing-key']),/separate user confirmation/);
});
test('Director live provider eligibility enforces the 0.40 output ceiling and high-effort support',()=>{
 assert.equal(eligible(listing.data).length,1);assert.equal(eligible(listing.data,0,8192,{json:true}).length,1);assert.equal(eligible({...listing.data,endpoints:[{...endpoint,supported_parameters:['reasoning','reasoning_effort','max_tokens']}]},0,8192,{json:true}).length,0);assert.equal(LIMITS.completion,.4);assert.equal(MODEL,'deepseek/deepseek-v4.1-flash:floor');
 for(const bad of [{pricing:{prompt:'0.00000009',completion:'0.00000041'}},{supported_parameters:['reasoning','max_tokens']},{pricing:{prompt:'0.00000026',completion:'0.0000003'}},{pricing:{prompt:'0.00000009',completion:'0.0000003',request:'0.01'}}])assert.equal(eligible({...listing.data,endpoints:[{...endpoint,...bad}]}).length,0);
});
for(const suite of ['independent','chained'])for(const badReply of [false,true])test('Offline '+suite+' Director/Narrator live-run rehearsal '+(badReply?'stops after a bad contract':'captures routing, usage, reasoning and all eight calls'),async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nera-director-eval-')),realFetch=globalThis.fetch,realLog=console.log,key='fake-openrouter-key-for-replay';let completions=0;
 globalThis.fetch=async(url,opts)=>{
  if(String(url).endsWith('/endpoints'))return new Response(JSON.stringify(listing));
  assert.equal(String(url),API);const body=JSON.parse(opts.body);completions++;
  assert.equal(body.model,MODEL);assert.equal(body.reasoning.effort,'high');assert.equal(body.provider.max_price.completion,.4);assert.equal(body.provider.max_price.prompt,.25);assert.equal(body.provider.require_parameters,true);
  let content;
  if(!body.stream){
   assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);
   const raw=JSON.parse(body.messages[0].content.slice(body.messages[0].content.lastIndexOf('\n\n{')+2)),s=raw.state,input=body.messages.at(-1).content;
   const output={version:1,action:'narrate',transition:'unchanged',objective:'Narrate the authorized action without taking the next voluntary decision.',stopCondition:'Stop before the next player choice',memoryIds:raw.entityIndex.map(e=>e.id),requiredMemoryIds:[],updates:{}};
   if(/registration options/.test(input))output.updates.decisions={upsert:[{id:'registration',text:'Which excursion option?',status:'open'}],close:[]};
   if(/Dinner finishes/.test(input))output.updates.commitments={upsert:[{id:'visit-lysia',status:'ready'}],close:[]};
   if(/one-hour route/.test(input)){output.transition='completed';output.updates.scene={...s.scene,date:'22/10/738',time:'01:00',location:'Crownspire infirmary'};}
   if(/closed bridge/.test(input))output.transition='blocked';
   if(/established healer Lysia/.test(input))output.updates.scene={...s.scene,present:['Nera','Isolde Veyless','Lysia Solenne']};
   if(/I choose Observation only/.test(input))output.updates.decisions={upsert:[],close:s.decisions.map(i=>i.id)};
   content=badReply?'invalid json':JSON.stringify(output);
   return new Response(JSON.stringify({id:'mock-'+completions,model:MODEL.split(':')[0],provider:'Test',choices:[{message:{content,reasoning:'Mock private reasoning '+key},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:300,completion_tokens_details:{reasoning_tokens:100},cost:.001}}),{headers:{'content-type':'application/json'}});
  }
  content='Isolde waits for Nera’s next action.';
  const events=[{id:'mock-'+completions,model:MODEL.split(':')[0],provider:'Test',choices:[{delta:{reasoning:'Mock private reasoning '+key},finish_reason:null}]},{choices:[{delta:{content},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:300,completion_tokens_details:{reasoning_tokens:100},cost:.001}}];
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 console.log=()=>{};
 try{
  await main(['prepare','--out',dir,'--suite',suite]);assert.equal(completions,0);
  const preflight=JSON.parse(await readFile(join(dir,'preflight.json'),'utf8'));assert.equal(preflight.completionCalls,0);assert.equal(preflight.paidApprovalRequired,true);assert.equal(preflight.scenarios.length,4);assert.ok(preflight.previewBasedCostBoundUSD<.10);
  const previews=JSON.parse(await readFile(join(dir,'previews.json'),'utf8')),promise=previews[ suite==='chained'?0:1 ];assert.ok(promise.director.body.messages[0].content.includes('visit-lysia'));assert.ok(!promise.director.body.messages.slice(1).some(m=>m.content.includes('After dinner, I will')));
  await writeFile(join(dir,'key.txt'),key);
  const args=['run','--out',dir,'--key-file',join(dir,'key.txt'),'--confirm-live','yes','--approved-budget','0.10'];
  if(badReply){await assert.rejects(main(args),/invalid JSON/);assert.equal(completions,1);}else{const result=await main(args);assert.equal(completions,8);assert.ok(result.every(r=>r.hardPass));assert.ok(result.every(r=>r.canonicalScene));assert.ok(result.every(r=>r.regenerateReused));assert.ok(result.some(r=>r.continueBlocked));if(suite==='chained'){for(let i=1;i<result.length;i++)assert.deepEqual(result[i].before,result[i-1].after);assert.equal(result[2].corruptHistoricalTag,true);assert.equal(result[2].after.scene.location,'Crownspire infirmary');assert.equal(result[3].after.decisions.length,0);}}
  const ledger=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8'));assert.ok(ledger.every(r=>r.provider==='Test' && r.responseModel==='deepseek/deepseek-v4.1-flash'));assert.ok(ledger.every(r=>r.actualMicros===1000 && r.reasoningTokens===100));
  const response=await readFile(join(dir,'1-response.txt'),'utf8');assert.ok(!response.includes(key));assert.ok(response.includes('[REDACTED]'));
  await assert.rejects(main(args),/already contains paid calls/);await assert.rejects(main(['prepare','--out',dir]),/paid run/);
 }finally{globalThis.fetch=realFetch;console.log=realLog;await rm(dir,{recursive:true,force:true});}
});
test('Hard live checks detect a lost promise, skipped choice, wrong hour and invented participant',()=>{
 const row={expect:{location:'Inn',date:'21/10/738',time:'01:00',pendingDecision:true,readyCommitment:'promise'}},turn={contract:{action:'narrate'},after:{scene:{location:'Elsewhere',date:'22/10/738',time:'02:00',present:['Stranger']},decisions:[],commitments:[]}};
 assert.ok(checkTransition(row,turn).length>=6);
});
