import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
async function setup(){
 const source=await readFile(new URL('fixtures/performance/lore-records.js',import.meta.url),'utf8');
 return {old:await appHarness({sources:{'lore-records.js':source}})('lore-records.js'),use:appHarness()};
}
test('source fingerprints retain every existing lane, ordering and UTF-16 value',async()=>{
 const {old,use}=await setup(),current=await use('lore-records.js');
 const values=[null,true,0,-1,'',"Míra 雪の姫 🌙 \ud800 \u0000",{z:undefined,a:[1,null,{y:2,x:'still not before 21/11/738'}]}];
 let seed=42;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let i=0;i<120;i++)values.push({id:i,text:Array.from({length:i*3},()=>String.fromCharCode(random()%65536)).join(''),provenance:{revision:i,order:random()}});
 for(const value of values)assert.equal(current.fingerprint(value),old.fingerprint(value));
 assert.equal(current.fingerprint({b:2,a:1}),current.fingerprint({a:1,b:2}));
 assert.notEqual(current.fingerprint('before'),current.fingerprint('still before'));
});
test('reconciliation preserves IDs, approvals, qualifiers and archived sources after edits',async()=>{
 const {old,use}=await setup(),current=await use('lore-records.js'),{makeEntry}=await use('lore-lines.js');
 const card=makeEntry('characters','Míra Vale',{id:'mira'});
 card.sections.notes.text='Obedient. Affection is unknown until 21/11/738.';
 card.sections.notes.lines=Array.from({length:30},(_,i)=>({id:'n'+i,text:'Míra does not owe '+i+' gold before 21/11/738. 雪の姫',by:i%2?'auto':'user',turn:i+1}));
 const entry=old.reconcileRecords(card);old.approveRecord(entry,entry.recordLayout.records[0]);
 const original=plain(entry);
 for(const change of [e=>e,e=>{e.sections.notes.text+=' Still unconfirmed.';return e;},e=>{e.sections.notes.lines[0].by='auto';return e;},e=>{e.sections.notes.lines.splice(0,1);return e;}]){
  const next=change(structuredClone(entry));
  assert.deepEqual(plain(current.reconcileRecords(next)),plain(old.reconcileRecords(next)));
  assert.deepEqual(plain(current.toRecordDocument(next,entry)),plain(old.toRecordDocument(next,entry)));
 }
 assert.deepEqual(plain(entry),original);
});
