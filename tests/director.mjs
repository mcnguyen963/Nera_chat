import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const state={version:1,scene:{date:'21/10/738',hour:20,location:'Inn',present:['Nera','Isolde']},event:{id:'dinner',name:'Dinner',phase:'meal'},decisions:[],threads:[],commitments:[{id:'visit',text:'Visit Lysia after dinner',trigger:'Dinner finishes',status:'waiting'}]};
const settings={narrationMode:'director',directorProfileId:'small',profiles:[{id:'small',endpoint:'https://director.test',apiKey:'key',modelId:'small-model'}],activeProfileId:'large',endpoint:'https://narrator.test',apiKey:'large-key',modelId:'large-model',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,reasoning:{},narratorSystemPrompt:'Write well',maxContextTokens:40000,maxResponseTokens:2000,keepRecentMessagesAfterSummary:10};
const contract=updates=>({version:1,action:'narrate',transition:'unchanged',objective:'Offer the next interaction',stopCondition:'Stop before the player answers',memoryIds:[],requiredMemoryIds:[],updates});
const tokens={countTokens:async t=>Math.ceil(t.length/4)};
test('Director ledger survives omitted updates across thirty turns and explicitly becomes ready without travel',async()=>{
 const api=await appHarness()('director-state.js');let next=state;
 for(let i=0;i<30;i++)next=api.parseDirectorContract(JSON.stringify(contract({})),next).after;
 assert.equal(next.commitments[0].text,state.commitments[0].text);
 next=api.parseDirectorContract(JSON.stringify(contract({event:{id:'dinner',name:'Dinner',phase:'finished'},commitments:{upsert:[{id:'visit',status:'ready'}],close:[]}})),next).after;
 assert.equal(next.commitments[0].status,'ready');assert.equal(next.scene.location,'Inn');assert.equal(next.commitments[0].trigger,'Dinner finishes');
});
test('Explicit closure preserves evidence and missing items never close a pending decision',async()=>{
 const api=await appHarness()('director-state.js');const next=api.parseDirectorContract(JSON.stringify(contract({decisions:{upsert:[{id:'choice',text:'Register for excursion?',status:'open'}],close:[]}})),state).after;
 assert.equal(api.parseDirectorContract(JSON.stringify(contract({})),next).after.decisions.length,1);
 const closed=api.parseDirectorContract(JSON.stringify(contract({commitments:{upsert:[],close:['visit']}})),next).after;assert.equal(closed.commitments.length,0);assert.equal(api.activeDirectorState(closed).commitments.length,0);
});
test('Director validates JSON, game hours, dates, memory IDs and answer-only transitions',async()=>{
 const api=await appHarness()('director-state.js');
 for(const hour of [0,25,1.5,'9'])assert.throws(()=>api.validateDirectorState({...state,scene:{...state.scene,hour}}),/1–24/);
 assert.equal(api.validateDirectorState({...state,scene:{...state.scene,hour:24}}).scene.hour,24);
 assert.throws(()=>api.validateDirectorState({...state,scene:{...state.scene,date:'31/2/738'}}),/date/);
 assert.throws(()=>api.parseDirectorContract('{broken',state),/JSON/);
 assert.throws(()=>api.parseDirectorContract(JSON.stringify({...contract({}),memoryIds:['missing']}),state),/unknown memory/);
 assert.throws(()=>api.parseDirectorContract(JSON.stringify({...contract({scene:{hour:9,date:'22/10/738'}}),action:'answer'}),state),/unchanged/);
 assert.equal(api.parseDirectorContract(JSON.stringify({...contract({}),action:'answer'}),state).after.scene.hour,20);
});
test('Director normalizes required-only cards and omitted empty ledger operations without losing state',async()=>{
 const api=await appHarness()('director-state.js'),entries=[{id:'nera'},{id:'isolde'}];
 const raw={...contract({decisions:{upsert:[{id:'choice',text:'Choose an excursion option',status:'open'}]}}),requiredMemoryIds:['nera','isolde','nera']};
 const parsed=api.parseDirectorContract(JSON.stringify(raw),state,entries);
 assert.deepEqual(plain(parsed.contract.memoryIds),['nera','isolde']);assert.deepEqual(plain(parsed.contract.requiredMemoryIds),['nera','isolde']);
 assert.deepEqual(plain(parsed.contract.updates.decisions.close),[]);assert.equal(parsed.after.decisions[0].id,'choice');assert.deepEqual(plain(parsed.after.commitments),state.commitments);assert.deepEqual(plain(parsed.after.scene),state.scene);
 const closed=api.parseDirectorContract(JSON.stringify(contract({decisions:{close:['choice']}})),parsed.after,entries);
 assert.deepEqual(plain(closed.contract.updates.decisions.upsert),[]);assert.equal(closed.after.decisions.length,0);
 assert.throws(()=>api.parseDirectorContract(JSON.stringify({...raw,requiredMemoryIds:['unknown']}),state,entries),/unknown memory/);
 for(const operations of [null,{upsert:null},{close:null},{upsert:[null]}])assert.throws(()=>api.parseDirectorContract(JSON.stringify(contract({decisions:operations})),state),/invalid decisions operations/);
});
test('Director required-card normalization still enforces the combined selection limit',async()=>{
 const api=await appHarness()('director-state.js'),ids=Array.from({length:101},(_,i)=>'card-'+i);
 assert.throws(()=>api.parseDirectorContract(JSON.stringify({...contract({}),memoryIds:ids.slice(0,100),requiredMemoryIds:ids.slice(100)}),state,ids.map(id=>({id}))),/too many selected/);
});
test('Narrator scene tags cannot override Director time, place or presence',async()=>{
 const api=await appHarness()('director-state.js');assert.equal(api.directorSceneWarnings('date: 21/10/738 · time: Hour 11 · place: Elsewhere · present: Someone',state).length,1);assert.equal(api.directorSceneWarnings(api.directorScene(state),state).length,0);
});
test('Director context keeps five complete turns, commitments, indexes and latest input without full historical summary',async()=>{
 const use=appHarness({stubs:{'tokenizer.js':tokens}}),api=await use('director-context.js'),lore=await use('lore-lines.js');
 const history=Array.from({length:20},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',order:i+1,content:'Conversation '+i}));history.push({id:'latest',role:'user',order:21,content:'Let us travel'});
 const entry=lore.makeEntry('characters','Lysia');entry.sections.appearance.text='Healer in the infirmary';
 const built=await api.buildDirectorContext({id:'s',memory:{}},settings,history,[entry],state);
 assert.equal(built.report.recentMessages.length,10);assert.equal(built.apiMessages.at(-1).content,'Let us travel');
 assert.ok(built.apiMessages[0].content.includes('Visit Lysia after dinner'));assert.ok(built.apiMessages[0].content.includes('Healer in the infirmary'));assert.ok(!built.apiMessages.map(m=>m.content).join('').includes('Conversation 0'));
 const task=api.directorTaskSettings(settings);assert.equal(task.modelId,'small-model');assert.equal(task.endpoint,'https://director.test');assert.equal(task.maxResponseTokens,4000);assert.equal(settings.modelId,'large-model');
});
test('Director budget failure protects the live ledger and latest input',async()=>{
 const api=await appHarness({stubs:{'tokenizer.js':tokens}})('director-context.js');
 await assert.rejects(api.buildDirectorContext({id:'s',memory:{}},{...settings,directorMaxInputTokens:10},[{id:'u',role:'user',order:1,content:'Latest action'}],[],state),/exceed/);
});
test('Director calls once, saves only a pending contract, and Retry reuses it',async()=>{
 let calls=0,pending=null;const session={id:'s',directorState:state,historyRevision:1};
 const use=appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async()=>pending,savePendingDirectorTurn:async(_sid,t,source)=>{pending={...t,status:'pending',source};return pending;}},'llm-client.js':{chatCompletion:async()=>{calls++;return {content:JSON.stringify(contract({scene:{hour:21}})),finishReason:'stop',usage:{prompt_tokens:100}};}}}});
 const api=await use('director-turn.js'),messages=[{id:'u',role:'user',order:1,content:'Finish dinner'}];const turn=await api.prepareDirectorTurn(session,settings,messages,[]);
 assert.equal(turn.after.scene.hour,21);assert.equal(session.directorState.scene.hour,20);assert.equal(calls,1);
 const retried=await api.prepareDirectorTurn({...session,directorPending:turn.id},settings,messages,[]);assert.equal(retried.id,turn.id);assert.equal(calls,1);
});
test('Regenerate reuses completed contract and Continue waits at a pending player choice',async()=>{
 let calls=0;const completed={id:'d',version:1,status:'completed',before:state,after:state,contract:contract({})};
 const api=await appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async()=>completed,savePendingDirectorTurn:async(_s,t)=>t},'llm-client.js':{chatCompletion:async()=>{calls++;throw Error('Unexpected call');}}}})('director-turn.js');
 const messages=[{id:'u',role:'user',order:1,content:'Start'},{id:'a',role:'assistant',order:2,content:'Choose?',directorTurnId:'d'}],session={id:'s',directorState:{...state,decisions:[{id:'choice',text:'Visit now?',status:'open'}]},directorCheckpoint:'d'};
 assert.equal((await api.prepareDirectorTurn(session,settings,messages,[],{overwriteId:'a',upToOrder:2})).id,'d');
 assert.equal((await api.prepareDirectorTurn(session,settings,messages,[],{overwriteId:'a',continuationId:'a'})).contract.action,'wait');assert.equal(calls,0);
});
test('Director failures and stale inputs never persist a contract',async()=>{
 let saved=0;const api=await appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async()=>null,savePendingDirectorTurn:async()=>{saved++;}},'llm-client.js':{chatCompletion:async()=>({content:'{}',finishReason:'length'})}}})('director-turn.js');
 await assert.rejects(api.prepareDirectorTurn({id:'s',directorState:state},settings,[{role:'user',content:'Go',order:1}],[]),/incomplete/);assert.equal(saved,0);
});
test('Narrator context follows Director state and preserves existing retrieval alongside Director selections',async()=>{
 const use=appHarness({stubs:{'tokenizer.js':tokens,'messages.js':{getMessages:async()=>[]}}}),api=await use('context-builder.js'),lore=await use('lore-lines.js');
 const nera=lore.makeEntry('characters','Nera'),lysia=lore.makeEntry('characters','Lysia');lysia.sections.appearance.text='Silver healer coat';nera.sections.appearance.text='Player profile';
 const turn={before:state,after:{...state,scene:{...state.scene,location:'Infirmary',hour:6,date:'22/10/738'}},contract:{...contract({}),memoryIds:[lysia.id],requiredMemoryIds:[lysia.id]}};
 const built=await api.buildContextForRequest({id:'s',memory:{lorebooks:true,scene:true,protagonist:'Nera'},directorState:state},settings,{messages:[{id:'u',order:1,role:'user',content:'Visit Lysia'}],loreEntries:[nera,lysia],directorTurn:turn});
 assert.equal(built.report.mode,'director-narrator');assert.equal(built.report.scene.place,'Infirmary');assert.ok(built.apiMessages[0].content.includes('Director contract'));assert.ok(built.report.loaded.some(e=>e.entryId===lysia.id));
 assert.ok(built.apiMessages.some(m=>m.content.includes('Silver healer coat')));
 await assert.rejects(api.buildContextForRequest({id:'s',memory:{lorebooks:true,books:{characters:{budget:0}}}},settings,{messages:[{id:'u',role:'user',order:1,content:'Go'}],loreEntries:[lysia],directorTurn:turn}),/Required Director memories/);
});

test('A game-hour rollover requires a date change and preserves unknown time',async()=>{
 const api=await appHarness()('director-state.js'),last={...state,scene:{...state.scene,hour:24}};
 assert.throws(()=>api.parseDirectorContract(JSON.stringify(contract({scene:{hour:1}})),last),/following date/);
 assert.equal(api.parseDirectorContract(JSON.stringify(contract({scene:{hour:1,date:'22/10/738'}})),last).after.scene.hour,1);
 assert.equal(api.parseDirectorContract(JSON.stringify(contract({})),{...state,scene:{...state.scene,hour:null}}).after.scene.hour,null);
});
test('Director Stop prevents a late provider result from persisting a contract',async()=>{
 const controller=new AbortController();let saved=0;
 const api=await appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async()=>null,savePendingDirectorTurn:async()=>{saved++;}},'llm-client.js':{chatCompletion:async()=>{controller.abort();return {finishReason:'stop',content:JSON.stringify(contract({}))};}}}})('director-turn.js');
 await assert.rejects(api.prepareDirectorTurn({id:'s',directorState:state},settings,[{role:'user',content:'Go',order:1}],[],{},{signal:controller.signal}),/stopped/);assert.equal(saved,0);
});

test('Director refuses narrative state changes for explicit OOC input',async()=>{
 let saved=0;const api=await appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async()=>null,savePendingDirectorTurn:async()=>{saved++;}},'llm-client.js':{chatCompletion:async()=>({finishReason:'stop',content:JSON.stringify(contract({}))})}}})('director-turn.js');
 await assert.rejects(api.prepareDirectorTurn({id:'s',directorState:state},settings,[{role:'user',content:'<ooc>Who is Lysia?</ooc>',order:1}],[]),/OOC/);assert.equal(saved,0);
});
test('Regenerating a continuation reuses the latest continuation contract, rather than planning another scene',async()=>{
 const old={id:'continuation',version:1,status:'completed',before:state,after:state,contract:contract({})};let calls=0;
 const api=await appHarness({stubs:{'tokenizer.js':tokens,'director-store.js':{getDirectorTurn:async id=>old,savePendingDirectorTurn:async()=>{}},'llm-client.js':{chatCompletion:async()=>{calls++;}}}})('director-turn.js');
 const turn=await api.prepareDirectorTurn({id:'s',directorState:state,directorCheckpoint:old.id},settings,[{id:'u',order:1,role:'user',content:'Begin'},{id:'a',order:2,role:'assistant',content:'Original prefix',directorTurnId:'original'}],[],{overwriteId:'a',continuationId:'a',directorReuseId:old.id});
 assert.equal(turn.id,'continuation');assert.equal(calls,0);
});
