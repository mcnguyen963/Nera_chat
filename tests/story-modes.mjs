import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

const markdown=await readFile(new URL('../resources/story-modes/asterfall-lore.md',import.meta.url),'utf8');
async function setup({failAt='',changeOwnerAt=''}={}) {
  let owner='owner',next=0;
  const calls=[];
  const step=async(name,...args)=>{calls.push([name,...args]);if(changeOwnerAt===name)owner='other';if(failAt===name)throw new Error(name+' failed');};
  const use=appHarness({globals:{fetch:async url=>String(url).includes('/story-modes/')?({ok:true,text:async()=>markdown}):promptFetch(url)},stubs:{
    'auth.js':{currentUid:()=>owner},
    'sessions.js':{createSession:async(...args)=>{await step('create',...args);return 'story-'+ ++next;},updateSession:async(...args)=>step('publish',...args),deleteSession:async(...args)=>step('delete',...args)},
    'messages.js':{addMessagesBulk:async(...args)=>step('messages',...args)},
    'lore-store.js':{getLore:async()=>[],importLore:async(...args)=>step('lore',...args)}
  }});
  return {api:await use('story-modes.js'),calls};
}
const card=(entries,book,name)=>entries.find(e=>e.book===book && e.name===name);
test('story modes each prepare fresh, distinct starting canon',async()=>{
  const h=await setup();
  assert.deepEqual(Array.from(h.api.storyModes, m=>m.id),['hearing','summons','bond']);
  for(const mode of h.api.storyModes){
    const {entries}=h.api.prepareStoryMode(mode.id,markdown);
    assert.ok(entries.length>=75);assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);
    assert.equal(entries.filter(e=>e.kind==='timeline').length,1);
    const nera=card(entries,'characters','Nera Veyrath');
    const isolde=card(entries,'characters','Isolde Veyless');
    const liora=card(entries,'characters','Liora Fen');
    assert.match(nera.sections.status.text,/Eleven/);
    assert.match(isolde.sections.bond.text,/does not create love or grant sexual access/);
    assert.match(liora.sections.bond.text,/prior cruelty/);
    assert.doesNotMatch(JSON.stringify(entries),/girlfriend|seven-year sentence|Heaven Splitter|Krail secretly removed|\[T\d/i);
    assert.equal(!!card(entries,'events','The household hearing'),mode.id==='hearing');
    assert.equal(!!card(entries,'events','The duke’s summons'),mode.id==='summons');
    assert.equal(!!card(entries,'events','The household notice'),mode.id==='bond');
    if(mode.id!=='hearing')assert.doesNotMatch(JSON.stringify(entries),/accidental fire|detained.*hearing|portrait was damaged/i);
  }
});
test('each mode creates a separate story and publishes only after opening and lore',async()=>{
  const h=await setup();
  for(const mode of h.api.storyModes)await h.api.createStoryMode(mode.id);
  assert.deepEqual(h.calls.map(c=>c[0]),['create','messages','lore','publish','create','messages','lore','publish','create','messages','lore','publish']);
  for(let i=0;i<3;i++){
    const [created,messages,lore,publish]=h.calls.slice(i*4,i*4+4);
    assert.equal(created[2].importing,true);assert.equal(messages[1],`story-${i+1}`);
    assert.equal(messages[2].length,1);assert.equal(messages[2][0].role,'assistant');assert.equal(messages[2][0].content,h.api.storyModes[i].opening);
    assert.equal(lore[1].id,`story-${i+1}`);assert.ok(lore[2].writes.length>=75);
    assert.equal(publish[2].importing,false);assert.equal(publish[2].memory.lorebooks,true);assert.equal(publish[2].memory.protagonist,'Nera Veyrath');
    assert.equal('directorState' in publish[2],false);assert.equal('activeSummaryMessageId' in publish[2],false);
  }
});
for(const failAt of ['messages','lore','publish'])test(`failure at ${failAt} removes only the incomplete story`,async()=>{
  const h=await setup({failAt});await assert.rejects(h.api.createStoryMode('hearing'),new RegExp(failAt+' failed'));
  assert.deepEqual(h.calls.at(-1),['delete','story-1']);
  if(failAt!=='publish')assert.ok(!h.calls.some(c=>c[0]==='publish'));
});
test('account changes stop subsequent writes without deleting another account’s story',async()=>{
  const h=await setup({changeOwnerAt:'messages'});await assert.rejects(h.api.createStoryMode('bond'),/account changed/i);
  assert.deepEqual(h.calls.map(c=>c[0]),['create','messages']);
});
test('unknown modes and damaged starting content fail before any writes',async()=>{
  const h=await setup();await assert.rejects(h.api.createStoryMode('missing'),/Unknown story mode/);
  assert.throws(()=>h.api.prepareStoryMode('bond','not a lorebook'),/lorebooks/i);assert.equal(h.calls.length,0);
});
