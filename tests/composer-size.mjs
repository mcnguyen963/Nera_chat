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

test('Floating composer reserves actual growth and shrinkage without repeated writes or scroll changes',async()=>{
  const {observeComposerInset}=await appHarness()('ui/composer-size.js');
  const frames=[],writes=[];let height=100,callback,resizeCount=0;
  class Observer { constructor(fn){callback=fn;} observe(node){assert.equal(node,shell);} }
  const shell={getBoundingClientRect:()=>({height})};
  const schedule=observeComposerInset({shell,style:{setProperty:(name,value)=>writes.push([name,value])},onResize:()=>resizeCount++,frame:fn=>frames.push(fn),Observer});
  callback();schedule();assert.equal(frames.length,1);frames.shift()();
  assert.deepEqual(writes,[['--composer-height','100px']]);
  height=240;callback();callback();frames.shift()();assert.equal(writes.at(-1)[1],'240px');
  height=96;callback();frames.shift()();assert.equal(writes.at(-1)[1],'96px');
  callback();frames.shift()();assert.equal(resizeCount,3);
  height=0;callback();frames.shift()();assert.equal(writes.length,3);
});

test('Composer remeasures height-only visual viewport changes without altering selection',async()=>{
 const window={visualViewport:{height:600}},frames=[],writes=[];
 const field={value:'same text',clientWidth:300,scrollHeight:200,selectionStart:4,selectionEnd:4,style:new Proxy({},{set:(t,k,v)=>{writes.push(v);t[k]=v;return true;}})};
 const {createComposerSizer}=await appHarness({globals:{window}})('ui/composer-size.js');
 const resize=createComposerSizer({input:()=>field,frame:fn=>frames.push(fn)});
 resize();frames.shift()();resize();frames.shift()();assert.equal(writes.length,2);
 window.visualViewport.height=220;resize();resize();assert.equal(frames.length,1);frames.shift()();assert.equal(writes.length,4);assert.equal(field.selectionStart,4);assert.equal(field.selectionEnd,4);
});
