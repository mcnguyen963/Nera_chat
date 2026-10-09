import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
const before=!!process.env.E12_BEFORE;
const sources=before ? {'math-utils.js':'export {};','lore-select.js':await readFile('/private/tmp/e12-lore-select-before.js','utf8')} : {};
const use=()=>appHarness({sources,stubs:{'messages.js':{getMessages:async()=>[]}}});
test('E12 iterable extrema preserve empty and singleton results',async()=>{
  const {minOf,maxOf}=await use()('math-utils.js');
  assert.equal(minOf([]),Infinity);assert.equal(maxOf([]),-Infinity);
  assert.equal(minOf([7]),7);assert.equal(maxOf([7]),7);
});
test('E12 extrema handle 200000 values and Set input without argument limits',async()=>{
  const {minOf,maxOf}=await use()('math-utils.js'),values=Array.from({length:200000},(_,i)=>i-100000);
  assert.equal(minOf(values),-100000);assert.equal(maxOf(values),99999);
  assert.equal(minOf(new Set(values)),-100000);assert.equal(maxOf(new Set(values)),99999);
});
test('E12 extrema preserve numeric coercion, NaN and signed zero behavior',async()=>{
  const {minOf,maxOf}=await use()('math-utils.js');
  for(const values of [[3,'2',null],[3,NaN],[Infinity,-Infinity],[0,-0],[-0,0]]){
    assert.ok(Object.is(minOf(values),Math.min(...values)));
    assert.ok(Object.is(maxOf(values),Math.max(...values)));
  }
});
for(const book of ['facts','events'])test('E12 '+book+' recency selection safely sorts 200000 lore lines',async()=>{
  const u=use(),{selectEntries}=await u('lore-select.js'),{makeEntry}=await u('lore-lines.js'),{normalizeMemory}=await u('memory-settings.js');
  const older=makeEntry(book,'Older',{id:'older',kind:book==='events'?'thread':'card'}),newer=makeEntry(book,'Newer',{id:'newer',kind:book==='events'?'thread':'card'});
  older.sections.text.lines=[{at:-1}];newer.sections.text.lines=Array.from({length:200000},(_,at)=>({at}));
  const result=selectEntries([older,newer],normalizeMemory({lorebooks:true}),'',null);
  assert.deepEqual(Array.from(result.selected[book],row=>row.entry.id),['newer','older']);
});
