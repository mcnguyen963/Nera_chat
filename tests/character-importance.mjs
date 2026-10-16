import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
async function setup(){const use=appHarness();return {l:await use('lore-lines.js'),f:await use('lore-format.js'),r:await use('lore-records.js'),i:await use('character-importance.js'),s:await use('lore-select.js')};}

test('old and new characters default to Minor without mutating old cards or other books',async()=>{
 const {l,f,i}=await setup(),old=l.makeEntry('characters','Mira');delete old.importance;const before=JSON.stringify(old);
 assert.equal(i.characterImportance(old),3);assert.equal(JSON.stringify(old),before);
 assert.equal(l.makeEntry('characters','New').importance,3);assert.equal(f.normalizeLoreEntry(old).importance,3);
 for(const book of ['locations','facts','events','plan'])assert.equal(l.makeEntry(book,'Other').importance,undefined);
});

test('all importance levels round trip through legacy, selective, book and card formats',async()=>{
 const {l,f,r}=await setup();
 for(const importance of [1,2,3,4])for(const selective of [false,true]){
  let e=l.makeEntry('characters','Mira',{importance});e.sections.notes.text='An established ally.';
  if(selective)e=r.fromRecordDocument(r.toRecordDocument(e));
  for(const text of [f.toJson([e]),f.toMarkdown([e]),f.serializeCard(e,{format:'json'}),f.serializeCard(e,{format:'md'})]){
   const entry=text.includes('nera-lore-card')?f.parseCard(text).entry:(f.detectFormat(text)==='json'?f.fromJson(text):f.fromMarkdown(text)).entries[0];
   assert.equal(entry.importance,importance);assert.equal(entry.sections.notes.text,e.sections.notes.text);
  }
 }
 const legacy=f.fromJson('{"characters":[{"name":"Old"}]}').entries[0];assert.equal(legacy.importance,3);
 const record=r.toRecordDocument(legacy);delete record.subject.importance;assert.equal(r.fromRecordDocument(record).importance,3);
});

test('explicit invalid importance is rejected by all import paths',async()=>{
 const {l,f,r}=await setup();
 for(const value of [0,5,-1,1.5,'1',null,true]){
  const e=l.makeEntry('characters','Mira',{importance:value});
  assert.throws(()=>f.fromJson(JSON.stringify({characters:[{name:'Mira',importance:value}]})),/importance/);
  assert.throws(()=>f.normalizeLoreEntry(e),/importance/);
  const doc=r.toRecordDocument(l.makeEntry('characters','Mira'));doc.subject.importance=value;
  assert.throws(()=>r.fromRecordDocument(doc),/importance/);
  assert.throws(()=>f.parseCard(JSON.stringify({format:'nera-lore-card',version:1,entry:e})),/importance/);
 }
 for(const value of ['0','5','1.5','Core',''])assert.throws(()=>f.fromMarkdown('## Characters\n### Mira\nimportance: '+value),/importance/);
 assert.throws(()=>f.fromMarkdown('## Characters\n### Mira\n<!-- nera-entry: {"importance":5} -->'),/importance/);
});

test('replacement imports carry the chosen level and merge imports retain destination importance',async()=>{
 const {l,f}=await setup(),dest=l.makeEntry('characters','Mira',{importance:1}),incoming=l.makeEntry('characters','Mira',{importance:4});incoming.sections.notes.text='New note';
 const parsed=f.parseCard(f.serializeCard(incoming,{format:'json'}));
 assert.equal(f.planCardImport([dest],parsed,{targetId:dest.id,mode:'replace'}).data.importance,4);
 assert.equal(f.planCardImport([dest],parsed,{targetId:dest.id,mode:'merge'}).data.importance,1);
 const book=f.fromJson(f.toJson([incoming]));assert.equal(f.planImport([dest],book,{mode:'merge'}).writes[0].data.importance,1);
 assert.equal(f.planImport([dest],book,{mode:'replace'}).writes.find(w=>w.data).data.importance,4);
});

test('automatic memory changes preserve importance and rendered model cards stay identical',async()=>{
 const {l,s}=await setup(),e=l.makeEntry('characters','Mira',{importance:1}),message={id:'a',order:2,role:'assistant',content:'Mira returns.',narratorTurn:1};
 const rendered=s.renderEntry(e);for(const importance of [2,3,4])assert.equal(s.renderEntry({...e,importance}),rendered);
 const parsed=l.parseMemoryLines('T1 [char] Mira | notes: Returned to the inn.',{entries:[e],range:{fromTurn:1,toTurn:1,assistants:[{turn:1,order:2}]},messages:[message],mem:{}});
 const result=l.applyOps([e],parsed.ops,{messages:[message],session:{}});assert.equal(result.entries[0].importance,1);assert.ok(result.entries[0].sections.notes.lines.length);
});
