import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const history=(end='24/10/738',time='10:00')=>[
 {id:'u1',role:'user',order:1,revision:0,content:'Nera accepts responsibility for the stolen heirloom.'},
 {id:'a1',role:'assistant',order:2,revision:0,content:'The search begins.',scene:'date: 24/10/738 · time: 08:00 · place: Inn · present: Nera',sceneMeta:{kind:'manual'}},
 {id:'u2',role:'user',order:3,revision:0,content:'Nera returns the heirloom.'},
 {id:'a2',role:'assistant',order:4,revision:0,content:'The owner confirms its return.',scene:`date: ${end} · time: ${time} · place: Inn · present: Nera`,sceneMeta:{kind:'manual'}}
];
const op=(tag,messages,turn=tag==='open'?1:2,text=tag==='open'?'Nera accepts the search.':'The heirloom was returned.')=>({tag,book:'events',name:'Recover heirloom',section:'text',text,turn,src:turn*2,when:turn===1?'24/10/738':null,evidence:messages.slice(turn*2-2,turn*2).map(m=>({id:m.id,order:m.order,revision:0}))});
async function fixture(messages=history()) {
 const use=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async text=>Math.ceil(text.length/4)}}});
 const l=await use('lore-lines.js'),a=await use('thread-archive.js'),c=await use('continuity.js');
 const ctx={messages,session:{memory:{}},sourceRevision:0};
 const opened=l.applyOps([],[op('open',messages)],ctx),closed=l.applyOps(opened.entries,[op('closed',messages)],ctx);
 return {use,l,a,c,ctx,messages,opened,closed,entry:closed.entries[0]};
}
test('short-lived threads archive with opening and closure evidence; events stay independent',async()=>{
 const h=await fixture();assert.equal(h.a.archivedThread(h.entry),true);assert.equal(h.entry.threadMeta.outcome,'resolved');
 assert.equal(h.entry.threadHistory.opened.turn,1);assert.equal(h.entry.threadHistory.resolved.turn,2);assert.equal(h.closed.statusChanges[0].threadHistory.archive.reason,'short-lived');
 assert.equal(h.closed.creates.length,0);h.a.validateThreadHistory(h.entry.threadHistory);
 const events=h.l.applyOps(h.closed.entries,[{...op('event',h.messages),name:'Timeline',text:'Nera returned the stolen royal heirloom.'}],h.ctx);
 assert.equal(events.creates[0].kind,'timeline');assert.equal(events.creates[0].sections.text.lines[0].text,'Nera returned the stolen royal heirloom.');
 assert.equal(h.c.usableLore(events.entries,h.messages,{}).entries.length,1);
});
test('72-hour boundary and date precision never treat unknown or backwards time as a short duration',async()=>{
 for(const [date,time,expected] of [['27/10/738','07:59',true],['27/10/738','08:00',true],['27/10/738','08:01',false],['23/10/738','10:00',false],['24/10/738','07:59',false],['unknown','unknown',false],['26/10/738','unknown',true],['27/10/738','unknown',false],['1/11/738','10:00',false]]) {
  const h=await fixture(history(date,time));assert.equal(h.a.archivedThread(h.entry),expected,date+' '+time);
 }
 const h=await fixture(),dateOnly={date:'24/10/738',time:null};
 assert.equal(h.a.shortThreadDuration(dateOnly,{date:'26/10/738',time:null}),true);
 assert.equal(h.a.shortThreadDuration(dateOnly,{date:'27/10/738',time:null}),false);
});
test('authored and legacy threads are never enrolled; incidental tracked threads archive unresolved',async()=>{
 const h=await fixture();
 for(const extra of [{createdFrom:'user'}, {createdFrom:'auto'}, {createdFrom:'import'}]) {
  const e=h.l.makeEntry('events','Recover heirloom',{kind:'thread',status:'open',...extra});
  const changed=h.l.applyOps([e],[op('closed',h.messages)],h.ctx);assert.equal(changed.entries[0].threadHistory,undefined);
 }
 const background=h.l.applyOps(h.opened.entries,[op('background',h.messages)],h.ctx).entries[0];
 assert.equal(background.threadHistory.archive.reason,'incidental');assert.equal(background.threadMeta.outcome,'background-unresolved');
 const authored=structuredClone(h.opened.entries[0]);authored.sections.text.text='Author goal.';
 assert.equal(h.l.applyOps([authored],[op('closed',h.messages)],h.ctx).entries[0].threadHistory.archive,null);
});
test('edited, deleted and regeneration-hidden evidence disables archival without mutating saved cards',async()=>{
 const h=await fixture(),raw=JSON.stringify(h.entry);
 for(const messages of [h.messages.map(m=>m.id==='u1'?{...m,revision:1}:m),h.messages.filter(m=>m.id!=='a1')]) {
  assert.equal(h.c.usableLore([h.entry],messages,{}).entries.length,1);
  const result=h.l.applyOps(h.opened.entries,[op('closed',h.messages)],{...h.ctx,messages});assert.equal(h.a.archivedThread(result.entries[0]),false);
 }
 assert.equal(h.c.usableLore([h.entry],h.messages,{},4).entries.length,1);
 assert.equal(JSON.stringify(h.entry),raw);
});
test('restore preserves outcome, guards against immediate re-archival and reopening needs newer evidence',async()=>{
 const h=await fixture(),restored=h.a.restoreThreadArchive(h.entry);
 assert.equal(restored.threadMeta.outcome,'resolved');assert.equal(restored.status,'closed');assert.equal(restored.threadHistory.restored,true);
 assert.equal(h.a.archivedThread(h.l.applyOps([restored],[op('closed',h.messages,2,'Confirmed resolved again.')],h.ctx).entries[0]),false);
 const repeat=h.l.applyOps([h.entry],[op('open',h.messages)],h.ctx);assert.equal(repeat.skipped[0].reason,'archived thread needs new evidence');assert.equal(h.a.archivedThread(repeat.entries[0]),true);
 const messages=[...h.messages,{id:'u3',order:5,revision:0,role:'user',content:'Nera accepts a renewed search after the heirloom is stolen again.'},{id:'a3',order:6,revision:0,role:'assistant',content:'The search resumes.'}];
 const duplicate=h.l.applyOps([h.entry],[op('open',messages,3,'Nera accepts the search.')],{...h.ctx,messages});assert.equal(duplicate.entries[0].status,'closed');assert.equal(h.a.archivedThread(duplicate.entries[0]),true);
 const renewed=h.l.applyOps([h.entry],[{...op('open',messages,3,'Nera accepts a renewed search after a new theft.'),threadMeta:{kind:'ongoing',dueDate:null,dueTime:null,participants:['Nera'],location:null,outcome:null}}],{...h.ctx,messages});
 assert.equal(renewed.creates.length,0);assert.equal(h.a.archivedThread(renewed.entries[0]),false);assert.equal(renewed.entries[0].threadHistory.opened.turn,3);
});
test('archive identities are supplied only for extractor deduplication; custom prompts keep mandatory rules',async()=>{
 const h=await fixture(),p=await h.use('memory-prompts.js'),m=await h.use('memory-settings.js'),settings=await h.use('story-settings.js');
 const range={assistants:[{...h.messages[3],turn:2}],messages:h.messages.slice(2),fromTurn:2,toTurn:2};
 const built=await p.buildExtractionMessages({settings:{...settings.defaultStorySettings(),maxContextTokens:40000,memoryExtractionPrompt:'CUSTOM EXTRACTOR'},mem:m.normalizeMemory({protagonist:'Nera'}),entries:[h.entry],messages:h.messages,range,count:async t=>Math.ceil(t.length/4)});
 assert.ok(built.messages[0].content.startsWith('CUSTOM EXTRACTOR'));assert.match(built.messages[0].content,/direct involvement/);assert.match(built.messages[0].content,/Nera asks for water/);
 assert.match(built.messages[1].content,/ARCHIVED THREAD IDENTITIES/);assert.match(built.messages[1].content,/Recover heirloom/);assert.doesNotMatch(built.messages[1].content,/Nera accepts the search\./);
});
for(const records of [false,true])test(`archived threads cannot enter actual ${records?'record':'legacy'} narrator payloads through mentions, links or pins`,async()=>{
 const h=await fixture(),b=await h.use('context-builder.js'),m=await h.use('memory-settings.js'),s=await h.use('story-settings.js'),r=await h.use('lore-records.js');
 const entry=structuredClone(h.entry);entry.alwaysLoad=true;entry.sections.text.text='ARCHIVED_THREAD_SECRET';
 let entries=[entry];if(records){entries=entries.map(e=>r.reconcileRecords(e));for(const record of entries[0].recordLayout.records){record.pinned=true;record.triggers=['heirloom'];record.relatedEntryIds=['nera'];}}
 const messages=[...h.messages,{id:'u3',role:'user',order:5,revision:0,content:'Nera asks about Recover heirloom.'}];
 const result=await b.buildContextForRequest({id:'s',memory:m.normalizeMemory({lorebooks:true,scene:true,protagonist:'Nera'}),...(records?{loreSchemaVersion:3}:{})},{...s.defaultStorySettings(),maxContextTokens:40000,maxResponseTokens:1000},{messages,loreEntries:entries});
 assert.doesNotMatch(result.apiMessages.map(m=>m.content).join('\n'),/ARCHIVED_THREAD_SECRET/);assert.equal(result.report.loaded.some(e=>e.entryId===entry.id),false);
});
test('archive lifecycle survives JSON, Markdown, single-card and record interchange',async()=>{
 const h=await fixture(),f=await h.use('lore-format.js'),r=await h.use('lore-records.js');
 for(const e of [f.fromJson(f.toJson([h.entry])).entries.find(e=>e.kind==='thread'),f.fromMarkdown(f.toMarkdown([h.entry])).entries.find(e=>e.kind==='thread'),f.parseCard(f.serializeCard(h.entry,{format:'json',storyId:'s'})).entry,f.parseCard(f.serializeCard(h.entry,{format:'md',storyId:'s'})).entry,r.fromRecordDocument(r.toRecordDocument(h.entry))]) {
  assert.equal(h.a.archivedThread(e),true);h.a.validateThreadHistory(e.threadHistory);
 }
 const invalid=r.toRecordDocument(h.entry);invalid.subject.threadHistory.archive.reason='delete';assert.throws(()=>r.fromRecordDocument(invalid),/archive reason/);
});

test('disabled Events and threads neither records nor archives generated cards',async()=>{
 const h=await fixture(),mem={books:{events:{on:false}}};
 const changed=h.l.applyOps(h.opened.entries,[op('closed',h.messages)],{...h.ctx,mem});
 assert.equal(changed.statusChanges.length,0);assert.equal(changed.entries[0].status,'open');assert.equal(changed.entries[0].threadHistory.archive,null);
 const parsed=h.l.parseMemoryLines('T2 [open] Minor errand | Nera gets water.',{mem,messages:h.messages,range:{fromTurn:2,toTurn:2,assistants:[{...h.messages[3],turn:2}]}});assert.equal(parsed.ops.length,0);
});

test('thread list keeps archives separate from open, closed and all filters',async()=>{
 const h=await fixture();for(const filter of ['open','closed','all'])assert.equal(h.a.threadMatchesFilter(h.entry,filter),false);
 assert.equal(h.a.threadMatchesFilter(h.entry,'archived'),true);
 const restored=h.a.restoreThreadArchive(h.entry);assert.equal(h.a.threadMatchesFilter(restored,'closed'),true);assert.equal(h.a.threadMatchesFilter(restored,'all'),true);assert.equal(h.a.threadMatchesFilter(restored,'archived'),false);
});

test('Restore control stages a recoverable change and preserves the resolved outcome',async()=>{
 const h=await fixture(),item=structuredClone(h.entry);let changes=0;
 const node=(tag,text='')=>({tag,text,children:[],listeners:{},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},addEventListener(name,fn){this.listeners[name]=fn;}});
 const use=appHarness({stubs:{'ui/memory-ui.js':{node,field:(label,value)=>({wrap:node('label',label),input:{value,addEventListener(){}}})}}}),ui=await use('ui/thread-editor.js'),parent=node('div');
 ui.renderThreadEditor(parent,item,{onChange:()=>changes++});const archive=parent.children[0],restore=archive.children.find(n=>n.tag==='button');
 assert.match(archive.children[0].text,/resolved within three story days/);restore.listeners.click();
 assert.equal(changes,1);assert.equal(item.threadHistory.archive,null);assert.equal(item.status,'closed');assert.equal(item.threadMeta.outcome,'resolved');assert.match(archive.children[0].text,/Save to apply/);assert.ok(h.entry.threadHistory.archive);
});

test('cross-story card transfer keeps archive exclusion without depending on foreign history',async()=>{
 const h=await fixture(),f=await h.use('lore-format.js');
 const parsed=f.parseCard(f.serializeCard(h.entry,{format:'json',storyId:'original'}));
 const imported=f.planCardImport([],parsed,{storyId:'destination'}).data;
 assert.equal(imported.threadHistory.opened.by,'import');assert.equal(imported.threadHistory.opened.evidence.length,0);
 assert.equal(h.c.usableLore([imported],[],{}).entries.length,0);
});
