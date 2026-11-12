import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
test('record preparation hashes complete shared sources once per resolution phase',async()=>{
 const source=await readFile(new URL('../js/lore-records.js',import.meta.url),'utf8');
 // Adapt the frozen stateless API to the current callers without sharing work.
 const frozen=await readFile(new URL('fixtures/performance/lore-records.js',import.meta.url),'utf8')+`
export function createRecordResolver(entry){return {resolve:r=>resolveRecord(entry,r),approved:r=>approvedRecord(entry,r),supersession:r=>validSupersession(entry,r)};}
`;
 async function run(code,entry){
  const stats={characters:0};
  code=code.replace('export function fingerprint(value) {','export function fingerprint(value) { resolutionStats.characters+=JSON.stringify(value).length;');
  const use=appHarness({sources:{'lore-records.js':code},globals:{resolutionStats:stats}});
  const api=await use('lore-record-select.js');
  return {value:plain(api.recordUnits(entry,{loreNotesPerSection:3})),characters:stats.characters};
 }
 const use=appHarness(),records=await use('lore-records.js'),{makeEntry}=await use('lore-lines.js');
 const entry=makeEntry('characters','Míra Vale',{id:'mira'});
 entry.sections.notes.text=Array.from({length:32},(_,i)=>'Míra owes no debt before 21/11/738, clause '+i+'.').join('\n');
 let prepared=records.reconcileRecords(entry),base=prepared.recordLayout.records[0];
 prepared.recordLayout.records=entry.sections.notes.text.split('\n').map((line,i)=>{
  const start=entry.sections.notes.text.indexOf(line);
  return {...structuredClone(base),id:'passage'+i,sources:[{...base.sources[0],start,end:start+line.length}]};
 });
 for(const record of prepared.recordLayout.records)records.approveRecord(prepared,record);
 const a=await run(frozen,prepared),b=await run(source,prepared);
 assert.deepEqual(b.value,a.value);
 assert.ok(b.characters<a.characters/2,`hashed ${b.characters} vs baseline ${a.characters} characters`);
 const changed=structuredClone(prepared);changed.sections.notes.text+=' Still not released.';
 const next=await run(source,changed),reference=await run(frozen,changed);
 assert.deepEqual(next.value,reference.value);
 assert.ok(next.value.units.filter(u=>u.core).length===0,'an edit outside excerpts invalidates every approval on the next preparation');
});
