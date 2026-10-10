import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const use=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async t=>t.length}}});
const messages=[{id:'u',order:1,role:'user',content:'Begin'},{id:'a',order:2,role:'assistant',content:'Opening'},...Array.from({length:8},(_,i)=>({id:'m'+i,order:i+3,role:i%2?'assistant':'user',content:'Story '+i+'x'.repeat(500)})),{id:'target',order:11,role:'assistant',content:'REQUIRED TARGET',scene:'date: Day 1 · time: night · place: Inn · present: Nera'}];
for(const memory of [{},{scene:true,memoryBlock:true,replyContract:'user'},{scene:true,memoryBlock:true,replyContract:'system'}])test('Continuation budget reserves target and instruction '+JSON.stringify(memory),async()=>{
 const b=await use('context-builder.js'),p=await use('system-prompts.js');const settings={narratorSystemPrompt:'Narrate',maxContextTokens:18000,maxResponseTokens:100,keepRecentMessagesAfterSummary:0};
 const session={id:'s',memory};const result=await b.buildContextForRequest(session,settings,{messages,continuationId:'target',requireLatestUser:true});
 assert.ok(result.apiMessages.some(m=>m.role==='assistant' && m.content.includes('REQUIRED TARGET')));
 assert.equal(result.apiMessages.filter(m=>m.content.includes(p.prompts.continue)).length,1);assert.ok(result.apiMessages.at(-1).content.includes(p.prompts.continue));assert.equal(result.apiMessages.at(-1).role,'user');
 assert.equal(result.usedTokens,8+result.apiMessages.reduce((n,m)=>n+8+m.content.length,0));assert.ok(result.usedTokens<=settings.maxContextTokens);
 await assert.rejects(b.buildContextForRequest(session,{...settings,maxContextTokens:100},{messages,continuationId:'target'}),/budget/);
 await assert.rejects(b.buildContextForRequest({...session,breakpointOrder:11},settings,{messages,continuationId:'target'}),/checkpoint/);
});
test('Checkpoint preserves exact content and state, validates bounds, contains no duplicated story',async()=>{
 const c=await use('continuation.js');const prefix={id:'a',role:'assistant',content:'Exact prefix.  ',thinking:'Original',scene:'before',planThread:'plan',truncated:true,ooc:true,reviewWarnings:['old']};
 const combined=c.appendContinuation(prefix,{content:'New text',thinking:'New thinking',scene:'after',truncated:false});assert.equal(combined.truncated,true);
 const restored=c.continuationPrefix(combined);assert.equal(restored.content,prefix.content);assert.equal(restored.thinking,prefix.thinking);assert.equal(restored.scene,'before');assert.equal(restored.ooc,true);assert.equal(restored.planThread,'plan');
 assert.ok(!JSON.stringify(combined.lastContinuation).includes(prefix.content));
 for(const lastContinuation of [{}, {...combined.lastContinuation,contentOffset:-1},{...combined.lastContinuation,thinkingOffset:10000},{...combined.lastContinuation,before:{}}])assert.throws(()=>c.continuationPrefix({...combined,lastContinuation}),/malformed/);
});
