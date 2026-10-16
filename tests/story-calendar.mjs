import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const use=appHarness({stubs:{"messages.js":{getMessages:async()=>[]},"sessions.js":{getSession:async()=>null}}}),calendar=await use('story-calendar.js'),scene=await use('scene.js');
const anchor={mode:'modern',anchor:'Friday 21/10/738'};
const prior={when:'Friday 21/10/738',time:'15:40',place:'Hall',present:['Mira']};
const raw=(date,time)=>`date: ${date} · time: ${time} · place: Hall · present: Mira`;
function check(date,time,options={}) {return scene.validateSceneValues(raw(date,time),{calendar:anchor,prior,...options});}
test('author weekdays, early years and Gregorian leap rules are independent of machine timezone',()=>{
  for(const [date,weekday] of [['21/10/738','Friday'],['22/10/738','Saturday'],['20/10/738','Thursday'],['28/10/738','Friday']])assert.equal(calendar.formatStoryDate(calendar.parseStoryDate(date),anchor),weekday+' '+date);
  for(const [date,valid] of [['29/2/740',true],['29/2/738',false],['29/2/1900',false],['29/2/2000',true],['31/4/738',false],['1/1/1',true]])assert.equal(calendar.parseStoryDate(date).valid,valid);
  assert.equal(calendar.parseStoryDate('Friday 21/10/738').ordinal,calendar.parseStoryDate('0738-10-21').ordinal);
});
test('modern output canonicalizes equivalent dates and AM/PM clocks',()=>{
  const r=check('October 21, 738','3:40 PM');assert.equal(r.scene,raw('Friday 21/10/738','15:40'));assert.equal(r.sceneMeta.provenance.time,'prior');
  assert.equal(check('21/10/738','15:50').scene,raw('Friday 21/10/738','15:50'));
});
for(const [date,time] of [['Friday 21/10/738','25:99'],['31/4/738','15:40'],['Saturday 21/10/738','15:40'],['Friday 21/10/738','15:40:30'],['Friday 21/10/738','3:70 PM']])test(`invalid timestamp ${date} ${time} retains both prior fields`,()=>{
  const r=check(date,time);assert.equal(r.scene,raw(prior.when,prior.time));assert.equal(r.sceneMeta.provenance.date,'contradicted');assert.ok(r.warnings.length);
});
test('elapsed minutes cross midnight with date and weekday together',()=>{
  const old={...prior,time:'23:50'};
  assert.equal(check('Saturday 22/10/738','00:10',{prior:old,userText:'Wait for 20 minutes.'}).warnings.length,0);
  assert.equal(check('Friday 21/10/738','00:10',{prior:old,userText:'Wait for 20 minutes.'}).scene,raw('Saturday 22/10/738','00:10'));
  assert.equal(check('Saturday 22/10/738','00:20',{prior:old,userText:'Wait for twenty minutes.'}).scene,raw(old.when,old.time));
});
test('combined hours and minutes obey elapsed arithmetic',()=>{
  assert.equal(check(prior.when,'17:10',{userText:'Wait for one hour and thirty minutes.'}).warnings.length,0);
  assert.ok(check(prior.when,'17:20',{userText:'Wait for one hour and thirty minutes.'}).warnings.length);
});
for(const [before,after] of [['31/10/738','1/11/738'],['31/12/738','1/1/739'],['28/2/740','29/2/740'],['29/2/740','1/3/740']])test('midnight boundary '+before,()=>{
  const p={...prior,when:calendar.formatStoryDate(calendar.parseStoryDate(before),anchor),time:'23:55'};
  const r=check(after,'00:05',{prior:p,narration:'Ten minutes later, the wait ends.'});assert.equal(scene.parseScene(r.scene).when,calendar.formatStoryDate(calendar.parseStoryDate(after),anchor));assert.equal(r.warnings.length,0);
});
test('rejected date cannot keep a candidate midnight clock',()=>{
  const r=check('Friday 22/10/738','00:10',{prior:{...prior,time:'23:50'},userText:'Wait for twenty minutes.'});assert.equal(scene.parseScene(r.scene).time,'23:50');assert.equal(scene.parseScene(r.scene).when,prior.when);
});
test('OOC freezes the timestamp, and appointments and quoted dialogue are not elapsed evidence',()=>{
  assert.equal(check('Saturday 22/10/738','16:10',{ooc:true}).scene,raw(prior.when,prior.time));
  for(const text of ['Tomorrow the appointment will take 30 minutes.','She says, "We waited 30 minutes."'])assert.equal(check(prior.when,'15:45',{narration:text}).warnings.length,0);
});
test('backward movement needs a user correction with an explicit current timestamp',()=>{
  assert.ok(check(prior.when,'15:20').warnings.length);
  assert.equal(check(prior.when,'15:20',{userText:'Correction: it is Friday 21/10/738 at 15:20.'}).warnings.length,0);
  assert.ok(check(prior.when,'15:20',{userText:'Tomorrow the appointment is Friday 21/10/738 at 15:20.'}).warnings.length);
});
test('unknown precision stays unknown and invalid anchors cannot drive a request',()=>{
  assert.equal(scene.parseScene(check('unknown','unknown',{prior:null}).scene).time,null);
  assert.equal(scene.parseScene(check(prior.when,'15:40',{prior:null}).scene).time,null);
  assert.equal(scene.parseScene(check(prior.when,'15:20',{userText:'Correction: the current clock is 15:20.'}).scene).time,'15:20');
  assert.throws(()=>calendar.calendarInstruction({mode:'modern',anchor:'Friday 31/4/738'}),/anchor/);
});
test('story memory settings preserve the calendar without changing existing legacy requests',async()=>{
  const mem=await use('memory-settings.js'),builder=await use('context-builder.js');
  assert.equal(mem.normalizeMemory().calendar.mode,'legacy');
  assert.equal(JSON.stringify(mem.normalizeMemory({calendar:anchor}).calendar),JSON.stringify(anchor));
  const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:10000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:10};
  const messages=[{id:'u',role:'user',order:1,content:'Mira enters.'}],opts={messages,loreEntries:[]};
  const legacy=await builder.buildContextForRequest({id:'s',memory:{scene:true}},settings,opts);
  const modern=await builder.buildContextForRequest({id:'s',memory:{scene:true,calendar:anchor}},settings,opts);
  assert.doesNotMatch(JSON.stringify(legacy.apiMessages),/STORY CALENDAR/);assert.match(JSON.stringify(modern.apiMessages),/Friday 21\/10\/738/);
  assert.doesNotMatch(modern.apiMessages.at(-1).content,/Use descriptive times/);
  assert.match(modern.apiMessages.at(-1).content,/AFTER the final NPC line/);
  assert.match(modern.apiMessages.at(-1).content,/does not establish physical presence/);
  assert.match(legacy.apiMessages.at(-1).content,/Use descriptive times/);
  assert.equal(mem.normalizeMemory(JSON.parse(JSON.stringify({calendar:anchor}))).calendar.anchor,anchor.anchor);
});
test('modern reminder uses only established time and attendees, including AM/PM conversion and unknown precision',()=>{
  const text=calendar.modernSceneReminder(anchor,{...prior,time:'3:40 PM'},true);
  assert.match(text,/<scene>date: Friday 21\/10\/738 · time: 15:40 · place: Hall · present: Mira<\/scene>/);
  assert.match(text,/<plan_thread>/);assert.doesNotMatch(text,/present: Traveler/);
  assert.match(calendar.modernSceneReminder(anchor,null),/<scene>date: unknown · time: unknown · place: unknown · present: unknown<\/scene>/);
});
test('recovery validates modern timestamps through the same boundary',async()=>{
  const recovery=await use('scene-recovery.js');
  const context={calendar:anchor,prior:{scene:prior},names:['Mira'],narration:'They wait.',userText:'Wait 20 minutes.'};
  const reply=recovery.parseRecovery(JSON.stringify({date:prior.when,time:'16:00',place:'Hall',present:['Mira'],planThread:null}),context);
  assert.equal(reply.scene,raw(prior.when,'16:00'));assert.equal(reply.sceneMeta.kind,'inferred');
  assert.match(recovery.recoveryMessages(context)[0].content,/STORY CALENDAR/);
});

test('manual scene correction permits backward time but rejects invalid clocks and weekdays',()=>{
 assert.equal(scene.validateSceneEdit(raw('21/10/738','3:20 PM'),anchor),raw('Friday 21/10/738','15:20'));
 assert.throws(()=>scene.validateSceneEdit(raw('Saturday 21/10/738','15:20'),anchor),/weekday/);
 assert.throws(()=>scene.validateSceneEdit(raw('21/10/738','25:99'),anchor),/clock/);
});

for(const [before,after] of [['31/10/738','1/11/738'],['31/12/738','1/1/739'],['28/2/740','29/2/740'],['29/2/740','1/3/740']])test('stale same-date midnight tag automatically rolls '+before,()=>{
 const p={...prior,when:calendar.formatStoryDate(calendar.parseStoryDate(before),anchor),time:'23:55'};
 const r=check(p.when,'00:05',{prior:p,userText:'Wait ten minutes.'});assert.equal(scene.parseScene(r.scene).when,calendar.formatStoryDate(calendar.parseStoryDate(after),anchor));assert.equal(scene.parseScene(r.scene).time,'00:05');assert.equal(r.warnings.length,0);
});
test('midnight is next-day, future dates are not incremented twice, and unknown dates remain unknown',()=>{
 assert.equal(calendar.midnightRolloverDate('Friday 21/10/738','23:59','21/10/738','00:00'),'Saturday 22/10/738');
 assert.equal(calendar.midnightRolloverDate('21/10/738','23:59','22/10/738','00:10'),null);
 assert.equal(calendar.midnightRolloverDate(null,'23:59',null,'00:10'),null);
 assert.equal(calendar.midnightRolloverDate('21/10/738','15:40','21/10/738','15:30'),null);
});
