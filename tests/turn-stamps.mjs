import { promptFetch, promptImportMeta } from './prompt-files.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = vm.createContext({ URL,fetch:promptFetch });
const cache = new Map();
async function load(path) {
  if (cache.has(path)) return cache.get(path);
  const module = new vm.SourceTextModule(await readFile(new URL('../js/'+path,import.meta.url),'utf8'),{context,identifier:path,initializeImportMeta:promptImportMeta});
  cache.set(path,module);
  await module.link((specifier,parent)=>load(new URL(specifier,'https://local/'+parent.identifier).pathname.slice(1)));
  return module;
}
const module = await load('story-text.js');
await module.evaluate();
const cases = [
 ['Take Turn 5 of the dance','Take Turn 5 of the dance'],
 ['turn 3 of the wheel','turn 3 of the wheel'],
 ['t12 code','t12 code'],
 ['(T198–T204)',''],
 ['[T4; T7-T9]',''],
 ['T41-T45 she left','She left'],
 ['at T12, she stopped','She stopped'],
 ['She paused, at T12, she stopped.','She paused, she stopped.'],
 ['She waited. at T12, she stopped.','She waited. She stopped.'],
 ['since T120 she cut her hair','She cut her hair'],
 ['[T4 · Oct 738]','[Oct 738]'],
 ['(T4-T7 · Oct 738)','(Oct 738)'],
 ['[earlier; T4 · Oct 738]','[earlier; Oct 738]'],
 ['T120: She departed','She departed'],
 ['Turn 12: she departed','She departed'],
 ['Turn 12 · she departed','She departed'],
 ['(Turn 12) she departed','She departed'],
 ['[Turn 12 · Oct 738]','[Oct 738]'],
 ['She recalls Turn 12: the departure.','She recalls the departure.'],
 ['  two  spaces\n\nplain t12 code','  two  spaces\n\nplain t12 code'],
 ['Untouched  spacing\nat T12, she stopped\nTake Turn 5 of the dance','Untouched  spacing\nShe stopped\nTake Turn 5 of the dance'],
];
for (const [input,expected] of cases) test('turn stamp rendering: '+JSON.stringify(input),()=>{
 const stripTurnStamps=module.namespace.stripTurnStamps;
 assert.equal(typeof stripTurnStamps,'function');
 assert.equal(stripTurnStamps(input),expected);
 assert.equal(stripTurnStamps(stripTurnStamps(input)),expected);
});
