import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

async function setup() {
  const api=await appHarness()('ui/reading-recovery.js'),data=new Map();
  const target={getItem:k=>data.get(k) ?? null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  return {...api,data,target,store:api.createReadingPositionStore({storage:()=>target})};
}
const anchor=(id='message',order=1)=>({sticky:false,id,order,offset:-17});

test('Reading bookmarks survive a fresh store, isolate accounts and keep only twenty tiny anchors',async()=>{
  const {store,createReadingPositionStore,target,data}=await setup();
  for(let i=0;i<30;i++)store.write('a','story'+i,anchor('m'+i,i));
  store.write('b','story29',anchor('private',90));
  const fresh=createReadingPositionStore({storage:()=>target});
  assert.equal(fresh.read('a','story0'),null);assert.equal(fresh.read('a','story10').id,'m10');
  assert.equal(fresh.read('a','story29').id,'m29');assert.equal(fresh.read('b','story29').id,'private');
  assert.equal(JSON.parse([...data.values()][0]).length,20);
  assert.deepEqual(Object.keys(JSON.parse([...data.values()][0])[0]).sort(),['id','offset','order','sticky','story']);
  store.write('a','story10',anchor('new',91));assert.equal(fresh.read('a','story10').id,'new');
  store.clearStory('a','story10');assert.equal(fresh.read('a','story10'),null);
  store.clearAccount('a');assert.equal(fresh.read('a','story29'),null);assert.equal(fresh.read('b','story29').id,'private');
});

test('Malformed or blocked device preferences cannot interrupt chat startup',async()=>{
  const {store,data,target}=await setup();store.write('owner','story',anchor());const key=[...data.keys()][0];
  for(const invalid of ['not json','{}','[null]',JSON.stringify([{story:'story',...anchor(),offset:1e100}])]){
    target.setItem(key,invalid);assert.equal(store.read('owner','story'),null);
  }
  target.getItem=()=>{throw Error('blocked');};target.setItem=()=>{throw Error('quota');};target.removeItem=()=>{throw Error('blocked');};
  assert.equal(store.read('owner','story'),null);assert.doesNotThrow(()=>store.write('owner','story',anchor()));
  assert.doesNotThrow(()=>store.clearStory('owner','story'));assert.doesNotThrow(()=>store.clearAccount('owner'));
});

test('Recovery waits for its anchor or complete local history, and falls forward if the anchor was deleted',async()=>{
  const {store,createReadingRecovery}=await setup();store.write('owner','story',anchor('deleted',4));
  const events={},list={children:[],addEventListener:(name,fn)=>events[name]=fn,getBoundingClientRect:()=>({top:80})};
  const doc={addEventListener(){}},win={addEventListener(){}},live={owner:'owner',sid:'story',ready:true};
  const recovery=createReadingRecovery({list,current:()=>live,messages:()=>[],store,doc,win});recovery.open('owner','story');
  assert.equal(recovery.beforeRender([{id:'recent',order:100}]),null);
  const restored=recovery.beforeRender([{id:'before',order:2},{id:'next',order:5},{id:'recent',order:100}],{complete:true});
  assert.equal(restored.position.id,'next');assert.equal(restored.position.offset,-17);assert.equal(restored.count,2);
  assert.equal(recovery.beforeRender([{id:'next',order:5}],{complete:true}),null,'Restore is consumed once');
});

test('Scroll saving is debounced, background flush is immediate, and logout cancels stale writes',async()=>{
  const {store,createReadingRecovery}=await setup(),events={},jobs=new Map();let serial=0,writes=0;
  const message={id:'m',order:1},node={dataset:{messageId:'m'},getBoundingClientRect:()=>({top:-10,height:100})};
  const list={children:[node],scrollHeight:1000,clientHeight:100,scrollTop:200,getBoundingClientRect:()=>({top:0}),addEventListener:(name,fn)=>events[name]=fn};
  const doc={hidden:true,addEventListener:(name,fn)=>events[name]=fn},win={addEventListener:(name,fn)=>events[name]=fn};
  const live={owner:'a',sid:'one',ready:true},write=store.write;store.write=(...args)=>{writes++;write(...args);};
  const recovery=createReadingRecovery({list,current:()=>live,messages:()=>[message],store,doc,win,schedule:fn=>{jobs.set(++serial,fn);return serial;},cancel:id=>jobs.delete(id)});
  recovery.open('a','one');for(let i=0;i<50;i++)events.scroll();assert.equal(jobs.size,1);assert.equal(writes,0);
  events.visibilitychange();assert.equal(jobs.size,0);assert.equal(writes,1);assert.equal(store.read('a','one').offset,-10);
  events.scroll();recovery.clearAccount('a');for(const job of jobs.values())job();events.pagehide();
  assert.equal(jobs.size,0);assert.equal(store.read('a','one'),null);assert.equal(writes,1);
});

test('Lifecycle callbacks tolerate missing accounts and cannot overwrite a bookmark during loading',async()=>{
  const {store,createReadingRecovery}=await setup(),events={};store.write('a','one',anchor());
  let signedIn=true;
  const recovery=createReadingRecovery({list:{addEventListener(){}},current:()=>{if(!signedIn)throw Error('Not signed in');return {owner:'a',sid:'one',ready:false};},messages:()=>[],store,
    doc:{hidden:true,addEventListener:(k,fn)=>events[k]=fn},win:{addEventListener:(k,fn)=>events[k]=fn}});
  recovery.open('a','one');events.visibilitychange();assert.equal(store.read('a','one').id,'message');
  signedIn=false;assert.doesNotThrow(()=>events.pagehide());assert.equal(recovery.beforeRender([{id:'message',order:1}],{complete:true}),null);
});
