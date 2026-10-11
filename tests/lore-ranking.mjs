import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';
const plain = value => JSON.parse(JSON.stringify(value));
async function setup() {
  const calls=[];
  const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('unexpected history read');}},'tokenizer.js':{countTokens:async text=>text.length}},globals:{fetch:async(url,opts)=>{
    if(!opts?.body)return promptFetch(url,opts);
    calls.push(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'Local fixture.'},finish_reason:'stop'}]})};
  }}});
  const lore=await use('lore-lines.js'),select=await use('lore-select.js'),memory=await use('memory-settings.js');
  const card=(book,name,id,opts={})=>lore.makeEntry(book,name,{id,...opts});
  const mem=memory.normalizeMemory({lorebooks:true,books:{characters:{maxCards:1},locations:{maxCards:1}}});
  return {use,calls,card,select,mem};
}
const ids = (s,book) => Array.from(s.selected[book],x=>x.entry.id);
test('each book ranks message order and final occurrence equally for user and narrator, independent of entry order',async()=>{
  const h=await setup();
  for(const book of ['characters','locations','facts','events']) {
    const entries=[h.card(book,'Mira','a',{kind:'thread'}),h.card(book,'Kael','b',{kind:'thread'})];
    for(const role of ['user','assistant'])for(const content of ['Mira, then Kael','Mira, Kael, Mira'])for(const reversed of [false,true]) {
      const s=h.select.selectEntries(reversed ? [...entries].reverse() : entries,h.mem,'',null,'',{current:[],recent:[{id:'new',order:7,role,content},{id:'old',order:6,role:role==='user'?'assistant':'user',content:'Kael Mira Mira Mira'}]});
      const winner=content.endsWith('Mira')?'a':'b';assert.equal(ids(s,book)[0],winner);
      assert.deepEqual(plain(s.selected[book][0].ranking),{rank:1,priorityReason:'recent mention',mention:{messageId:'new',order:7,role,offset:content.lastIndexOf(winner==='a'?'Mira':'Kael')}});
      if(['characters','locations'].includes(book)){assert.equal(s.selected[book].length,1);assert.match(s.skipped[0].reason,/card limit/);assert.equal(s.skipped[0].ranking.rank,2);}
    }
    const s=h.select.selectEntries(entries,h.mem,'',null,'',{current:[],recent:[{id:'a',order:1,role:'user',content:'Mira'},{id:'b',order:2,role:'assistant',content:'Kael'}]});assert.equal(ids(s,book)[0],'b');
  }
});
test('scene priority, reserved cards, scene-list order and stable ties survive shuffled entries',async()=>{
  const h=await setup(),entries=[h.card('characters','Mira','mira'),h.card('characters','Kael','kael'),h.card('characters','Nera','pc'),h.card('characters','Roster','always',{alwaysLoad:true})];h.mem.protagonist='Nera';
  for(const list of [entries,[...entries].reverse()])for(const present of [['Mira','Kael'],['Kael','Mira']]) {
    const s=h.select.selectEntries(list,h.mem,'Nera', {present},'',{current:{id:'draft',order:3,role:'user',content:'Nera'},recent:[{id:'last',order:2,role:'assistant',content:'Kael Mira'}]});
    assert.deepEqual(ids(s,'characters'),['always','pc','mira']);assert.equal(s.selected.characters[2].reason,'in scene');
    assert.equal(h.select.selectEntries(list,h.mem,'', {present},'',{current:[],recent:[]}).selected.characters[2].entry.id,'kael');
  }
  const locations=[h.card('locations','Harbor','harbor'),h.card('locations','Inn','inn')];assert.deepEqual(ids(h.select.selectEntries(locations,h.mem,'Harbor',{place:'Inn'}),'locations'),['inn']);
});
test('world facts prioritize scene, current and recent mentions over timestamp fallback under a tight budget',async()=>{
  const h=await setup(),entries=['Scene law','Draft law','Recent law','Other law'].map((name,i)=>h.card('facts',name,'f'+i));
  entries[3].sections.text.lines=[{id:'new',at:999,text:'Newest unmentioned fact.'}];
  const sources={current:{id:'draft',order:4,role:'user',content:'Draft law'},recent:[{id:'narrator',order:3,role:'assistant',content:'Recent law'}]};
  const s=h.select.selectEntries(entries,h.mem,'Draft law',{raw:'Scene law'},'',sources);assert.deepEqual(ids(s,'facts'),['f0','f1','f2','f3']);
  const recentOnly=h.select.selectEntries(entries,h.mem,'',null,'',{current:[],recent:sources.recent});
  const base=h.select.renderEntry(entries[2],new Set());const fit=await h.select.fitBook(recentOnly.selected.facts,base.length+2,async text=>text.length);
  assert.deepEqual(Array.from(fit.included,e=>e.entry.id),['f2']);assert.match(fit.text,/Recent law/);assert.equal(fit.skipped.find(e=>e.entryId==='f3').ranking.rank,2);
});
test('closed threads remain eligible; open fallback uses timestamps and ID; Timeline keeps special detail allocation',async()=>{
  const h=await setup(),closed=h.card('events','Lost Seal','closed',{kind:'thread',status:'closed'}),open=h.card('events','Map Quest','open',{kind:'thread'}),other=h.card('events','Key Quest','other',{kind:'thread'}),timeline=h.card('events','Timeline','timeline',{kind:'timeline'});
  const lines=(prefix,n,at)=>Array.from({length:n},(_,i)=>({id:prefix+i,text:prefix+i,at,turn:i+1}));
  closed.sections.text.lines=lines('closed-note-',4,1);open.sections.text.lines=lines('open-note-',4,10);other.sections.text.lines=lines('other-note-',4,5);timeline.sections.text.lines=lines('timeline-note-',2,1);
  const s=h.select.selectEntries([timeline,other,open,closed],h.mem,'',null,'',{current:[],recent:[{id:'a',order:2,role:'assistant',content:'Lost Seal'}]});
  assert.deepEqual(ids(s,'events'),['closed','open','other','timeline']);assert.equal(closed.status,'closed');
  const costs=async text=>(text.match(/(?:closed|open|other|timeline)-note-/g)??[]).length;
  const fit=await h.select.fitBook(s.selected.events,9,costs,{events:true});assert.equal(fit.included.find(e=>e.entry.id==='timeline').lineIds.size,2);assert.equal(fit.included.find(e=>e.entry.id==='closed').lineIds.size,2);
  assert.match(h.select.renderEventsBlock(fit),/Closed threads/);
});
test('shared occurrence matcher preserves aliases, first names, Unicode boundaries and overlapping longest names',async()=>{
  const h=await setup(),entries=[h.card('characters','Mira Vale','mira',{aliases:['Silver Fox']}),h.card('characters','Fox','fox'),h.card('characters','Élan','elan')],index=h.select.buildLoreIndex(entries);
  const text='Silver Fox, Mira; Élan! NotÉlan. Silver Fox';
  assert.deepEqual(Array.from(h.select.findMentions(text,index,'characters')),['mira','elan']);
  assert.deepEqual(Array.from(h.select.findMentionOccurrences(text,index,'characters'),m=>m.id),['mira','mira','elan','mira']);
  assert.equal(h.select.selectEntries(entries,h.mem,'Mira Fox Mira',null).selected.characters[0].entry.id,'mira');
  assert.equal(h.select.selectEntries(entries,h.mem,'',null,'Mira Fox').selected.characters[0].entry.id,'fox');
});
test('both character fitters serialize admitted cards and capture ranking evidence across draft, regeneration and continuation',async()=>{
  const h=await setup(),builder=await h.use('context-builder.js'),client=await h.use('llm-client.js');
  const entries=[h.card('characters','Mira','mira'),h.card('characters','Kael','kael')];for(const e of entries)e.sections.notes.text='UNIQUE_'+e.id;
  const settings={narratorSystemPrompt:'Narrate.',modelId:'test',endpoint:'https://mock.test',apiKey:'mock',streaming:false,maxContextTokens:10000,maxResponseTokens:500};
  const messages=[{id:'u1',order:1,role:'user',content:'Opening.'},{id:'a1',order:2,role:'assistant',content:'Mira.'},{id:'u2',order:3,role:'user',content:'Wait.'},{id:'a2',order:4,role:'assistant',content:'Mira, Kael.'}];
  for(const characterSelection of [false,true]) {
    const session={id:'s',memory:{lorebooks:true,characterSelection,loreLookbackMessages:2,books:{characters:{maxCards:1,budget:1000}}}};
    const build=opts=>builder.buildContextForRequest(session,settings,{messages,loreEntries:entries,...opts});
    const built=await build({draftText:'Quiet.'});assert.equal(built.report.loaded[0].entryId,'kael');assert.equal(built.report.loaded[0].ranking.mention.messageId,'a2');
    let captured;await client.chatCompletion({settings,messages:built.apiMessages,onRequest:serialized=>{captured=structuredClone({requestBody:JSON.parse(serialized),report:built.report});}});
    const wire=JSON.stringify(captured.requestBody);assert.match(wire,/UNIQUE_kael/);assert.doesNotMatch(wire,/UNIQUE_mira|priorityReason|messageId|ranking/);assert.equal(captured.report.skipped.find(e=>e.entryId==='mira').ranking.rank,2);
    const saved=JSON.stringify(captured);built.report.loaded[0].ranking.mention.offset=-1;assert.equal(JSON.stringify(captured),saved);
    const regen=await build({upToOrder:4});assert.equal(regen.report.loaded[0].entryId,'mira');assert.equal(regen.report.loaded[0].ranking.mention.messageId,'a1');
    const cont=await build({continuationId:'a2'});assert.equal(cont.report.loaded[0].entryId,'kael');assert.equal(cont.report.loaded[0].ranking.mention.messageId,'a2');
    const draft=await build({draftText:'Kael, Mira'});assert.equal(draft.report.loaded[0].entryId,'mira');assert.equal(draft.report.loaded[0].ranking.mention.messageId,'__memory_draft');
    const tiny=await builder.buildContextForRequest({...session,memory:{...session.memory,books:{characters:{maxCards:1,budget:0}}}},settings,{messages,loreEntries:entries,draftText:'Mira'});assert.equal(tiny.report.loaded.length,0);assert.equal(tiny.report.skipped.find(e=>e.entryId==='mira').ranking.rank,1);assert.match(tiny.report.skipped.find(e=>e.entryId==='mira').reason,/over budget/);
  }
});

test('an oversized higher-ranked card can be skipped for a smaller card with its original rank intact',async()=>{
  const h=await setup(),large=h.card('locations','Grand Palace','large'),small=h.card('locations','Hut','small');large.sections.description.text='Long canon. '.repeat(100);
  h.mem.books.locations.maxCards=2;
  const s=h.select.selectEntries([small,large],h.mem,'Hut then Grand Palace',null);
  const fit=await h.select.fitBook(s.selected.locations,50,async text=>text.length);
  assert.deepEqual(Array.from(fit.included,e=>e.entry.id),['small']);assert.equal(fit.included[0].ranking.rank,2);assert.equal(fit.skipped[0].entryId,'large');assert.equal(fit.skipped[0].ranking.rank,1);
});
