import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
const count=async text=>Math.ceil(text.length/4),plain=x=>JSON.parse(JSON.stringify(x));
async function setup({records=false,limit=30000,bookBudget=2200}={}) {
 const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'messages.js':{getMessages:async()=>{throw Error('Unexpected storage read');}}}});
 const lore=await use('lore-lines.js'),settingsApi=await use('story-settings.js'),state=await use('director-state.js');
 const entry=(book,id,name,text)=>{const e=lore.makeEntry(book,name);e.id=id;Object.values(e.sections)[0].text=text;return e;};
 let entries=[entry('characters','pc','Nera','Only the user controls Nera.'),entry('characters','depart','Dara Vale','Reserved, with a dry voice. Dara knows the letter was lost, but does not know who took it.'),entry('characters','arrive','Lysia Solenne','Patient and precise. Lysia has not heard about the lost letter.'),entry('locations','inn','Stone Inn','Stone Inn has a narrow doorway. Dara remains here.'),entry('locations','clinic','Crownspire infirmary','A quiet infirmary. Arrival does not authorize registration.'),entry('facts','rule','Travel conditions','The clinic is one hour away. A fee has not been established; no fee cannot be inferred.')];
 entries[1].aliases=['Dara'];
 if(records){const api=await use('lore-records.js');entries=entries.map(e=>api.reconcileRecords(e));}
 const before={version:1,scene:{date:'21/10/738',hour:20,location:'Stone Inn',present:['Nera','Dara']},event:null,decisions:[],threads:[],commitments:[]};
 const raw={version:1,action:'narrate',transition:'completed',objective:'Walk to the clinic and stop at arrival.',stopCondition:'Arrival, before any greeting or registration.',memoryIds:['clinic'],requiredMemoryIds:[],updates:{scene:{hour:21,location:'Crownspire infirmary',present:['Nera','Lysia Solenne']}}};
 const turn={id:'t',before,...state.parseDirectorContract(JSON.stringify(raw),before,entries),playerBoundary:{kind:'arrival',instruction:'Stop when we arrive'}};
 const settings={...settingsApi.defaultStorySettings(),narrationMode:'director',maxContextTokens:limit,maxResponseTokens:8192,keepRecentMessagesAfterSummary:4};
 const session={id:'s',loreSchemaVersion:records?3:2,memory:{scene:true,lorebooks:true,protagonist:'Nera',memoryBlock:true,books:{characters:{budget:bookBudget,maxCards:8},locations:{budget:bookBudget,maxCards:8},facts:{budget:bookBudget}}}};
 const messages=[{id:'u1',order:1,role:'user',content:'I talk with Dara at Stone Inn.'},{id:'a1',order:2,role:'assistant',content:'Dara waits at the narrow doorway.'},{id:'u2',order:3,role:'user',content:'I walk to Crownspire infirmary. Stop when we arrive.'}];
 const builder=await use('context-builder.js');
 const build=(extra={})=>builder.buildContextForRequest(session,settings,{messages,loreEntries:entries,directorTurn:turn,includeInspection:true,...extra});
 return {use,entries,settings,session,messages,turn,build,settingsApi};
}
test('Both built-in narrator modes share the reviewed foundation and Director delegates state authority',async()=>{
 const {prompts}=await appHarness()('system-prompts.js');
 assert.match(prompts.narrator,/NO MANUFACTURED TENSION OR THREADS/);assert.match(prompts.directorNarratorDefault,/NO MANUFACTURED TENSION OR THREADS/);
 assert.doesNotMatch(prompts.directorNarratorDefault,/Rebuild the current state|chat wins|scene tag is the only state/);
 assert.match(prompts.directorNarratorDefault,/Read the current contract/);
 assert.doesNotMatch(prompts.directorNarratorDefault,/\{\{[A-Z_]+\}\}/);
});
test('Old custom prompts migrate unchanged with a review flag and new fields survive filtering and conflicts',async()=>{
 const api=await appHarness()('story-settings.js'),old={narratorSystemPrompt:'CUSTOM state rules and writing style'};
 const migrated=await api.migrateStorySettings(old);assert.equal(migrated.directorNarratorSystemPrompt,old.narratorSystemPrompt);assert.equal(migrated.narratorSystemPrompt,old.narratorSystemPrompt);assert.equal(migrated.directorNarratorPromptNeedsReview,true);
 const current={...migrated,directorNarratorSystemPrompt:'REMOTE'};
 assert.throws(()=>api.mergeStorySettings(current,migrated,{directorNarratorSystemPrompt:'LOCAL'}),/another device/);
 assert.equal(api.mergeStorySettings(current,current,{directorNarratorPromptNeedsReview:false}).directorNarratorPromptNeedsReview,false);
 assert.deepEqual(plain(api.pickStorySettings({...migrated,apiKey:'secret'})),plain(migrated));
 const defaults=await api.migrateStorySettings({narratorSystemPrompt:api.defaultStorySettings().narratorSystemPrompt});assert.equal(defaults.directorNarratorPromptNeedsReview,false);
});
for(const records of [false,true])test('Both scenes contribute lore while the brief preserves exact passages once ('+records+')',async()=>{
 const h=await setup({records}),before=JSON.stringify({entries:h.entries,turn:h.turn,messages:h.messages}),built=await h.build();
 const loaded=new Set(built.report.loaded.map(e=>e.entryId));for(const id of ['pc','depart','arrive','inn','clinic'])assert.ok(loaded.has(id),id);
 assert.deepEqual(plain(built.report.scene.present),['Nera','Lysia Solenne']);assert.equal(built.report.scene.place,'Crownspire infirmary');
 const i=built.apiMessages.findIndex(m=>m.content.startsWith('[Reply brief'));assert.equal(built.apiMessages[i+1].role,'user');assert.ok(built.apiMessages[i+1].content.includes('Stop when we arrive'));
 const brief=built.report.replyBrief;assert.equal(brief.text,built.inspection.sections.replyBrief);assert.equal(built.apiMessages[i].content,brief.text);assert.ok(brief.loreTokens<=1500);assert.ok(brief.sources.length);
 const request=built.apiMessages.map(m=>m.content).join('\n');for(const src of brief.sources){assert.equal(request.split(src.text).length-1,1,src.name);assert.ok(h.entries.some(e=>e.id===src.entryId));}
 assert.ok(request.includes('does not know who took it'));assert.ok(request.includes('A fee has not been established'));
 assert.equal(before,JSON.stringify({entries:h.entries,turn:h.turn,messages:h.messages}));
 const uninspected=await h.build({includeInspection:false});assert.deepEqual(plain(uninspected.apiMessages),plain(built.apiMessages));assert.equal(uninspected.usedTokens,built.usedTokens);
 const actual=8+(await Promise.all(built.apiMessages.map(async m=>8+await count(m.content)))).reduce((a,b)=>a+b,0);assert.equal(actual,built.usedTokens);
});
test('Large fitted source units stay in normal memory and brief omissions explain why',async()=>{
 const h=await setup({bookBudget:9000});h.entries[1].sections.personality.text='Dara never knows the thief’s identity. '+('Dara remembers the road. '.repeat(350));
 const built=await h.build();assert.ok(built.report.replyBrief.omitted.some(e=>e.entryId==='depart'&&e.reason.includes('brief limit')));
 const request=built.apiMessages.map(m=>m.content).join('\n');assert.ok(request.includes(h.entries[1].sections.personality.text));assert.ok(!built.report.replyBrief.sources.some(e=>e.entryId==='depart'));
});
test('Required contract survives tiny lore budgets, while disabled required books still fail',async()=>{
 const h=await setup({bookBudget:20}),built=await h.build();assert.ok(built.report.replyBrief.text.includes('targetState'));assert.equal(built.report.replyBrief.sources.length,0);
 h.turn.contract.requiredMemoryIds=['clinic'];h.session.memory.books.locations.on=false;
 await assert.rejects(h.build(),/required Director memory book is disabled/);
});
test('Card limits prefer required and arrival cards before departure or ordinary matches',async()=>{
 const h=await setup();h.session.memory.books.characters.maxCards=1;h.turn.contract.memoryIds=['depart'];h.turn.contract.requiredMemoryIds=['depart'];
 const built=await h.build(),ids=built.report.loaded.filter(e=>e.book==='characters').map(e=>e.entryId);assert.ok(ids.includes('pc'));assert.ok(ids.includes('depart'));assert.ok(!ids.includes('arrive'));
 assert.ok(built.report.skipped.some(e=>e.entryId==='arrive' && /card limit/.test(e.reason)));
});
test('Blocked travel keeps destination cards relevant without inventing final presence',async()=>{
 const h=await setup();h.turn.after=structuredClone(h.turn.before);h.turn.contract.transition='blocked';h.turn.contract.memoryIds=['clinic','arrive'];h.turn.contract.updates={};
 const built=await h.build();assert.deepEqual(plain(built.report.scene.present),['Nera','Dara']);assert.equal(built.report.scene.place,'Stone Inn');assert.ok(built.report.loaded.some(e=>e.entryId==='clinic'));
});
test('Continuation brief uses the original action source and the same Director contract',async()=>{
 const h=await setup(),partial={id:'a2',order:4,role:'assistant',content:'The clinic doorway comes into view.',directorTurnId:'t',truncated:true};h.messages.push(partial);
 const built=await h.build({continuationId:'a2',requireLatestUser:true});assert.equal(built.report.replyBrief.userSource,'u2');assert.ok(built.apiMessages.at(-2).content.includes('Reply brief'));assert.ok(built.apiMessages.at(-2).content.includes('Arrival, before any greeting'));
});

test('The source guard remains mandatory after a preserved custom prompt and keeps historical player conduct qualified',async()=>{
 const h=await setup();h.settings.directorNarratorSystemPrompt='CUSTOM: make the scenery detailed; estimate state from prose.';h.settings.directorNarratorPromptNeedsReview=true;
 const built=await h.build(),system=built.apiMessages[0].content;
 assert.ok(system.startsWith('CUSTOM:'));assert.ok(system.indexOf('Treat past player conduct')>system.indexOf('CUSTOM:'));
 assert.ok(system.includes('must not establish invented past player dialogue'));assert.ok(system.includes('do not invent a specific cause'));
 assert.ok(built.report.warnings.some(w=>w.includes('custom Director-mode Narrator instructions need review')));
 const known=built.apiMessages.map(m=>m.content).join('\n');assert.ok(known.includes('does not know who took it'));assert.ok(known.includes('Arrival, before any greeting or registration.'));
 assert.ok(!known.includes('You asked me how the road was'));assert.ok(!known.includes('plate that has been welded'));
});

test('Unrelated selected lore stays in normal memory while current subjects and Director choices enter the brief',async()=>{
 const h=await setup();const built=await h.build();
 const brief=built.report.replyBrief;assert.ok(brief.sources.some(s=>s.entryId==='clinic'));assert.ok(brief.sources.some(s=>s.entryId==='depart'));
 assert.ok(!brief.sources.some(s=>s.entryId==='rule'));assert.ok(brief.omitted.some(s=>s.entryId==='rule'&&s.reason.includes('normal memory')));
 assert.ok(built.inspection.sections.facts.includes('A fee has not been established'));
 assert.ok(built.apiMessages.at(-2).content.includes('[Final grounding check for this reply]'));assert.equal(built.apiMessages.at(-1).role,'user');
 h.turn.contract.memoryIds.push('rule');const selected=await h.build();assert.ok(selected.report.replyBrief.sources.some(s=>s.entryId==='rule'));assert.ok(!selected.inspection.sections.facts.includes('A fee has not been established'));
});

test('Arrival outline follows only completed explicit-arrival contracts and preserves genuine interruptions',async()=>{
 const h=await setup(),built=await h.build();assert.ok(built.report.replyBrief.text.includes('[Arrival realization outline]'));assert.ok(built.report.replyBrief.text.includes('Departure from Stone Inn'));assert.ok(built.report.replyBrief.text.includes('Arrival at Crownspire infirmary'));
 h.turn.contract.transition='attempted';const interrupted=await h.build();assert.ok(!interrupted.report.replyBrief.text.includes('[Arrival realization outline]'));assert.ok(interrupted.report.replyBrief.text.includes('Director contract:'));
});

test('Director review catches past player claims inside NPC dialogue while preserving explicit current actions and uncertain interpretations',async()=>{
 const api=await appHarness()('turn-review.js');
 for(const text of ['Dara says, "You looked at me across this table and decided I could be kept in the dark."','Dara says, “You said that two days ago.”'])assert.equal(api.lintDirectorHistory(text,{userText:'I apologize.'}).length,1);
 assert.equal(api.lintDirectorHistory('Dara says, "You put your hand on the bars."',{userText:'I put my hand on the bars.'}).length,0);
 assert.equal(api.lintDirectorHistory('Dara says, "It felt like you decided I could not handle the news."',{userText:'I apologize.'}).length,0);
 assert.equal(api.lintDirectorHistory('Dara says, "I am still hurt that you concealed the letter for two days."').length,0);
 assert.equal(api.lintPlayerAgency('Dara says, "You looked at me across this table."','Nera').length,0);
});
test('Director review flags an implicit player response after a new NPC request without treating a request alone as compliance',async()=>{
 const api=await appHarness()('turn-review.js');
 const captured='"Say it back to me the way you would say it if I were a clerk," she says. She listens while you put both appointments in order. When you finish she nods.';
 assert.equal(api.lintDirectorResponseBoundary(captured).length,1);
 assert.equal(api.lintDirectorResponseBoundary('“Tell me,” she says. You answer her and she nods.').length,1);
 assert.equal(api.lintDirectorResponseBoundary('“Tell me,” she says, and waits for your answer.').length,0);
 assert.equal(api.lintDirectorResponseBoundary('“I asked you here today. Tomorrow is separate,” she says. She waits.').length,0);
 assert.equal(api.lintDirectorResponseBoundary('She reads the page. “You answer the clerk tomorrow,” she says.').length,0);
});
