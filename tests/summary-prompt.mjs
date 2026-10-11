import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

const root=process.env.F20_PROMPT_ROOT;
const readPrompt=file=>readFile(root ? `${root}/${file}` : new URL('../system prompts/'+file,import.meta.url),'utf8');
test('Default summary prompt matches the revised continuity text within its word budget',async()=>{
  // Keep approved text in a versioned fixture, independent of local release notes.
  const approved=(await readFile(new URL('./fixtures/summary-approved-f20.md',import.meta.url),'utf8')).trim();
  const actual=(await readPrompt('summarizer.md')).trim();
  assert.equal(actual,approved);
  assert.ok(actual.split(/\s+/).length<=1470);
  const directive=await readPrompt('summary-output.md');
  assert.match(directive,/carry forward the previous summary's still-relevant story, voice, relationship, knowledge, and promise information/);
  assert.match(directive,/\{\{MAX_OUTPUT_TOKENS\}\}/);
});
test('Summary requests carry the active summary and then each complete chunk replacement',async()=>{
  const requests=[];
  const history=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i,narratorTurn:Math.floor(i/2)+1}));
  const previous='Mira owed Sol a map after the thaw. Only Sol knew why she left.';
  const active={id:'old-summary',order:13,role:'summary',content:previous,coveredRange:{fromOrder:3,toOrder:4}};
  const replacements=[previous+'\nThe bridge was repaired.',previous+'\nThe bridge was repaired. Mira reached the inn.',previous+'\nThe bridge was repaired. Mira reached the inn and found Sol.'];
  let saved;
  const use=appHarness({stubs:{
    'messages.js':{getMessages:async()=>[...history,active],getCheckpointMessages:async()=>[...history,active],newMessageId:()=> 'replacement',addMessage:async(_sid,message)=>{saved=message;return {id:message.id,message};}},
    'tokenizer.js':{countTokens:async text=>Math.ceil(text.length/4)},
    'context-builder.js':{buildContextForRequest:async()=>({usedTokens:100,report:{warnings:[]}}),computeContextUsage:async()=>({}),MESSAGE_FRAME_TOKENS:8,REQUEST_FRAME_TOKENS:8},
    'llm-client.js':{chatCompletion:async request=>{requests.push(request);return {content:replacements[requests.length-1],finishReason:'stop'};}},
  }});
  const {prompts}=await use('system-prompts.js');
  const {runSummarization}=await use('summarizer.js');
  await runSummarization({id:'story',activeSummaryMessageId:active.id,breakpointOrder:4,longTermPlan:'Private future outline'},
    {summarizerSystemPrompt:prompts.summarizer,maxContextTokens:50000,summarizerMaxTokens:4000,summarizerChunkTokens:1,keepRecentMessagesAfterSummary:2});
  assert.equal(requests.length,3);
  for(const [i,request]of requests.entries()){
    assert.equal(request.messages.length,2);
    assert.equal(request.messages[0].content,prompts.summarizer);
    const input=request.messages[1].content;
    assert.ok(input.startsWith('Previous summary:\n'+(i ? replacements[i-1] : previous)+'\n\nNew events to fold in:\n'));
    assert.ok(input.includes('=== Turn '+(i+3)+' ==='));
    assert.ok(input.includes('USER: Event '+(4+i*2)));
    assert.ok(input.includes('STORY: Event '+(5+i*2)));
    assert.ok(input.includes('within 4000 output tokens'));
    assert.doesNotMatch(input,/Private future outline|Event 0\b|Event 1\b|Event 10\b|Event 11\b|\{\{MAX_OUTPUT_TOKENS\}\}/);
  }
  assert.equal(saved.content,replacements.at(-1));
  assert.equal(saved.coveredRange.toOrder,10);
});
test('Serialized summaries use task-specific continuity and preserve configured reasoning',async()=>{
  for(const endpoint of ['https://openrouter.ai/api/v1/chat/completions','https://mock.local/chat'])for(const memory of [{},{lorebooks:true}])for(const reasoning of [
    {enabled:true,mode:'effort',effort:'high'},
    {enabled:true,mode:'max_tokens',maxTokens:4096},
    {enabled:false,explicitDisable:true},
  ]){
    const requests=[];
    const previous='Only Sol knew Mira owed him a map after the thaw.';
    const history=Array.from({length:8},(_,i)=>({id:'m'+i,order:i+1,narratorTurn:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:'Event '+i}));
    history.push({id:'old-summary',order:9,role:'summary',content:previous,coveredRange:{fromOrder:1,toOrder:2}});
    const use=appHarness({globals:{fetch:async(url,options)=>{
      if(String(url)!==endpoint)return promptFetch(url,options);
      requests.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({choices:[{message:{content:previous+' Mira reached the inn.'},finish_reason:'stop'}]})};
    }},stubs:{
      'messages.js':{getMessages:async()=>history,getCheckpointMessages:async()=>history,newMessageId:()=> 'replacement',addMessage:async(_sid,message)=>({id:message.id,message})},
      'tokenizer.js':{countTokens:async text=>Math.ceil(text.length/4)},
      'context-builder.js':{buildContextForRequest:async()=>({usedTokens:100,report:{warnings:[]}}),computeContextUsage:async()=>({}),MESSAGE_FRAME_TOKENS:8,REQUEST_FRAME_TOKENS:8},
    }});
    const {prompts}=await use('system-prompts.js');
    const settings={endpoint,modelId:'test',streaming:false,maxContextTokens:120000,maxResponseTokens:1000,summarizerMaxTokens:89000,keepRecentMessagesAfterSummary:2,summarizerSystemPrompt:'Summarize only.',reasoning};
    await (await use('summarizer.js')).runSummarization({id:'story',memory,activeSummaryMessageId:'old-summary',breakpointOrder:2},settings);
    assert.equal(requests.length,1);
    const body=requests[0],system=body.messages[0].content;
    assert.deepEqual(body.messages.map(m=>m.role),['system','user']);
    assert.equal(system,'Summarize only.'+(memory.lorebooks ? '\n\n'+prompts.summaryContinuity : ''));
    assert.doesNotMatch(system,/Continue from the newest narrative and the current user message/);
    if(memory.lorebooks)assert.match(system,/Carry forward still-relevant older continuity from the previous summary/);
    assert.match(prompts.continuity,/Continue from the newest narrative and the current user message/);
    assert.ok(body.messages[1].content.startsWith('Previous summary:\n'+previous+'\n\nNew events to fold in:\n'));
    assert.equal(body.max_tokens,89000);
    assert.match(body.messages[1].content,/within 89000 output tokens\. This is a ceiling, not a target/);
    if(reasoning.enabled)assert.deepEqual(body.reasoning,reasoning.mode==='effort' ? {effort:'high'} : {max_tokens:4096});
    else if(endpoint.includes('openrouter.ai'))assert.deepEqual(body.reasoning,{enabled:false});
    else assert.equal(body.reasoning,undefined);
    assert.equal(settings.reasoning,reasoning);
  }
});
test('F20 immediately preceding summary default migrates, while customized summaries stay unchanged',async()=>{
  const use=appHarness({globals:{crypto:webcrypto,fetch:async(url,options)=>{
    const file=decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    if(root && ['summarizer.md','summary-output.md','legacy-prompt-default-hashes.md'].includes(file))return {ok:true,text:()=>readPrompt(file)};
    return promptFetch(url,options);
  }},stubs:{'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:()=>{},getDocFromServer:()=>{},setDoc:()=>{},onSnapshot:()=>{},runTransaction(){},serverTimestamp(){}},'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},'state.js':{state:{}}}});
  const settings=await use('settings.js');
  // This is the exact outgoing default whose hash the release adds to migrations.
  const old=await readFile(new URL('./fixtures/summary-before-f20.md',import.meta.url),'utf8');
  assert.ok((await readPrompt('legacy-prompt-default-hashes.md')).split('\n').includes('summarizerSystemPrompt 039940653b9452e1975a00787e0ebfe887b9fecb409a730b380c498d67256609'));
  assert.equal((await settings.mergeDefaults({summarizerSystemPrompt:old.trim()})).summarizerSystemPrompt,settings.DEFAULT_SETTINGS.summarizerSystemPrompt);
  const custom=old.trim()+'\nMy custom story requirements.';
  assert.equal((await settings.mergeDefaults({summarizerSystemPrompt:custom})).summarizerSystemPrompt,custom);
});
