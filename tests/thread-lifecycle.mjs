import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const appointment={kind:'appointment',dueDate:'24/10/738',dueTime:'8 AM',participants:['Lysia'],location:'Infirmary',outcome:null};
const thread={id:'date',book:'events',kind:'thread',name:'Visit Lysia',status:'open',threadMeta:appointment};
const modern={version:2,scene:{date:'24/10/738',time:'08:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
const contract=updates=>JSON.stringify({version:1,action:'narrate',transition:'unchanged',objective:'Answer now',stopCondition:'Wait for player',memoryIds:[],requiredMemoryIds:[],updates});
test('Scheduled threads expire after exactly 72 story hours, unresolved; date-only preserves the whole due day',async()=>{
 const t=await appHarness()('thread-lifecycle.js');
 assert.equal(t.normalizeThreadMeta(appointment).dueTime,'08:00');
 assert.equal(t.threadLifecycle(thread,{date:'27/10/738',time:'07:59'}).status,'open');
 assert.equal(t.threadLifecycle(thread,{date:'27/10/738',time:'08:00'}).threadMeta.outcome,'expired-unresolved');
 const day={...thread,threadMeta:{...appointment,dueTime:null}};
 assert.equal(t.threadLifecycle(day,{date:'27/10/738',time:'23:59'}).status,'open');
 assert.equal(t.threadLifecycle(day,{date:'28/10/738',time:'00:00'}).status,'closed');
 assert.equal(t.threadLifecycle(thread,{date:'27/10/738',time:null}).status,'open');
 assert.equal(t.threadLifecycle(thread,{date:'28/10/738',time:null}).status,'closed');
 assert.equal(thread.status,'open');
});
test('Unknown timing, broad goals, fixed Plan and ambiguous history never expire',async()=>{
 const t=await appHarness()('thread-lifecycle.js');const scene={date:'1/12/738',time:'20:00'};
 for(const item of [{...thread,threadMeta:null,text:'Find the missing map.'},{...thread,threadMeta:{...appointment,kind:'ongoing'}},{...thread,book:'plan'}, {...thread,threadTimingNeedsReview:true},{...thread,threadMeta:null,text:'Maybe meet on 24/10/738 at 8 AM.'},{...thread,threadMeta:null,text:'Meet on 24/10/738 or 25/10/738 at 8 AM.'}])assert.equal(t.threadLifecycle(item,scene).status,'open');
 const legacy={...thread,threadMeta:null,text:'Meet Lysia on 24/10/738 at 8 AM.'};assert.equal(t.threadLifecycle(legacy,scene).threadMeta.outcome,'expired-unresolved');
 const reopened=t.reopenThread(t.threadLifecycle(thread,scene));assert.equal(reopened.threadMeta.kind,'ongoing');assert.equal(reopened.threadMeta.dueDate,null);assert.equal(reopened.status,'open');
});
test('Director modern clocks preserve minutes, reject backwards time and keep legacy checkpoints readable',async()=>{
 const s=await appHarness()('director-state.js');
 const turn=s.parseDirectorContract(contract({scene:{time:'08:15'}}),modern);assert.equal(turn.after.scene.time,'08:15');
 assert.throws(()=>s.parseDirectorContract(contract({scene:{time:'07:59'}}),modern),/backwards/);
 const legacy={...modern,version:1,scene:{...modern.scene,hour:24}};delete legacy.scene.time;
 assert.equal(s.validateDirectorState(legacy).scene.hour,24);assert.equal(s.directorClockNeedsReview({},[],legacy),'Hour 24');
 const converted=s.modernizeDirectorState(legacy,'25/10/738','00:15');assert.equal(converted.scene.time,'00:15');assert.equal(legacy.version,1);
 const seeded=s.seedDirectorState({memory:{}},[{role:'assistant',order:1,scene:'date: 24/10/738 · time: 15:45 · place: Inn · present: Nera',sceneMeta:{kind:'manual'}}]);assert.equal(seeded.version,2);assert.equal(seeded.scene.time,'15:45');
});
test('Director archives accepted lifecycle changes and deduplicates an identical appointment',async()=>{
 const s=await appHarness()('director-state.js'),item={id:'first',text:'Visit Lysia',status:'waiting',threadMeta:appointment};
 const before={...modern,commitments:[item]};
 const duplicate=s.parseDirectorContract(contract({commitments:{upsert:[{...item,id:'second'}],close:[]}}),before);assert.equal(duplicate.after.commitments.length,1);assert.equal(duplicate.after.commitments[0].id,'first');
 const expired=s.parseDirectorContract(contract({scene:{date:'27/10/738',time:'08:00'}}),before);assert.equal(expired.after.commitments.length,0);assert.equal(expired.after.archive[0].threadMeta.outcome,'expired-unresolved');assert.equal(before.commitments.length,1);
 assert.throws(()=>s.parseDirectorContract(contract({commitments:{upsert:[{...item,threadMeta:{...appointment,outcome:'expired-unresolved'}}]}}),before),/expiry/);
 const solved=s.parseDirectorContract(contract({commitments:{close:['first']}}),before);assert.equal(solved.after.archive[0].threadMeta.outcome,'resolved');
 assert.equal(s.activeDirectorState(expired.after).archive,undefined);
});
test('Structured extraction persists metadata, rejects premature expiry and protects authored background items',async()=>{
 const use=appHarness(),l=await use('lore-lines.js');
 const history=[{id:'u',role:'user',order:1,content:'We agree to meet Lysia on 24/10/738 at 8 AM.'},{id:'a',role:'assistant',order:2,content:'Lysia confirms.',scene:'date: 24/10/738 · time: 08:00 · place: Inn · present: Nera',sceneMeta:{kind:'manual'}}];
 const text='T1 [open] Visit Lysia: '+JSON.stringify({text:'Agreed meeting.',threadMeta:appointment});
 const parsed=l.parseMemoryLines(text,{messages:history,range:{assistants:[{...history[1],turn:1}]}});assert.equal(parsed.ops.length,1,JSON.stringify(parsed));
 const applied=l.applyOps([],parsed.ops,{messages:history,session:{memory:{}},now:1});assert.equal(applied.creates[0].threadMeta.dueTime,'08:00');
 const premature=l.applyOps(applied.entries,[{...parsed.ops[0],tag:'expired'}],{messages:history,session:{memory:{}}});assert.equal(premature.statusChanges.length,0);assert.equal(premature.entries[0].status,'open');
 const authored={...applied.entries[0],createdFrom:'user'};authored.sections.text.text='Author mission.';
 const background=l.applyOps([authored],[{...parsed.ops[0],tag:'background'}],{messages:history,session:{memory:{}}});assert.equal(background.statusChanges.length,0);
});
test('Metadata survives native and scoped Markdown interchange without changing fixed Plan',async()=>{
 const use=appHarness(),l=await use('lore-lines.js'),f=await use('lore-format.js');
 const e=l.makeEntry('events','Visit Lysia',{id:'visit',kind:'thread'});e.threadMeta=appointment;e.sections.text.text='Agreed meeting.';
 const exported=f.toJson([e]);assert.ok(JSON.stringify(exported).includes('threadMeta'));
 const json=f.fromJson(exported),md=f.fromMarkdown(f.toMarkdown([e]));assert.equal(json.entries.find(e=>e.kind==='thread').threadMeta.dueTime,'08:00');assert.equal(md.entries.find(e=>e.kind==='thread').threadMeta.dueTime,'08:00');
});
test('Expiry projections re-evaluate after historical edits and never write or mutate the source',async()=>{
 const use=appHarness(),l=await use('lore-lines.js'),c=await use('continuity.js');
 const messages=[{id:'u',role:'user',order:1,revision:0,content:'Agreed.'},{id:'a',role:'assistant',order:2,revision:0,content:'Confirmed.'}];
 const e=l.makeEntry('events','Visit Lysia',{id:'visit',kind:'thread',status:'open'});e.threadMeta=appointment;
 const source={by:'auto',id:'note',text:'Agreed meeting.',src:2,evidence:c.evidenceFor(messages),sourceRevision:0};e.threadMetaSource=source;e.sections.text.lines=[source];
 const scene={date:'28/10/738',time:'09:00'};
 const raw=JSON.stringify(e),closed=c.usableLore([e],messages,{},Infinity,scene).entries[0];assert.equal(closed.threadMeta.outcome,'expired-unresolved');assert.equal(JSON.stringify(e),raw);
 const edited=messages.map(m=>m.id==='u'?{...m,revision:1}:m),review=c.usableLore([e],edited,{},Infinity,scene).entries[0];assert.equal(review.status,'open');assert.equal(review.threadMeta,null);assert.equal(review.threadTimingNeedsReview,true);
 const regenerated=c.usableLore([e],messages,{},2,scene).entries[0];assert.equal(regenerated.threadMeta,null);
});
test('Scheduled metadata persists through guarded extraction expiry and a later explicit resolution',async()=>{
 const use=appHarness(),l=await use('lore-lines.js');const e=l.makeEntry('events','Visit Lysia',{id:'visit',kind:'thread',createdFrom:'auto'});e.threadMeta=appointment;
 const history=[{id:'u',role:'user',order:1,content:'We wait.'},{id:'a',role:'assistant',order:2,content:'The next morning arrives.',scene:'date: 28/10/738 · time: 09:00 · place: Inn · present: Nera',sceneMeta:{kind:'manual'}}];
 const expired=l.applyOps([e],[],{messages:history,session:{memory:{}}});assert.equal(expired.statusChanges.length,1);assert.equal(expired.statusChanges[0].threadMeta.outcome,'expired-unresolved');assert.equal(expired.entries[0].sections.text.lines.length,1);
 const solved=l.applyOps(expired.entries,[{tag:'closed',book:'events',name:'Visit Lysia',section:'text',text:'Lysia confirms the matter was resolved.',turn:1,src:2,evidence:[{id:'a',order:2,revision:0}]}],{messages:history,session:{memory:{}}});assert.equal(solved.entries[0].threadMeta.outcome,'resolved');assert.equal(solved.creates.length,0);
});
test('Every request role keeps mandatory thread policy after a custom prompt; prompt migration preserves custom text',async()=>{
 const use=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}}}),p=await use('system-prompts.js'),s=await use('story-settings.js'),b=await use('context-builder.js'),d=await use('director-context.js'),m=await use('memory-prompts.js'),turns=await use('turns.js'),memory=await use('memory-settings.js');
 const custom={narratorSystemPrompt:'MY CLASSIC',directorNarratorSystemPrompt:'MY WRITER',directorSystemPrompt:'MY DIRECTOR',memoryExtractionPrompt:'MY EXTRACTOR'};
 const migrated=await s.migrateStorySettings(custom);for(const key of Object.keys(custom))assert.equal(migrated[key],custom[key]);
 const messages=[{id:'u',order:1,role:'user',content:'I ask her.'},{id:'a',order:2,role:'assistant',content:'She answers.'},{id:'u2',order:3,role:'user',content:'I wait.'}],settings={...s.defaultStorySettings(),...custom,maxContextTokens:40000,maxResponseTokens:1000,directorProfileId:'d',profiles:[{id:'d',endpoint:'https://test.invalid',apiKey:'mock',modelId:'test'}]},mem=memory.normalizeMemory({scene:true,lorebooks:true,lagTurns:0,batchTurns:1}),session={id:'s',memory:mem};
 for(const director of [false,true]){const result=await b.buildContextForRequest(session,{...settings,narrationMode:director?'director':'classic'},{messages,loreEntries:[],...(director?{directorTurn:{before:modern,after:modern,contract:JSON.parse(contract({}))}}:{})});assert.ok(result.apiMessages[0].content.includes(p.prompts.threadPolicy));assert.ok(result.apiMessages[0].content.startsWith(director?'MY WRITER':'MY CLASSIC'));}
 const director=await d.buildDirectorContext(session,settings,messages,[],modern);assert.ok(director.apiMessages[0].content.startsWith('MY DIRECTOR'));assert.ok(director.apiMessages[0].content.includes(p.prompts.threadPolicy));
 const range={assistants:[{...messages[1],turn:1}],messages:messages.slice(0,2),fromTurn:1,toTurn:1},extraction=await m.buildExtractionMessages({settings,mem,entries:[],messages,range,count:async t=>Math.ceil(t.length/4)});assert.ok(extraction.messages[0].content.startsWith('MY EXTRACTOR'));assert.ok(extraction.messages[0].content.includes(p.prompts.threadPolicy));assert.ok(extraction.messages[0].content.includes(p.prompts.threadExtraction));
});
test('Legacy regeneration reuses the original checkpoint without converting history or calling a provider',async()=>{
 const legacy={...modern,version:1,scene:{date:'24/10/738',hour:24,location:'Inn',present:['Nera']}},saved={id:'old',version:1,status:'completed',before:legacy,after:legacy,contract:JSON.parse(contract({}))};
 const use=appHarness({stubs:{'director-store.js':{getDirectorTurn:async()=>saved,savePendingDirectorTurn:async()=>{throw Error('Unexpected save');}},'llm-client.js':{chatCompletion:async()=>{throw Error('Unexpected model call');}}}}),d=await use('director-turn.js');
 const result=await d.prepareDirectorTurn({id:'s',directorCheckpoint:'old',directorState:legacy},{},[{id:'a',role:'assistant',order:2,directorTurnId:'old'}],[],{overwriteId:'a'});assert.deepEqual(plain(result),saved);assert.equal(result.after.scene.hour,24);
});
test('Thread import previews respect Keep mine timing and validate selective-record metadata',async()=>{
 const use=appHarness(),l=await use('lore-lines.js'),f=await use('lore-format.js'),records=await use('lore-records.js');
 const target=l.makeEntry('events','Visit Lysia',{id:'visit',kind:'thread',status:'open'});target.threadMeta={...appointment,dueTime:'08:00'};target.sections.text.text='Agreed visit.';
 const incoming=structuredClone(target);incoming.threadMeta.dueTime='09:30';
 const parsed=f.parseCard(f.serializeCard(incoming,{format:'json',storyId:'s'}));
 const mine=f.planCardImport([target],parsed,{targetId:'visit',storyId:'s',mode:'merge',conflict:'mine'});assert.equal(mine.data.threadMeta.dueTime,'08:00');
 const file=f.planCardImport([target],parsed,{targetId:'visit',storyId:'s',mode:'merge',conflict:'file'});assert.equal(file.data.threadMeta.dueTime,'09:30');assert.ok(file.preview.changes.some(c=>c.field==='threadMeta'));
 const whole=f.fromJson(f.toJson([incoming]));assert.equal((f.planImport([target],whole,{conflict:'mine'}).writes.find(w=>w.id==='visit')?.data ?? target).threadMeta.dueTime,'08:00');
 const doc=records.toRecordDocument(target);doc.subject.threadMeta.dueTime='25:99';assert.throws(()=>records.fromRecordDocument(doc),/thread date/);
});
test('Director midnight date normalization precedes expiry and remains speculative until narration completes',async()=>{
 const s=await appHarness()('director-state.js'),before={...modern,scene:{...modern.scene,date:'26/10/738',time:'23:50'},commitments:[{id:'date',text:'Meet Lysia',status:'waiting',threadMeta:{...appointment,dueTime:'00:00'}}]};
 const turn=s.parseDirectorContract(contract({scene:{time:'00:10'}}),before);assert.equal(turn.after.scene.date,'27/10/738');assert.equal(turn.contract.updates.scene.date,'27/10/738');assert.equal(turn.after.archive[0].threadMeta.outcome,'expired-unresolved');assert.equal(before.scene.date,'26/10/738');assert.equal(before.commitments.length,1);
 assert.throws(()=>s.parseDirectorContract(contract({scene:{date:'25/10/738',time:'00:10'}}),before),/backwards/);
});
