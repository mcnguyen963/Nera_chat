import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
async function setup(){const use=appHarness();return {f:await use('lore-format.js'),l:await use('lore-lines.js')};}
function note(id,text='Old note'){return {id,text,turn:5,when:'Ngày 3',src:10,by:'auto',at:1,evidence:[{id:'msg',order:10,revision:0}],sourceRevision:2};}
for(const [book,kind] of [['characters','card'],['locations','card'],['facts','card'],['events','timeline'],['events','thread']])for(const format of ['md','json'])test(`${format} single ${book}/${kind} round trip preserves sections and provenance`,async()=>{
 const {f,l}=await setup(),e=l.makeEntry(book,kind==='timeline' ? 'Timeline' : 'Ánh 🌙',{kind,status:kind==='thread' ? 'closed' : null,aliases:['雪'],alwaysLoad:true,draft:true});
 const key=Object.keys(e.sections)[0];e.sections[key].text='Text\n# literal heading';e.sections[key].lines=[note('line','One\n# Two')];e.sections[key].kind='snapshot';e.sections[key].cutoff={turn:5,order:10};
 const parsed=f.parseCard(f.serializeCard(e,{format,storyId:'s'}));assert.equal(parsed.sourceStoryId,'s');assert.deepEqual(plain(parsed.entry),plain(e));
});
test('visible Markdown edits and deletions override note metadata; IDs survive edits',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Mira');e.sections.notes.lines=[note('one'),note('two','Remove me')];e.sections.appearance.text='Red hair';
 let text=f.serializeCard(e,{storyId:'s'}).replace('### Mira','### Renamed').replace('- [T5 · Ngày 3] Old note','- [T8 · Day 8] Edited note');
 text=text.replace('- [T5 · Ngày 3] Remove me\n','').replace(/#### Appearance\n[\s\S]*?(?=#### Status)/,'');
 const parsed=f.parseCard(text);assert.equal(parsed.entry.name,'Renamed');assert.equal(parsed.entry.sections.appearance.text,'');
 const lines=parsed.entry.sections.notes.lines;assert.equal(lines.length,1);assert.equal(lines[0].id,'one');assert.equal(lines[0].text,'Edited note');assert.equal(lines[0].turn,8);assert.equal(lines[0].when,'Day 8');assert.equal(lines[0].by,'user');assert.equal(lines[0].src,null);
 const plan=f.planCardImport([e],parsed,{targetId:e.id,storyId:'s'});assert.equal(plan.data.id,e.id);assert.equal(plan.data.sections.notes.lines.length,1);assert.equal(plan.preview.notes.edited.length,1);assert.equal(plan.preview.notes.removed.length,1);
});
test('replace removes missing sections and notes, preserves destination and creation time',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Before');e.createdAt={seconds:12,nanoseconds:4};e.sections.notes.lines=[note('one')];e.sections.appearance.text='Before';
 const source=l.makeEntry('characters','After');delete source.sections.appearance;
 const p=f.planCardImport([e],f.parseCard(f.serializeCard(source,{format:'json',storyId:'s'})),{targetId:e.id,storyId:'s'});
 assert.equal(p.data.name,'After');assert.equal(p.data.id,e.id);assert.deepEqual(plain(p.data.createdAt),plain(e.createdAt));assert.equal(p.data.sections.appearance.text,'');assert.equal(p.data.sections.notes.lines.length,0);
});
test('merge updates IDs, deduplicates content, retains omissions and honors conflict choices',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Before',{aliases:['Old'],alwaysLoad:true});e.sections.notes.text='Mine';e.sections.notes.lines=[note('one'),note('keep','Keep')];
 const src=structuredClone(e);src.name='After';src.aliases=['New'];src.alwaysLoad=false;src.sections.notes.text='File';src.sections.notes.lines=[note('one','Edited'),note('other','Keep'),note('new','New')];
 const parsed=f.parseCard(f.serializeCard(src,{format:'json',storyId:'s'}));
 for(const [conflict,text] of [['file','File'],['mine','Mine'],['both','Mine\n\nFile']]){const p=f.planCardImport([e],parsed,{targetId:e.id,storyId:'s',mode:'merge',conflict});assert.equal(p.data.sections.notes.text,text);assert.equal(p.data.sections.notes.lines.length,3);assert.equal(p.data.sections.notes.lines[0].id,'one');assert.equal(p.data.sections.notes.lines[0].by,'user');assert.equal(p.data.alwaysLoad,false);assert.deepEqual(plain(p.data.aliases),['Old','New']);const twice=f.planCardImport([p.data],parsed,{targetId:e.id,storyId:'s',mode:'merge',conflict:'file'});assert.equal(twice.data.sections.notes.lines.length,3);}
});
test('explicit destination survives rename; suggestion prefers same-story ID and exposes ambiguity',async()=>{
 const {f,l}=await setup(),a=l.makeEntry('characters','A'),b=l.makeEntry('characters','B');const src={...a,name:'B'},parsed=f.parseCard(f.serializeCard(src,{storyId:'s'}));
 assert.equal(f.suggestCardDestination([a,b],parsed,'s').suggestedId,a.id);assert.equal(f.planCardImport([a,b],parsed,{targetId:a.id,storyId:'s'}).data.id,a.id);
 a.aliases=['B'];parsed.sourceStoryId='other';const suggestion=f.suggestCardDestination([a,b],parsed,'s');assert.equal(suggestion.suggestedId,null);assert.equal(suggestion.matches.length,2);
});
test('cross-story creation refreshes IDs, removes evidence and snapshot cutoffs, keeps canon and readable stamps',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Mira');e.sections.status={text:'Wounded',lines:[{...note('one'),kind:'snapshot',cutoff:{order:10}}],origin:'auto',kind:'snapshot',cutoff:{order:10},unavailable:true,sourceRevision:2};e.statusSource=note('status');
 const parsed=f.parseCard(f.serializeCard(e,{format:'json',storyId:'other'})),p=f.planCardImport([],parsed,{storyId:'s'}),s=p.data.sections.status;
 assert.notEqual(p.id,e.id);assert.notEqual(s.lines[0].id,'one');assert.equal(s.kind,'background');assert.equal(s.cutoff,null);assert.equal(s.lines[0].src,null);assert.equal(s.lines[0].evidence.length,0);assert.equal(s.lines[0].turn,5);assert.equal(s.lines[0].when,'Ngày 3');assert.equal(p.data.sections.personality.kind,'canon');assert.equal(p.data.statusSource,null);
});
test('single-card parser accepts existing one-card books and rejects malformed, multiple and oversized files',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('locations','Inn');for(const text of [f.toJson([e]),f.toMarkdown([e])])assert.equal(f.parseCard(text).entry.name,'Inn');
 assert.throws(()=>f.parseCard(f.toJson([e,{...e,id:'two',name:'Other'}])),/exactly one card/);assert.throws(()=>f.parseCard('{bad'),/JSON/);assert.throws(()=>f.parseCard('x'.repeat(2*1024*1024+1)),/2 MB/);
 const invalid=structuredClone(e);invalid.sections.notes.lines=[note('same'),note('same')];assert.throws(()=>f.serializeCard(invalid),/unique/);
 invalid.sections.notes.lines=[];invalid.sections.notes.text='x'.repeat(900000);assert.throws(()=>f.serializeCard(invalid),/storage limit/);
});
test('reject incompatible destinations, deleted targets and duplicate Timeline',async()=>{
 const {f,l}=await setup(),timeline=l.makeEntry('events','Timeline',{kind:'timeline'}),thread=l.makeEntry('events','Quest',{kind:'thread',status:'open'}),parsed=f.parseCard(f.serializeCard(timeline));
 assert.throws(()=>f.planCardImport([timeline],parsed),/Timeline already exists/);assert.throws(()=>f.planCardImport([thread],parsed,{targetId:thread.id}),/same book and card kind/);assert.throws(()=>f.planCardImport([],parsed,{targetId:'gone'}),/deleted/);
});
test('moving a note between sections preserves its identity without duplicate IDs during Merge',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Mira');e.sections.notes.lines=[note('move')];const source=structuredClone(e);source.sections.appearance.lines=source.sections.notes.lines;source.sections.notes.lines=[];
 const parsed=f.parseCard(f.serializeCard(source,{format:'json',storyId:'s'}));for(const mode of ['replace','merge']){const p=f.planCardImport([e],parsed,{storyId:'s',targetId:e.id,mode});assert.equal(p.data.sections.notes.lines.length,0);assert.equal(p.data.sections.appearance.lines[0].id,'move');assert.equal(p.data.sections.appearance.lines[0].by,'auto');}
});
test('comma aliases round trip and unsupported references are warned about and excluded',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Mira',{aliases:['Lady, Mira','雪']});assert.deepEqual(plain(f.parseCard(f.serializeCard(e)).entry.aliases),['Lady, Mira','雪']);
 e.sourceStoryRef={id:'foreign'};e.sections.notes.foreignStory='other';e.sections.notes.lines=[{...note('one'),messageId:'foreign'}];const parsed=f.parseCard(f.serializeCard(e,{format:'json'}));assert.equal(parsed.warnings.length,3);assert.equal(parsed.entry.sourceStoryRef,undefined);assert.equal(parsed.entry.sections.notes.foreignStory,undefined);assert.equal(parsed.entry.sections.notes.lines[0].messageId,undefined);
});
test('legacy JSON with only a thread imports exactly one card, and single-card flags validate strictly',async()=>{
 const {f}=await setup();assert.equal(f.parseCard('{"events":{"threads":[{"title":"Quest","status":"open","text":"Find it"}]}}').entry.kind,'thread');
 assert.throws(()=>f.parseCard('## Events\n### Thread: Quest\nstatus: typo\nText'),/status must be/);assert.throws(()=>f.parseCard('## Characters\n### Mira\nalways load: perhaps\nText'),/Always load/);
});
