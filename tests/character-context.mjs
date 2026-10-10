import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';
import { promptFetch } from './prompt-files.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const settings={narratorSystemPrompt:'Narrate.',modelId:'test',endpoint:'https://mock.test',apiKey:'mock',streaming:false,maxContextTokens:10000,maxResponseTokens:500,keepRecentMessagesAfterSummary:4};
const messages=[{id:'u1',order:1,role:'user',content:'Opening story.'},{id:'a1',order:2,role:'assistant',content:'Opening reply.'},{id:'u2',order:3,role:'user',content:'Ask Mira about council authority.'}];
async function setup() {
 const calls=[];const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('unexpected read');}},'tokenizer.js':{countTokens:async t=>t.length}},globals:{fetch:async(url,opts)=>{if(!opts?.body)return promptFetch(url,opts);calls.push(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'Mock reply.'},finish_reason:'stop'}]})};}}});
 return {use,calls,builder:await use('context-builder.js'),lore:await use('lore-lines.js'),core:await use('character-core.js'),client:await use('llm-client.js')};
}
function card(h,name='Mira',id='mira') {const e=h.lore.makeEntry('characters',name,{id,alwaysLoad:true});e.sections.personality.text='Independent, careful; cannot command the council.';e.sections.appearance.text='Silver eyes.';e.sections.notes.text='Background '.repeat(120);e.coreReferences=[h.core.reviewCore(e,[h.core.coreSource(e,'personality'),h.core.coreSource(e,'appearance')])];return e;}
function story(characterSelection=true,budget=200) {return {id:'s',memory:{lorebooks:true,characterSelection,memoryBlock:true,books:{characters:{budget,maxCards:8}}}};}
test('opt-in full-fit and explicit/default disabled payloads preserve legacy bytes',async()=>{
 const h=await setup(),e=card(h),opts={messages,loreEntries:[e],includeInspection:true};
 const off=await h.builder.buildContextForRequest(story(false,5000),settings,opts),on=await h.builder.buildContextForRequest(story(true,5000),settings,opts),absent=story(false,5000);delete absent.memory.characterSelection;
 const defaults=await h.builder.buildContextForRequest(absent,settings,opts);
 assert.deepEqual(plain(on.apiMessages),plain(off.apiMessages));assert.deepEqual(plain(defaults),plain(off));assert.equal(on.usedTokens,off.usedTokens);assert.equal(off.report.characterSelection,undefined);
});
test('eight cores integrate within book and final request ceilings, preserving allocation and conversation',async()=>{
 const h=await setup(),entries=Array.from({length:8},(_,i)=>card(h,'Character '+i,'c'+i));
 const fact=h.lore.makeEntry('facts','Law');fact.sections.text.text='WORLD_PRIORITY';const event=h.lore.makeEntry('events','Timeline',{kind:'timeline'});event.sections.text.text='EVENT_PRIORITY';const location=h.lore.makeEntry('locations','Inn',{alwaysLoad:true});location.sections.description.text='LOCATION_DETAIL';entries.push(fact,event,location);
 const s=story(true,1150),before=JSON.stringify({s,entries,messages});const built=await h.builder.buildContextForRequest(s,settings,{messages,loreEntries:entries,includeInspection:true});
 assert.equal(built.report.characterSelection.characters.length,8);assert.ok(built.report.characterSelection.characters.every(c=>Object.values(c.coreCoverage).every(Boolean)));assert.equal(built.report.loaded.filter(c=>c.book==='characters').length,8);
 assert.ok(built.usedTokens<=settings.maxContextTokens);assert.ok(built.report.characterSelection.budget<1150);
 const wire=built.apiMessages.map(m=>m.content).join('\n');assert.ok(wire.indexOf('WORLD_PRIORITY')<wire.indexOf('EVENT_PRIORITY'));assert.ok(wire.indexOf('EVENT_PRIORITY')<wire.indexOf('Character 0'));assert.ok(wire.indexOf('Character 0')<wire.indexOf('LOCATION_DETAIL'));
 for(const m of messages)assert.ok(wire.includes(m.content));assert.equal(JSON.stringify({s,entries,messages}),before);assert.equal(h.calls.length,0);
 const tight=await h.builder.buildContextForRequest(s,{...settings,maxContextTokens:built.usedTokens-650},{messages,loreEntries:entries});assert.ok(tight.usedTokens<=built.usedTokens-650);assert.ok(tight.report.characterSelection.characters.some(c=>c.missingCoverage.length));for(const m of messages)assert.ok(tight.apiMessages.some(n=>n.content.includes(m.content)));
});
test('matching and core references cannot bypass stale evidence or regeneration cutoffs',async()=>{
 const h=await setup(),e=card(h);e.sections.notes.lines=[{id:'old',text:'COUNCIL_SECRET council authority.',by:'auto',turn:1,src:2,evidence:[{id:'a1',order:2,revision:0}]},{id:'future',text:'FUTURE_SECRET council authority.',by:'auto',turn:2,src:4,evidence:[{id:'a2',order:4,revision:0}]}];
 Object.assign(e.sections.status,{text:'SNAPSHOT_SECRET council authority.',kind:'snapshot',cutoff:{order:4,turn:2}});
 e.coreReferences=[h.core.reviewCore(e,[h.core.coreSource(e,'notes','old'),h.core.coreSource(e,'notes','future'),h.core.coreSource(e,'status')],['constraints'])];
 const history=[messages[0],{...messages[1],revision:1},messages[2],{id:'a2',order:4,role:'assistant',revision:0,content:'Later scene.'}],built=await h.builder.buildContextForRequest(story(true,2500),settings,{messages:history,loreEntries:[e],upToOrder:4,includeInspection:true});
 const wire=JSON.stringify(built.apiMessages);assert.doesNotMatch(wire,/COUNCIL_SECRET|FUTURE_SECRET|SNAPSHOT_SECRET/);assert.equal(built.report.characterSelection.characters[0].invalidCores.length,1);assert.equal(built.report.skipped.filter(s=>s.text?.includes('SECRET')).length,3);
});
test('future trajectories keep conditional wording; closed events stay closed; serialized reports add no calls or metadata',async()=>{
 const h=await setup(),e=card(h);e.sections.notes.lines=[{id:'plan',text:'If invited next winter, she may study at the academy; she has not enrolled.',by:'import',turn:2,when:'Day 2'},{id:'knowledge',text:'She does not know the secret and cannot control independent council members.',by:'user',turn:1}];
 const closed=h.lore.makeEntry('events','Missing letter',{kind:'thread',status:'closed'});closed.sections.text.text='The letter was found.';
 const input=[...messages,{id:'u3',order:5,role:'user',content:'Mira academy winter invitation secret council Missing letter'}],built=await h.builder.buildContextForRequest(story(true,400),settings,{messages:input,loreEntries:[e,closed],includeInspection:true});
 const wire=built.apiMessages.map(m=>m.content).join('\n');assert.match(wire,/If invited next winter, she may study at the academy; she has not enrolled\./);assert.match(wire,/does not know the secret and cannot control independent/);assert.match(wire,/Closed threads \(resolved; do not reopen without new story evidence\):[\s\S]*Missing letter/);assert.equal(h.calls.length,0);
 let captured;await h.client.chatCompletion({settings,messages:built.apiMessages,onRequest:serialized=>{captured=structuredClone({requestBody:JSON.parse(serialized),report:built.report});}});
 assert.equal(h.calls.length,1);assert.deepEqual(captured.requestBody,JSON.parse(h.calls[0]));assert.doesNotMatch(h.calls[0],/coreReferences|currentMatches|selectionReport|fingerprint|missingCoverage/);
 for(const c of captured.report.characterSelection.characters)if(c.text)assert.ok(h.calls[0].includes(JSON.stringify(c.text).slice(1,-1)));
 const saved=JSON.stringify(captured);built.report.characterSelection.characters[0].text='changed preview';await h.builder.buildContextForRequest(story(true,0),settings,{messages:input,loreEntries:[e]});assert.equal(JSON.stringify(captured),saved);assert.equal(h.calls.length,1);
});
