import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

// Synthetic replay: referenced owner exports are not present in this checkout.
const storedScene='date: October 738 · time: morning · place: Hall · present: Mira';
const history=[
 {id:'u1',order:1,narratorTurn:1,role:'user',content:'Begin.'},
 {id:'a1',order:2,narratorTurn:1,role:'assistant',content:'Mira opens the door.',scene:storedScene,sceneMeta:{kind:'declared',provenance:{date:'prior',time:'prior'}}},
 {id:'summary',order:3,role:'summary',content:'### Last established situation (T4-T5)\n[T4 · Oct 738] at T12, she stopped.',coveredRange:{toOrder:2}},
 {id:'u2',order:4,narratorTurn:2,role:'user',content:'Continue.'},
 {id:'a2',order:5,narratorTurn:2,role:'assistant',content:'<think>PRIVATE_INLINE_THINKING</think>Mira sits by the window.',thinking:'PRIVATE_PROVIDER_THINKING',scene:storedScene,sceneMeta:{kind:'declared',provenance:{date:'kept',time:'kept'}}},
 {id:'u3',order:6,narratorTurn:3,role:'user',content:'Wait.'},
 {id:'a3',order:7,narratorTurn:3,role:'assistant',content:'Mira closes the book.',scene:storedScene,sceneMeta:{kind:'carried',fromId:'a2',fromOrder:5,missingStreak:1}},
 {id:'u4',order:8,narratorTurn:4,role:'user',content:'Ask Mira about her journey.'},
];
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:100000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:10,modelId:'synthetic-model',endpoint:'https://test.invalid/chat',streaming:false};

test('F19 synthetic finalized narrator request unfreezes old scenes and removes summary/lore stamps',async()=>{
 const requests=[];
 const use=appHarness({globals:{fetch:async(url,options)=>{
  if(String(url)!==settings.endpoint)return promptFetch(url,options);
  requests.push(JSON.parse(options.body));
  return {ok:true,json:async()=>({choices:[{message:{content:'Synthetic verification response.'},finish_reason:'stop'}]})};
 }},stubs:{'messages.js':{getMessages:async()=>history},'tokenizer.js':{countTokens:async text=>text.length}}});
 const builder=await use('context-builder.js'),{makeEntry}=await use('lore-lines.js'),client=await use('llm-client.js');
 const character=makeEntry('characters','Mira',{alwaysLoad:true});
 character.sections.status.text='at T12, she stopped';
 character.sections.status.lines=[{id:'hair',text:'since T120 she cut her hair',when:'T4-T5',turn:120,by:'user',at:1}];
 const timeline=makeEntry('events','Timeline',{kind:'timeline'});timeline.sections.text.text='T41-T45 she left';
 const sourceBefore=JSON.stringify({history,character,timeline});
 const built=await builder.buildContextForRequest({id:'synthetic',activeSummaryMessageId:'summary',breakpointOrder:2,memory:{scene:true,lorebooks:true,memoryBlock:true}},settings,{messages:history,loreEntries:[character,timeline],requireLatestUser:true});
 await client.chatCompletion({settings,messages:built.apiMessages});
 assert.equal(requests.length,1);
 const wire=requests[0].messages.map(message=>message.content).join('\n');
 assert.doesNotMatch(wire,/\bT\d|PRIVATE_INLINE_THINKING|PRIVATE_PROVIDER_THINKING|Last established situation/);
 assert.match(wire,/Situation at the summary cutoff/);
 assert.match(wire,/She stopped/);assert.match(wire,/She cut her hair/);assert.match(wire,/She left/);
 for (const prose of ['Mira sits by the window.','Mira closes the book.']) {
  const reply=requests[0].messages.find(message=>message.content.includes(prose));
  assert.match(reply.content,/<scene>date: unknown · time: unknown · place: Hall · present: Mira<\/scene>/);
 }
 assert.match(wire,/Last recorded scene \(later replies did not update it\): date: unknown · time: unknown · place: Hall/);
 assert.equal(built.report.scene.when,null);assert.equal(built.report.scene.time,null);assert.equal(built.report.scene.fromOrder,5);
 assert.equal(JSON.stringify({history,character,timeline}),sourceBefore);
});

test('F19 synthetic turn headers share sanitized old scenes and accept a new clock without migration',async()=>{
 const use=appHarness(),turns=await use('turns.js'),scene=await use('scene.js');
 const transcript=turns.formatTurnsTranscript(history);
 assert.match(transcript,/=== Turn 2 · date: unknown · time: unknown · place: Hall · present: Mira ===/);
 assert.doesNotMatch(transcript,/PRIVATE_INLINE_THINKING|PRIVATE_PROVIDER_THINKING/);
 const old=scene.latestScene(history);
 assert.equal(old.fromId,'a2');assert.equal(old.scene.time,null);assert.equal(old.scene.when,null);
 const next=scene.validateSceneValues('date: October 738 · time: evening · place: Hall · present: Mira',{prior:old.scene,narration:'Mira takes her seat.',userText:'Continue.'});
 assert.equal(scene.parseScene(next.scene).time,'evening');assert.equal(next.sceneMeta.provenance.time,'declared');
 assert.equal(scene.parseScene(next.scene).when,'October 738');assert.equal(next.sceneMeta.provenance.date,'declared');
 assert.equal(history.find(message=>message.id==='a2').scene,storedScene);
});
