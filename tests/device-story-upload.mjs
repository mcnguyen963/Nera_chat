import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=value=>JSON.parse(JSON.stringify(value));

async function setup({schema=2}={}) {
 const root='users/owner/sessions/story',documents=new Map(),fault={},calls={reads:0,transactions:0,activeWrites:0};
 const ref=(_db,...parts)=>({path:parts.join('/'),id:parts.at(-1)});
 const snapshot=target=>{const data=structuredClone(documents.get(target.path));return {id:target.id,ref:target,exists:()=>data!==undefined,data:()=>structuredClone(data)};};
 const fs={doc:ref,collection:ref,serverTimestamp:()=>new Date(),
  getDocFromServer:async target=>{calls.reads++;if(fault.receiptOffline&&target.path.includes('/storyRecovery/'))throw Error('Receipt offline');return snapshot(target);},
  getDocsFromServer:async target=>{calls.reads++;return {docs:[...documents].filter(([path])=>path.startsWith(target.path+'/')&&!path.slice(target.path.length+1).includes('/')).map(([path])=>snapshot({path,id:path.split('/').at(-1)}))};},
  runTransaction:async(_db,work)=>{
   const index=++calls.transactions,writes=[];let writing=false;
   const result=await work({get:async target=>{assert.equal(writing,false,'all transaction reads must precede writes');return snapshot(target);},set:(target,data)=>{writing=true;writes.push({target,data});},update:(target,data)=>{writing=true;writes.push({target,data,update:true});},delete:target=>{writing=true;writes.push({target,remove:true});}});
   const final=writes.some(w=>w.target.path===root);
   if(fault.failAt===index || fault.failFinal && final)throw Error('Network failed');
   for(const write of writes){if(write.target.path===root || !write.target.path.includes('/storyRecovery/'))calls.activeWrites++;if(write.remove)documents.delete(write.target.path);else documents.set(write.target.path,structuredClone(write.update?{...documents.get(write.target.path),...write.data}:write.data));}
   if(fault.loseAcknowledgement && final)throw Error('Reply lost after commit');
   return result;
  }};
 const use=appHarness({stubs:{'db.js':{db:{}},'auth.js':{currentUid:()=>fault.owner ?? 'owner'},'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':fs}}),api=await use('device-story-upload.js'),lines=await use('lore-lines.js');
 const lore=lines.makeEntry('facts','Device rule');lore.id='device-rule';lore.sections.text.text='Author-maintained canon.';
 const cloudLore=lines.makeEntry('facts','Cloud rule');cloudLore.id='cloud-rule';cloudLore.sections.text.text='Original cloud canon.';
 const cloudSession={title:'Cloud story',storageVersion:2,historyRevision:9,loreRevision:6,directorRevision:3,storySettingsRevision:4,nextOrder:3,loreSchemaVersion:schema,loreGeneration:schema===3?'old-generation':null,memory:{autoUpdate:false},createdAt:new Date(1000)};
 const oldMessages=[{id:'old-user',role:'user',order:1,content:'Cloud opening.'},{id:'old-reply',role:'assistant',order:3,content:'Cloud reply.',narratorTurn:1}];
 documents.set(root,cloudSession);documents.set(root+'/messageChunks/chunk_old',{messages:oldMessages,firstOrder:1,lastOrder:3});documents.set(root+'/storySettings/current',{version:6,revision:4,values:{narratorSystemPrompt:'Cloud prompt'}});
 const recordApi=await use('lore-records.js');documents.set(schema===3?root+'/loreV3/old-generation/entries/cloud-rule':root+'/lore/cloud-rule',schema===3?recordApi.toRecordDocument(cloudLore):cloudLore);
 const messages=[{id:'u',role:'user',order:1,revision:0,narratorTurn:1,content:'Phone action.'},{id:'a',role:'assistant',order:2,revision:0,narratorTurn:1,content:'Phone reply.',thinking:'Private thinking.',scene:'Day 1 · Inn'}];
 const device={format:'nera-chat-backup',version:1,deviceHistoryComplete:true,session:{id:'story',title:'Phone story',nextOrder:4,nextNarratorTurn:2,historyRevision:4,memory:{autoUpdate:true,protagonist:'Nera'},memoryState:{extractedThroughOrder:2,needsRebuild:false},longTermPlan:'Phone plan'},
  messages,storySettings:{version:6,revision:2,values:{narratorSystemPrompt:'Phone prompt',memoryExtractionPrompt:'Phone memory prompt'}},lore:[lore],loreSnapshot:{initialized:true,schemaVersion:schema,entries:[lore]},directorTurns:[]};
 const active=()=>plain([...documents].filter(([path])=>!path.includes('/storyRecovery/')));
 return {api,device,documents,root,fault,calls,active,use,cloudSession};
}

test('Device recovery finds pending turns missing from the open phone view without reading Firebase',async()=>{
 const {api,device,calls}=await setup(),base={session:{...device.session,historyRevision:1,nextOrder:1},messages:device.messages.slice(0,1),turns:{}};
 const op={id:'pending',kind:'add',payload:{id:'lost',message:{role:'assistant',content:'The missing long reply.'}},createdAt:1};
 const copies=api.deviceStoryCopies({sid:'story',current:base,outbox:{base,records:[{op,acknowledged:false}]},storySettings:device.storySettings,loreSnapshot:device.loreSnapshot});
 assert.equal(calls.reads,0);assert.equal(copies.length,2);assert.equal(copies[1].snapshot.messages.at(-1).content,'The missing long reply.');assert.equal(copies[1].snapshot.deviceHistoryComplete,true);
});

test('Device recovery preserves the full prompt and lore snapshot of a saved recovery backup',async()=>{
 const {api,device}=await setup();device.storySettings.values.narratorSystemPrompt='Recovered custom prompt';
 const copies=api.deviceStoryCopies({sid:'story',aux:{deviceRecoveryBackups:[{at:'yesterday',snapshot:device}]},storySettings:{values:{narratorSystemPrompt:'Different prompt'}},loreSnapshot:{entries:[]}});
 assert.equal(copies[0].snapshot.storySettings.values.narratorSystemPrompt,'Recovered custom prompt');assert.equal(copies[0].snapshot.lore.length,1);
});

test('Device recovery still offers complete copies when a damaged pending journal cannot replay',async()=>{
 const {api,device}=await setup(),view={session:device.session,messages:device.messages,turns:{}};
 const copies=api.deviceStoryCopies({sid:'story',current:view,outbox:{base:view,records:[{op:{kind:'invalid'}}]},storySettings:device.storySettings,loreSnapshot:device.loreSnapshot});
 assert.equal(copies.length,1);assert.equal(copies.warnings.length,1);assert.equal(copies[0].snapshot.messages.length,2);
});

test('Device recovery offers the visible unsaved reply and keeps it in downloads even when it cannot be applied',async()=>{
 const {api,device}=await setup(),view={session:device.session,messages:device.messages,turns:{}};
 const reply={id:'unsaved',sid:'story',owner:'owner',message:{role:'assistant',content:'Recovered unsaved narration'}};
 const options={sid:'story',current:view,storySettings:device.storySettings,loreSnapshot:device.loreSnapshot,unsavedReply:reply};
 const copies=api.deviceStoryCopies(options);assert.equal(copies.length,2);assert.equal(copies[1].snapshot.messages.at(-1).content,reply.message.content);
 assert.equal(copies[0].snapshot.unsavedReply.message.content,reply.message.content);
 reply.overwriteId='missing-reply';const failed=api.deviceStoryCopies(options);assert.equal(failed.length,1);assert.equal(failed.warnings.length,1);assert.equal(failed[0].snapshot.unsavedReply.overwriteId,'missing-reply');
});

test('Device upload refuses partial recent history, missing dependencies and duplicate IDs before server reads',async()=>{
 for(const mutate of [s=>delete s.deviceHistoryComplete,s=>s.messages=[],s=>s.loreSnapshot.initialized=false,s=>s.messages[1].id=s.messages[0].id,s=>s.session.activeSummaryMessageId='missing']){
  const {api,device,calls}=await setup();mutate(device);await assert.rejects(api.uploadDeviceStory(device),/complete|loaded|conflicting|checkpoint/);assert.equal(calls.reads,0);assert.equal(calls.activeWrites,0);
 }
});

for(const schema of [2,3])test('Device upload replaces the entire story atomically and preserves a cloud backup for lore v'+schema,async()=>{
 const {api,device,documents,root,calls,cloudSession}=await setup({schema}),result=await api.uploadDeviceStory(device);
 const saved=documents.get(root);assert.equal(saved.title,'Phone story');assert.equal(saved.historyRevision,10);assert.equal(saved.nextOrder,4,'deleted order counters must not be reused');assert.equal(saved.longTermPlan,'Phone plan');
 assert.deepEqual(plain(saved.memory),plain(device.session.memory));assert.deepEqual(plain(saved.memoryState),plain(device.session.memoryState));
 assert.equal(documents.get(root+'/storySettings/current').values.narratorSystemPrompt,'Phone prompt');assert.equal(saved.storySettingsRevision,5);
 const stored=[...documents].filter(([path])=>path.startsWith(root+'/messageChunks/')).flatMap(([,data])=>data.messages);
 assert.deepEqual(plain(stored),device.messages);assert.equal(stored[1].thinking,'Private thinking.');assert.equal(documents.has(root+'/messageChunks/chunk_old'),false);
 if(schema===2){assert.equal(documents.has(root+'/lore/cloud-rule'),false);assert.equal(documents.get(root+'/lore/device-rule').sections.text.text,'Author-maintained canon.');}
 else {assert.notEqual(saved.loreGeneration,'old-generation');assert.ok(documents.has(root+'/loreV3/'+saved.loreGeneration+'/entries/device-rule'));assert.ok(documents.has(root+'/loreV3/old-generation/entries/cloud-rule'));}
 const backup=documents.get(root+'/storyRecovery/'+result.backupId);assert.equal(backup.state,'completed');
 const parts=[...documents].filter(([path])=>path.startsWith(root+'/storyRecovery/'+result.backupId+'/parts/')).map(([,part])=>part);
 assert.ok(parts.some(p=>p.side==='cloud'&&p.tree==='session'&&p.data.historyRevision===cloudSession.historyRevision));
 assert.ok(parts.some(p=>p.side==='cloud'&&p.tree==='messageChunks'&&p.data.messages[1].content==='Cloud reply.'));
 assert.ok(parts.some(p=>p.side==='device'&&p.tree==='messageChunks'&&p.data.messages[1].content==='Phone reply.'));
 assert.equal(result.messages[1].id,'a');assert.equal(result.messageSnapshot.chunkRanges.length,1);assert.ok(calls.activeWrites>0);
});

for(const failure of ['backup','final'])test('Device upload '+failure+' failure keeps all active cloud data and the phone source unchanged',async()=>{
 const {api,device,fault,active}=await setup(),before=active(),phone=plain(device);
 if(failure==='backup')fault.failAt=1;else fault.failFinal=true;
 await assert.rejects(api.uploadDeviceStory(device),/Network failed/);assert.deepEqual(active(),before);assert.deepEqual(plain(device),phone);
});

test('Device upload stops if Firebase changes during backup instead of replacing the newer cloud state',async()=>{
 const {api,device,documents,root,calls}=await setup();
 await assert.rejects(api.uploadDeviceStory(device,{onProgress:text=>{if(text.startsWith('Replacing'))documents.get(root).historyRevision++;}}),/Firebase changed/);
 assert.equal(calls.activeWrites,0);assert.equal(documents.get(root).historyRevision,10);assert.equal(documents.get(root+'/messageChunks/chunk_old').messages[1].content,'Cloud reply.');
});

test('Device upload rejects a changed account before any active cloud replacement',async()=>{
 const {api,device,fault,calls}=await setup();
 await assert.rejects(api.uploadDeviceStory(device,{onProgress:text=>{if(text.startsWith('Saving'))fault.owner='someone-else';}}),/Account changed/);assert.equal(calls.activeWrites,0);
});

test('Device upload rejects oversized transactions and schema downgrades without mutating Firebase',async()=>{
 const large=await setup();large.device.messages=Array.from({length:12},(_,i)=>({id:'large-'+i,order:i+1,role:i%2?'assistant':'user',content:'x'.repeat(650000)}));
 await assert.rejects(large.api.uploadDeviceStory(large.device),/too large for one safe/);assert.equal(large.calls.transactions,0);
 const older=await setup({schema:3});older.device.loreSnapshot.schemaVersion=2;
 await assert.rejects(older.api.uploadDeviceStory(older.device),/older lorebook format/);assert.equal(older.calls.activeWrites,0);
});

test('Device upload supports long chunked stories without truncating their history',async()=>{
 const {api,device,documents,root}=await setup();device.messages=Array.from({length:2500},(_,i)=>({id:'long-'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:'Story event '+i+' '+'.'.repeat(120)}));device.session.nextOrder=2500;
 const result=await api.uploadDeviceStory(device),messages=[...documents].filter(([path])=>path.startsWith(root+'/messageChunks/')).flatMap(([,data])=>data.messages);
 assert.equal(messages.length,2500);assert.equal(messages.at(-1).content,device.messages.at(-1).content);assert.ok(result.messageSnapshot.chunkRanges.length>6);
});

test('Device upload recognizes a committed receipt if the final network acknowledgement was lost',async()=>{
 const {api,device,fault,documents,root}=await setup();fault.loseAcknowledgement=true;
 const result=await api.uploadDeviceStory(device);assert.equal(documents.get(root).lastDeviceUpload.id,result.backupId);assert.equal(documents.get(root).historyRevision,10);
});

test('Device upload distinguishes an unconfirmed final outcome from a failed backup',async()=>{
 const {api,device,fault,active}=await setup(),before=active();fault.failFinal=true;fault.receiptOffline=true;
 await assert.rejects(api.uploadDeviceStory(device),error=>error.uploadUncertain===true && /could not be confirmed/.test(error.message));assert.deepEqual(active(),before);
});

test('Device upload rebases a pending Director contract onto the uploaded story revision',async()=>{
 const {api,device,documents,root,use}=await setup();
 const state={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
 device.session.directorState=state;device.session.directorPending='pending';device.directorTurns=[{id:'pending',version:1,status:'pending',before:state,after:state,source:{historyRevision:4}}];
 const result=await api.uploadDeviceStory(device),{requestSource}=await use('continuity.js');
 assert.deepEqual(plain(documents.get(root+'/directorTurns/pending').source),plain(requestSource(result.session)));
});

test('Device upload backs up the active legacy history before publishing a chunked replacement',async()=>{
 const {api,device,documents,root}=await setup();documents.get(root).storageVersion=1;
 documents.set(root+'/messages/legacy-u',{role:'user',order:1,content:'Original legacy opening'});
 documents.set(root+'/messages/legacy-a',{role:'assistant',order:2,content:'Original legacy reply'});
 const result=await api.uploadDeviceStory(device);assert.equal(result.cloudBackup.messages[1].content,'Original legacy reply');assert.equal(result.cloudBackup.messages[1].id,'legacy-a');
 assert.equal(documents.get(root).storageVersion,2);assert.equal(documents.get(root+'/messages/legacy-a').content,'Original legacy reply');
});
