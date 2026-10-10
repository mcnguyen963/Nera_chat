import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
const frozen=await readFile(new URL('./fixtures/mobile-context/memory-context.js',import.meta.url),'utf8');
const count=async text=>Math.ceil(text.length/4)+(text.match(/\n\n/g)?.length ?? 0);
async function builders(){
  const current=appHarness(),before=appHarness({sources:{'memory-context.js':frozen}});
  return {optimized:(await current('memory-context.js')).buildMemoryContext,frozen:(await before('memory-context.js')).buildMemoryContext,makeEntry:(await current('lore-lines.js')).makeEntry};
}
const history=n=>Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:(i%5===0?'<OOC>note</OOC> ':'')+'Story '+i+' '+('varied text. '.repeat(i%7+1)),...(i%2?{scene:'date: Day 1 · time: night · place: Inn · present: Mira',planThread:'Preserve the map.'}:{})}));
const settings={narratorSystemPrompt:'Narrate.',maxResponseTokens:100,keepRecentMessagesAfterSummary:5};
const deps={count,adRule:'Author directives.',normalizeAd:s=>s};
async function outcome(build,session,settings,opts,deps){try{return JSON.parse(JSON.stringify(await build(session,settings,opts,deps)));}catch(e){return {error:e.message};}}
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
