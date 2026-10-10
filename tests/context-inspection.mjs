import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const settings={narratorSystemPrompt:'Narrate this world.',maxContextTokens:100000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:4};
const scene='date: Day 1 · time: night · place: Inn · present: Mira';
const messages=[
  {id:'u1',order:1,role:'user',content:'Begin with Mira.'},
  {id:'a1',order:2,role:'assistant',content:'<think>HIDDEN_THINKING</think>Mira arrives.',scene},
  {id:'u2',order:3,role:'user',content:'Explore.'},
  {id:'a2',order:4,role:'assistant',content:'The inn is quiet.',scene},
  {id:'summary',order:5,role:'summary',content:'### Last established situation\n[T1] Mira arrived.',coveredRange:{toOrder:3}},
];
async function setup(){
  const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected read');}},'tokenizer.js':{countTokens:async text=>text.length}}});
  return {builder:await use('context-builder.js'),lore:await use('lore-lines.js'),client:await use('llm-client.js')};
}
for(const role of ['user','system']) test(`inspection captures fitted lore and final messages without changing ${role} memory request`,async()=>{
  const {builder,lore,client}=await setup();
  const character=lore.makeEntry('characters','Mira',{alwaysLoad:true});
  character.sections.appearance.text='Silver hair.';
  character.sections.notes.lines=Array.from({length:16},(_,i)=>({id:'note-'+i,text:`UNIQUE_NOTE_${i} `+'x'.repeat(160),turn:i+1,at:i,by:'user'}));
  const location=lore.makeEntry('locations','Inn',{alwaysLoad:true});location.sections.description.text='A stone inn.';
  const facts=lore.makeEntry('facts','Magic');facts.sections.text.text='Magic follows moonlight.';
  const timeline=lore.makeEntry('events','Timeline',{kind:'timeline'});timeline.sections.text.text='[T1] Mira reached the inn.';
  const excluded=lore.makeEntry('characters','Skipped');excluded.sections.appearance.text='SHOULD_NOT_APPEAR';
  const loreEntries=[character,location,facts,timeline,excluded];
  const session={id:'s',activeSummaryMessageId:'summary',breakpointOrder:3,memory:{scene:true,lorebooks:true,memoryBlock:true,blockRole:role,replyContract:role,books:{characters:{budget:1000,maxCards:1}}}};
  const opts={messages,loreEntries,draftText:'Ask Mira about magic.'};
  const before=JSON.stringify({session,messages,loreEntries});
  const plain=await builder.buildContextForRequest(session,settings,opts);
  const inspected=await builder.buildContextForRequest(session,settings,{...opts,includeInspection:true});
  assert.equal(plain.inspection,undefined);
  assert.equal(JSON.stringify(inspected.apiMessages),JSON.stringify(plain.apiMessages));
  assert.equal(inspected.usedTokens,plain.usedTokens);
  assert.equal(JSON.stringify(inspected.report),JSON.stringify(plain.report));
  assert.equal(JSON.stringify(client.buildRequestBody(settings,inspected.apiMessages)),JSON.stringify(client.buildRequestBody(settings,plain.apiMessages)));
  assert.equal(JSON.stringify({session,messages,loreEntries}),before);
  const wire=inspected.apiMessages.map(m=>m.content).join('\n\n'),parts=inspected.inspection.sections;
  for(const text of Object.values(parts)) if(text) assert.ok(wire.includes(text),`Preview must be a rendered request fragment: ${text.slice(0,60)}`);
  assert.match(parts.characters,/Silver hair/);assert.match(parts.locations,/stone inn/);
  assert.match(parts.facts,/Magic follows moonlight/);assert.match(parts.events,/Mira reached the inn/);
  assert.match(parts.summary,/Situation at the summary cutoff/);
  assert.doesNotMatch(parts.events,/\[T1\]/);
  const loaded=inspected.report.loaded.find(e=>e.entryId===character.id);
  assert.ok(loaded.linesCut>0);
  for(const line of character.sections.notes.lines) assert.equal(parts.characters.includes(line.text),loaded.lineIds.includes(line.id));
  assert.doesNotMatch(wire,/HIDDEN_THINKING|SHOULD_NOT_APPEAR/);
  for(const m of inspected.inspection.messages) {
    assert.equal(m.role,inspected.apiMessages[m.requestIndex].role);
    assert.equal(m.content,inspected.apiMessages[m.requestIndex].content);
  }
  assert.ok(inspected.inspection.messages.some(m=>m.source==='Composer draft'));
  assert.equal(parts.memory.startsWith('<memory>'),role==='user');
});

test('legacy inspection preserves ordering, summary, omission marker and draft without changing payload',async()=>{
  const {builder}=await setup();
  const session={id:'legacy',activeSummaryMessageId:'summary',breakpointOrder:3};
  const opts={messages,draftText:'<script>Read this literally</script>'};
  const plain=await builder.buildContextForRequest(session,settings,opts);
  const result=await builder.buildContextForRequest(session,settings,{...opts,includeInspection:true});
  assert.equal(JSON.stringify(result.apiMessages),JSON.stringify(plain.apiMessages));
  assert.equal(result.usedTokens,plain.usedTokens);
  assert.equal(result.inspection.sections.system,result.apiMessages[0].content);
  assert.match(result.inspection.sections.summary,/Mira arrived/);
  assert.ok(result.inspection.sections.gap);
  assert.equal(result.inspection.messages.at(-1).source,'Composer draft');
  for(const m of result.inspection.messages) assert.equal(m.content,result.apiMessages[m.requestIndex].content);
  assert.doesNotMatch(result.apiMessages.map(m=>m.content).join('\n'),/HIDDEN_THINKING/);
});

test('inspection excludes unsent reply directives when memory mode has no user messages',async()=>{
  const {builder}=await setup();
  const result=await builder.buildContextForRequest({id:'empty',memory:{scene:true,memoryBlock:true,replyContract:'system'}},settings,{messages:[],includeInspection:true});
  assert.equal(result.inspection.sections.replyContract,'');
  assert.equal(result.inspection.sections.reminder,'');
  assert.equal(result.inspection.messages.length,0);
  for(const text of Object.values(result.inspection.sections)) if(text) assert.ok(result.apiMessages.some(m=>m.content.includes(text)));
});
