import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const count=async t=>Math.ceil(t.length/4);
async function fixture(){
 const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'messages.js':{getMessages:async()=>[]}}}),l=await use('lore-lines.js'),cast=await use('director-cast.js'),states=await use('director-state.js');
 const entries=['Nera','Ada','Bea','Cora','Dara','Ena','Fara','Lysia'].map((name,i)=>{const e=l.makeEntry('characters',name);e.id='c'+i;e.sections.personality.text=name+' personality';e.sections.notes.text='PRIVATE_DETAIL_'+name;return e;});
 const before={version:1,scene:{date:'21/10/738',hour:15,location:'Class A classroom',present:entries.slice(0,7).map(e=>e.name)},event:null,decisions:[],threads:[],commitments:[]};
 const contract={version:1,action:'narrate',transition:'unchanged',objective:'Attend class',stopCondition:'Stop before the player answers',memoryIds:[],requiredMemoryIds:[],updates:{}};
 return {use,l,cast,states,entries,before,contract};
}
test('five focused NPCs plus player preserve background attendance and promote addressed classmates',async()=>{
 const h=await fixture(),turn={before:h.before,after:structuredClone(h.before),contract:h.contract};
 const a=h.cast.directorCast(turn,h.entries,{protagonist:'Nera',currentText:'I ask Fara about the lesson.',limit:5});
 assert.equal(a.focusCharacterIds.length,5);assert.equal(a.playerCharacterId,'c0');assert.equal(a.focusCharacterIds[0],'c6');assert.equal(a.backgroundNames.length,1);
 assert.deepEqual(turn.after.scene.present,h.before.scene.present);
 const background=a.backgroundNames[0],b=h.cast.directorCast(turn,h.entries,{protagonist:'Nera',currentText:'I ask '+background+' a question.',limit:5});assert.ok(b.focusedNames.includes(background));assert.deepEqual(turn.after.scene.present,h.before.scene.present);
});
test('explicit focus is validated against attendance, NPC identity and configurable limits',async()=>{
 const h=await fixture();
 const valid=h.states.parseDirectorContract(JSON.stringify({...h.contract,focusCharacterIds:['c1']}),h.before,h.entries,{protagonist:'Nera',focusLimit:3});assert.deepEqual(plain(valid.contract.memoryIds),['c1']);
 for(const ids of [['c0'],['unknown'],['c7'],['c1','c1'],['c1','c2','c3','c4']])assert.throws(()=>h.states.parseDirectorContract(JSON.stringify({...h.contract,focusCharacterIds:ids}),h.before,h.entries,{protagonist:'Nera',focusLimit:3}),/focusCharacterIds/);
 assert.equal(h.states.parseDirectorContract(JSON.stringify(h.contract),h.before,h.entries).contract.focusCharacterIds,undefined);
 assert.throws(()=>h.states.validateDirectorState({...h.before,scene:{...h.before.scene,present:Array.from({length:101},(_,i)=>'Person '+i)}}),/invalid scene/);
});
test('visiting an established NPC can update presence without losing restrictions or inventing a new entity',async()=>{
 const h=await fixture(),parsed=h.states.parseDirectorContract(JSON.stringify({...h.contract,focusCharacterIds:['c7'],transition:'completed',updates:{scene:{location:'Dispensary',present:['Nera','Lysia']}}}),h.before,h.entries,{protagonist:'Nera'});
 assert.deepEqual(plain(parsed.after.scene.present),['Nera','Lysia']);
 const blocked=h.states.parseDirectorContract(JSON.stringify({...h.contract,transition:'blocked',objective:'The supplied closure prevents entry; do not invent another route.'}),h.before,h.entries);assert.deepEqual(plain(blocked.after),h.before);
});
test('class roster hints preserve whole sourced absence exceptions and ignore ambiguous group mixtures',async()=>{
 const h=await fixture(),roster=h.l.makeEntry('facts','Class A roster');roster.id='roster';roster.sections.text.text='Class A includes Ada, Bea and Cora. Bea is absent today.';
 const mixed=h.l.makeEntry('facts','Mixed lists');mixed.sections.text.text='Class A includes Dara. Class B includes Ena.';
 const hints=h.cast.attendanceHints([...h.entries,roster,mixed],'I attend Class A activities.',h.before.scene);
 assert.equal(hints.length,1);assert.equal(hints[0].text,roster.sections.text.text);assert.deepEqual(plain(hints[0].memberIds),['c1','c2','c3']);assert.equal(hints[0].source.section,'text');
 assert.equal(h.cast.attendanceHints([...h.entries,roster],'I eat lunch.',{location:'Dining hall'}).length,0);
});
for(const records of [false,true])test(`Narrator keeps background names but omits ordinary detailed background cards in ${records?'selective':'legacy'} mode`,async()=>{
 const h=await fixture(),builder=await h.use('context-builder.js'),r=await h.use('lore-records.js');
 const contract={...h.contract,focusCharacterIds:['c1','c2','c3','c4','c5']},turn={id:'test',before:h.before,after:h.before,contract};
 const settings={narrationMode:'director',directorFocusLimit:5,maxContextTokens:60000,maxResponseTokens:2000,keepRecentMessagesAfterSummary:10};
 const session={id:'s',...(records?{loreSchemaVersion:3}:{}),directorState:h.before,memory:{scene:true,lorebooks:true,protagonist:'Nera',memoryBlock:true,books:{characters:{on:true,budget:14000,maxCards:20}}}};
 const built=await builder.buildContextForRequest(session,settings,{messages:[{id:'u',role:'user',order:1,content:'I listen to Ada.'}],loreEntries:records?h.entries.map(e=>r.reconcileRecords(e)):h.entries,directorTurn:turn,includeInspection:true});
 const text=JSON.stringify(built.apiMessages);assert.ok(text.includes('Fara'));assert.ok(!text.includes('PRIVATE_DETAIL_Fara'));assert.ok(text.includes('PRIVATE_DETAIL_Ada'));assert.ok(text.includes('backgroundNames'));assert.ok(built.report.skipped.some(e=>e.name==='Fara'&&e.reason.includes('background')));
});
test('Director index token cache invalidates changed briefs and keeps final requests within budget',async()=>{
 const h=await fixture(),api=await h.use('director-context.js');let calls=0;const counter=async t=>{calls++;return count(t);};
 const settings={directorProfileId:'d',profiles:[{id:'d',endpoint:'https://test',modelId:'test',apiKey:'offline'}],directorMaxInputTokens:20000,directorMaxOutputTokens:8192,directorRecentTurns:5},session={id:'s',memory:{protagonist:'Nera'}},messages=[{id:'u',order:1,role:'user',content:'I attend Class A activities.'}];
 const first=await api.buildDirectorContext(session,settings,messages,h.entries,h.before,{count:counter}),before=calls;
 const next=await api.buildDirectorContext(session,settings,messages,h.entries,h.before,{count:counter});assert.deepEqual(plain(next.apiMessages),plain(first.apiMessages));assert.ok(calls-before<before);
 h.entries[1].sections.personality.text='Changed identity and restriction';const changed=await api.buildDirectorContext(session,settings,messages,h.entries,h.before,{count:counter});assert.ok(JSON.stringify(changed.apiMessages).includes('Changed identity and restriction'));assert.ok(changed.usedTokens<=20000);
});
test('the previous built-in Director prompt upgrades while custom prompts and focus settings survive',async()=>{
 const {readFile}=await import('node:fs/promises'),old=await readFile(new URL('./fixtures/outgoing-prompts/director.md',import.meta.url),'utf8');
 const use=appHarness(),settings=await use('story-settings.js'),prompts=(await use('system-prompts.js')).prompts;
 const migrated=await settings.migrateStorySettings({directorSystemPrompt:old,directorFocusLimit:3});assert.equal(migrated.directorSystemPrompt,prompts.director);assert.equal(migrated.directorFocusLimit,3);
 const custom=await settings.migrateStorySettings({directorSystemPrompt:old+'\nCustom pacing.',directorFocusLimit:8});assert.equal(custom.directorSystemPrompt,old+'\nCustom pacing.');assert.equal(custom.directorFocusLimit,8);
 assert.equal(settings.defaultStorySettings().directorFocusLimit,5);assert.throws(()=>settings.explicitStorySettings({directorFocusLimit:0}),/directorFocusLimit/);
});
test('Director timings cover preparation, provider, validation and save; retries reuse the saved cast without a model call',async()=>{
 let calls=0,saved;const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'director-store.js':{getDirectorTurn:async()=>saved,savePendingDirectorTurn:async(_sid,t,source)=>(saved={...t,status:'pending',source})},'llm-client.js':{chatCompletion:async()=>{calls++;return {content:JSON.stringify({version:1,action:'narrate',transition:'unchanged',objective:'Wait in class.',stopCondition:'Before the player answers.',memoryIds:[],requiredMemoryIds:[],focusCharacterIds:['ada'],updates:{}}),finishReason:'stop',usage:{cost:.001}};}}}});
 const l=await use('lore-lines.js'),ada=l.makeEntry('characters','Ada');ada.id='ada';
 const before={version:1,scene:{date:'21/10/738',hour:15,location:'Class A',present:['Nera','Ada']},event:null,decisions:[],threads:[],commitments:[]},session={id:'s',memory:{protagonist:'Nera'},directorState:before},messages=[{id:'u',order:1,role:'user',content:'I attend class.'}],settings={directorProfileId:'d',profiles:[{id:'d',endpoint:'https://test',apiKey:'x',modelId:'test'}],directorMaxInputTokens:20000,directorMaxOutputTokens:8192,directorRecentTurns:5};
 const api=await use('director-turn.js'),turn=await api.prepareDirectorTurn(session,settings,messages,[ada]);
 for(const key of ['contextPreparationMs','providerMs','validationMs','pendingPersistenceMs'])assert.ok(turn.timings[key]>=0);
 assert.equal(turn.usage.cost,.001);const retry=await api.prepareDirectorTurn({...session,directorPending:turn.id},settings,messages,[ada]);assert.equal(calls,1);assert.deepEqual(plain(retry.cast),plain(turn.cast));
});
test('directly requested established characters reach Director control lore ahead of broad always-load cast cards',async()=>{
 const h=await fixture(),api=await h.use('director-context.js'),general=h.l.makeEntry('characters','Cast roster',{alwaysLoad:true});general.sections.notes.text='General cast material. '.repeat(400);
 const settings={directorProfileId:'d',profiles:[{id:'d',endpoint:'https://test',modelId:'test',apiKey:'offline'}],directorMaxInputTokens:20000,directorMaxOutputTokens:8192,directorRecentTurns:5};
 const built=await api.buildDirectorContext({id:'s',memory:{protagonist:'Nera',lorebooks:true,books:{characters:{on:true,budget:2000,maxCards:1}}}},settings,[{id:'u',order:1,role:'user',content:'I go visit Lysia.'}],[...h.entries,general],h.before);
 const data=JSON.parse(built.apiMessages[0].content.slice(built.apiMessages[0].content.lastIndexOf('\n\n{')+2));
 assert.ok(data.controlLore.some(e=>e.name==='Lysia'));assert.ok(data.controlLore.findIndex(e=>e.name==='Lysia')<data.controlLore.findIndex(e=>e.name==='Cast roster')||!data.controlLore.some(e=>e.name==='Cast roster'));
});

test('focus excludes the player when story settings use a character alias',async()=>{
 const h=await fixture();h.entries[0].aliases=['Player'];
 assert.throws(()=>h.states.parseDirectorContract(JSON.stringify({...h.contract,focusCharacterIds:['c0']}),h.before,h.entries,{protagonist:'Player'}),/focusCharacterIds/);
});
