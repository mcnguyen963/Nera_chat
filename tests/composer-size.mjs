import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('Composer batches typing, restore, starter and rewrite sizing; skips unchanged text/width',async()=>{
  const {createComposerSizer}=await appHarness()('ui/composer-size.js');
  const frames=[],writes=[],field={value:'',clientWidth:300,scrollHeight:30,scrollTop:0,style:new Proxy({},{set:(target,key,value)=>{writes.push(value);target[key]=value;return true;}})};
  const resize=createComposerSizer({input:()=>field,frame:fn=>frames.push(fn)}),flush=()=>frames.shift()();
  resize();resize();assert.equal(frames.length,1);flush();assert.deepEqual(writes,['auto','30px']);
  resize();flush();assert.equal(writes.length,2);
  field.value='multiline\ntext';field.scrollHeight=400;resize();resize({scroll:true});flush();assert.equal(field.style.height,'400px');assert.equal(field.scrollTop,400);
  field.value='';field.scrollHeight=30;resize();flush();assert.equal(field.style.height,'30px');
  field.clientWidth=150;field.scrollHeight=60;resize();flush();assert.equal(field.style.height,'60px');
  field.value='restore';resize({scroll:true});field.value='latest rewrite';resize({scroll:true});assert.equal(frames.length,1);flush();assert.equal(field.style.height,'60px');
});
