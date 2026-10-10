import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const history=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i,revision:0,narratorTurn:Math.floor(i/2)+1}));
const account={endpoint:'https://mock.local/chat',modelId:'shared-model',apiKey:'shared-key',streaming:false,maxContextTokens:50000,maxResponseTokens:2000,keepRecentMessagesAfterSummary:2,summarizerMaxTokens:2000,summarizerChunkTokens:20000,reasoning:{enabled:false}};
test('Resolver overlays only six story fields and leaves shared and device values intact',async()=>{
 const api=await appHarness()('story-settings.js'),base={...account,streamVibrationMode:'off',petMovement:'roam'};
 const resolved=api.resolveStorySettings(base,{narratorSystemPrompt:'Story A',apiKey:'intruder',maxContextTokens:1,petMovement:'stay',streamVibrationMode:'speed'});
 assert.equal(resolved.narratorSystemPrompt,'Story A');for(const key of ['apiKey','maxContextTokens','petMovement','streamVibrationMode'])assert.equal(resolved[key],base[key]);assert.equal(base.narratorSystemPrompt,undefined);
 const copied=api.explicitStorySettings({rewriteSystemPrompt:null});assert.equal(typeof copied.rewriteSystemPrompt,'string');assert.equal(Object.keys(copied).length,6);
});
test('Serialized narration, regeneration context, summary, rewrite, extraction and reorganize use each story prompt with unchanged calls',async()=>{
 const requests=[],saves=[];
 const use=appHarness({globals:{fetch:async(url,opts)=>{if(String(url)!==account.endpoint)return promptFetch(url,opts);const body=JSON.parse(opts.body);requests.push(body);return {ok:true,json:async()=>({choices:[{message:{content:'T2 [char] Mira | appearance: New scar'},finish_reason:'stop'}]})};}},stubs:{
  'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)},
  'messages.js':{getMessages:async()=>history,getCheckpointMessages:async()=>history,newMessageId:()=> 'summary',addMessage:async(sid,m,opts)=>{saves.push({sid,m,opts});return {id:m.id,message:m,historyRevision:1};}},
 }});
 const scope=await use('story-settings.js'),context=await use('context-builder.js'),client=await use('llm-client.js'),summary=await use('summarizer.js'),rewrite=await use('rewrite.js'),prompts=await use('memory-prompts.js'),lore=await use('lore-lines.js'),memory=await use('memory-settings.js'),turns=await use('turns.js'),reorganize=await use('memory-reorganize.js');
 for(const name of ['A','B']){
  const values={...scope.defaultStorySettings(),narratorSystemPrompt:'NARRATOR '+name,summarizerSystemPrompt:'SUMMARY '+name,rewriteSystemPrompt:'REWRITE '+name,memoryExtractionPrompt:'EXTRACT '+name,memoryReorganizePrompt:'REORGANIZE '+name};
  const settings=scope.resolveStorySettings(account,values),session={id:name,historyRevision:0},entry=lore.makeEntry('characters','Mira'),mem=memory.normalizeMemory({lagTurns:0,scene:true});
  entry.sections.appearance.lines=[{id:'note',text:'Old scar',turn:2,src:4,by:'auto',at:1,evidence:[{id:'m3',order:4,revision:0}]}];
  const before=requests.length;
  await client.chatCompletion({settings,messages:(await context.buildContextForRequest(session,settings,{messages:history,loreEntries:[]})).apiMessages});
  await client.chatCompletion({settings,messages:(await context.buildContextForRequest(session,settings,{messages:history,loreEntries:[],upToOrder:11})).apiMessages});
  await summary.runSummarization(session,settings,{messages:history,loreEntries:[]});
  await client.chatCompletion({settings,messages:await rewrite.buildRewriteMessages(settings,history,'Draft')});
  const range=turns.dueRange(history,{extractedThroughOrder:0},mem,{manual:true});
  const built=await prompts.buildExtractionMessages({settings,mem,entries:[entry],messages:history,range,count:async t=>Math.ceil(t.length/4)});
  await client.chatCompletion({settings:memory.memoryTaskSettings(settings,mem),messages:built.messages});
  await reorganize.runReorganizeBatch({session,settings,mem,messages:history},[entry],{[entry.id]:['appearance']},'');
  assert.equal(requests.length-before,6);
  for(const [i,marker]of ['NARRATOR','NARRATOR','SUMMARY','REWRITE','EXTRACT','REORGANIZE'].entries()){const r=requests[before+i];assert.ok(r.messages[0].content.includes(marker+' '+name));assert.equal(r.model,account.modelId);assert.ok(!('response_format'in r));assert.ok(!('provider'in r));assert.ok(!('storySettings'in r));}
 }
 assert.equal(saves.length,2);assert.equal(account.narratorSystemPrompt,undefined);
});
test('Explicit incompatible ending clocks are checked before prior and earlier matching references',async()=>{
 const scene=await appHarness()('scene.js'),raw='date: Day 1 · time: morning · place: Inn · present: Mira',prior=scene.parseScene(raw);
 for(const narration of ['It is night.','They began that morning.\n\nNow it is night.']){const result=scene.validateSceneValues(raw,{prior,narration});assert.equal(result.sceneMeta.provenance.time,'contradicted');assert.ok(result.warnings.length);}
 assert.equal(scene.validateSceneValues(raw,{prior,narration:'It is early morning.'}).warnings.length,0);
});
test('Apostrophe identity collisions require review, while unique matches retain displayed spelling',async()=>{
 const api=await appHarness()('lore-lines.js'),a=api.makeEntry('characters','D\'Arcy'),b=api.makeEntry('characters','D’Arcy');
 const op={book:'characters',name:'D’Arcy',tag:'char',section:'appearance',text:'New coat',turn:1,evidence:[]};
 assert.equal(api.normalizeName(a.name),api.normalizeName(b.name));assert.equal(api.applyOps([a],[op]).creates.length,0);assert.equal(api.applyOps([a],[op]).entries[0].name,a.name);
 assert.equal(api.duplicateCards([a,b]).size,2);assert.throws(()=>api.applyOps([a,b],[op]),/Duplicate cards/);
});
test('Invalidation ranges exclude older downstream notes but retain rebuilt notes and author canon',async()=>{
 const api=await appHarness()('continuity.js'),messages=[{id:'a',order:4,revision:0}],session={memoryInvalidations:[{fromOrder:2,toOrder:6,revision:7}],memoryState:{extractedThroughOrder:6}};
 const line={by:'auto',src:4,sourceRevision:6,evidence:[{id:'a',order:4,revision:0}]};
 assert.equal(api.noteNeedsReview(line,messages,session),true);assert.equal(api.noteNeedsReview({...line,sourceRevision:7},messages,session),false);
 assert.equal(api.noteNeedsReview({...line,by:'user'},messages,session),false);assert.equal(api.noteNeedsReview({...line,by:'import'},messages,session),false);
});
test('Summary cancellation discards output before saving and preserves a completed transaction',async()=>{
 for(const stage of ['chunk','save']){
  const controller=new AbortController(),saves=[];let calls=0;
  const use=appHarness({stubs:{'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)},'llm-client.js':{chatCompletion:async()=>{calls++;if(stage==='chunk')controller.abort('user');return {content:'Complete summary',finishReason:'stop'};}},'messages.js':{getMessages:async()=>history,getCheckpointMessages:async()=>history,newMessageId:()=> 'sum',addMessage:async(_sid,m)=>{saves.push(m);controller.abort('user');return {id:m.id,message:m,historyRevision:1};}}}});
  const summary=await use('summarizer.js'),settings={...account,summarizerSystemPrompt:'Summary',narratorSystemPrompt:'Narrator'};
  if(stage==='chunk'){await assert.rejects(summary.runSummarization({id:'s'},settings,{messages:history,signal:controller.signal}),/Summary stopped/);assert.equal(saves.length,0);}else{const result=await summary.runSummarization({id:'s'},settings,{messages:history,signal:controller.signal});assert.equal(result.summaryId,'sum');assert.equal(saves.length,1);}assert.equal(calls,1);
 }
});
test('Malformed streams, API rejection, and provider terminal reasons never offer partial recovery',async()=>{
 const settings={...account,streaming:true};
 for(const [event,classification] of [['{broken','malformed_response'],[JSON.stringify({error:{message:'Rejected'}}),'api_rejection'],[JSON.stringify({choices:[{finish_reason:'content_filter',delta:{}}]}),'provider_finish']]){
  const chunks=['data: '+JSON.stringify({choices:[{delta:{content:'Partial'}}]})+'\n','data: '+event+'\n'];let i=0;
  const api=await appHarness({globals:{fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>i<chunks.length ? {done:false,value:new TextEncoder().encode(chunks[i++])} : {done:true},cancel(){}})}})}})('llm-client.js');
  await assert.rejects(api.chatCompletion({settings,messages:[]}),error=>{assert.equal(error.classification,classification);assert.equal(error.partial,undefined);if(classification==='provider_finish')assert.equal(error.finishReason,'content_filter');return true;});
 }
});
test('Long conversation replays unchanged without provider calls or input mutation',async()=>{
 // Generate the replay in the test: private investigate/ exports are absent from clean checkouts.
 const messages=Array.from({length:581},(_,i)=>({id:'replay-'+i,order:i+1,role:i%2 ? 'assistant' : 'user',revision:0,narratorTurn:Math.floor(i/2)+1,
  content:`Replay message ${i+1}: Mira explores the quiet archive.\n`+('She studies a map, records the route, and leaves the sealed door untouched. '.repeat(24))}));
 const session={id:'replay',historyRevision:0,longTermPlan:'Mira decides when to open the archive door.',memory:{lorebooks:true,protagonist:'Mira'}},before=JSON.stringify({messages,session});let providerCalls=0;
 const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected storage call');}},'llm-client.js':{chatCompletion:async()=>{providerCalls++;throw Error('Unexpected provider call');}},'tokenizer.js':{countTokens:async t=>Math.ceil(new TextEncoder().encode(t).length/4)}}});
 const settingsApi=await use('story-settings.js'),context=await use('context-builder.js'),lore=await use('lore-lines.js'),entry=lore.makeEntry('characters','Mira');entry.sections.notes.text='Mira keeps the archive key.';const loreEntries=[entry],beforeLore=JSON.stringify(loreEntries);
 const built=await context.buildContextForRequest(session,{...account,...settingsApi.defaultStorySettings(),maxContextTokens:125000,maxResponseTokens:15000},{messages,loreEntries});
 assert.equal(messages.length,581);assert.equal(JSON.stringify({messages,session}),before);assert.equal(JSON.stringify(loreEntries),beforeLore);assert.equal(providerCalls,0);assert.ok(built.apiMessages.length);assert.ok(built.usedTokens<=125000);assert.ok(built.droppedCount>0);assert.ok(built.apiMessages.some(m=>m.content.includes('Replay message 581:')));
});

test('Active-story subscriptions replace prompts, ignore stale replies, and block failed loads',async()=>{
 let uid='u',releaseA,delayA=false;const docs=new Map(),callbacks=new Map();
 const snap=(path,metadata={})=>({metadata,exists:()=>docs.has(path),data:()=>structuredClone(docs.get(path))});
 const firestore={doc:(_db,...parts)=>({path:parts.join('/')}),serverTimestamp:()=>0,
  runTransaction:async(_db,work)=>{const writes=[];const result=await work({get:async ref=>{if(delayA && ref.path==='users/u/sessions/A/storySettings/current')await new Promise(resolve=>releaseA=resolve);return snap(ref.path);},set:(ref,v)=>writes.push([ref.path,v]),update:(ref,v)=>writes.push([ref.path,{...docs.get(ref.path),...v}])});for(const [path,value]of writes)docs.set(path,value);return result;},
  onSnapshot:(ref,next,error)=>{callbacks.set(ref.path,{next,error});return ()=>callbacks.delete(ref.path);},
 };
 const use=appHarness({stubs:{'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':firestore,'db.js':{db:{}},'auth.js':{currentUid:()=>uid}}});
 const pure=await use('story-settings.js'),store=await use('story-settings-store.js'),{state}=await use('state.js');state.settings=account;
 for(const owner of ['u','v'])for(const name of ['A','B']){docs.set(`users/${owner}/sessions/${name}`,{storySettingsRevision:1});docs.set(`users/${owner}/sessions/${name}/storySettings/current`,{version:1,revision:1,values:{...pure.defaultStorySettings(),narratorSystemPrompt:owner+' '+name}});}
 state.sessionId='A';delayA=true;const a=store.selectStorySettings('A');while(!releaseA)await new Promise(resolve=>setTimeout(resolve,0));
 state.sessionId='B';await store.selectStorySettings('B');releaseA();await a;assert.equal(store.effectiveActiveSettings().narratorSystemPrompt,'u B');assert.equal(callbacks.has('users/u/sessions/A/storySettings/current'),false);
 const path='users/u/sessions/B/storySettings/current',updated={...docs.get(path),revision:2,values:{...docs.get(path).values,narratorSystemPrompt:'Remote B'}};docs.set(path,updated);callbacks.get(path).next(snap(path));assert.equal(store.effectiveActiveSettings().narratorSystemPrompt,'Remote B');
 callbacks.get(path).error(Error('offline'));assert.throws(()=>store.effectiveActiveSettings(),/prompts have not loaded/);
 uid='v';state.sessionId='B';await store.selectStorySettings('B');assert.equal(store.effectiveActiveSettings().narratorSystemPrompt,'v B');assert.equal(callbacks.has(path),false);
 state.sessionId='missing';await assert.rejects(store.selectStorySettings('missing'));assert.equal(state.storySettings,null);assert.throws(()=>store.effectiveActiveSettings(),/prompts have not loaded/);
});
