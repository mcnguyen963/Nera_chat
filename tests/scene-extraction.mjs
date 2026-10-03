import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';
const plain = value => JSON.parse(JSON.stringify(value));
const seed = 'date: Day 2 · time: unknown · place: Inn · present: Nera, Mira, Kael';
const snapshot = changes => ({ date:'Day 2',time:'unknown',place:'Inn',present:['Nera','Mira','Kael'],
  evidence:{ date:'',time:'',place:'',present:[] },departed:[],...changes });

test('separate writing context preserves fixed plan, omits history metadata and includes current snapshot even without memory block',async () => {
  const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async()=>[] },'tokenizer.js':{ countTokens:async s=>s.length } } });
  const build = (await use('context-builder.js')).buildContextForRequest;
  const settings = { narratorSystemPrompt:(await use('system-prompts.js')).prompts.narrator,maxContextTokens:50000,maxResponseTokens:1000 };
  const history = [{ id:'u',role:'user',order:1,content:'Start.' },{ id:'a',role:'assistant',order:2,content:'Mira waits.',scene:seed,planThread:'Wait for a choice.',acceptance:'accepted' },{ id:'u2',role:'user',order:3,content:'Continue.' }];
  const plan = 'A hearing remains pending. $& Preserve {{THESE}} exactly.';
  const built = await build({ longTermPlan:plan,memory:{ scene:true,sceneMode:'extract',protagonist:'Nera',replyContract:'user' } },settings,{ messages:history,requireLatestUser:true,separateSceneExtraction:true });
  assert.ok(built.apiMessages[0].content.includes(plan));
  assert.doesNotMatch(built.apiMessages[0].content,/include one short <plan_thread>|scene output contract|Required hidden tags/);
  const assistant = built.apiMessages.find(m=>m.role === 'assistant');
  assert.doesNotMatch(assistant.content,/<scene>|<plan_thread>/);
  assert.equal(built.apiMessages.filter(m=>m.content.includes('CURRENT WRITING CONTRACT')).length,1);
  assert.ok(built.apiMessages.at(-1).content.startsWith('CURRENT WRITING CONTRACT'));
  assert.ok(built.apiMessages.some(m=>m.content.includes('[APP SCENE SNAPSHOT') && m.content.includes(seed)));
  assert.equal(built.usedTokens,8+built.apiMessages.reduce((sum,m)=>sum+8+m.content.length,0));
  const legacy = await build({ longTermPlan:plan,memory:{ scene:true } },settings,{ messages:history,requireLatestUser:true });
  assert.match(legacy.apiMessages[0].content,/include one short <plan_thread>/);
  assert.match(legacy.apiMessages.find(m=>m.role === 'assistant').content,/<scene>/);
  const notConnected = await build({ longTermPlan:plan,memory:{ scene:true,sceneMode:'extract' } },settings,{ messages:history,requireLatestUser:true });
  assert.deepEqual(plain(notConnected.apiMessages),plain(legacy.apiMessages),'An unwired setting cannot switch the production writer to prose-only');
});

test('evidenced departure changes the actual next-request cards, while outsiders and absent background characters stay excluded',async () => {
  const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async()=>[] },'tokenizer.js':{ countTokens:async s=>s.length } } });
  const scene = await use('scene.js'),extract = await use('scene-extraction.js'),lore = await use('lore-lines.js');
  const entries = ['Nera','Mira','Kael','Outside Person','Absent Person'].map(n=>lore.makeEntry('characters',n));
  entries.push(lore.makeEntry('locations','Inn'));
  const narration = 'Kael leaves the Inn and closes the door. Outside Person stands outside the room.';
  const prior = scene.latestScene([],Infinity,seed);
  const context = extract.sceneExtractionContext({ narration,userText:'Continue.',prior,entries,sourceRevision:3 });
  const result = extract.parseSceneExtraction(JSON.stringify(snapshot({ present:['Nera','Mira','Outside Person'],
    evidence:{ date:'',time:'',place:'',present:[{ name:'Outside Person',quote:'Outside Person stands outside the room.' }] },
    departed:[{ name:'Kael',quote:'Kael leaves the Inn and closes the door.' }] })),context);
  assert.deepEqual(plain(scene.parseScene(result.scene).present),['Nera','Mira']);
  assert.equal(result.sceneMeta.sourceRevision,3);assert.equal(result.sceneMeta.stale,true);
  const built = await (await use('context-builder.js')).buildContextForRequest({ memory:{ scene:true,sceneMode:'extract',lorebooks:true,startingScene:seed } },
    { narratorSystemPrompt:'Narrate.',maxContextTokens:50000,maxResponseTokens:1000 },{ loreEntries:entries,messages:[
      { id:'u',role:'user',order:1,content:'Start.' },{ id:'a',role:'assistant',order:2,content:narration,acceptance:'accepted',...result },
      { id:'u2',role:'user',order:3,content:'Continue.' }],requireLatestUser:true,separateSceneExtraction:true });
  assert.deepEqual(plain(built.report.loaded.filter(e=>e.book === 'characters').map(e=>e.name)),['Nera','Mira']);
  assert.equal(built.report.loaded.find(e=>e.book === 'locations').name,'Inn');
  assert.ok(built.report.warnings.some(w=>w.includes('stale')));
});

test('extraction withholds invented evidence, mere mentions, NPC clock claims and proposed departures',async () => {
  const use = appHarness(),scene = await use('scene.js'),extract = await use('scene-extraction.js');
  const narration = 'Kael will leave tomorrow. Mira mentions Visitor. Mira says, "It is noon."';
  const context = extract.sceneExtractionContext({ narration,userText:'Continue.',prior:scene.latestScene([],Infinity,seed) });
  const result = extract.parseSceneExtraction(JSON.stringify(snapshot({ time:'noon',place:'Palace',present:['Nera','Mira','Visitor'],
    evidence:{ date:'',time:'It is noon.',place:'You arrive at Palace.',present:[{ name:'Visitor',quote:'Mira mentions Visitor.' }] },
    departed:[{ name:'Kael',quote:'Kael will leave tomorrow.' }] })),context);
  assert.deepEqual(plain(scene.parseScene(result.scene)),plain(scene.parseScene(seed)));
  assert.equal(result.sceneMeta.kind,'carried');assert.equal(result.sceneMeta.fromOrder,0);
  assert.equal(result.warnings.length,4);
  assert.throws(()=>extract.parseSceneExtraction(JSON.stringify({ ...snapshot(),extra:true }),context),/Invalid scene/);
  const messages = extract.sceneExtractionMessages({ ...context,plan:'DO NOT SEND',history:'DO NOT SEND' });
  assert.doesNotMatch(messages[1].content,/DO NOT SEND|pendingPlan|planThread/);
});

test('structured extraction uses a small independent request and leaves narrator reasoning settings untouched',async () => {
  let request;
  const use = appHarness({ stubs:{ 'tokenizer.js':{ countTokens:async s=>Math.ceil(s.length/4) },
    'llm-client.js':{ chatCompletion:async args=>{ request=args;return { content:JSON.stringify(snapshot()),usage:{ cost:0.001 } }; } } } });
  const scene = await use('scene.js'),extract = await use('scene-extraction.js');
  const settings = { endpoint:'https://openrouter.ai/api/v1/chat/completions',modelId:'writer',maxContextTokens:120000,
    streaming:true,maxResponseTokens:8000,reasoning:{ enabled:true,mode:'effort',effort:'high' } };
  const result = await extract.extractSceneState(settings,extract.sceneExtractionContext({ narration:'Mira waits.',userText:'Continue.',prior:scene.latestScene([],Infinity,seed) }));
  assert.equal(request.settings.modelId,'z-ai/glm-5.3-flash:floor');
  assert.equal(request.settings.reasoning.enabled,false);assert.equal(settings.reasoning.enabled,true);
  assert.equal(request.settings.streaming,false);assert.equal(request.responseFormat.json_schema.strict,true);
  assert.equal(request.provider.require_parameters,true);assert.equal(request.messages.length,2);
  assert.equal(result.call.purpose,'scene extraction');assert.equal(result.call.usage.cost,0.001);
});
