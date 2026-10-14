import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const count=async text=>text.length;
async function setup() {
  const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'messages.js':{getMessages:async()=>{throw Error('Unexpected history read');}}}});
  return {use,plan:await use('scheduled-plan.js'),l:await use('lore-lines.js'),f:await use('lore-format.js'),r:await use('lore-records.js'),b:await use('context-builder.js')};
}
function event(h,name='Festival') {
  const e=h.l.makeEntry('plan',name,{schedule:{start:'1/10/738',end:'20/10/738',status:'pending',phases:[
    {id:'intro',title:'Introduction',start:'1/10/738',end:'5/10/738',text:'INTRO_A_B_C',status:'pending'},
    {id:'middle',title:'Development',start:'6/10/738',end:'12/10/738',text:'DEVELOPMENT',status:'pending'},
    {id:'climax',title:'Climax',start:'13/10/738',end:'18/10/738',text:'CLIMAX',status:'pending'},
    {id:'closing',title:'Closing',start:'19/10/738',end:'20/10/738',text:'CLOSING',status:'pending'},
  ]}});e.id='festival';e.sections.text.text='SHARED_OVERVIEW';return e;
}
test('phases use inclusive dates, seven-day previews and explicit completion',async()=>{
  const h=await setup(),e=event(h),before=JSON.stringify(e);
  assert.deepEqual(plain(h.plan.selectScheduledPlan([e],'1/10/738').selected.map(x=>[x.phase.id,x.reason])),[['intro','active'],['middle','upcoming']]);
  assert.equal(h.plan.selectScheduledPlan([e],'5/10/738').selected[0].phase.id,'intro');
  assert.deepEqual(plain(h.plan.selectScheduledPlan([e],'6/10/738').selected.map(x=>[x.phase.id,x.reason])),[['middle','active'],['intro','overdue'],['climax','upcoming']]);
  assert.equal(JSON.stringify(e),before);
  e.schedule.phases[0].status='completed';assert.ok(!h.plan.selectScheduledPlan([e],'6/10/738').selected.some(x=>x.phase.id==='intro'));
  assert.ok(h.plan.selectScheduledPlan([e],'21/10/738').selected.every(x=>x.reason==='overdue'));
  e.schedule.status='completed';assert.equal(h.plan.selectScheduledPlan([e],'6/10/738').selected.length,0);
  e.schedule.status='pending';assert.equal(h.plan.selectScheduledPlan([e],'6/10/738').selected[0].phase.id,'middle');
});
test('unphased plans, overlaps, backward corrections, date gaps and invalid dates',async()=>{
  const h=await setup(),e=event(h);e.schedule.phases=[];e.schedule.start='20/10/738';e.schedule.end='30/10/738';
  assert.equal(h.plan.selectScheduledPlan([e],'12/10/738').selected.length,0);
  assert.equal(h.plan.selectScheduledPlan([e],'13/10/738').selected[0].reason,'upcoming');
  assert.equal(h.plan.selectScheduledPlan([e],'30/10/738').selected[0].reason,'active');
  assert.equal(h.plan.selectScheduledPlan([e],'31/10/738').selected[0].reason,'overdue');
  assert.equal(h.plan.selectScheduledPlan([e],'25/10/738').selected[0].reason,'active');
  const phases=event(h);phases.schedule.phases[1].start='5/10/738';assert.equal(h.plan.selectScheduledPlan([phases],'5/10/738').selected.filter(x=>x.reason==='active').length,2);
  for(const range of [{start:'31/12/738',end:'2/1/739'},{start:'28/2/740',end:'1/3/740'}])assert.doesNotThrow(()=>h.plan.validateSchedule({...range,status:'pending',phases:[]}));
  for(const range of [{start:'29/2/738',end:'1/3/738'},{start:'30/10/738',end:'20/10/738'}])assert.throws(()=>h.plan.validateSchedule({...range,status:'pending',phases:[]}));
  phases.schedule.phases[0].start='30/9/738';assert.throws(()=>h.plan.validateSchedule(phases.schedule),/within/);
});
test('unknown date excludes scheduled instructions with actionable warning',async()=>{
  const h=await setup(),selection=h.plan.selectScheduledPlan([event(h)],'Day 5');
  assert.equal(selection.selected.length,0);assert.match(selection.warnings[0],/Starting scene/);
  assert.equal(selection.skipped[0].reason,'story date unavailable');
});
test('whole phases fit under budget, share overview once, and skip oversized phases',async()=>{
  const h=await setup(),e=event(h),selected=h.plan.selectScheduledPlan([e],'6/10/738');
  const all=await h.plan.fitScheduledPlan(selected.selected,10000,count);assert.equal(all.text.split('SHARED_OVERVIEW').length-1,1);assert.equal(all.tokens,all.text.length);assert.doesNotMatch(all.text,/CLOSING/);
  const cap=h.plan.PLAN_HEADER.length+200,fit=await h.plan.fitScheduledPlan(selected.selected,cap,count);assert.ok(fit.tokens<=cap);assert.ok(fit.skipped.length);
  e.schedule.phases[1].text='X'.repeat(10000);const smaller=await h.plan.fitScheduledPlan(h.plan.selectScheduledPlan([e],'6/10/738').selected,1000,count);assert.ok(smaller.included.some(x=>x.phase.id==='intro'));assert.doesNotMatch(smaller.text,/XXXXXXXX/);
});
test('confirmed time skips include interval phases and the destination preview',async()=>{
  const h=await setup(),e=event(h),jump=h.plan.validatePlanJump({from:'1/10/738',to:'19/10/738'});
  assert.equal(h.plan.selectScheduledPlan([e],jump.from,jump).selected.length,4);
  for(const to of ['1/10/738','30/9/738','31/4/738'])assert.throws(()=>h.plan.validatePlanJump({from:'1/10/738',to}));
});
for(const records of [false,true])for(const format of ['md','json'])test(`plan ${format} round trip with phases in ${records?'record':'legacy'} mode`,async()=>{
  const h=await setup(),original=event(h),e=records?h.r.reconcileRecords(original):original;
  e.schedule.phases[0].text='A\n## escaped heading\n<!-- nera-phase: literal -->';e.schedule.phases[1].status='completed';
  const text=format==='md'?h.f.toMarkdown([e],{books:['plan']}):h.f.toJson([e],{books:['plan']});
  const parsed=format==='md'?h.f.fromMarkdown(text):h.f.fromJson(text);assert.deepEqual(plain(parsed.entries[0].schedule),plain(e.schedule));assert.deepEqual(plain(parsed.books),['plan']);
  const imported=h.f.planImport([],parsed,{book:'plan'}).writes[0].data;assert.deepEqual(plain(imported.schedule),plain(e.schedule));
  assert.equal(h.f.planImport([imported],parsed,{book:'plan'}).writes.length,0);
  for(const cardFormat of ['md','json']) {const card=h.f.parseCard(h.f.serializeCard(e,{format:cardFormat}));assert.deepEqual(plain(card.entry.schedule),plain(e.schedule));assert.deepEqual(plain(h.f.planCardImport([],card).data.schedule),plain(e.schedule));}
  assert.deepEqual(plain(h.r.fromRecordDocument(h.r.toRecordDocument(e)).schedule),plain(e.schedule));
});
test('merge conflicts preserve mine, accept file, or retain both phase variants',async()=>{
  const h=await setup(),mine=event(h),file=structuredClone(mine);file.schedule.phases[0].text='OTHER_INTRO';
  const parsed=h.f.fromJson(h.f.toJson([file],{books:['plan']}));
  assert.equal(h.f.planImport([mine],parsed,{book:'plan',conflict:'mine'}).writes.length,0);
  assert.equal(h.f.planImport([mine],parsed,{book:'plan',conflict:'file'}).writes[0].data.schedule.phases[0].text,'OTHER_INTRO');
  const both=h.f.planImport([mine],parsed,{book:'plan',conflict:'both'}).writes[0].data;assert.equal(both.schedule.phases.length,5);h.plan.validateSchedule(both.schedule);assert.equal(h.f.planImport([both],parsed,{book:'plan',conflict:'both'}).writes.length,0);
});
test('empty plan exports remain explicitly scoped in legacy and record stories',async()=>{
  const h=await setup(),other=h.r.reconcileRecords(h.l.makeEntry('facts','Other'));
  for(const entries of [[],[other]])for(const format of ['json','md']) {
    const text=format==='json'?h.f.toJson(entries,{books:['plan']}):h.f.toMarkdown(entries,{books:['plan']});
    const parsed=format==='json'?h.f.fromJson(text):h.f.fromMarkdown(text);assert.deepEqual(plain(parsed.books),['plan']);
    const replaced=h.f.planImport([event(h),other],parsed,{book:'plan',mode:'replace'});assert.equal(replaced.writes.length,1);assert.equal(replaced.writes[0].id,'festival');assert.equal(replaced.writes[0].delete,true);
  }
});
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:18000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:4};
function story() {return {id:'s',longTermPlan:'FIXED_UNDATED_GOAL',memory:{scene:true,lorebooks:true,calendar:{mode:'modern',anchor:'Friday 21/10/738'},startingScene:'date: 1/10/738 · time: 10:00 · place: Hall · present: Mira',books:{plan:{on:true,budget:5000}}}};}
const history=[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Morning.',scene:'date: 1/10/738 · time: 10:00 · place: Hall · present: Mira'},{id:'next',order:3,role:'user',content:'Proceed.'}];
for(const recordMode of [false,true])test(`serialized context gates phases and accounts budget in ${recordMode?'record':'legacy'} mode`,async()=>{
  const h=await setup(),entry=event(h),session=story();if(recordMode)session.loreSchemaVersion=3;
  const entries=[recordMode?h.r.reconcileRecords(entry):entry],before=JSON.stringify({entries,session,history});
  const result=await h.b.buildContextForRequest(session,settings,{messages:history,loreEntries:entries,includeInspection:true});
  const wire=result.apiMessages.map(m=>m.content).join('\n');assert.match(wire,/INTRO_A_B_C/);assert.match(wire,/DEVELOPMENT/);assert.doesNotMatch(wire,/CLIMAX|CLOSING/);assert.match(wire,/FIXED_UNDATED_GOAL/);
  assert.equal(result.usedTokens,8+result.apiMessages.reduce((n,m)=>n+m.content.length+8,0));assert.ok(result.report.blocks.find(x=>x.key==='plan').tokens<=5000);assert.match(result.inspection.sections.plan,/SHARED_OVERVIEW/);assert.equal(result.report.loaded.filter(x=>x.book==='plan').length,2);
  assert.equal(JSON.stringify({entries,session,history}),before);
  const inspected=await h.b.buildContextForRequest(session,settings,{messages:history,loreEntries:entries});assert.deepEqual(plain(inspected.apiMessages),plain(result.apiMessages));
  session.memory.books.plan.on=false;const off=await h.b.buildContextForRequest(session,settings,{messages:history,loreEntries:entries});assert.doesNotMatch(JSON.stringify(off.apiMessages),/INTRO_A_B_C|DEVELOPMENT/);
});
test('Retry and regeneration replay saved jump; Continue and later drafts do not repeat it',async()=>{
  const h=await setup(),session=story(),entries=[event(h)],jump={from:'1/10/738',to:'19/10/738'},messages=structuredClone(history);messages[2].planJump=jump;
  const a=await h.b.buildContextForRequest(session,settings,{messages,loreEntries:entries}),retry=await h.b.buildContextForRequest(session,settings,{messages,loreEntries:entries});assert.deepEqual(plain(a.apiMessages),plain(retry.apiMessages));assert.match(JSON.stringify(a.apiMessages),/CLOSING|AUTHOR-CONFIRMED TIME SKIP/);
  const later=[...messages,{id:'end',order:4,role:'assistant',content:'Arrived.',scene:'date: 19/10/738 · time: 12:00 · place: Hall · present: Mira'}];
  const regen=await h.b.buildContextForRequest(session,settings,{messages:later,loreEntries:entries,upToOrder:4});assert.deepEqual(plain(regen.apiMessages),plain(a.apiMessages));
  const continuation=await h.b.buildContextForRequest(session,settings,{messages:later,loreEntries:entries,continuationId:'end'});assert.doesNotMatch(JSON.stringify(continuation.apiMessages),/AUTHOR-CONFIRMED TIME SKIP/);
  const draft=await h.b.buildContextForRequest(session,settings,{messages:later,loreEntries:entries,draftText:'Talk.'});assert.doesNotMatch(JSON.stringify(draft.apiMessages),/AUTHOR-CONFIRMED TIME SKIP/);
  const preview=await h.b.buildContextForRequest(session,settings,{messages:history,loreEntries:entries,draftText:'Skip.',draftPlanJump:jump});assert.match(JSON.stringify(preview.apiMessages),/CLOSING/);
});
