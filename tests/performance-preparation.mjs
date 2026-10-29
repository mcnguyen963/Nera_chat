import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';

const plain=value=>JSON.parse(JSON.stringify(value,(_key,v)=>Object.prototype.toString.call(v)==='[object Map]'?[...v]:v));
const history=n=>Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,narratorTurn:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:'A quiet harbor.',acceptance:'accepted'}));
test('memory range, status and upcoming timing preserve 480 baseline outcomes',async()=>{
  const source=await readFile(new URL('./fixtures/performance/turns.js',import.meta.url),'utf8');
  const baseline=await appHarness({sources:{'turns.js':source}})('turns.js'),current=await appHarness()('turns.js');
  let seed=20261027,cases=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<160;i++){
    const messages=history(2+Math.floor(random()*70));
    for(const message of messages){message.acceptance=['accepted','pending','rejected',undefined][Math.floor(random()*4)];if(random()<.08)message.directorIncomplete=true;if(random()<.06)message.role='summary';}
    if(i%7===0)messages.push({...messages[0],order:messages.length+1,acceptance:'pending'});
    const ms={extractedThroughOrder:i%11===0?null:Math.floor(random()*messages.length)};
    const mem={scene:i%3!==0,lagTurns:Math.floor(random()*5),batchTurns:1+Math.floor(random()*8)},opts={manual:i%4===0},before=plain(messages);
    for(const fn of ['dueRange','dueRangeStatus','memoryUpdateTiming']){assert.deepEqual(plain(current[fn](messages,ms,mem,opts)),plain(baseline[fn](messages,ms,mem,opts)),fn+' '+i);cases++;}
    assert.deepEqual(plain(messages),before);
  }
  assert.equal(cases,480);
});

test('memory eligibility scales with history size and observes mutations between calls',async()=>{
  const api=await appHarness()('turns.js'),mem={scene:true,lagTurns:2,batchTurns:5},counts=[];
  for(const n of [100,1000]){
    let reads=0;const messages=history(n).map(m=>new Proxy(m,{get(target,key){if(['id','role','order'].includes(key))reads++;return target[key];}}));
    assert.ok(api.dueRangeStatus(messages,{extractedThroughOrder:0},mem).range);counts.push(reads);
  }
  assert.ok(counts[1]<counts[0]*12,JSON.stringify(counts));
  const messages=history(10);messages[1].directorIncomplete=true;
  assert.deepEqual(plain(api.dueRangeStatus(messages,{extractedThroughOrder:0},mem)),{reason:'pending',turn:1});
  messages[1].directorIncomplete=false;
  assert.ok(api.dueRangeStatus(messages,{extractedThroughOrder:0},{...mem,batchTurns:2}).range);
});

test('sync and cooperative selection retain baseline ranking, overlaps and mutable-index behavior',async()=>{
  const source=await readFile(new URL('./fixtures/performance/lore-select.js',import.meta.url),'utf8');
  const baseline=await appHarness({sources:{'lore-select.js':source}})('lore-select.js'),use=appHarness(),select=await use('lore-select.js'),lines=await use('lore-lines.js'),memory=await use('memory-settings.js');
  const cards=[['characters','Míra Vale'],['characters','Old Tom'],['characters','Tom Stone'],['characters','Will Rose'],['locations','Silver Hall'],['locations','Hall'],['facts','C++ law'],['events','Lost Seal']].map(([book,name],i)=>lines.makeEntry(book,name,{id:'c'+i,...(book==='events'?{kind:'thread',status:'closed'}:{})}));
  cards[0].aliases=['雪の姫',"Míra’s friend"];cards[1].aliases=['Old\tTom'];cards[4].aliases=['Silver (Hall)'];
  const mem=memory.normalizeMemory({lorebooks:true,books:{characters:{maxCards:2},locations:{maxCards:1}}});
  let yields=0,time=0;
  for(let i=0;i<36;i++){
    const entries=i%2?[...cards].reverse():cards,scene=i%3?{present:['Míra Vale'],place:'Silver Hall',raw:'C++ law'}:null;
    const sources={current:[{id:'current',order:10,role:'user',content:i%2?'Old Tom, Míra Vale, 雪の姫':'Will meets will. Silver (Hall) C++ law'}],recent:[{id:'recent',order:10,role:'assistant',content:'Old\tTom and Míra Vale visit Silver\nHall. Lost Seal.'}],...(i%4===0?{startingScene:{present:['Old Tom']},directorRequiredIds:['c1'],directorMemoryIds:['c4']}:{})};
    const before=plain({entries,sources}),expected=plain(baseline.selectEntries(entries,mem,'',scene,'',sources));
    assert.deepEqual(plain(select.selectEntries(entries,mem,'',scene,'',sources)),expected);
    assert.deepEqual(plain(await select.selectEntriesAsync(entries,mem,'',scene,'',sources,{now:()=>time++,yieldTask:async()=>{yields++;}})),expected);
    assert.deepEqual(plain({entries,sources}),before);
  }
  assert.ok(yields>0);
  const index=select.buildLoreIndex(cards);
  index.characters.splice(0,index.characters.length,{entryId:'new',term:'Nera',normTerm:'nera',firstName:false});
  assert.deepEqual(plain(select.findMentions('Nera meets Míra',index,'characters')),['new']);
  cards[0].name='Nera Solenne';cards[0].aliases=['Silver Captain'];
  assert.deepEqual(plain(await select.selectEntriesAsync(cards,mem,'Silver Captain',null)),plain(baseline.selectEntries(cards,mem,'Silver Captain',null)));
});

test('cooperative matching cancels at a real task boundary without sharing iterators between requests',async()=>{
  const use=appHarness(),select=await use('lore-select.js'),lines=await use('lore-lines.js'),memory=await use('memory-settings.js');
  const entries=Array.from({length:120},(_,i)=>lines.makeEntry('characters','Character'+i+' Vale',{id:'c'+i})),mem=memory.normalizeMemory({lorebooks:true});
  const text='Character1 Vale visits Character11 Vale.';
  const expected=plain(select.selectEntries(entries,mem,text,null)),controller=new AbortController();
  let time=0,yields=0;
  await assert.rejects(select.selectEntriesAsync(entries,mem,text,null,'',{}, {signal:controller.signal,now:()=>time++,yieldTask:async()=>{yields++;controller.abort();}}),{name:'AbortError'});
  assert.equal(yields,1);
  const outcomes=await Promise.all([1,2,3].map(()=>select.selectEntriesAsync(entries,mem,text,null,'',{}, {now:()=>time++,yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0))})));
  for(const outcome of outcomes)assert.deepEqual(plain(outcome),expected);
  await assert.rejects(select.selectEntriesAsync(entries,mem,text,null,'',{}, {check:()=>{throw new Error('Stale story');}}),/Stale story/);
});

test('compiled matcher reuse is bounded and ignores stale term membership',async()=>{
  let compilations=0;
  function CountedRegExp(...args){compilations++;return new RegExp(...args);}
  const select=await appHarness({globals:{RegExp:CountedRegExp}})('lore-select.js');
  const term=name=>({entryId:name,term:name,normTerm:name,firstName:false}),index={characters:[term('first')]};
  select.findMentions('first',index,'characters');const first=compilations;
  select.findMentions('first',index,'characters');assert.equal(compilations,first);
  index.characters=Array.from({length:4100},(_,i)=>term('unused'+i));select.findMentions('',index,'characters');
  assert.equal(compilations,first,'empty text does not compile unused terms');
  for(const item of index.characters)select.findMentions(item.term,{characters:[item]},'characters');
  const full=compilations;index.characters=[term('first')];
  assert.deepEqual(plain(select.findMentions('first',index,'characters')),['first']);assert.equal(compilations,full+1,'old patterns are evicted');
});

test('cold matching compiles only possible ASCII terms and retains Unicode fallback',async()=>{
  let compilations=0;
  function CountedRegExp(...args){compilations++;return new RegExp(...args);}
  const select=await appHarness({globals:{RegExp:CountedRegExp}})('lore-select.js');
  compilations=0;
  const terms=['silver hall','kael sol','mira vale','雪の姫'].map((name,i)=>({entryId:String(i),term:name,normTerm:name,firstName:false}));
  const index={characters:terms};
  assert.deepEqual(plain(select.findMentions('Silver Hall',index,'characters')),['0']);
  assert.equal(compilations,2,'the ASCII match and non-ASCII term need regex matching');
  assert.deepEqual(plain(select.findMentions('ſilver hall',index,'characters')),['0']);
  assert.equal(compilations,4,'Unicode case folding uses the full matcher path');
  const empty={characters:[{entryId:'empty',term:'',normTerm:'',firstName:false}]};
  assert.deepEqual(plain(select.findMentionOccurrences('',empty,'characters')),[{id:'empty',start:0,end:0}]);
});

test('negative-match shortcuts preserve Unicode case folds, punctuation and whitespace',async()=>{
  const source=await readFile(new URL('./fixtures/performance/lore-select.js',import.meta.url),'utf8');
  const baseline=await appHarness({sources:{'lore-select.js':source}})('lore-select.js'),use=appHarness(),select=await use('lore-select.js'),{makeEntry}=await use('lore-lines.js');
  const cards=['Silver Hall','Kael Sol','C++ law',"Mira's friend",'A.B [C]'].map((name,i)=>makeEntry('facts',name,{id:'c'+i}));
  const index=select.buildLoreIndex(cards),reference=baseline.buildLoreIndex(cards);
  for(const text of ['ſilver hall','Kael Sol','SILVER\n\tHALL','C++ law · Kael Sol','Mira’s friend — A.B [C]','雪の姫 🌙 Silver Hall','Nothing is here.','Silver·Hall','A.B\u00a0[C]'])
    assert.deepEqual(plain(select.findMentionOccurrences(text,index,'facts')),plain(baseline.findMentionOccurrences(text,reference,'facts')),text);
});
