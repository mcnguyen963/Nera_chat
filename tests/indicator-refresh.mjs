import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup() {
  let focus=true,source='account/session/epoch/draft',calls=0,active=0,maxActive=0;
  const jobs=[],tasks=new Map(),applied=[],errors=[];let next=0;
  const {createIndicatorRefresh}=await appHarness()('ui/indicator-refresh.js');
  const refresh=createIndicatorRefresh({focused:()=>focus,key:()=>source,compute:()=>{calls++;active++;maxActive=Math.max(maxActive,active);return new Promise((resolve,reject)=>jobs.push({resolve:v=>{active--;resolve(v);},reject:e=>{active--;reject(e);}}));},apply:v=>applied.push(v),onError:e=>errors.push(e),schedule:fn=>{tasks.set(++next,fn);return next;},cancel:id=>tasks.delete(id)});
  return {refresh,jobs,applied,errors,tasks,setFocus:v=>focus=v,setSource:v=>source=v,get calls(){return calls;},get maxActive(){return maxActive;},flush:()=>{for(const [id,fn] of tasks){tasks.delete(id);fn();}}};
}
test('Typing pauses and remote refreshes keep previous count until blur; refocus cancels queued work',async()=>{
  const h=await setup();
  for(let i=0;i<20;i++){h.setSource('draft '+i);h.refresh.invalidate();await h.refresh.request();}
  assert.equal(h.calls,0);
  h.setFocus(false);h.refresh.blur();h.setFocus(true);h.refresh.invalidate();h.flush();assert.equal(h.calls,0);
  h.setFocus(false);h.refresh.blur();h.flush();assert.equal(h.calls,1);
  h.jobs.shift().resolve('latest draft');await tick();assert.deepEqual(h.applied,['latest draft']);
});
test('Coalesces remote updates, discards stale successes and errors, serializes replacement',async()=>{
  const h=await setup();h.setFocus(false);const first=h.refresh.request();
  const requests=Array.from({length:10},()=>h.refresh.request());
  h.jobs.shift().resolve('old');await tick();assert.equal(h.calls,2);assert.deepEqual(h.applied,[]);
  h.jobs.shift().resolve('new');await Promise.all([first,...requests]);assert.deepEqual(h.applied,['new']);assert.equal(h.maxActive,1);
  const old=h.refresh.request();h.setSource('new account/session/epoch');h.jobs.shift().reject(Error('stale error'));await tick();assert.equal(h.errors.length,0);
  h.jobs.shift().resolve('new session');await old;assert.deepEqual(h.applied,['new','new session']);
});
test('Focus during computation rejects result and defers replacement until blur',async()=>{
  const h=await setup();h.setFocus(false);const work=h.refresh.request();h.setFocus(true);h.refresh.invalidate();h.jobs.shift().resolve('old');await work;
  assert.equal(h.calls,1);assert.deepEqual(h.applied,[]);
  h.setSource('latest typed draft');h.setFocus(false);h.refresh.blur();h.flush();h.jobs.shift().resolve('fresh');await tick();assert.deepEqual(h.applied,['fresh']);
});
