import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
const frozen=await readFile(new URL('./fixtures/mobile-context/memory-context.js',import.meta.url),'utf8');
const count=async text=>Math.ceil(text.length/4)+(text.match(/\n\n/g)?.length ?? 0);
// Preserve the frozen assembly while applying the intentionally added mandatory policy.
async function builders(){
  const current=appHarness(),before=appHarness({sources:{'memory-context.js':frozen.replace('const system=', 'narrator+="\\n\\n"+prompts.threadPolicy; const system=')}});
  return {optimized:(await current('memory-context.js')).buildMemoryContext,frozen:(await before('memory-context.js')).buildMemoryContext,makeEntry:(await current('lore-lines.js')).makeEntry};
}
const history=n=>Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:(i%5===0?'<OOC>note</OOC> ':'')+'Story '+i+' '+('varied text. '.repeat(i%7+1)),...(i%2?{scene:'date: Day 1 · time: night · place: Inn · present: Mira',planThread:'Preserve the map.'}:{})}));
const settings={narratorSystemPrompt:'Narrate.',maxResponseTokens:100,keepRecentMessagesAfterSummary:5};
const deps={count,adRule:'Author directives.',normalizeAd:s=>s};
// Ranking and character allocation diagnostics are intentionally new; this frozen
// fixture still compares every request byte and all history/token accounting.
async function outcome(build,session,settings,opts,deps){try{return JSON.parse(JSON.stringify(await build(session,settings,opts,deps),(key,value)=>['ranking','characterBudget'].includes(key) ? undefined : value));}catch(e){return {error:e.message};}}
test('Frozen builder parity: summaries, budgets, lore, aligned windows, directives and continuations',async()=>{
  const b=await builders();
  const entries=['facts','events','characters','locations'].map(book=>{
    const e=b.makeEntry(book,book==='characters'?'Mira':book==='locations'?'Inn':book,{id:book,alwaysLoad:true});
    for(const section of Object.values(e.sections))section.text='Canon '+book+' '.repeat(10);
    return e;
  });
  let cases=0;
  for(const summary of [false,true])for(const blockWindow of [false,true])for(const role of ['user','system'])for(const budget of [80,1300,2200,4000,10000])for(const onlyRequiredWindow of [false,true])for(const mode of ['draft','continue','placeholder','history']){
    const messages=history(40);if(summary)messages.push({id:'summary',role:'summary',order:41,content:'Historical events.',coveredRange:{toOrder:18}});
    const session={id:'s',longTermPlan:'Find the map.',memory:{scene:true,memoryBlock:true,lorebooks:true,blockWindow,blockRole:role,batchTurns:3,replyContract:role,characterSelection:true},...(summary?{activeSummaryMessageId:'summary',breakpointOrder:18}:{})};
    const opts={messages,loreEntries:entries,includeInspection:true,onlyRequiredWindow,...(mode==='draft'?{draftText:'Mira visits the Inn. <ad>Look around</ad>'}:mode==='continue'?{continuationId:'m39'}:mode==='placeholder'?{placeholderLatest:true}:{})};
    const s={...settings,maxContextTokens:budget};
    assert.deepEqual(await outcome(b.optimized,session,s,opts,deps),await outcome(b.frozen,session,s,opts,deps),JSON.stringify({summary,blockWindow,role,budget,mode}));cases++;
  }
  assert.equal(cases,320);
});
test('Frozen parity with irregular persisted turns, required-only windows and regeneration',async()=>{
  const b=await builders(),messages=history(60);messages[10].narratorTurn=20;messages[12].narratorTurn=2;
  for(const maxContextTokens of [1000,1800,3000,20000])for(const onlyRequiredWindow of [false,true]){
    const session={id:'s',memory:{memoryBlock:true,blockWindow:true,batchTurns:2}},s={...settings,maxContextTokens},opts={messages,onlyRequiredWindow,upToOrder:51,includeInspection:true};
    assert.deepEqual(await outcome(b.optimized,session,s,opts,deps),await outcome(b.frozen,session,s,opts,deps));
  }
});
test('Tokenizer recovery rebuild matches the frozen final payload and report',async()=>{
  const b=await builders(),session={memory:{memoryBlock:true}},opts={messages:history(70),includeInspection:true},s={...settings,maxContextTokens:100000};
  const recovering=()=>{let calls=0;return async text=>text.length*(++calls<=40?2:1);};
  assert.deepEqual(await outcome(b.optimized,session,s,opts,{...deps,count:recovering()}),await outcome(b.frozen,session,s,opts,{...deps,count:recovering()}));
});
test('History selection token-count operations grow linearly for newest-first and block trials',async()=>{
  const b=await builders();
  for(const blockWindow of [false,true]){
    const calls=[],reads=[];
    for(const n of [500,2000]){let operations=0,idReads=0;const messages=history(n).map(m=>new Proxy(m,{get:(target,key)=>{if(key==='id')idReads++;return target[key];}}));await b.optimized({memory:{memoryBlock:true,blockWindow,batchTurns:5}},{...settings,maxContextTokens:blockWindow?12000:1000000},{messages},{...deps,count:async text=>{operations++;return count(text);}});calls.push(operations);reads.push(idReads);assert.ok(idReads<n*80,`${n} messages: ${idReads} ID reads`);assert.ok(operations<n*20,`${n} messages: ${operations} counts`);}
    assert.ok(calls[1]<calls[0]*4.3,JSON.stringify(calls));
    assert.ok(reads[1]<reads[0]*4.3,JSON.stringify(reads));
  }
});

test('summary-covered history remains available without tokenizing messages that cannot enter the request',async()=>{
 const seen=[],use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected cloud read');}},'tokenizer.js':{countTokens:async text=>{seen.push(text);return Math.ceil(text.length/4);},tokenizerReady:()=>true}}});
 const {buildContextForRequest}=await use('context-builder.js');
 const messages=Array.from({length:10000},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:'HISTORY_MESSAGE_'+i}));
 messages[5000].content='OLD_ONLY_MESSAGE_5000';messages.push({id:'summary',order:10001,role:'summary',content:'Earlier events remain summarized.',coveredRange:{toOrder:9980}});
 const before=JSON.stringify(messages),session={id:'s',activeSummaryMessageId:'summary',breakpointOrder:9980,memory:{lorebooks:true}};
 const built=await buildContextForRequest(session,{narratorSystemPrompt:'Narrate.',maxContextTokens:30000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:10},{messages,loreEntries:[],draftText:'Next action',includeInspection:true});
 assert.ok(!seen.some(t=>t.includes('OLD_ONLY_MESSAGE_5000')));assert.ok(seen.length<200,'count work follows the eligible window');
 const wire=JSON.stringify(built.apiMessages);assert.match(wire,/HISTORY_MESSAGE_0\b/);assert.match(wire,/HISTORY_MESSAGE_1\b/);assert.match(wire,/HISTORY_MESSAGE_9999\b/);assert.match(wire,/Earlier events remain summarized/);assert.match(wire,/Next action/);
 assert.equal(JSON.stringify(messages),before);assert.ok(built.inspection.messages.length<30);
});

test('a bounded unsummarized request skips old text that cannot enter its newest-first window',async()=>{
 const seen=[],use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected cloud read');}},'tokenizer.js':{countTokens:async text=>{seen.push(text);return Math.ceil(text.length/4);},tokenizerReady:()=>true}}});
 const {buildContextForRequest}=await use('context-builder.js');
 const messages=Array.from({length:10000},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:'HISTORY_MESSAGE_'+i+' '+('A remembered passage. '.repeat(40))}));
 const session={id:'s',memory:{memoryBlock:true,blockWindow:false}},before=JSON.stringify({messages,session});
 const built=await buildContextForRequest(session,{...settings,maxContextTokens:6000,maxResponseTokens:1000},{messages,loreEntries:[],draftText:'Next action',includeInspection:true});
 assert.ok(!seen.some(text=>text.includes('HISTORY_MESSAGE_5000 ')),'unused old messages should not reach the tokenizer');
 assert.ok(seen.length<300,'token work should follow the fitted window');
 const wire=JSON.stringify(built.apiMessages);
 for(const marker of ['HISTORY_MESSAGE_0 ','HISTORY_MESSAGE_1 ','HISTORY_MESSAGE_9999 ','Next action'])assert.ok(wire.includes(marker),marker);
 assert.equal(built.report.blocks.find(b=>b.key==='window').mode,'newest-first');
 assert.ok(built.droppedCount>9900);assert.ok(built.usedTokens<=6000);
 assert.equal(JSON.stringify({messages,session}),before);
});

test('scene rendering and reports preserve seed, missing, invalid, carried, pending, OOC and cutoff semantics',async()=>{
 const b=await builders(),seed='date: Day 1 · time: morning · place: Inn · present: Mira',next='date: Day 2 · time: evening · place: Road · present: Mira';
 const base=[{id:'u',order:1,role:'user',content:'Begin.'},{id:'a',order:2,role:'assistant',content:'Mira waits.',scene:seed,sceneMeta:{kind:'declared'}}];
 const cases=[
   {name:'seed without replies',messages:base.slice(0,1)},
   {name:'missing metadata',messages:[base[0],{...base[1],scene:undefined,sceneMeta:undefined}]},
   {name:'invalid scene',messages:[base[0],{...base[1],scene:'date: ???'}]},
   {name:'carried scene',messages:[...base,{id:'carried',order:3,role:'assistant',content:'A pause.',scene:next,sceneMeta:{kind:'carried'}}]},
   {name:'pending scene',messages:[...base,{id:'pending',order:3,role:'assistant',content:'Mira travels.',acceptance:'pending',sceneCandidate:next}]},
   {name:'OOC scene',messages:[...base,{id:'ooc',order:3,role:'assistant',content:'<OOC>A question.</OOC>',ooc:true,scene:next}]},
   {name:'duplicate reply identity',messages:[...base,{...base[1],content:'The corrected reply.',scene:next}]},
   {name:'cutoff excludes the later scene',messages:[...base,{id:'later',order:4,role:'assistant',content:'Mira travels.',scene:next}],upToOrder:4},
 ];
 for(const fixture of cases)for(const continuation of [false,true]){
   if(continuation&&!fixture.messages.some(m=>m.id==='a'))continue;
   const session={id:'s',memory:{scene:true,memoryBlock:true,startingScene:seed}},opts={messages:fixture.messages,includeInspection:true,...(continuation?{continuationId:'a'}:{draftText:'Proceed.'}),...(fixture.upToOrder?{upToOrder:fixture.upToOrder}:{})},before=JSON.stringify({session,opts}),s={...settings,maxContextTokens:100000};
   assert.deepEqual(await outcome(b.optimized,session,s,opts,deps),await outcome(b.frozen,session,s,opts,deps),fixture.name+' / '+continuation);
   assert.equal(JSON.stringify({session,opts}),before);
 }
});

test('delayed candidate counting respects cancellation and source changes before assembly continues',async()=>{
 for(const abort of [false,true]){
   const use=appHarness(),{buildMemoryContext}=await use('memory-context.js'),controller=new AbortController();
   let signalStarted,release,stale=false;
   const started=new Promise(resolve=>{signalStarted=resolve;}),delay=new Promise(resolve=>{release=resolve;});
   const messages=history(80);messages[79].content='DELAYED_CANDIDATE';
   const before=JSON.stringify(messages),running=buildMemoryContext({memory:{memoryBlock:true,blockWindow:false}},{...settings,maxContextTokens:6000},{messages,draftText:'Proceed.',signal:controller.signal,check:()=>{if(stale)throw Error('Story changed');}},{...deps,count:async text=>{if(text==='DELAYED_CANDIDATE'){signalStarted();await delay;}return count(text);}});
   await started;
   if(abort)controller.abort();else stale=true;
   release();
   await assert.rejects(running,abort?{name:'AbortError'}:/Story changed/);
   assert.equal(JSON.stringify(messages),before);
 }
});

test('tokenizer recovery during candidate admission rebuilds a tight request with consistent accounting',async()=>{
 const use=appHarness(),{buildMemoryContext}=await use('memory-context.js');
 const messages=history(200);messages[199].content='RECOVER_AT_NEWEST '+messages[199].content;
 const session={memory:{memoryBlock:true,blockWindow:false}},opts={messages,draftText:'Proceed.',includeInspection:true},s={...settings,maxContextTokens:2500};
 let recovered=false;
 const recovering=await buildMemoryContext(session,s,opts,{...deps,count:async text=>{if(text.startsWith('RECOVER_AT_NEWEST '))recovered=true;return recovered?count(text):Math.ceil(text.length/8);}});
 const stable=await buildMemoryContext(session,s,opts,deps),warning='Token counts changed during context assembly; the request was rebuilt once.';
 assert.equal(recovering.report.warnings[0],warning);
 recovering.report.warnings.shift();
 assert.deepEqual(JSON.parse(JSON.stringify(recovering)),JSON.parse(JSON.stringify(stable)));
 assert.ok(recovering.usedTokens<=2500);assert.ok(recovering.droppedCount>0);
});
