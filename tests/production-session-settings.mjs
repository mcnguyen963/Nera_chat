import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function setup(session,{review,failWrites=false}={}) {
  let server=structuredClone(session), version=0, txReads=0;const patches=[];
  const firestore={
    doc:()=>({}),serverTimestamp:()=>1,increment:n=>({increment:n}),
    runTransaction:async(_db,work)=>{
      for(let attempt=0;attempt<10;attempt++) {
        const original=version,writes=[];
        const result=await work({get:async()=>{txReads++;const data=structuredClone(server);return {exists:()=>data!==null,data:()=>data};},update:(_target,partial)=>writes.push(partial)});
        if(version!==original)continue;
        if(failWrites && writes.length)throw new Error('offline');
        for(const partial of writes){patches.push(partial);for(const [key,value]of Object.entries(partial)){const path=key.split('.');let out=server;for(const part of path.slice(0,-1))out=out[part]??={};const end=path.at(-1);out[end]=value?.increment ? (out[end]??0)+value.increment : structuredClone(value);}}
        version++;return result;
      }
      throw new Error('Too many retries');
    },
  };
  const stubs={
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':firestore,'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},
    'continuity.js':{requestSource(){},usableLore:()=>({entries:[]}),effectivelyPaused(){return false;},StaleSourceError:class extends Error{},SupersededError:class extends Error{},assertExtractionSource(){}},
    'memory-settings.js':{normalizeMemory:m=>m ?? {},memoryTaskSettings:()=>({})},'turns.js':{dueRange:()=>null},
    'memory-prompts.js':{buildExtractionMessages(){}},'lore-lines.js':{parseMemoryLines(){},applyOps(){}},'llm-client.js':{chatCompletion(){}},'tokenizer.js':{countTokens(){}},
    'lore-store.js':{commitExtraction(){},markGeneratedForReview:async()=>{review?.({server,replace:value=>{server=value;version++;}});return [];}},
    'sessions.js':{updateSession:async(_sid,partial)=>{patches.push(partial);Object.assign(server,partial);}},
  };
  const context=vm.createContext({console,Date,Map,Set,structuredClone,AbortController,document:{dispatchEvent(){}},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}}}), cache=new Map();
  async function load(path){if(cache.has(path))return cache.get(path);const promise=(async()=>{const stub=stubs[path],source=!stub ? await readFile(new URL('../js/'+path,import.meta.url),'utf8') : '';const m=stub ? new vm.SyntheticModule(Object.keys(stub),function(){for(const[k,v]of Object.entries(stub))this.setExport(k,v);},{context,identifier:path}) : new vm.SourceTextModule(source,{context,identifier:path});await m.link((specifier,parent)=>load(specifier.startsWith('https:')?specifier:new URL(specifier,'https://local/'+parent.identifier).pathname.slice(1)));return m;})();cache.set(path,promise);return promise;}
  async function use(path){const m=await load(path);if(m.status!=='evaluated')await m.evaluate();return m.namespace;}
  return {use,patches,get server(){return server;},get reads(){return txReads;}};
}

test('D8 rebuild captures its revision before marking cards and keeps a concurrent invalidation',async()=>{
  const initial={historyRevision:2,memoryInvalidations:[{fromOrder:5,revision:2}],memoryState:{failureStreak:2},memory:{}};
  const h=await setup(initial,{review:({server,replace})=>replace({...server,historyRevision:3,memoryInvalidations:[...server.memoryInvalidations,{fromOrder:7,revision:3}]})});
  const updater=await h.use('memory-updater.js'),live={session:structuredClone(initial),messages:[],entries:[]};
  updater.configureMemoryUpdater({get:()=>live,busy:()=>false,prepare:async()=>{},patch:(_sid,state)=>Object.assign(live.session.memoryState,state)});
  assert.equal(await updater.rebuild('s'),true);
  assert.deepEqual(h.server.memoryInvalidations,[{fromOrder:7,revision:3}]);
  assert.equal(h.server.memoryState.needsRebuild,true);assert.equal(h.server.memoryState.rebuildFromOrder,7);
  assert.deepEqual(JSON.parse(JSON.stringify(live.session.memoryInvalidations)),[{fromOrder:7,revision:3}]);
});

test('D8 range rebuild removes only processed invalidations and retains earlier and newer edits',async()=>{
  const h=await setup({historyRevision:4,memoryInvalidations:[{fromOrder:2,revision:1},{fromOrder:8,revision:3},{fromOrder:8,revision:4}],memoryState:{}});
  const helper=await h.use('session-memory.js');
  const result=await helper.clearMemoryInvalidations('s',{seenRevision:3,fromOrder:5,pointer:4});
  assert.deepEqual(JSON.parse(JSON.stringify(result.memoryInvalidations)),[{fromOrder:2,revision:1},{fromOrder:8,revision:4}]);
  assert.equal(h.server.memoryState.extractedThroughOrder,4);assert.equal(h.server.memoryState.rebuildFromOrder,2);
});

test('D8 concurrent memory failures increment the server streak and pause at the server threshold',async()=>{
  const h=await setup({memoryState:{failureStreak:1}}),helper=await h.use('session-memory.js');
  await Promise.all([helper.recordMemoryFailure('s','first'),helper.recordMemoryFailure('s','second')]);
  assert.equal(h.server.memoryState.failureStreak,3);assert.equal(h.server.memoryState.paused,true);
  assert.ok(h.patches.every(p=>p['memoryState.failureStreak'].increment===1));
});

test('D8 session memory transactions refuse a tombstoned or missing story',async()=>{
  for(const session of [null,{deleting:true}]){
    const h=await setup(session),helper=await h.use('session-memory.js');
    await assert.rejects(helper.recordMemoryFailure('s','failure'),e=>e.name==='StoryDeleted');
    await assert.rejects(helper.clearMemoryInvalidations('s',{seenRevision:0}),e=>e.name==='StoryDeleted');
    assert.equal(h.patches.length,0);
  }
});

test('D8 settings diff writes changed leaves and leaves a concurrent extraction pointer and other choices intact',async()=>{
  const original={lorebooks:true,autoUpdate:false,books:{characters:{budget:500,on:true},events:{budget:300,on:true}}};
  const next=structuredClone(original);next.books.characters.budget=600;
  const h=await setup({memory:{...original,autoUpdate:true},memoryState:{extractedThroughOrder:100}}),helper=await h.use('session-memory.js');
  const partial=helper.diffMemorySettings(original,next);
  assert.deepEqual(JSON.parse(JSON.stringify(partial)),{'memory.books.characters.budget':600});
  assert.ok(!('memory' in partial));assert.ok(!('memoryState.extractedThroughOrder' in partial));
  assert.deepEqual(JSON.parse(JSON.stringify(helper.diffMemorySettings(original,original))),{});
});


test('D8 failed session transactions leave invalidations, pointers and failure streak unchanged',async()=>{
  const initial={memoryInvalidations:[{fromOrder:5,revision:1}],memoryState:{extractedThroughOrder:10,failureStreak:2}};
  const h=await setup(initial,{failWrites:true}),helper=await h.use('session-memory.js');
  await assert.rejects(helper.clearMemoryInvalidations('s',{seenRevision:1,pointer:0}),/offline/);
  await assert.rejects(helper.recordMemoryFailure('s','error'),/offline/);
  assert.deepEqual(h.server,initial);assert.equal(h.patches.length,0);
});
