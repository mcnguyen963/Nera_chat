import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const settings={activeProfileId:'global',endpoint:'https://other.test',apiKey:'global-key',modelId:'global-model',maxResponseTokens:1000,maxOutputPrice:.01,modelContextTokens:8000,reasoning:{enabled:false},profiles:[{id:'global',modelId:'global-model'},{id:'n',endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:'n-key',modelId:'deepseek/deepseek-v4.1-flash:floor',maxResponseTokens:8192,maxOutputPrice:.4,streaming:true,reasoning:{enabled:true,mode:'effort',effort:'high'}},{id:'d',endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:'d-key',modelId:'anthropic/claude-haiku-5.5:floor',maxResponseTokens:8192,maxOutputPrice:.5,reasoning:{enabled:true,mode:'effort',effort:'medium'}}],narratorProfileId:'n',directorProfileId:'d',directorMaxOutputTokens:8192,directorMaxInputTokens:20000};
test('Each role resolves its own price, key, reasoning and output capacity without changing shared settings',async()=>{
 const use=appHarness(),api=await use('model-profiles.js'),director=await use('director-context.js'),before=JSON.stringify(settings);
 const narrator=api.resolveModelProfile(settings,'n',{role:'Narrator'}),task=director.directorTaskSettings(narrator);
 assert.equal(narrator.modelId,'deepseek/deepseek-v4.1-flash:floor');assert.equal(narrator.apiKey,'n-key');assert.equal(narrator.maxOutputPrice,.4);assert.equal(narrator.reasoning.effort,'high');assert.equal(narrator.maxResponseTokens,8192);assert.equal(narrator.modelContextTokens,null);
 assert.equal(task.modelId,'anthropic/claude-haiku-5.5:floor');assert.equal(task.apiKey,'d-key');assert.equal(task.maxOutputPrice,.5);assert.equal(task.reasoning.effort,'medium');assert.equal(task.maxResponseTokens,8192);assert.equal(task.streaming,false);
 assert.equal(JSON.stringify(settings),before);assert.equal(api.resolveModelProfile(settings,'').modelId,'global-model');assert.throws(()=>api.resolveModelProfile(settings,'deleted',{role:'Narrator'}),/Narrator model profile no longer exists/);
});
test('Role test presets use the requested exact models and effort, reuse existing profiles and never copy non-OpenRouter credentials',async()=>{
 const api=await appHarness()('model-profiles.js');let id=0;
 const result=api.addRoleTestProfiles({...settings,profiles:[{id:'global',endpoint:'https://other.test',apiKey:'private-other-key'}]},()=> 'test-'+ ++id);
 const d=result.profiles.find(p=>p.id===result.ids.director),n=result.profiles.find(p=>p.id===result.ids.narrator);
 assert.equal(d.modelId,'anthropic/claude-haiku-5.5:floor');assert.equal(d.reasoning.effort,'medium');assert.equal(d.maxOutputPrice,.5);assert.equal(d.apiKey,'');assert.equal(n.modelId,'deepseek/deepseek-v4.1-flash:floor');assert.equal(n.reasoning.effort,'high');assert.equal(n.maxOutputPrice,.4);
 const again=api.addRoleTestProfiles({...settings,profiles:result.profiles},()=>{throw Error('Duplicate profile');});assert.deepEqual(plain(again.profiles),plain(result.profiles));
 const existing=api.addRoleTestProfiles(settings);assert.equal(existing.ids.director,'d');assert.equal(existing.ids.narrator,'n');assert.deepEqual(plain(existing.profiles),plain(settings.profiles));
 const custom=structuredClone(settings);custom.profiles.find(p=>p.id==='d').reasoning.effort='high';
 const selected=api.addRoleTestProfiles(custom,()=> 'medium-director');assert.equal(selected.ids.director,'medium-director');assert.equal(selected.profiles.find(p=>p.id==='d').reasoning.effort,'high');assert.equal(selected.profiles.find(p=>p.id==='medium-director').reasoning.effort,'medium');
});
test('Narrator selections migrate without changing old defaults and participate in story setting conflicts',async()=>{
 const api=await appHarness()('story-settings.js'),old=await api.migrateStorySettings({narratorSystemPrompt:'Custom'});assert.equal(old.narratorProfileId,'');
 assert.equal(api.explicitStorySettings({...old,narratorProfileId:'n'}).narratorProfileId,'n');assert.equal(api.pickStorySettings({...old,narratorProfileId:'n',apiKey:'do-not-copy'}).apiKey,undefined);
 assert.throws(()=>api.mergeStorySettings({...old,narratorProfileId:'remote'},old,{narratorProfileId:'n'}),/another device/);assert.throws(()=>api.explicitStorySettings({...old,narratorProfileId:4}),/Invalid Narrator profile/);
});

test('Effective story settings and the production serializer send each role to its selected model',async()=>{
 const requests=[],live={settings:structuredClone(settings),sessionId:'s',storySettingsId:'s',storySettings:{revision:1,values:{narratorProfileId:'n',directorProfileId:'d',directorMaxOutputTokens:8192,directorMaxInputTokens:20000,directorRecentTurns:5}},storySettingsLoadFailed:false};
 const use=appHarness({globals:{fetch:async(url,opts)=>{if(url instanceof URL&&url.protocol==='file:'){const {promptFetch}=await import('./prompt-files.mjs');return promptFetch(url);}requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({choices:[{message:{content:requests.length===1?JSON.stringify({version:1,action:'narrate',transition:'unchanged',objective:'Confirm the appointment.',stopCondition:'Wait for the player.',memoryIds:[],requiredMemoryIds:[],updates:{}}):'Lysia confirms the appointment and waits.'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});}},stubs:{
 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc(){},runTransaction(){throw Error('No external writes');},onSnapshot(){},serverTimestamp(){}},'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},'state.js':{state:live},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)},'director-store.js':{getDirectorTurn:async()=>null,savePendingDirectorTurn:async(_sid,t)=>t}
 }});
 const store=await use('story-settings-store.js'),coordinator=await use('director-turn.js'),client=await use('llm-client.js'),effective=store.effectiveActiveSettings(),before={version:1,scene:{date:'21/10/738',hour:16,location:'Bench',present:['Nera','Lysia']},event:null,decisions:[],threads:[],commitments:[]};
 await coordinator.prepareDirectorTurn({id:'s',directorState:before},effective,[{id:'u',role:'user',order:1,content:'Confirm tomorrow’s appointment.'}],[]);
 await client.chatCompletion({settings:{...effective,streaming:false},messages:[{role:'user',content:'Narrate the contract.'}]});
 assert.equal(requests[0].model,'anthropic/claude-haiku-5.5:floor');assert.equal(requests[0].reasoning.effort,'medium');assert.equal(requests[0].provider.max_price.completion,.5);assert.equal(requests[0].response_format.type,'json_schema');
 assert.equal(requests[1].model,'deepseek/deepseek-v4.1-flash:floor');assert.equal(requests[1].reasoning.effort,'high');assert.equal(requests[1].provider.max_price.completion,.4);assert.equal(requests[1].response_format,undefined);
 assert.equal(live.settings.activeProfileId,'global');assert.equal(live.settings.apiKey,'global-key');
});
