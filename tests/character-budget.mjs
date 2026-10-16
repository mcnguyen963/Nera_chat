import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const count=async text=>text.length;
async function setup(){const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected history read');}},'tokenizer.js':{countTokens:count}}});return {use,l:await use('lore-lines.js'),s:await use('lore-select.js'),c:await use('character-select.js'),r:await use('lore-record-select.js'),records:await use('lore-records.js'),core:await use('character-core.js'),m:await use('memory-settings.js'),budget:await use('character-budget.js')};}
function card(h,name,importance,lines=50){const e=h.l.makeEntry('characters',name,{id:name.toLowerCase(),importance});e.sections.notes.lines=Array.from({length:lines},(_,i)=>({id:name+i,text:`${name} fact ${i}: `+'detail '.repeat(12),by:'import',turn:i+1}));return e;}
function fitters(h){return [['legacy',(cards,cap,options)=>h.s.fitBook(cards,cap,count,options)],['excerpts',(cards,cap,options)=>h.c.fitCharacters(cards,cap,count,options)],['records',(cards,cap,options)=>h.r.fitRecords(cards,cap,count,options)]];}
for(const mode of ['legacy','excerpts','records'])test(`${mode}: crowded 10k allocation retains relevant supporting facts within the total ceiling`,async()=>{
 const h=await setup(),entries=[card(h,'Core',1,160),card(h,'Major',2,100),card(h,'Minor',3),card(h,'Background',4)];
 const fit=await fitters(h).find(([name])=>name===mode)[1](entries.map(entry=>({entry,reason:'in scene'})),10000,{}),report=fit.characterBudget;
 assert.ok(fit.tokens<=10000);assert.equal(report.priority.allocation,8000);assert.equal(report.supporting.allocation,2000);
 assert.ok(report.priority.used>=7500,JSON.stringify(report));assert.ok(report.supporting.used>=1700,JSON.stringify(report));assert.equal(report.supporting.included,2);
 assert.match(fit.text,/Minor fact/);assert.match(fit.text,/Background fact/);
 assert.equal(report.tokens,await count(fit.text));assert.ok(report.priority.borrowed<=200);
});
for(const mode of ['legacy','excerpts','records'])test(`${mode}: both groups borrow unused space without changing complete source units`,async()=>{
 const h=await setup(),fit=fitters(h).find(([name])=>name===mode)[1];
 for(const smallPriority of [true,false]){
  const high=card(h,'Core',1,smallPriority?1:90),low=card(h,'Minor',3,smallPriority?90:1),cards=[{entry:high},{entry:low}];
  const result=await fit(cards,4000,{}),borrower=smallPriority?'supporting':'priority';
  assert.ok(result.characterBudget[borrower].borrowed>0);assert.ok(result.tokens<=4000);
  assert.match(result.text,/Core fact \d+/);assert.match(result.text,/Minor fact \d+/);
 }
 const all=await fit([{entry:card(h,'Core',1,1)},{entry:card(h,'Minor',3,1)}],10000,{});
 assert.equal(all.included.length,2);assert.equal(all.included.reduce((n,e)=>n+e.linesCut,0),0);
});

test('card selection protects supporting slots, shares unused slots, honors relevance and retains exemptions',async()=>{
 const h=await setup(),high=Array.from({length:12},(_,i)=>card(h,'Core'+i,1,0)),low=Array.from({length:4},(_,i)=>card(h,'Minor'+i,3,0));
 const absent=card(h,'Absent',1),pc=card(h,'Nera',3,0),always=card(h,'Always',4,0);always.alwaysLoad=true;
 const pinned=h.records.reconcileRecords(card(h,'Pinned',4,1));pinned.recordLayout.records[0].pinned=true;
 const mem=h.m.normalizeMemory({lorebooks:true,protagonist:'Nera',books:{characters:{maxCards:10}}});
 const select=(extraHigh=high,extraLow=low)=>h.s.selectEntries([...extraHigh,...extraLow,pc,always,pinned,absent],mem,'',{present:[...extraHigh,...extraLow].map(e=>e.name)},'',{records:true});
 const chosen=select().selected.characters.map(i=>i.entry);
 assert.equal(chosen.filter(e=>high.includes(e)).length,8);assert.equal(chosen.filter(e=>low.includes(e)).length,2);
 for(const exempt of [pc,always,pinned])assert.ok(chosen.includes(exempt));assert.ok(!chosen.includes(absent));
 assert.equal(select(high,low.slice(0,1)).selected.characters.filter(i=>high.includes(i.entry)).length,9);
 assert.equal(select(high.slice(0,2),low).selected.characters.length,9);
 mem.books.characters.maxCards=1;assert.equal(select().selected.characters.length,4);
});

test('equivalent scene relevance prefers Core before Major and Minor before Background; a direct mention wins a one-card limit',async()=>{
 const h=await setup(),entries=[card(h,'Abackground',4,0),card(h,'Bminor',3,0),card(h,'Cmajor',2,0),card(h,'Dcore',1,0)],mem=h.m.normalizeMemory({lorebooks:true,books:{characters:{maxCards:4}}});
 const selected=h.s.selectEntries(entries,mem,'',{present:entries.map(e=>e.name)}).selected.characters;
 assert.deepEqual(Array.from(selected,i=>i.entry.importance),[1,2,3,4]);
 mem.books.characters.maxCards=1;const current=h.s.selectEntries(entries,mem,'Bminor',null,'Dcore');assert.equal(current.selected.characters[0].entry.name,'Bminor');
});

for(const mode of ['legacy','excerpts','records'])test(`${mode}: Director-required supporting constraints can borrow beyond 20 percent`,async()=>{
 const h=await setup(),high=card(h,'Core',1,200),required=card(h,'Minor',3,0);required.sections.notes.text='REQUIRED_CONSTRAINT '+ 'whole evidence '.repeat(220);
 if(mode==='excerpts')required.coreReferences=[h.core.reviewCore(required,[h.core.coreSource(required,'notes')],['constraints'])];
 const fit=await fitters(h).find(([name])=>name===mode)[1]([{entry:high},{entry:required}],10000,{requiredIds:[required.id]});
 assert.ok(fit.characterBudget.supporting.borrowed>0);assert.match(fit.text,/REQUIRED_CONSTRAINT/);assert.ok(fit.tokens<=10000);assert.ok(fit.text.includes(required.sections.notes.text));
});

for(const mode of ['legacy','excerpts','records'])test(`${mode}: tiny budgets and oversized supporting units never truncate facts or exceed the cap`,async()=>{
 const h=await setup(),high=card(h,'Core',1,1),low=card(h,'Minor',3,0);low.sections.notes.text='INDIVISIBLE '+ 'fact '.repeat(800);
 if(mode==='excerpts')low.coreReferences=[h.core.reviewCore(low,[h.core.coreSource(low,'notes')],['constraints'])];
 const cards=[{entry:high},{entry:low}],fit=fitters(h).find(([name])=>name===mode)[1];
 for(const cap of [0,1,300]){const result=await fit(cards,cap,{});assert.ok(result.tokens<=cap);assert.doesNotMatch(result.text,/INDIVISIBLE/);}
});

test('required optional cards take precedence over pooled optional slot quotas',async()=>{
 const h=await setup(),items=[1,2,3,4].map((importance,i)=>({entry:card(h,'Card'+i,importance,0)}));
 const selected=h.budget.characterCardSlots(items,2,{requiredIds:[items[2].entry.id,items[3].entry.id]});
 assert.equal(selected.size,2);assert.ok(selected.has(items[2]));assert.ok(selected.has(items[3]));
});

test('protagonist stays in the priority group regardless of its tag',async()=>{
 const h=await setup(),pc={entry:card(h,'Nera',3,0)},minor={entry:card(h,'Minor',3,0)};
 assert.equal(h.budget.priorityCharacter(pc,'Nera'),true);assert.equal(h.budget.priorityCharacter(minor,'Nera'),false);
});

for(const mode of ['legacy','excerpts','records'])for(const narrationMode of ['classic','director'])test(`${mode} ${narrationMode}: final serialized context respects budgets, preserves supporting facts and reports the selected text`,async()=>{
 const h=await setup(),entries=[card(h,'Core',1,160),card(h,'Major',2,90),card(h,'Minor',3),card(h,'Background',4),card(h,'Absent',1,10)];
 const names=entries.slice(0,4).map(e=>e.name),messages=[{id:'u',order:1,role:'user',content:'Speak with '+names.join(', ')+'.'}];
 const state={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:names},event:null,threads:[],decisions:[],commitments:[]};
 const turn={before:state,after:state,contract:{version:1,action:'narrate',transition:'unchanged',objective:'Reply now',stopCondition:'Stop for the player',memoryIds:[],requiredMemoryIds:[],updates:{}}};
 const memory={lorebooks:true,scene:true,characterSelection:mode==='excerpts',books:{characters:{budget:10000,maxCards:10}},startingScene:'date: 21/10/738 · time: 20:00 · place: Inn · present: '+names.join(', ')};
 const settings={narrationMode,narratorSystemPrompt:'Narrate.',directorNarratorSystemPrompt:'Narrate.',maxContextTokens:50000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:4,modelId:'test'};
 const session={id:'s',memory,...(mode==='records'?{loreSchemaVersion:3}:{})};
 const options={messages,loreEntries:entries,...(narrationMode==='director'?{directorTurn:turn}:{}),requireLatestUser:true};
 const builder=await h.use('context-builder.js'),before=JSON.stringify({entries,session,messages});
 const result=await builder.buildContextForRequest(session,settings,{...options,includeInspection:true});
 const normal=await builder.buildContextForRequest(session,settings,options);
 assert.equal(JSON.stringify(result.apiMessages),JSON.stringify(normal.apiMessages));
 const report=result.report.characterBudget;assert.ok(report.tokens<=report.budget);assert.ok(report.budget<=10000);assert.ok(result.usedTokens<=settings.maxContextTokens-settings.maxResponseTokens);
 assert.ok(report.priority.used>=7000);assert.ok(report.supporting.used>=1700);assert.equal(report.supporting.included,2);
 const wire=JSON.stringify(result.apiMessages);assert.match(wire,/Minor fact/);assert.match(wire,/Background fact/);assert.doesNotMatch(wire,/Absent fact|characterBudget|allocation|protectedIds/);
 assert.equal(JSON.stringify({entries,session,messages}),before);
});

test('mixed groups count rendered joins and non-additive tokenizer boundaries against the exact total ceiling',async()=>{
 const h=await setup(),entries=[card(h,'Core',1,60),card(h,'Minor',3,50)],cards=entries.map(entry=>({entry}));
 const measure=async text=>Math.ceil(text.length/4)+(text.match(/\n\n/g)?.length ?? 0);
 for(const [mode] of fitters(h)){
  const result=mode==='legacy'?await h.s.fitBook(cards,1000,measure):mode==='excerpts'?await h.c.fitCharacters(cards,1000,measure):await h.r.fitRecords(cards,1000,measure);
  assert.equal(result.tokens,await measure(result.text));assert.equal(result.characterBudget.tokens,result.tokens);assert.ok(result.tokens<=1000);assert.ok(result.characterBudget.supporting.used>=150);
 }
});
