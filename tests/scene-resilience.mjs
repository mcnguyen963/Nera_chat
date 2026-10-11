import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';
const plain = x => JSON.parse(JSON.stringify(x));
const seed = 'date: 18 September 731 · time: unknown · place: West Reception Room · present: Nera Veyrath, Isolde Veyless';

test('declared date/time do not use their own tag as narration evidence',async () => {
  const s = await appHarness()('scene.js');
  const candidate = seed.replace('time: unknown','time: late morning');
  const checked = s.validateSceneValues(candidate,{ narration:'Krail waits.\n<scene>'+candidate+'</scene>',userText:'I woke this morning on 18 September 731.' });
  assert.equal(s.parseScene(checked.scene).time,'late morning');assert.equal(s.parseScene(checked.scene).when,'18 September 731');
  assert.equal(checked.sceneMeta.provenance.time,'declared');assert.equal(checked.warnings.length,0);
  const supported = s.validateSceneValues(candidate,{ narration:'It is late morning.',prior:s.parseScene(seed) });
  assert.equal(s.parseScene(supported.scene).time,'late morning');assert.equal(supported.sceneMeta.provenance.date,'prior');
  assert.equal(s.parseScene(s.validateSceneValues(candidate,{ narration:'It is early morning.',prior:s.parseScene(seed) }).scene).time,'late morning');
  assert.equal(s.parseScene(s.validateSceneValues(candidate,{ narration:'Krail says, "It is late morning."',prior:s.parseScene(seed) }).scene).time,'late morning','NPC claims are not narration evidence, but a declared clock is accepted');
});

test('carried scenes survive reload with their original cutoff and accumulate staleness; pending candidates do not replace accepted state',async () => {
  const s = await appHarness()('scene.js');
  const history = [{ id:'a1',role:'assistant',order:2,scene:seed }];
  for(const order of [4,6]) history.push({ id:'a'+order,role:'assistant',order,...plain(s.carryScene(s.latestScene(history))) });
  let current = s.latestScene(plain(history));
  assert.equal(current.fromOrder,2);assert.equal(current.fromId,'a1');assert.equal(current.missingStreak,2);
  history.push({ id:'p',role:'assistant',order:8,scene:seed.replace('West Reception Room','Elsewhere'),acceptance:'pending' });
  current = s.latestScene(history);assert.equal(current.scene.place,'West Reception Room');assert.equal(current.missingStreak,3);
  history.push({ id:'valid',role:'assistant',order:10,scene:seed });
  assert.equal(s.latestScene(history).missingStreak,0);assert.equal(s.latestScene([],Infinity,seed).kind,'seed');
});

test('opening seed beats background mention order and reminders are counted once at the final input',async () => {
  const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:async s => s.length } } });
  const { buildContextForRequest } = await use('context-builder.js'),{ makeEntry } = await use('lore-lines.js');
  const entries = ['Absent Person','Nera Veyrath','Isolde Veyless'].map(n => makeEntry('characters',n));
  entries.push(makeEntry('locations','West Reception Room'));
  const settings = { narratorSystemPrompt:'Narrate.',maxContextTokens:50000,maxResponseTokens:1000 };
  const messages = [{ id:'u',role:'user',order:1,content:'I remember Absent Person.' }];
  let previous = null;
  for(const variant of ['off','system','user']) {
    const built = await buildContextForRequest({ longTermPlan:'A pending hearing.',memory:{ scene:true,lorebooks:true,startingScene:seed,
      replyContract:variant,books:{ characters:{ maxCards:2 } } } },settings,{ messages,loreEntries:entries,requireLatestUser:true });
    assert.deepEqual(plain(built.report.loaded.filter(e=>e.book==='characters').map(e=>e.name)),entries.filter(e=>e.book==='characters' && e.name!=='Absent Person').sort((a,b)=>a.id<b.id?-1:1).map(e=>e.name));
    const contracts = built.apiMessages.filter(m=>m.content.includes('[Reply format —' ));
    assert.equal(contracts.length,variant==='off' ? 0 : 1);
    if(variant==='system') assert.ok(built.apiMessages.at(-2).content.startsWith('[Reply format —' ));
    if(variant==='user') assert.equal(built.apiMessages.at(-1).role,'user');
    if(variant!=='off') { assert.match(contracts[0].content,/active/i);assert.ok(built.usedTokens>previous); }
    previous = variant==='off' ? built.usedTokens : previous;
    assert.equal(built.usedTokens,8+built.apiMessages.reduce((n,m)=>n+8+m.content.length,0));
  }
});

test('player-agency lint distinguishes NPC quotes and warnings gate extraction without skipping checkpoints',async () => {
  const use = appHarness(),r = await use('turn-review.js'),t = await use('turns.js');
  assert.deepEqual(plain(r.lintPlayerAgency('Isolde says, "I will fetch the physician."','Nera Veyrath')),[]);
  for(const prose of ['You say, "Bring him here."','Nera decides to sign.','I take the pen.']) assert.ok(r.lintPlayerAgency(prose,'Nera Veyrath').length);
  assert.equal(r.lintPlayerAgency('When your gaze flicks toward her, she turns.','Nera Veyrath').length,0);
  assert.ok(r.lintUnestablishedTime('Pale afternoon light crosses the room.').length);
  assert.deepEqual(plain(r.lintUnestablishedTime('Pale afternoon light crosses the room.',{ prior:{ time:'afternoon' } })),[]);
  const history = [{ id:'a',role:'assistant',order:2,acceptance:'accepted',content:'Krail waits.' },
    { id:'b',role:'assistant',order:4,acceptance:'pending',content:'You sign.' },{ id:'c',role:'assistant',order:6,acceptance:'accepted',content:'The door opens.' }];
  const mem = { scene:true,batchTurns:2,lagTurns:0,updateMaxTokens:1000 };
  assert.equal(t.dueRange(history,{ extractedThroughOrder:0 },mem),null);
  assert.equal(t.dueRange(history,{ extractedThroughOrder:0 },mem,{ manual:true }).endOrder,2);
  assert.equal(t.dueRange(history,{ extractedThroughOrder:2 },mem,{ manual:true }),null);
  const accepted=[...history,{id:'u',role:'user',order:7,content:'Continue.'}];
  assert.equal(t.dueRange(accepted,{extractedThroughOrder:0},mem).endOrder,4);
});

test('structured recovery validates schema, names and provenance locally and never modifies narration or plan',async () => {
  const use = appHarness(),s = await use('scene.js'),r = await use('scene-recovery.js');
  const context = { narration:'Isolde Veyless remains beside you.',userText:'Continue.',prior:s.latestScene([],Infinity,seed),
    names:['Nera Veyrath','Isolde Veyless'],plan:'Pending hearing.' };
  const obj = { date:'18 September 731',time:'late morning',place:'West Reception Room',present:context.names,planThread:'Await the player’s choice.' };
  const result = r.parseRecovery(JSON.stringify(obj),context);
  assert.equal(result.sceneMeta.kind,'inferred');assert.equal(s.parseScene(result.scene).time,'late morning');
  for(const invalid of [{ ...obj,time:14 },{ ...obj,planThread:[] }]) assert.equal(r.parseRecovery(JSON.stringify(invalid),context),null);
  assert.equal(r.parseRecovery(JSON.stringify(obj),{ ...context,plan:'' }).planThread,null);
});

test('summary refuses an unaccepted eligible turn before making any provider or storage call',async () => {
  let calls = 0;
  const use = appHarness({ stubs:{ 'messages.js':{ getMessages:async()=>[],getCheckpointMessages:async()=>[],addMessage:async()=>{calls++;},newMessageId:()=> 's' },
    'llm-client.js':{ chatCompletion:async()=>{calls++;} },'tokenizer.js':{ countTokens:async s=>s.length } } });
  const result = await (await use('summarizer.js')).runSummarization({ id:'s',memory:{scene:true} },{maxContextTokens:50000,maxResponseTokens:1000, keepRecentMessagesAfterSummary:1 },{ messages:[
    { id:'u',role:'user',order:1,content:'Continue.' },{ id:'a',role:'assistant',order:2,acceptance:'accepted',content:'Opening.' },{id:'blocked',role:'assistant',order:3,acceptance:'pending',content:'You sign.'},
    { id:'a2',role:'assistant',order:4,content:'Krail waits.' }] });
  assert.equal(result.skipped,true);assert.match(result.reason,/flagged replies/);assert.equal(calls,0);
});
