import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvaluationBudget,eligibleEndpoints,EVAL_MODEL,EXPANDED_EVAL_LIMITS} from './tools/lorebook-eval-core.mjs';
import {main} from './tools/lorebook-eval.mjs';
import {countTokens,tokenizerStatus} from './tools/production-tokenizer.mjs';
test('evaluation loads the production tokenizer without falling back to byte counts',async()=>{
  const text='A small test of production token counting.';
  const tokens=await countTokens(text);assert.equal(tokenizerStatus(),'ok');assert.ok(tokens<new TextEncoder().encode(text).length/2);
});
test('budget reserves total input and output and never drops failed or unresolved spend',()=>{
  const b=new EvaluationBudget(),row=b.reserve({scenario:'a',inputBound:1000,maxTokens:8192});assert.equal(row.reservedMicros,4346);
  b.settle(row,null);assert.equal(b.charged,4346);assert.throws(()=>b.reserve({scenario:'b',inputBound:1000,maxTokens:8192}),/unresolved/);
  b.settle(row,{cost:0.003});assert.equal(b.charged,3000);
  assert.throws(()=>b.reserve({scenario:'huge',inputBound:500000,maxTokens:8192}),/budget/);
  for(let i=1;i<8;i++){const r=b.reserve({scenario:'c'+i,inputBound:1000,maxTokens:2048});b.settle(r,{cost:0.001});}
  assert.throws(()=>b.reserve({scenario:'ninth',inputBound:1,maxTokens:1}),/Eight-call/);
});
test('provider listing must match the model, ceilings, reasoning support and context size',()=>{
  const endpoint={tag:'test',pricing:{prompt:'0.0000001',completion:'0.0000003'},context_length:120000,max_completion_tokens:9000,supported_parameters:['reasoning','max_tokens']};
  const catalog={id:'deepseek/deepseek-v4.1-flash',endpoints:[endpoint]};assert.equal(eligibleEndpoints(catalog,10000).length,1);
  for(const bad of [{pricing:{prompt:'0.0000001',completion:'0.0000006'}},{supported_parameters:['max_tokens']},{context_length:1000},{pricing:{prompt:'0.0000001',completion:'0.0000003',request:'0.01'}}])assert.equal(eligibleEndpoints({...catalog,endpoints:[{...endpoint,...bad}]},10000).length,0);
  assert.equal(eligibleEndpoints({...catalog,id:'other'}).length,0);
});
test('expanded budget counts all earlier spend and still enforces the unchanged output ceiling',()=>{
  const earlier=Array.from({length:8},(_,i)=>({number:i+1,status:'received',actualMicros:1000,reservedMicros:2000}));
  const b=new EvaluationBudget(earlier,EXPANDED_EVAL_LIMITS);assert.equal(b.charged,8000);assert.equal(b.limits.completion,0.5);
  const row=b.reserve({scenario:'followup',inputBound:1000,maxTokens:8192});assert.equal(row.number,9);assert.equal(row.reservedMicros,4346);
  b.settle(row,{cost:0.001});assert.equal(b.charged,9000);
  assert.throws(()=>b.reserve({scenario:'too-large',inputBound:800000,maxTokens:8192}),/\$0.20/);
  assert.throws(()=>new EvaluationBudget([],{...EXPANDED_EVAL_LIMITS,budget:0.21}),/Invalid/);
});
test('paid mode requires exact separate approval before inspecting a key',async()=>{
  await assert.rejects(()=>main(['run','--approved-budget','0.11']),/explicit user approval/);
  await assert.rejects(()=>main(['run']),/explicit user approval/);
});
for(const interrupted of [false,true])test('offline replay exercises streaming and extraction'+(interrupted?' after reviewed missing scene':' through a complete run'),async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nera-eval-replay-')),key='mock-secret-not-a-real-key',originalFetch=globalThis.fetch,log=console.log;
  let calls=0;
  const endpoint={name:'Test',tag:'test',pricing:{prompt:'0.0000001',completion:'0.0000003'},context_length:1048576,max_completion_tokens:943718,supported_parameters:['reasoning','max_tokens']};
  globalThis.fetch=async(url,opts)=>{
    if(String(url).endsWith('/endpoints'))return new Response(JSON.stringify({data:{id:'deepseek/deepseek-v4.1-flash',endpoints:[endpoint]}}));
    assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');const body=JSON.parse(opts.body);calls++;assert.equal(body.model,EVAL_MODEL);assert.equal(body.provider.max_price.completion,0.5);assert.equal(body.provider.max_price.prompt,0.25);
    if(calls===5||body.response_format)assert.deepEqual(body.reasoning,{enabled:false});else if(calls===7)assert.deepEqual(body.reasoning,{effort:'low'});else assert.deepEqual(body.reasoning,{effort:'high'});
    if(body.response_format) {
      assert.equal(body.response_format.type,'json_schema');assert.equal(body.stream,undefined);
      const context=JSON.parse(body.messages[1].content),prior=context.priorScene;
      const content=JSON.stringify({date:prior.when,time:calls===22?'15:55':prior.time,place:prior.place,present:prior.present,planThread:null});
      return new Response(JSON.stringify({id:'mock-'+calls,model:EVAL_MODEL,provider:'Test',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:200,cost:0.001}}),{headers:{'content-type':'application/json'}});
    }
    if(calls===6){const text=body.messages.map(m=>m.content).join('\n');assert.match(text,/blue chest/);assert.doesNotMatch(text,/<ad>Establish this event/);assert.doesNotMatch(text,/recordLayout|recordSelection/);}
    let content;
    if(calls===5||calls===7)content='T4 [char] Mira Vale | status: Locked the recovered letter in the blue chest.';
    else if(calls===8)content='OOC: The NPCs are at Stone Inn.';
    else if(calls>8) {
      const number=calls-8,user=body.messages.at(-1).content;
      const example=[...user.matchAll(/<scene>([^<]+)<\/scene>/g)].at(-1)?.[1];assert.ok(example);
      const {appHarness}=await import('./app-harness.mjs'),scene=await appHarness()('scene.js'),calendar=await appHarness()('story-calendar.js');
      let parsed=scene.parseScene(example);
      if(number===5)parsed.present=['Traveler','Mira Vale'];if(number===6)parsed.present=['Mira Vale'];
      if(calls===24)parsed.present=['Traveler','Mira Vale'];
      if(number>=7&&number<=9){const next=['1/11/738','1/1/739','29/2/740'][number-7];parsed.when=calendar.formatStoryDate(calendar.parseStoryDate(next),{mode:'modern',anchor:'Friday 21/10/738'});parsed.time='00:05';}
      if(number===10)parsed.time='15:55';
      content=number===12?'OOC: Friday 21/10/738, 15:40, Stone Inn.':'Mira Vale waits.\n<scene>'+scene.sceneLine(parsed)+'</scene>';
    }
    else {const date=calls>=3?'Saturday 22/10/738':'Friday 21/10/738',time=calls===3?'00:10':calls>=4?'00:11':'15:45';content=(calls===4?'Mira Vale locked the recovered letter in the blue chest.':'Mira Vale remains unaffected by moonflower poison.')+(interrupted&&calls===4?'':`\n<scene>date: ${date} · time: ${time} · place: Stone Inn · present: Mira Vale</scene>`);}
    const parts=[content.slice(0,20),content.slice(20)];
    const events=parts.map(content=>({id:'mock-'+calls,provider:'Test',model:EVAL_MODEL,choices:[{delta:{content},finish_reason:null}]}));
    events.unshift({choices:[{delta:{reasoning:'Test reasoning '+key},finish_reason:null}]});events.push({id:'mock-'+calls,provider:'Test',model:EVAL_MODEL,choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:300,cost:0.001}});
    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  console.log=()=>{};
  try {
    await main(['prepare','--out',dir]);await writeFile(join(dir,'key.txt'),key);
    const runArgs=['run','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.10'];
    if(interrupted) {
      await assert.rejects(()=>main(runArgs),/new-memory failed/);assert.equal(calls,4);
      const firstResponse=await readFile(join(dir,'4-response.txt'),'utf8');
      await main([...runArgs,'--continue-reviewed','new-memory-missing-scene']);
      assert.equal(await readFile(join(dir,'4-response.txt'),'utf8'),firstResponse);
      assert.equal(JSON.parse(await readFile(join(dir,'results.json'),'utf8')).results[3].hardPass,false);
    }else await main(runArgs);
    assert.equal(calls,8);const ledger=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8'));assert.equal(ledger.length,8);assert.ok(ledger.every(r=>r.actualMicros===1000));
    const results=await readFile(join(dir,'results.json'),'utf8');assert.doesNotMatch(results,new RegExp(key));assert.equal(JSON.parse(results).releaseReady,false);
    await assert.rejects(()=>main(['run','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.10']),/already has paid calls/);assert.equal(calls,8);
    if(!interrupted) {
      await assert.rejects(()=>main(['followup','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.10']),/0.20/);
      await main(['followup','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.20']);assert.equal(calls,20);
      const extended=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8'));assert.equal(extended.length,20);assert.ok(extended.every(r=>r.actualMicros===1000));
      assert.equal(JSON.parse(await readFile(join(dir,'results.json'),'utf8')).chargedUSD,0.02);
      await assert.rejects(()=>main(['followup','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.20']),/Review the interrupted follow-up/);assert.equal(calls,20);
      await main(['recovery','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.20','--reviewed-through','20']);assert.equal(calls,22);
      await main(['backend-check','--out',dir,'--key-file',join(dir,'key.txt'),'--approved-budget','0.20','--reviewed-through','22','--provider-tag','test']);assert.equal(calls,24);
      const finalLedger=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8'));assert.equal(finalLedger.length,24);assert.equal(JSON.parse(await readFile(join(dir,'results.json'),'utf8')).chargedUSD,0.024);
    }
  }finally{console.log=log;globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
