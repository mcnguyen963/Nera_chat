import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
function storage() {const data=new Map();return {data,get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
async function setup(target=storage()) {
  const jobs=[];let failures=0;
  const {createComposerDraftStore}=await appHarness()('composer-drafts.js');
  const options={storage:()=>target,schedule:(fn,ms)=>{assert.equal(ms,200);jobs.push(fn);return fn;},cancel:()=>{},onFailure:()=>failures++};
  return {store:createComposerDraftStore(options),fresh:()=>createComposerDraftStore(options),target,jobs,failures:()=>failures};
}
test('Drafts are isolated by account/story, debounce, and survive a fresh module store',async()=>{
  const {store,fresh,jobs,target}=await setup();
  store.set('a','one','first');store.set('a','one','newer');store.set('a','two','other');store.set('b','one','private');
  assert.equal(target.length,0);jobs[0]();assert.equal(target.length,0,'stale debounce must not write');
  store.flush('a','one');assert.equal(fresh().read('a','one'),'newer');
  store.flush();assert.equal(fresh().read('a','two'),'other');assert.equal(fresh().read('b','one'),'private');assert.equal(store.read('a','missing'),'');
  store.set('a','one','');store.flush();assert.equal(fresh().read('a','one'),'');
});
test('Deletion and sign-out cancel callbacks and remove only the requested scope',async()=>{
  const {store,fresh,jobs}=await setup();
  store.set('a','one','one');store.set('a','two','two');store.set('b','one','b');store.flush();
  store.set('a','one','late');store.clearStory('a','one');jobs.at(-1)();assert.equal(fresh().read('a','one'),'');
  store.set('a','two','later');store.clearAccount('a');for(const job of jobs)job();
  assert.equal(store.read('a','two'),'');assert.equal(fresh().read('a','two'),'');assert.equal(fresh().read('b','one'),'b');
});
test('Quota/storage failure retains memory and reports lack of reload recovery',async()=>{
  const target=storage();target.setItem=()=>{throw Error('quota');};
  const {store,failures}=await setup(target);store.set('a','one','kept');assert.equal(store.flush(),false);assert.equal(store.read('a','one'),'kept');assert.equal(failures(),1);
});
test('Keys cannot collide when account or story includes separators',async()=>{
  const {store,fresh}=await setup();store.set('a:b','c','one');store.set('a','b:c','two');store.flush();assert.equal(fresh().read('a:b','c'),'one');assert.equal(fresh().read('a','b:c'),'two');
});
