import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

const counter=async text=>text.length;
async function builderHarness(){
  const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected server read');}},'tokenizer.js':{countTokens:counter}}});
  return {builder:await use('context-builder.js'),memory:await use('memory-settings.js')};
}
const history=Array.from({length:20},(_,i)=>({id:'m'+(i+1),order:i+1,role:i%2 ? 'assistant' : 'user',narratorTurn:Math.floor(i/2)+1,content:(i<2 ? 'Opening '+i : 'Turn content '+i+' '+ 'x'.repeat(2000)),...(i%2 ? {scene:'date: Day 1 · time: night · place: Inn · present: Nera'} : {})})).concat({id:'latest',order:21,role:'user',narratorTurn:11,content:'LATEST ACTION'});
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:16000,maxResponseTokens:100,keepRecentMessagesAfterSummary:2};

for(const role of ['user','system'])for(let depth=0;depth<=10;depth++)for(const summary of [false,true]) {
  test(`C3 context layout role ${role}, depth ${depth}, summary ${summary}`,async()=>{
    const {builder,memory}=await builderHarness(),mem=memory.normalizeMemory({memoryBlock:true,scene:true,blockRole:role,blockDepth:depth});
    assert.equal(mem.blockDepth,Math.max(1,depth));
    const session={id:'s',memory:mem,...(summary ? {activeSummaryMessageId:'summary',breakpointOrder:10} : {})};
    const messages=summary ? history.concat({id:'summary',order:22,role:'summary',content:'Earlier events',coveredRange:{fromOrder:1,toOrder:10}}) : history;
    const result=await builder.buildContextForRequest(session,settings,{messages,requireLatestUser:true});
    assert.equal(result.usedTokens,8+result.apiMessages.reduce((n,m)=>n+m.content.length+8,0));
    assert.ok(result.usedTokens<=settings.maxContextTokens);
    assert.equal(result.apiMessages[0].role,'system');
    assert.equal(result.apiMessages.at(-1).role,'user');assert.match(result.apiMessages.at(-1).content,/LATEST ACTION/);
    const sceneIndex=result.apiMessages.findIndex(m=>m.content.includes('Current scene (from the latest reply):'));
    assert.ok(sceneIndex>0);assert.ok(sceneIndex<=result.apiMessages.length-1);
    if(role==='user'){assert.equal(sceneIndex,result.apiMessages.length-1);assert.equal(result.apiMessages.filter(m=>m.role==='system').length,1);}
    else {assert.equal(result.apiMessages[sceneIndex].role,'system');assert.equal(result.apiMessages[sceneIndex+1].role,'user');}
    const openings=result.apiMessages.filter(m=>m.content.includes('Opening '));assert.equal(openings.length,2);assert.equal(openings[0].role,'user');assert.equal(openings[1].role,'assistant');
    assert.ok(result.droppedCount>0);
    const windowed=result.apiMessages.find(m=>m.role!=='system' && !m.content.includes('Opening '));assert.ok(windowed);assert.match(windowed.content,/omitted|not included|not sent/i);
    if(summary)assert.match(result.apiMessages[0].content,/Earlier events/);
  });
}
