import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const api=await appHarness()('scene.js');
const raw=(time,date='October 738')=>`date: ${date} · time: ${time} · place: Hall · present: A`;
const prior=api.parseScene(raw('morning'));
for(const [time,narration,accepted,provenance] of [
 ['evening','They sat down to supper.','evening','narration'],
 ['evening','They reached the gates.','evening','declared'],
 ['night','The morning sun hit the table.','morning','contradicted'],
 ['evening','After breakfast they rode for hours.\n\nThe seventh bell rang as they reached the gates.','evening','declared'],
 ['night','They talked until dark.\n\nShe finished her breakfast in silence.','morning','contradicted'],
 ['evening','We ride tomorrow morning.','evening','declared'],
 ['afternoon','Evening bells rang.','afternoon','declared'],
 ['the seventh bell','The lamps were lit.','the seventh bell','declared'],
 ['evening','"Good morning," she said.','evening','declared']
])test(`F1 ${time}: ${narration}`,()=>{
 const result=api.validateSceneValues(raw(time),{prior,narration});
 assert.equal(api.parseScene(result.scene).time,accepted);assert.equal(result.sceneMeta.provenance.time,provenance);
 assert.equal(result.warnings.length,provenance==='contradicted'?1:0);
});
test('F1 classes use strong boundaries and exclude future cues',()=>{
 assert.deepEqual([...api.timeClassesIn('the afternoon light')],['afternoon']);
 assert.deepEqual([...api.timeClassesIn('over lunch')],['noon']);assert.equal(api.timeClassesIn('We ride tomorrow morning').size,0);
});
for(const [old,date,narration,expected,provenance] of [
 ['October 738','October 739','The next morning, he returned.','October 738','contradicted'],
 ['Day 9','Day 10','The next morning, he returned.','Day 10','narration'],
 ['14 October 738','15 October 738','The next morning, he returned.','15 October 738','narration'],
 ['October 738','14 October 738','He returned.','14 October 738','declared'],
 ['October 738','March 739','Five months later, the snow had gone.','March 739','narration'],
 [null,'October 738','He returned.','October 738','declared']
])test(`F1 date ${old} to ${date}`,()=>{
 const result=api.validateSceneValues(raw('morning',date),{prior:{when:old,time:'morning'},narration});
 assert.equal(api.parseScene(result.scene).when,expected);assert.equal(result.sceneMeta.provenance.date,provenance);
});
test('F1 missing prior accepts a model-declared clock',()=>{
 const result=api.validateSceneValues(raw('evening'),{narration:'They arrived.'});assert.equal(result.sceneMeta.provenance.time,'declared');
});
test('F1 old rejected fields become unknown only in effective history and carry forward',()=>{
 for(const key of ['time','date']) {
  const history=[{id:'a',role:'assistant',order:2,content:'Arrived.',scene:raw('morning'),sceneMeta:{kind:'declared',provenance:{[key]:'kept'}}},{id:'b',role:'assistant',order:4,content:'Waited.',sceneMeta:{kind:'carried'}}];
  const timeline=api.sceneTimeline(history);
  assert.match(timeline.get('a').effective,new RegExp(key+': unknown'));assert.equal(timeline.get('b').effective,timeline.get('a').effective);assert.equal(history[0].scene,raw('morning'));
  history[0].sceneMeta.provenance[key]='contradicted';assert.equal(api.sceneTimeline(history).get('a').effective,raw('morning'));
 }
});
test('F3 thinking extraction strips labels and takes the last filled candidate',()=>{
 assert.equal(api.sceneFromThinking(null),null);
 assert.equal(api.sceneFromThinking('Scene tag: '+raw('evening')+'\n<scene>'+raw('night')+'</scene>'),raw('night'));
 assert.equal(api.sceneFromThinking('Scene tag: date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME, FULL NAME'),null);
 assert.equal(api.parseScene(api.sceneFromThinking('Scene tag: '+raw('evening'))).when,'October 738');
});
test('E1 bracketed OOC notes yield to narrative continuation cues',()=>{
 assert.equal(api.classifyUserInput('(OOC: fix her name) and continue the scene (quietly)'),'narrative');
 assert.equal(api.classifyUserInput('[OOC: fix her name] and continue the scene [quietly]'),'narrative');
 assert.equal(api.classifyUserInput('(OOC: please (briefly) recap)'),'ooc');
 assert.equal(api.classifyUserInput('(OOC: brb) You draw the blade (quietly)'),'ooc');
});
test('F3 incomplete reasoning drafts do not replace an earlier filled candidate; explicit unknown is valid',()=>{
 const earlier=raw('evening');assert.equal(api.sceneFromThinking(earlier+'\nScene tag: date: October 738 · place:'),earlier);
 assert.equal(api.sceneFromThinking('Scene tag: date: unknown · time: evening · place: Hall · present: A'),'date: unknown · time: evening · place: Hall · present: A');
});
