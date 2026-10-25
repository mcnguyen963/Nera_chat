import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const messages=[{id:'u',order:1,role:'user',revision:0,content:'Begin.'},{id:'a',order:2,role:'assistant',revision:0,content:'Reply.'}];
const file=value=>({name:'story.json',size:1000,text:async()=>JSON.stringify(value)});
const backup=(extra={})=>({format:'nera-chat-backup',version:1,session:{id:'original',historyRevision:12,title:'Story',memoryState:{extractedThroughOrder:2,needsRebuild:true,rebuildFromOrder:1},memoryInvalidations:[{fromOrder:1,toOrder:2,revision:12}]},messages:plain(messages),lore:[],...extra});
async function setup({storage,changeAccount=false,failPublish=false}={}) {
 const calls=[],lore=[],session={id:'imported',historyRevision:0,nextOrder:0,storySettingsRevision:1};let owner='owner';
 const use=appHarness({stubs:{
  'auth.js':{currentUid:()=>owner},
  'sessions.js':{createSession:async()=>{calls.push('create');return session.id;},getSession:async()=>structuredClone(session),listSessions:async()=>[],deleteSession:async()=>calls.push('delete'),updateSession:async(_id,patch)=>{calls.push('publish');if(failPublish)throw Error('Publish failed');Object.assign(session,patch);}},
  'messages.js':{newMessageId:()=> 'recovered',getMessages:async()=>[],addMessagesBulk:async(_id,items)=>{calls.push('messages');session.historyRevision++;session.nextOrder=items.at(-1)?.order ?? 0;}},
  'lore-store.js':{getLore:async()=>lore,importLore:async(_id,plan)=>{calls.push('lore');lore.push(...plan.writes.map(w=>structuredClone(w.data)));session.loreRevision=(session.loreRevision ?? 0)+1;},migrateRecords:async()=>calls.push('migrate')},
  'ui/memory-ui.js':{download(){}},
  ...(storage?{'unsaved-replies.js':{storeUnsavedReply:async(...args)=>{calls.push('retain-reply');if(changeAccount)owner='other';return storage(...args);}}}:{}),
 }});
 return {use,api:await use('import-export.js'),calls,lore,session};
}

test('malformed JSONL reports original line numbers and performs no story writes',async()=>{
 const h=await setup(),text='\n'+JSON.stringify({character_name:'Story'})+'\n\n{"mes":"lost"\n'+JSON.stringify({mes:'Valid',is_user:true})+'\n{broken';
 await assert.rejects(h.api.importSillyTavern({name:'story.jsonl',size:text.length,text:async()=>text}),e=>{
  assert.deepEqual(Array.from(e.lineNumbers),[4,6]);assert.match(e.message,/4, 6/);return true;
 });assert.deepEqual(h.calls,[]);
});
test('full JSON syntax, invalid messages and malformed unsaved replies fail before creating a story',async()=>{
 for(const value of [backup({messages:[...messages,messages[0]]}),backup({messages:[{role:'assistant',content:null}]}),backup({unsavedReply:{message:{role:'assistant',content:42}}}),backup({version:99})]){
  const h=await setup();await assert.rejects(h.api.importSillyTavern(file(value)));assert.deepEqual(h.calls,[]);
 }
 const h=await setup(),damaged='{"format":"nera-chat-backup",\n"messages": [\n{"mes":"must not import as JSONL"}\n';
 await assert.rejects(h.api.importSillyTavern({name:'damaged.json',size:100,text:async()=>damaged}),/JSON backup is damaged/);assert.deepEqual(h.calls,[]);
});
test('blank lines and non-message records remain supported without losing the header',async()=>{
 const h=await setup(),parsed=h.api.parseSillyTavernJsonl('\n\n{"character_name":"Story"}\nnull\n[1]\n{}\n{"mes":"Hi","is_user":true}');
 assert.equal(parsed.title,'Story');assert.equal(parsed.messages.length,1);
});
test('invalid imported prompts and Director checkpoints fail before any story writes',async()=>{
 for(const extra of [{storySettings:{values:{narrationMode:'unsupported'}}},{directorTurns:[{id:'bad/path',version:1}]}]){
  const h=await setup();await assert.rejects(h.api.importSillyTavern(file(backup(extra))));assert.deepEqual(h.calls,[]);
 }
});

for(const schema of [2,3])test(`import v${schema} freezes stale lore and rebases valid provenance for future edits`,async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js'),records=await h.use('lore-records.js'),continuity=await h.use('continuity.js');
 const entry=makeEntry('characters','Mira');entry.id='mira';
 const history=[...plain(messages),{id:'u3',order:3,role:'user',revision:0,content:'Go on.'},{id:'a4',order:4,role:'assistant',revision:0,content:'More.'}];
 entry.sections.notes.lines=[
  {id:'stale',text:'Outdated fact.',by:'auto',src:2,sourceRevision:10,evidence:[{id:'a',order:2,revision:0}]},
  {id:'valid',text:'Established fact.',by:'auto',src:4,sourceRevision:12,evidence:[{id:'a4',order:4,revision:0}]},
  {id:'manual',text:'Author canon.',by:'user',sourceRevision:99},
 ];
 const core=await h.use('character-core.js');entry.coreReferences=[core.reviewCore(entry,[core.coreSource(entry,'notes','valid')])];
 let importedEntry=entry;
 if(schema===3){
  importedEntry=records.reconcileRecords(entry);
  for(const r of importedEntry.recordLayout.records)records.approveRecord(importedEntry,r,7);
  importedEntry=records.toRecordDocument(importedEntry);
 }
 const original=backup({messages:history,lore:[importedEntry]});const before=JSON.stringify(original);
 await h.api.importSillyTavern(file(original));const result=h.lore[0],lines=result.sections.notes.lines;
 assert.equal(JSON.stringify(original),before);
 assert.equal(lines[0].needsReview,true);assert.equal(lines[1].sourceRevision,0);assert.equal(lines[2].sourceRevision,99);
 assert.equal(h.session.memoryState.needsRebuild,true);assert.equal(h.session.memoryState.rebuildFromOrder,1);
 assert.equal(h.session.memoryState.extractedThroughOrder,2);assert.equal(h.session.memoryInvalidations,undefined);assert.equal(h.session.historyRevision,1);
 assert.equal(continuity.noteNeedsReview(lines[0],history,h.session),true);assert.equal(continuity.noteNeedsReview(lines[1],history,h.session),false);
 const edited={...h.session,memoryInvalidations:[{fromOrder:4,toOrder:4,revision:2}]};
 assert.equal(continuity.noteNeedsReview(lines[1],history,edited),true);
 assert.equal(core.resolveCore(result,result.coreReferences[0],{messages:history,session:h.session}).valid,true);
 if(schema===3){
  const valid=result.recordLayout.records.find(r=>records.resolveRecord(result,r).sources.some(s=>s.lineId==='valid'));
  const stale=result.recordLayout.records.find(r=>records.resolveRecord(result,r).sources.some(s=>s.lineId==='stale'));
  assert.equal(records.approvedRecord(result,valid),true);assert.equal(valid.approval.at,7);assert.equal(stale.approval,undefined);
 }
});
test('invalidated thread closure and timing sources remain marked for review after import',async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js'),entry=makeEntry('events','Promise');entry.id='promise';
 const note={by:'auto',src:2,sourceRevision:1,evidence:[{id:'a',order:2,revision:0}]};entry.statusSource=note;entry.threadMetaSource=note;
 await h.api.importSillyTavern(file(backup({lore:[entry]})));
 for(const key of ['statusSource','threadMetaSource']){assert.equal(h.lore[0][key].needsReview,true);assert.equal(h.lore[0][key].sourceRevision,0);}
});
test('existing invalid record approvals never become approved during rebasing; stale bundles stay grouped',async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js'),r=await h.use('lore-records.js');
 const entry=makeEntry('characters','Mira');entry.id='mira';entry.sections.personality.text='Only when invited.';
 entry.sections.notes.lines=[{id:'stale',text:'She follows.',by:'auto',src:2,sourceRevision:1,evidence:[{id:'a',order:2,revision:0}]}];
 const sources=r.recordSources(entry),record={id:'bundle',category:'constraint',coreCandidate:true,relatedEntryIds:[],triggers:[],sources:sources.filter(s=>s.data.text).map(s=>({sourceId:s.id,start:0,end:s.data.text.length,fingerprint:r.fingerprint(s)}))};
 entry.schemaVersion=3;entry.recordLayout={records:[record]};r.approveRecord(entry,record,7);
 const invalid=structuredClone(record);invalid.id='invalid';invalid.sources[0].fingerprint='already-invalid';entry.recordLayout.records.push(invalid);
 await h.api.importSillyTavern(file(backup({lore:[r.toRecordDocument(entry)]})));
 const result=h.lore[0];assert.equal(result.recordLayout.records.find(r=>r.id==='bundle').approval,undefined);
 assert.equal(result.recordLayout.records.find(r=>r.id==='invalid').approval,undefined);
 const {usableLore}=await h.use('continuity.js'),filtered=usableLore([result],messages,h.session).entries[0];
 // Filtering a stale source must not create an independently usable companion.
 assert.ok(filtered);assert.equal(r.resolveRecord(filtered,filtered.recordLayout.records.find(r=>r.id==='bundle')).valid,false);
 assert.equal(r.reconcileRecords(filtered).recordLayout.records.some(v=>v.id.startsWith('record_auto_')&&r.resolveRecord(filtered,v).text==='Only when invited.'),false);
});
test('rebuild bounds are clamped and unordered history restarts extraction',async()=>{
 for(const [order,expected] of [[-20,0],[999,2],[undefined,0]]){
  const h=await setup(),value=backup();value.session.memoryState.rebuildFromOrder=order;
  await h.api.importSillyTavern(file(value));assert.equal(h.session.memoryState.rebuildFromOrder,expected);
 }
 const h=await setup(),value=backup();delete value.messages[0].order;await h.api.importSillyTavern(file(value));
 assert.equal(h.session.memoryState.extractedThroughOrder,0);assert.equal(h.session.memoryState.rebuildFromOrder,0);
});

const unsaved=(extra={})=>({id:'paid',sid:'original',owner:'old-account',sourceRevision:12,message:{role:'assistant',content:'Paid narration.',thinking:'Private reasoning.'},...extra});
test('an imported Classic append stays separate and is rebound before story publication',async()=>{
 const retained=[],h=await setup({storage:async(...args)=>{retained.push(args);return true;}}),value=backup({messages:[messages[0]],unsavedReply:unsaved()});
 await h.api.importSillyTavern(file(value));const reply=retained[0][2],{requestSource}=await h.use('continuity.js');
 assert.equal(reply.owner,'owner');assert.equal(reply.sid,'imported');assert.equal(reply.id,'recovered');assert.equal(reply.recoveryCopyOnly,false);
 assert.equal(reply.message.thinking,'Private reasoning.');assert.equal(reply.sourceRevision,h.session.historyRevision);
 assert.deepEqual(plain(reply.expectedSource),plain(requestSource(h.session)));assert.equal(h.session.nextOrder,1);
 assert.ok(h.calls.indexOf('retain-reply')<h.calls.indexOf('publish'));assert.equal(h.api.importReport('imported').recoveredReply,true);
});
test('an imported replacement is saveable only for the unchanged final assistant target',async()=>{
 const retained=[],h=await setup({storage:async(...args)=>{retained.push(args);return true;}});
 await h.api.importSillyTavern(file(backup({unsavedReply:unsaved({id:'a',overwriteId:'a',order:2,continuation:true})})));
 assert.equal(retained[0][2].recoveryCopyOnly,false);assert.equal(retained[0][2].overwriteId,'a');
});
for(const [name,change] of [
 ['missing target',{overwriteId:'deleted',order:2}],['changed source',{sourceRevision:11}],['missing revision',{sourceRevision:null}],
 ['Director contract',{message:{role:'assistant',content:'Director reply.',directorTurnId:'missing'}}],['incomplete replacement',{replanReplacement:true,message:{role:'assistant',content:'Partial',truncated:true}}],
 ['changed author input',{expectedSource:{longTermPlan:'Different'}}],
 ['previously unsafe recovery',{recoveryCopyOnly:true,recoveryReason:'The original history was changed.'}],
])test(`recovered ${name} offers copy-only recovery`,async()=>{
 const retained=[],h=await setup({storage:async(...args)=>{retained.push(args);return true;}});
 await h.api.importSillyTavern(file(backup({messages:[messages[0]],unsavedReply:unsaved(change)})));
 assert.equal(retained[0][2].recoveryCopyOnly,true);assert.ok(retained[0][2].recoveryReason);
});
test('already saved narration is not duplicated as an unsaved reply',async()=>{
 const h=await setup({storage:async()=>{throw Error('Should not retain a duplicate');}});
 await h.api.importSillyTavern(file(backup({unsavedReply:unsaved({id:'a',message:{...messages[1]}})})));
 assert.equal(h.api.importReport('imported').recoveredReply,false);assert.equal(h.calls.includes('retain-reply'),false);
});
test('matching visible text with different saved scene data is retained for recovery',async()=>{
 const retained=[],h=await setup({storage:async(...args)=>{retained.push(args);return true;}});
 await h.api.importSillyTavern(file(backup({unsavedReply:unsaved({id:'a',overwriteId:'a',order:2,message:{...messages[1],scene:'Day 2 · A different location'}})})));
 assert.equal(retained.length,1);assert.equal(retained[0][2].message.scene,'Day 2 · A different location');
});
test('unavailable device storage retains narration in memory and clearly reports non-persistence',async()=>{
 const h=await setup();await h.api.importSillyTavern(file(backup({messages:[messages[0]],unsavedReply:unsaved()})));
 const store=await h.use('unsaved-replies.js'),reply=await store.loadUnsavedReply('owner','imported');
 assert.equal(reply.message.content,'Paid narration.');assert.equal(await store.loadUnsavedReply('other','imported'),null);
 assert.equal(h.api.importReport('imported').replyPersisted,false);assert.match(h.api.importReport('imported').message,/Keep this page open/);
});
test('account changes while retaining recovery cannot publish the imported story in another account',async()=>{
 const h=await setup({changeAccount:true,storage:async()=>true});
 await assert.rejects(h.api.importSillyTavern(file(backup({messages:[messages[0]],unsavedReply:unsaved()}))),/Account changed/);
 assert.equal(h.calls.includes('publish'),false);assert.equal(h.calls.includes('delete'),false);
});
test('a failed import clears its staged unsaved reply before cleanup',async()=>{
 const retained=[],h=await setup({failPublish:true,storage:async(...args)=>{retained.push(args);return true;}});
 await assert.rejects(h.api.importSillyTavern(file(backup({messages:[messages[0]],unsavedReply:unsaved()}))),/Publish failed/);
 assert.equal(retained.at(-1)[2],null);assert.equal(h.calls.at(-1),'delete');
});
