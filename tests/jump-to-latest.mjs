import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

test('jump to latest uses message geometry, ignores notices, and hides at the bottom',async()=>{
 const frames=[],events={},buttonEvents={};let jumps=0;
 const list={scrollHeight:2000,scrollTop:0,clientHeight:500,getBoundingClientRect:()=>({top:0,bottom:500,height:500}),addEventListener:(t,f)=>events[t]=f};
 const message=(top,previousElementSibling=null,real=true)=>({previousElementSibling,matches:()=>real,getBoundingClientRect:()=>({top:top-list.scrollTop})});
 list.lastElementChild=message(1900,message(1800,message(1700,message(1500,null,true),false)));
 const button={hidden:true,addEventListener:(t,f)=>buttonEvents[t]=f},doc={getElementById:()=>null,querySelector:()=>null};
 const {initJumpToLatest}=await appHarness({globals:{window:{addEventListener(){}}}})('ui/jump-to-latest.js');
 initJumpToLatest({list,button,doc,frame:fn=>frames.push(fn),onJump:()=>jumps++});frames.shift()();assert.equal(button.hidden,false);
 list.scrollTop=1500;events.scroll();events.scroll();assert.equal(frames.length,1);frames.shift()();assert.equal(button.hidden,true);
 list.scrollTop=1000;events.scroll();frames.shift()();assert.equal(button.hidden,false);buttonEvents.click();frames.shift()();assert.equal(jumps,1);
 list.lastElementChild=message(1900,message(1800));events.scroll();frames.shift()();assert.equal(button.hidden,true);
});
