import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

import {findChrome} from './browser-fixture.mjs';

// A fresh, unsigned browser profile and synthetic sources only. These checks use
// actual IndexedDB transactions, not the in-memory substitutes in unit tests.
test('browser index recovery, concurrent queue claims and summary field merging', {timeout:60000},async t=>{
  const chrome=await findChrome();
  if(!chrome)return t.skip('Chrome/Chromium unavailable.');
  t.diagnostic('Browser: '+chrome);
  const root=resolve('js'),prompts=resolve('system prompts'),profile=await mkdtemp(join(tmpdir(),'nera-index-recovery-'));
  const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Embedding maintenance test</title>');}const url=decodeURIComponent(req.url.split('?')[0]),isPrompt=url.startsWith('/system prompts/'),base=isPrompt?prompts:root,path=resolve(base,'.'+(isPrompt?url.slice('/system prompts'.length):url));if(!path.startsWith(base+'/')||!path.endsWith(isPrompt?'.md':'.js'))throw Error();res.setHeader('Content-Type',isPrompt?'text/plain':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  let serial=0,buffer='',errors='';const pending=new Map();
  const rejectAll=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
  browser.stderr.on('data',d=>errors=(errors+d).slice(-2000));browser.on('error',rejectAll);browser.on('exit',()=>rejectAll(Error(errors)));
  browser.stdio[3].on('error',rejectAll);browser.stdio[4].on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(message.id);if(!p)continue;clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result);}});
  const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out: '+errors));},15000);pending.set(id,{resolve,reject,timer});browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
  try{
    const {targetId}=await command('Target.createTarget',{url:'about:blank'}),{sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}),send=(method,params)=>command(method,params,sessionId);
    await send('Page.enable');await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    const evaluate=async fn=>{const out=await send('Runtime.evaluate',{expression:`(${fn})()`,awaitPromise:true,returnByValue:true});assert.ok(!out.exceptionDetails,JSON.stringify(out.exceptionDetails));return out.result.value;};
    const result=await evaluate(async()=>{
      const assert=(value,message)=>{if(!value)throw Error(message);},tick=()=>new Promise(r=>setTimeout(r,0)),defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
      const {recallStorage}=await import('/history-recall-storage.js'),{createLoreSemantic,loreIndexProgress,clearLoreSemanticAccount}=await import('/lore-semantic.js'),{createLoreIndexUpdater}=await import('/lore-index-updater.js'),{makeEntry}=await import('/lore-lines.js'),{mergeSummaryResult}=await import('/summary-state.js');
      const first=await recallStorage.mergePendingBatch('synthetic','story',{fromOrder:5,throughOrder:10});
      await Promise.all([recallStorage.mergePendingBatch('synthetic','story',{fromOrder:2,throughOrder:12}),recallStorage.mergePendingBatch('synthetic','story',{fromOrder:8,throughOrder:20})]);
      assert(!await recallStorage.clearPendingBatch('synthetic','story',first.version),'old job cleared newer pending range');
      const latest=await recallStorage.loadPendingBatch('synthetic','story');assert(latest.fromOrder===2&&latest.throughOrder===20&&latest.version===3,'concurrent ranges were lost');
      let owner='synthetic',fail=false,gate=null,started=0;
      const entry=makeEntry('characters','Mira',{id:'mira'});entry.sections.notes.text='Dilute the antidote.';
      const live={storyEpoch:1,historyComplete:true,session:{id:'story',loreRevision:1,memory:{semanticLore:true,semanticEndpoint:'http://localhost:11434/v1/embeddings',semanticModel:'synthetic',lorebooks:true}},messages:[],entries:[entry]};
      const semantic=createLoreSemantic({embedder:async(_connection,texts)=>{started++;const wait=gate;if(wait)await wait.promise;if(fail)throw Error('Synthetic interruption');return texts.map(()=>Float32Array.from([1,0]));}});
      const options={getSnapshot:()=>live,ownerNow:()=>owner,index:semantic.index,needsRefresh:semantic.needsRefresh},worker=createLoreIndexUpdater(options);
      gate=defer();const old=worker.request(live);while(!started)await tick();
      live.session.loreRevision=2;live.entries[0].sections.notes.text='Use clean water to dilute the antidote.';const changed=worker.request(live);gate.resolve();gate=null;await Promise.all([old,changed]);
      assert(worker.status(owner,'story')==='success','coalesced edit did not finish');assert(!await semantic.needsRefresh({owner,sid:'story',mem:live.session.memory,entries:live.entries}),'stale vector replaced changed record');
      live.session.loreRevision++;live.entries[0].sections.notes.text='A newer saved dose.';fail=true;await worker.request(live);assert(await loreIndexProgress.load(owner,'story'),'failure lost durable intent');
      fail=false;const reloaded=createLoreIndexUpdater(options);await reloaded.resume(live);assert(reloaded.status(owner,'story')==='success','reload failed to resume');assert(!await loreIndexProgress.load(owner,'story'),'completed job retained marker');
      // Simulate a save interrupted before it could write the pending marker.
      live.session.loreRevision++;live.entries[0].sections.notes.text='Final saved dose.';await createLoreIndexUpdater(options).resume(live);assert(!await semantic.needsRefresh({owner,sid:'story',mem:live.session.memory,entries:live.entries}),'save-to-queue crash gap was not repaired');
      gate=defer();live.session.loreRevision++;live.entries[0].sections.notes.text='Dose under review.';const indexing=reloaded.request(live),before=started;while(started===before)await tick();
      // A concurrent summary owns only its history fields. Its stale memory copy
      // must not replace the memory result that committed while it generated.
      Object.assign(live.session,{historyRevision:2,loreRevision:9,memoryState:{extractedThroughOrder:18}});
      live.session=mergeSummaryResult(live.session,{summaryId:'sum',newBreakpointOrder:16,historyRevision:3,session:{historyRevision:3,nextOrder:22,loreRevision:1,memoryState:{extractedThroughOrder:2}}});
      gate.resolve();gate=null;await indexing;
      assert(live.session.memoryState.extractedThroughOrder===18&&live.session.loreRevision===9&&live.session.breakpointOrder===16,'summary clobbered memory fields');
      await reloaded.request(live);assert(reloaded.status(owner,'story')==='success','newer memory could not finish indexing');
      live.entries=[];live.session.loreRevision++;await reloaded.request(live);assert((await semantic.exportVectors({owner,sid:'story',mem:live.session.memory})).length===0,'deleted source retained vector');
      gate=defer();const priorStarted=started,manual=semantic.index({owner,sid:'purge',mem:live.session.memory,entries:[entry]}).then(()=>false,error=>/cleared/.test(error.message));while(started===priorStarted)await tick();
      await clearLoreSemanticAccount(owner);gate.resolve();gate=null;assert(await manual,'manual index survived its account purge');
      assert((await semantic.exportVectors({owner,sid:'purge',mem:live.session.memory})).length===0,'manual index recreated purged vectors');
      owner='other';return {passed:true,concurrentClaims:true,reloadResume:true,crashGap:true,summaryMerge:true,emptyIndex:true};
    });
    assert.equal(result.passed,true);assert.equal(result.concurrentClaims,true);assert.equal(result.reloadResume,true);assert.equal(result.crashGap,true);assert.equal(result.summaryMerge,true);assert.equal(result.emptyIndex,true);
    if(process.env.NERA_LIVE_EMBEDDINGS==='1'){
      const provider=await evaluate(async()=>{
        const {createLoreSemantic}=await import('/lore-semantic.js'),{createRecallEngine}=await import('/history-recall-engine.js'),{recallStorage}=await import('/history-recall-storage.js'),{embedTexts}=await import('/history-embeddings.js'),{makeEntry}=await import('/lore-lines.js');
        const owner='synthetic-provider',sid='synthetic-provider',endpoint='http://127.0.0.1:11434/v1/embeddings',model='qwen3-embedding:0.6b',connection={endpoint,model,key:JSON.stringify([endpoint,model])},mem={semanticLore:true,semanticEndpoint:endpoint,semanticModel:model};
        const card=makeEntry('characters','Mira Validation',{id:'mira'});card.sections.notes.text='Mira prepares a willow-bark antidote in the harbor clinic.';
        const lore=createLoreSemantic();await lore.index({owner,sid,mem,entries:[card]});const match=await lore.search({owner,sid,mem,entries:[card],query:'Who prepares the antidote at the harbor clinic?'});
        if(!match.ids.includes('mira'))throw Error('Live provider lore search failed: '+match.status);
        const history=createRecallEngine({storage:recallStorage,embed:embedTexts}),messages=[{id:'u',order:1,role:'user',content:'Ask Mira where the antidote is kept.',revision:0},{id:'a',order:2,role:'assistant',content:'Mira says the willow-bark antidote is in the blue chest at the harbor clinic.',revision:0}];
        const indexed=await history.index({owner,sid,messages,connection});if(!indexed.persisted||indexed.rows.some(r=>r.dimensions!==1024||!r.formatVersion))throw Error('Live provider history metadata missing');
        const found=await history.search({owner,sid,connection,messages:[...messages,{id:'latest',order:3,role:'user',content:'Where is the willow-bark antidote kept?'}],excludeIds:['latest']});
        if(found.status!=='hybrid'||!found.passages.some(p=>p.messageId==='a'))throw Error('Live provider history search failed: '+found.status);
        return {model,dimensions:1024,lorePassed:true,historyPassed:true,devicePersisted:true};
      });
      assert.equal(provider.lorePassed,true);assert.equal(provider.historyPassed,true);t.diagnostic('Live localhost 0.6b provider passed lore and history browser indexing/search with synthetic text and real IndexedDB.');
    }
  }finally{browser.kill();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
