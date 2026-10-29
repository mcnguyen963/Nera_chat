import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';

const plain=value=>JSON.parse(JSON.stringify(value,(_key,v)=>Object.prototype.toString.call(v)==='[object Map]'?[...v]:v));
const history=n=>Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,narratorTurn:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:i%2?'Story <scene>secret</scene>':'Action <ad> remember this </ad>',acceptance:'accepted',scene:i%2?'Day 1 · night · Inn · present: Mira':null}));

async function versions() {
  const source=await readFile(new URL('./fixtures/performance/turns.js',import.meta.url),'utf8');
  // The reference formatter still performs its original lookups and builds its own timeline.
  const reference=source+'\nexport function prepareTranscriptContext(messages) { return {timeline:sceneTimeline(messages)}; }\n';
  return [appHarness({sources:{'turns.js':reference}}),appHarness()];
}

test('transcript formatting preserves the original result for ranges, duplicate IDs and scene states',async()=>{
  const [beforeUse,afterUse]=await versions(),before=await beforeUse('turns.js'),after=await afterUse('turns.js');
  for(let i=0;i<80;i++){
    const messages=history(8+i);
    messages[0].role=i%3===0?'summary':messages[0].role;
    messages[1].acceptance=['accepted','pending','rejected'][i%3];
    messages[1].sceneCandidate={scene:'Day 2 · night · Tower · present: Mira'};
    if(i%2===0)messages[3].id=messages[1].id;
    if(i%5===0)messages[5].narratorTurn=messages[3].narratorTurn;
    if(i%7===0)messages[2].id=undefined;
    if(i%11===0)messages[4].narratorTurn=NaN;
    if(i%13===0)messages[6].id=NaN;
    messages.reverse();
    const turns=after.computeTurns(messages),context=after.prepareTranscriptContext(messages,turns);
    for(const opts of [{},{title:'Export',protagonist:'Nera'},{range:{messages:messages.slice(2,-1)}}]){
      const expected=before.formatTurnsTranscript(messages,turns,opts);
      assert.equal(after.formatTurnsTranscript(messages,turns,opts),expected,'fresh context '+i);
      assert.equal(after.formatTurnsTranscript(messages,turns,{...opts,context}),expected,'reused context '+i);
    }
  }
  const messages=history(4);messages[1].scene='Day 1 · night · Inn · present: Mira';
  const beforeEdit=after.formatTurnsTranscript(messages);
  messages[1].scene='Day 2 · morning · Tower · present: Mira';
  assert.notEqual(after.formatTurnsTranscript(messages),beforeEdit,'a new call observes edits');
  const legacy=[{order:1,role:'assistant',content:'Legacy',scene:'Day 1 · night · Inn · present: Mira'},
    {id:'known',order:2,role:'user',content:'Known'}];
  const customTurns={turnById:new Map([['known',99]]),assistants:[]};
  const range={messages:[{id:'unknown',order:3,role:'user',content:'External'}]};
  assert.equal(after.formatTurnsTranscript(legacy,customTurns,{range}),before.formatTurnsTranscript(legacy,customTurns,{range}),
    'a missing assistant turn still resolves the first undefined ID');
});

test('full transcript lookups scale linearly with history length',async()=>{
  const [,use]=await versions(),turns=await use('turns.js'),reads=[];
  for(const size of [100,1000]){
    let count=0;
    const messages=history(size).map(m=>new Proxy(m,{get(target,key){if(key==='id')count++;return target[key];}}));
    turns.formatTurnsTranscript(messages);
    reads.push(count);
  }
  assert.ok(reads[1]<reads[0]*12,JSON.stringify(reads));
});

test('memory extraction keeps complete request and fitted range with shared transcript context',async()=>{
  const [beforeUse,afterUse]=await versions();
  const before=await beforeUse('memory-prompts.js'),after=await afterUse('memory-prompts.js');
  const turnApi=await afterUse('turns.js'),memory=await afterUse('memory-settings.js'),lore=await afterUse('lore-lines.js');
  const messages=history(30),mem=memory.normalizeMemory({batchTurns:10,lagTurns:0,updateMaxTokens:256,protagonist:'Nera'});
  messages[5].acceptance='pending';messages[7].directorIncomplete=true;
  const turns=turnApi.computeTurns(messages),range={messages,assistants:turns.assistants,fromTurn:1,toTurn:15};
  const entry=lore.makeEntry('characters','Mira');entry.sections.notes.text='Known canon.';
  const count=async text=>Math.ceil(text.length/4);
  for(const maxContextTokens of [4000,6000,15000]){
    const input={settings:{maxContextTokens,maxResponseTokens:256,memoryExtractionPrompt:'Extract.'},mem,entries:[entry],messages,range,count};
    const expected=await before.buildExtractionMessages(input),actual=await after.buildExtractionMessages(input);
    assert.deepEqual(plain(actual),plain(expected),'budget '+maxContextTokens);
  }
});
