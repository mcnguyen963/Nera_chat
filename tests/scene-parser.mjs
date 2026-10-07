import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';
const use=appHarness();
const api=await use('scene.js');
const B='date: Day 2 · time: night · place: Inn · present: Mira, Kael';
const tag=s => '<scene>'+s+'</scene>';
const P='Prose.';
const cases=[
 [`${P}\n${tag(B)}`,B,P],
 [`${P} ${tag(B)}`,B,P],
 [`${P}\n${tag(B)}\n<plan_thread>x</plan_thread>`,B,P],
 [`${P}\n<SCENE>${B}</SCENE>`,B,P],
 [`${P}\n${tag(B.replace(/date|time|place|present/g,s=>s[0].toUpperCase()+s.slice(1)))}`,B,P],
 [`${P}\n${tag(B.replaceAll('·','•'))}`,B,P],
 [`${P}\n${tag(B.replaceAll('·','|'))}`,B,P],
 [`${P}\n${tag(B.replaceAll(' · ','·'))}`,B,P],
 [`${P}\n${tag(B.replace('night','14:30'))}`,B.replace('night','14:30'),P],
 [`${P}\n${tag(B.replaceAll(' · ','\n'))}`,B,P],
 [`${P}\n${tag(B+'.')}`,B,P],
 [`${P}\n\x60\x60\x60\n${tag(B)}\n\x60\x60\x60`,B,P],
 [`${P}\n\x60\x60\x60xml\n${tag(B)}\n\x60\x60\x60`,B,P],
 [`${P}\n${tag(B)}\n${tag(B.replace('Inn','Hall'))}`,B.replace('Inn','Hall'),P],
 [`<think>draft ${tag(B.replace('Inn','Draft'))}</think>${P}\n${tag(B)}`,B,P],
 [`${P}\n<scene>${B}`,B,P],
 ['Prose <scene> explanation… more prose\n\nNext paragraph.',null,'Prose explanation… more prose\n\nNext paragraph.'],
 [`${P}\n<scene>${B}\n\nMore prose.`,B,'Prose.\n\nMore prose.'],
 [`${P}\n<scene_state>${B}</scene_state>`,B,P],
 [`${P}\n<scene_state>Date: Day 2. Active event: the hearing. Present: Mira</scene_state>`,'date: Day 2 · time: unknown · place: unknown · present: Mira',P],
 [`${P}\n[Scene: Inn]`,null,P],
 [`${P}\n[Scene: Day 2 · night · Inn · present: Mira, Kael]`,B,P],
 [`${P}\n**Scene:** ${B}`,B,P],
 [`${P}\n<!-- scene: ${B} -->`,B,P],
 [`${P}\n<!-- scene -->\n</div>`,null,P],
 [`${P}\n${tag('Day 2 · night · Inn · present: Mira, Kael')}`,B,P],
 [`${P}\n${tag('date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME')}`,null,P],
 [`${P}\n${tag(B.replace('Mira, Kael','Nera Veyrath (you), none, Mira'))}`,B.replace('Mira, Kael','Nera Veyrath, Mira'),P],
 [`${P}\n${tag('"'+B+'"')}`,B,P],
 [`${P}\n${tag('')}`,null,P],
 [`${P}\n${tag('day: Day 2 · hour: night · location: Inn · characters: Mira, Kael')}`,B,P],
 [`${P}\n${tag('date: unknown · time: unknown · place: Inn · present: unknown')}`,'date: unknown · time: unknown · place: Inn · present: unknown',P],
 [P,null,P],
 [`${P}\n${tag(B.replace('Inn','West Wing - Reception Room, Palace'))}`,B.replace('Inn','West Wing - Reception Room, Palace'),P],
 [`${P}\n<plan_thread>x</plan_thread> ${tag(B)}`,B,P],
 [`${P}\n${tag(B.replace(/(date|time|place|present):/g,'**$1:**'))}`,B,P],
 [`${P}\n${tag(B.replace('Inn','Inn: upstairs room'))}`,B.replace('Inn','Inn, upstairs room'),P],
 [`${P}\n${tag(B.replace('Inn','Old Inn: upstairs'))}`,B.replace('Inn','Old Inn, upstairs'),P],
 [`${P}\n${tag(B+' · active event: the hearing')}`,B,P],
];
for (const [i,[input,scene,clean]] of cases.entries()) test(`S3 scene fixture ${i+1}`,() => {
 const out=api.readSceneOutput(input); assert.equal(out.scene,scene);assert.equal(out.clean,clean);
 if(scene) assert.equal(api.canonicalScene(scene),scene);
});

test('S3 malformed metadata leaves later narration and streaming remains hidden',async () => {
 const {stripPlan}=await use('plan-parser.js');
 assert.equal(stripPlan('Story\n<scene>bad\n\nMore story.',{final:true}),'Story\nbad\n\nMore story.');
 assert.equal(stripPlan('Story\n<scene>bad\n\nMore story.'),'Story');
 assert.equal(api.canonicalScene('Tavern, night'),null);
 assert.equal(api.canonicalScene('Inn'),null);
 assert.equal(api.canonicalScene('Day 9 | night | Inn | present: A, a, B'),'date: Day 9 · time: night · place: Inn · present: A, B');
 assert.equal(api.sceneLine({date:'Day 2',time:'10:30',place:'Inn',present:[]}),B.replace('night','10:30').replace('Mira, Kael','unknown'));
 const ordered=api.readSceneOutput(`<scene>${B.replace('Inn','First')}</scene>\n<scene>${B}`);
 assert.equal(ordered.scene,B);
});

test('S1 pending acceptance depends on later user input, never on current lint',async () => {
 const {isAcceptedTurn}=await use('turn-review.js');
 for(const acceptance of [undefined,'accepted','pending','rejected']) {
  const m={role:'assistant',order:2,content:'You say yes.',acceptance};
  assert.equal(isAcceptedTurn(m),!['pending','rejected'].includes(acceptance));
  assert.equal(isAcceptedTurn(m,{lastUserOrder:3}),true);
  assert.equal(isAcceptedTurn(m,{sceneOn:false}),true);
 }
});

test('S4 timeline uses accepted candidates and carried references; legacy replies invalidate seeds',() => {
 const messages=[{id:'a',role:'assistant',order:2,scene:B},{id:'b',role:'assistant',order:4,sceneMeta:{kind:'carried'}},{id:'o',role:'assistant',order:6,ooc:true},{id:'p',role:'assistant',order:8,acceptance:'pending',sceneCandidate:{scene:B.replace('Inn','Hall')}}];
 let timeline=api.sceneTimeline(messages);assert.equal(timeline.get('b').own,null);assert.equal(timeline.get('b').effective,B);assert.equal(timeline.get('o').missingStreak,1);assert.equal(timeline.get('p').effective,B);
 timeline=api.sceneTimeline([...messages,{id:'u',role:'user',order:9}]);assert.equal(timeline.get('p').own,B.replace('Inn','Hall'));
 assert.equal(api.latestScene([{id:'legacy',role:'assistant',order:2,content:'Old story.'}],Infinity,B).scene,null);
});

test('S6 lint warns on speech/decisions and ignores ordinary actions and NPC quotations',async () => {
 const {lintPlayerAgency,stripDialogue}=await use('turn-review.js');
 for(const text of ['You take the letter.','You nod once.','Krail watches you turn.','You reach the door.','Nera nods once.','Krail says, “You agree.”']) assert.equal(lintPlayerAgency(text,'Mira').length,0,text);
 for(const text of ["You say, 'fine.'",'Then you decide to stay.','Nera Veyrath agrees.']) assert.ok(lintPlayerAgency(text,'Nera Veyrath').length,text);
 assert.equal(stripDialogue('“open quote\n\nYou decide.'),'\n\nYou decide.');
 assert.equal(stripDialogue("It's morning."),"It's morning.");
});

test('S8 scene validation retains unsupported known values and recognizes progression',() => {
 const prior=api.parseScene(B.replace('night','afternoon'));
 const result=api.validateSceneValues(B.replace('Day 2','Day 3').replace('night','dawn'),{prior,narration:'The third day dawns.'});
 assert.equal(api.parseScene(result.scene).when,'Day 3'); assert.equal(api.parseScene(result.scene).time,'dawn');
 for(const narration of ['He remembered last night.','Nothing establishes the clock.']) {
  const result=api.validateSceneValues(B,{prior,narration});assert.equal(api.parseScene(result.scene).time,'afternoon');assert.equal(result.sceneMeta.provenance.time,'kept');
 }
});

test('S11 recovery parses fenced JSON, canonicalizes names, drops unevidenced attendees and disables reasoning explicitly',async () => {
 const r=await use('scene-recovery.js');
 const obj={date:'Day 2',time:'10:30',place:'Inn',present:['mira','Stranger','Kael'],planThread:null};
 const result=r.parseRecovery('```json\n'+JSON.stringify(obj)+'\n```',{names:['Mira'],narration:'At 10:30, Kael enters.',userText:'Day 2',prior:null});
 assert.equal(result.scene,B.replace('night','10:30'));assert.equal(r.parseRecovery('garbage',{}),null);
});
const classification=[
 ['<ad>When they reach the gate, have the guard stop them.</ad>','narrative'],
 ['<ad>How about a time skip to evening.</ad>','narrative'],
 ['<ad>Which path does she take? Write it.</ad>','narrative'],
 ['OOC: nice! Anyway I draw my sword.','narrative'],
 ['(OOC: who is here?)','ooc'],['[OOC: who is here?]','ooc'],['((who is here?))','ooc'],['OOC - who is here?','ooc'],
 ['<ad>Continue the hearing. Have Krail leave the room.</ad>','narrative'],
 ['<ad>Have Bastian Krail leave the room.</ad>','narrative'],
 ['<ad>The door opens and Magerrett enters.</ad>','narrative'],
 ['<ad>Summarize what happened, then continue the hearing.</ad>','narrative'],
 ['<ad>Answer OOC, then continue the hearing.</ad>','narrative'],
 ['<ad>What does Krail think?</ad> I ask him to leave.','narrative'],
 ['<ad>Who is physically present?</ad>','question'],['<ad>What does Mira believe?</ad>','question'],
 ['<ad>Can you summarize the hearing?</ad>','question'],['<ad>Summarize the scene.</ad>','question'],
 ['<ad>Answer OOC without advancing events.</ad>','ooc'],['<ooc>Explain the scene.</ooc>','ooc'],
 ['OOC: Who is present?','ooc'],['[OOC] Who is present?','ooc'],['I draw my sword.','narrative'],['(I nod.)','narrative'],
 ['<ad>What does Krail do when she enters?</ad>','question'],
];
for(const [i,[text,expected]] of classification.entries()) test(`S7 OOC fixture ${i+1}`,() => assert.equal(api.classifyUserInput(text),expected));

test('S2 obsolete extraction settings are ignored while invalid starting scenes remain recoverable',async () => {
 const {normalizeMemory}=await use('memory-settings.js');const mem=normalizeMemory({sceneMode:'separate',sceneExtractionModel:'x',startingScene:'Unreadable seed'});
 assert.equal('sceneMode' in mem,false);assert.equal('sceneExtractionModel' in mem,false);assert.equal(mem.startingScene,null);assert.equal(mem.startingSceneRaw,'Unreadable seed');
});

test('S11 only OpenRouter recovery requests explicitly disable reasoning and drop require_parameters',async () => {
 let request;
 const local=appHarness({stubs:{
  'llm-client.js':{chatCompletion:async opts => {request=opts;return {content:JSON.stringify({date:'unknown',time:'unknown',place:'Inn',present:[],planThread:null})};}},
  'tokenizer.js':{countTokens:async () => 10}
 }});
 const r=await local('scene-recovery.js');await r.recoverScene({endpoint:'https://openrouter.ai/api/v1/chat/completions',maxContextTokens:10000},{narration:'At the inn.',userText:'Continue.',names:[]});
 assert.equal(request.settings.reasoning.explicitDisable,true);assert.equal('require_parameters' in request.provider,false);
 const {buildRequestBody}=await use('llm-client.js');assert.equal(buildRequestBody(request.settings,[]).reasoning.enabled,false);
 assert.equal(buildRequestBody({...request.settings,endpoint:'https://example.test'},[]).reasoning,undefined);
});
