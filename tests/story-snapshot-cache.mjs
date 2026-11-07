import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStorySnapshotCache} from '../js/story-snapshot-cache.js';

test('background jobs retain their snapshots until idle without retaining other visited stories',()=>{
  const running=new Set(['working']),cache=createStorySnapshotCache(id=>running.has(id));
  const work={messages:['unfinished job source']};cache.set('working',work);
  for(let i=0;i<10;i++)cache.set('idle-'+i,{messages:[i]});
  assert.equal(cache.get('working'),work);
  assert.equal(cache.size,3);assert.equal(cache.get('idle-0'),undefined);
  running.clear();cache.set('newest',{});
  assert.equal(cache.get('working'),undefined);assert.equal(cache.size,3);
});

test('temporary excess consists only of pinned jobs and is released when jobs finish',()=>{
  const running=new Set(['a','b','c','d']),cache=createStorySnapshotCache(id=>running.has(id));
  for(const id of running)cache.set(id,{id});
  assert.equal(cache.size,4);
  running.delete('a');cache.prune();assert.equal(cache.get('a'),undefined);assert.equal(cache.size,3);
  cache.clear();assert.equal(cache.size,0);
});
