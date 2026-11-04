import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
async function setup(){const use=appHarness();return {f:await use('lore-format.js'),l:await use('lore-lines.js')};}
for(const book of ['characters','locations','facts','events'])for(const format of ['md','json'])test(`${book} ${format} category round trip preserves content and metadata`,async()=>{
 const {f,l}=await setup(),e=l.makeEntry(book,book==='events'?'Timeline':'Mira',{kind:book==='events'?'timeline':'card',aliases:['Alias, one'],alwaysLoad:true});
 const key=book==='characters'||book==='locations'?'notes':'text';e.sections[key]={text:'A story\n## not a heading',origin:'user',kind:'canon',cutoff:null,lines:[{id:'ln',text:'A note\nUpdates: escaped',turn:7,when:'Day 3',src:4,by:'auto',at:10,evidence:[{order:4}],sourceRevision:2}]};
 const all=[e,l.makeEntry(book==='facts'?'locations':'facts','Other')];
 if(book==='events')for(const status of ['open','closed'])all.push(l.makeEntry(book,status,{kind:'thread',status}));
 const text=format==='md'?f.toMarkdown(all,{books:[book],includeEmpty:true}):f.toJson(all,{books:[book]});
 const parsed=format==='md'?f.fromMarkdown(text):f.fromJson(text);assert.deepEqual(plain(parsed.books),[book]);assert.deepEqual(plain(parsed.entries[0].sections[key]),plain(e.sections[key]));assert.deepEqual(plain(parsed.entries[0].aliases),plain(e.aliases));assert.equal(parsed.entries[0].alwaysLoad,true);
 if(book==='events')assert.deepEqual(plain(parsed.entries.map(e=>e.status)),[null,'open','closed']);
 const plan=f.planImport(all,parsed,{book,mode:'replace',loreRevision:3});assert.equal(plan.book,book);assert.equal(plan.loreRevision,3);assert.ok(plan.writes.every(w=>w.delete?all.find(e=>e.id===w.id).book===book:w.data.book===book));
});
test('mixed input filters before matching and deletion, missing and explicit empty books differ',async()=>{
 const {f,l}=await setup(),a=l.makeEntry('characters','Mira'),b=l.makeEntry('facts','Mira');
 const parsed=f.fromJson(f.toJson([a,b]));
 for(const mode of ['merge','replace']){const p=f.planImport([a,b],parsed,{book:'characters',mode});assert.deepEqual(Object.keys(p.preview.books),['characters']);assert.ok(p.writes.every(w=>w.id!==b.id));}
 for(const text of ['## Locations\n','{"locations":[]}'])assert.throws(()=>f.planImport([a,b],text.startsWith('{')?f.fromJson(text):f.fromMarkdown(text),{book:'characters',mode:'replace'}),/does not contain Characters/);
 for(const book of ['characters','locations','facts','events'])for(const format of ['md','json']){
 const e=l.makeEntry(book,'Old',{kind:book==='events'?'thread':'card',status:book==='events'?'closed':null}),text=format==='md'?f.toMarkdown([],{books:[book]}):f.toJson([],{books:[book]}),parsed=format==='md'?f.fromMarkdown(text):f.fromJson(text);
 const p=f.planImport([e,b],parsed,{book,mode:'replace'});assert.equal(p.preview.books[book].new,0);assert.ok(p.preview.books[book].removed>=1);assert.ok(p.preview.books[book].cards.some(c=>c.name==='Old'&&c.type==='removed'));assert.equal(f.planImport([e],parsed,{book}).writes.length,0);
 }
});
test('name/alias merge honors conflicts and repeated imports are unchanged',async()=>{
 const {f,l}=await setup(),e=l.makeEntry('characters','Mira',{aliases:['Lady']}),incoming=l.makeEntry('characters','Lady');e.sections.notes.text='Mine';incoming.sections.notes.text='File';incoming.sections.notes.lines=[{id:'one',text:'New',turn:1,when:null,src:null,by:'import',at:1}];
 const parsed=f.fromJson(f.toJson([incoming],{books:['characters']}));
 for(const conflict of ['mine','file','both']){const p=f.planImport([e],parsed,{book:'characters',conflict});assert.equal(p.writes[0].id,e.id);assert.equal(p.writes[0].data.sections.notes.text,conflict==='file'?'File':'Mine');const twice=f.planImport([p.writes[0].data],parsed,{book:'characters',conflict});assert.equal(twice.writes.length,0);assert.equal(twice.preview.books.characters.unchanged,1);}
});
test('scoped copies retain draft, provenance and reviewed note core references',async()=>{
 const use=appHarness(),f=await use('lore-format.js'),l=await use('lore-lines.js'),core=await use('character-core.js'),e=l.makeEntry('characters','Mira',{draft:true});
 e.sections.notes.lines=[{id:'source',text:'She never commands the council.',turn:7,when:null,src:null,by:'user',at:1}];e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'notes','source')])];
 for(const text of [f.toJson([e]),f.toMarkdown([e],{includeEmpty:true})]){const parsed=f.detectFormat(text)==='json'?f.fromJson(text):f.fromMarkdown(text),p=f.planImport([],parsed,{book:'characters'}),copy=p.writes[0].data;assert.notEqual(copy.id,e.id);assert.equal(copy.draft,true);assert.deepEqual(plain(copy.sections),plain(e.sections));assert.equal(core.resolveCore(copy,copy.coreReferences[0]).valid,true);}
});

test('WP-03 indented Markdown control lines round-trip in text, phases and notes',async()=>{
 const {f,l}=await setup();
 const body=['First','  ### X','  ## Y','  #### Z','  Updates:','**Updates:**','  <!-- nera-line: {} -->','  \\literal','Last'].join('\n');
 const card=l.makeEntry('characters','Mira');card.sections.notes.text=body;
 card.sections.notes.lines=[{id:'control',text:body,turn:4,when:null,src:1,by:'auto',at:1}];
 const plan=l.makeEntry('plan','Visit',{schedule:{start:'1/10/738',end:'2/10/738',status:'pending',phases:[{id:'phase',title:'Meeting',start:'1/10/738',end:'2/10/738',status:'pending',text:body}]}});
 const parsed=f.fromMarkdown(f.toMarkdown([card,plan],{includeEmpty:true}));
 assert.deepEqual(plain(parsed.warnings),[]);assert.equal(parsed.entries.length,2);
 assert.deepEqual(plain(parsed.entries[0].sections),plain(card.sections));
 assert.deepEqual(plain(parsed.entries[1].schedule),plain(plan.schedule));
});
test('WP-03 old column-zero escaped exports still import identically',async()=>{
 const {f}=await setup();
 const text=['# Lorebooks','format: nera-lorebooks-md 2','## World facts','### Old card','First','\\## literal','\\Updates:','\\\\literal','Last'].join('\n');
 const parsed=f.fromMarkdown(text);
 assert.deepEqual(plain(parsed.warnings),[]);
 assert.equal(parsed.entries[0].sections.text.text,'First\n## literal\nUpdates:\n\\literal\nLast');
});

test('invalid thread metadata preserves every Markdown card and warns with its name and field',async()=>{
 const {f,l}=await setup(),bad=l.makeEntry('events','Recovered guard',{kind:'thread',status:'closed'}),good=l.makeEntry('events','Letter delivered',{kind:'thread',status:'closed'});
 bad.threadMeta={kind:'commitment',dueDate:null,dueTime:null,participants:[],location:null,outcome:'resolved'};
 const markdown=f.toMarkdown([bad,good],{books:['events'],includeEmpty:true}).replace('"outcome":"resolved"','"outcome":"Recovered; returned to duty"');
 const imported=f.fromMarkdown(markdown);assert.equal(imported.entries.length,2);assert.equal(imported.entries[0].threadMeta,undefined);assert.equal(imported.entries[1].name,'Letter delivered');
 assert.ok(imported.warnings.some(w=>w.reason.includes('Recovered guard')&&w.reason.includes('threadMeta')));
 assert.throws(()=>f.fromMarkdown(markdown.replace('"outcome":','"outcome" broken:')),/Recovered guard.*metadata|metadata.*Recovered guard/);
});
