import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('Reveal only moves enough to expose the field inside its boundaries',async()=>{
 const {revealDelta}=await appHarness()('focus-reveal.js');
 assert.equal(revealDelta({top:30,bottom:60},{top:20,bottom:100}),0);
 assert.equal(revealDelta({top:80,bottom:120},{top:20,bottom:100}),28);
 assert.equal(revealDelta({top:0,bottom:30},{top:20,bottom:100}),-28);
 assert.equal(revealDelta({top:30,bottom:60},{top:80,bottom:70}),0);
});
test('Nested scrollers reveal only active editor; pinch zoom and disconnected fields do not move',async()=>{
 const outer={scrollTop:0,scrollHeight:500,clientHeight:200,parentElement:null,getBoundingClientRect:()=>({top:0,bottom:200}),querySelectorAll:()=>[]};
 const inner={scrollTop:0,scrollHeight:400,clientHeight:100,parentElement:outer,getBoundingClientRect:()=>({top:40,bottom:140}),querySelectorAll:()=>[]};
 const field={tagName:'INPUT',isConnected:true,matches:()=>true,closest:()=>null,parentElement:inner,getBoundingClientRect:()=>({top:150,bottom:180})};
 const document={body:{},activeElement:field};const window={visualViewport:{scale:1,offsetTop:0,height:200}};
 const {revealFocusedField}=await appHarness({globals:{document,window,getComputedStyle:n=>({overflowY:n===field?'visible':'auto'})}})('focus-reveal.js');
 revealFocusedField();assert.equal(inner.scrollTop,48);assert.equal(outer.scrollTop,0);
 window.visualViewport.scale=1.5;revealFocusedField();assert.equal(inner.scrollTop,48);
 window.visualViewport.scale=1;field.isConnected=false;revealFocusedField();assert.equal(inner.scrollTop,48);
});

test('Long textarea reveals the caret internally without changing selection or scrolling the page',async()=>{
 let removed=false,mirrored='';
 const marker={style:{},offsetTop:100},mirror={style:{},append(){mirrored=this.textContent;},remove(){removed=true;}};
 const field={tagName:'TEXTAREA',isConnected:true,matches:()=>true,closest:()=>null,parentElement:null,value:'abc\ndef',selectionStart:3,selectionEnd:3,offsetWidth:100,clientHeight:30,scrollTop:0,getBoundingClientRect:()=>({top:60,bottom:90,left:0,right:100,width:100})};
 const document={activeElement:field,body:{append(){}},createElement:tag=>tag==='span'?marker:mirror};
 const window={visualViewport:{scale:1,height:150,offsetTop:0}};
 const {revealFocusedField}=await appHarness({globals:{document,window,getComputedStyle:()=>({lineHeight:'20px',fontSize:'16px'})}})('focus-reveal.js');
 revealFocusedField();assert.equal(field.scrollTop,90);assert.equal(field.selectionStart,3);assert.equal(field.selectionEnd,3);assert.equal(mirrored,'abc');assert.equal(removed,true);
});
