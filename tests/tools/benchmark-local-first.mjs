// Read-only benchmark. Outputs timings and counts, never private story text.
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {appHarness} from '../app-harness.mjs';
import * as vendor from '../../js/vendor/gpt-tokenizer-2.9.0.js';
const path=process.argv[2];if(!path)throw new Error('Supply a local full-backup JSON path.');
const data=JSON.parse(await readFile(path,'utf8')),messages=data.messages;
if(!Array.isArray(messages))throw new Error('Expected a full story backup with messages.');
const use=appHarness({stubs:{'messages.js':{getMessages:async()=>messages},'tokenizer.js':{countTokens:async text=>Math.ceil(vendor.countTokens(text)*1.02),tokenizerReady:()=>true}}});
const {createStoryQueue}=await use('story-queue.js'),{sceneTimeline}=await use('scene.js'),{computeTurns}=await use('turns.js');
const target=messages.findLast(m=>m.role==='user'),base={session:{...data.session,id:'benchmark'},messages,turns:{}};
const timings=[];let worstTimeline=0;
for(let i=0;i<30;i++){
 const q=createStoryQueue({owner:'benchmark',sid:'benchmark',base,currentOwner:()=> 'benchmark',storage:{put:async()=>true,ack:async()=>true},commit:()=>new Promise(()=>{})});
 const start=performance.now();q.enqueue({id:'edit-'+i,kind:'edit',payload:{id:target.id,content:target.content+' '},createdAt:1});timings.push(performance.now()-start);
 const renderStart=performance.now();sceneTimeline(q.view.messages,{startingScene:data.session.memory?.startingScene});computeTurns(q.view.messages);worstTimeline=Math.max(worstTimeline,performance.now()-renderStart);
 const removeStart=performance.now();q.enqueue({id:'delete-'+i,kind:'delete',payload:{id:target.id},createdAt:1});timings.push(performance.now()-removeStart);q.close();
}
const {computeContextUsage}=await use('context-builder.js'),{defaultStorySettings}=await use('story-settings.js');
const settings={...defaultStorySettings(),...data.storySettings?.values,maxContextTokens:120000,maxResponseTokens:4096};
const contextStart=performance.now();await computeContextUsage(data.session,settings,messages,{loreEntries:data.lore ?? []});const coldContextMs=performance.now()-contextStart;
const warmStart=performance.now();await computeContextUsage(data.session,settings,messages,{loreEntries:data.lore ?? []});const warmContextMs=performance.now()-warmStart;
timings.sort((a,b)=>a-b);console.log(JSON.stringify({messages:messages.length,loreCards:data.lore?.length ?? 0,operations:timings.length,localMutationP95Ms:+timings[Math.floor(timings.length*.95)].toFixed(2),localMutationMaxMs:+timings.at(-1).toFixed(2),sceneAndTurnDerivationMaxMs:+worstTimeline.toFixed(2),coldContextMs:+coldContextMs.toFixed(2),warmContextMs:+warmContextMs.toFixed(2),firebaseRequests:0,paidLLMCalls:0,device:'local desktop runtime; not a phone measurement'},null,2));
