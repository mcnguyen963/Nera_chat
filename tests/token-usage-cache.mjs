import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {indexedDBFixture} from './indexeddb-fixture.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const sent=(overrides={})=>({kind:'provider',tokens:75000,max:120000,reserved:8192,at:100,modelId:'model',contextKey:'v1',report:{totals:{input:100000,max:120000},blocks:[{key:'summary',label:'Summary',tokens:30000}],inspection:'Do not persist full text'},...overrides});
async function factory(){return (await appHarness()('ui/token-usage-cache.js')).createTokenUsageCache();}

test('last-send provider count takes priority without invoking any estimator',async()=>{
 const cache=await factory();cache.remember('u','s',sent());let calls=0;
 for(let i=0;i<10;i++)assert.equal((await cache.estimate('u','s','new-context',()=>{calls++;throw Error('Must not count');})).tokens,75000);
 assert.equal(calls,0);assert.equal(cache.read('u','s').kind,'provider');
});
test('local last-send estimate also avoids a new calculation',async()=>{
 const cache=await factory();cache.remember('u','s',sent({kind:'sent-estimate',tokens:98000}));
 assert.equal((await cache.estimate('u','s','edited',()=>{throw Error('No recount');})).tokens,98000);
});
test('initial estimates coalesce and cache once per context revision',async()=>{
 const cache=await factory(),gate=deferred();let calls=0;
 const compute=async check=>{calls++;await gate.promise;check();return sent({tokens:4000});};
 const a=cache.estimate('u','s','v1',compute),b=cache.estimate('u','s','v1',compute);
 await Promise.resolve();assert.equal(calls,1);gate.resolve();await Promise.all([a,b]);
 await cache.estimate('u','s','v1',compute);assert.equal(calls,1);
 await cache.estimate('u','s','v2',compute);assert.equal(calls,2);assert.equal(cache.read('u','s').contextKey,'v2');
});
test('a delayed estimate cannot replace a newly received provider count',async()=>{
 const cache=await factory(),gate=deferred();
 const pending=cache.estimate('u','s','v1',async()=>{await gate.promise;return sent({tokens:100000});});
 await Promise.resolve();cache.remember('u','s',sent());gate.resolve();await assert.rejects(pending,/changed/);
 assert.equal(cache.read('u','s').tokens,75000);
});
test('manual previews coalesce, cache their full result in memory, and discard outdated work',async()=>{
 const cache=await factory(),gate=deferred();let calls=0,current=true;
 const compute=async check=>{calls++;await gate.promise;check();return {apiMessages:['large request']};};
 const a=cache.preview('u','s','v1',compute,()=>current),b=cache.preview('u','s','v1',compute,()=>current);
 await Promise.resolve();assert.equal(calls,1);gate.resolve();assert.equal(await a,await b);
 assert.equal((await cache.preview('u','s','v1',compute)).apiMessages[0],'large request');assert.equal(calls,1);
 const old=cache.preview('u','s','v2',async check=>{await Promise.resolve();current=false;check();},()=>current);
 await assert.rejects(old,/changed/);assert.equal(cache.hasPreview('u','s','v2'),false);
});
test('failed estimates remain cached until their context changes',async()=>{
 const cache=await factory();let calls=0;const compute=()=>{calls++;throw Error('No room');};
 for(let i=0;i<3;i++)await assert.rejects(cache.estimate('u','s','v1',compute),/No room/);
 assert.equal(calls,1);await assert.rejects(cache.estimate('u','s','v2',compute),/No room/);assert.equal(calls,2);
});
test('cancelled background estimates can resume at the same key without clearing a newer job',async()=>{
 const cache=await factory(),gate=deferred();let current=true,calls=0;
 const pending=cache.estimate('u','s','v1',async check=>{calls++;await gate.promise;check();return sent();},()=>current);
 await Promise.resolve();current=false;gate.resolve();await assert.rejects(pending,/changed/);
 current=true;await cache.estimate('u','s','v1',async()=>{calls++;return sent();},()=>current);assert.equal(calls,2);
 const oldGate=deferred(),newGate=deferred();
 const older=cache.estimate('u','s','v2',async check=>{await oldGate.promise;check();return sent();},()=>current);await Promise.resolve();
 const newer=cache.estimate('u','s','v3',async()=>{await newGate.promise;return sent({tokens:123});});await Promise.resolve();
 current=false;oldGate.resolve();await assert.rejects(older,/changed/);newGate.resolve();assert.equal((await newer).tokens,123);
});
test('cache keys isolate account and story, clear cancels work, and old restores cannot overwrite new results',async()=>{
 const cache=await factory();cache.remember('u','s',sent());assert.equal(cache.read('other','s'),null);assert.equal(cache.read('u','other'),null);
 cache.restore('u','s',sent({tokens:1,at:1,version:1}));assert.equal(cache.read('u','s').tokens,75000);
 cache.remember('u','s',sent({kind:'estimate',at:200}));cache.restore('u','s',sent({at:100,version:1}));assert.equal(cache.read('u','s').kind,'provider');
 const gate=deferred();const pending=cache.preview('u','s','v1',async()=>{await gate.promise;return {};});
 await Promise.resolve();cache.clear();gate.resolve();await assert.rejects(pending,/changed/);assert.equal(cache.read('u','s'),null);
});
test('persisted usage is compact, excludes private request/settings data, and survives reload through IndexedDB',async()=>{
 const cache=await factory(),idb=indexedDBFixture();cache.remember('u','s',sent({apiKey:'private-key',requestBody:{messages:['large secret request']}}));
 await cache.preview('u','s','v1',async()=>({requestBody:'large preview',settings:{apiKey:'private-key'}}));
 const serialized=cache.serialize('u','s');assert.doesNotMatch(JSON.stringify(serialized),/private-key|large secret request|large preview|Do not persist full text/);
 const use=appHarness({globals:{indexedDB:idb.indexedDB}}),storage=await use('chat-cache.js');
 await storage.saveChatCache('u','s',{session:{id:'s'},recent:[{content:'Story remains intact'}]});
 await storage.saveTokenUsage('u','s',serialized);const stored=await storage.loadChatCache('u','s');
 assert.equal(stored.recent[0].content,'Story remains intact');
 const reloaded=await factory();reloaded.restore('u','s',stored.tokenUsage);assert.equal(reloaded.read('u','s').tokens,75000);
 assert.equal(reloaded.hasPreview('u','s','v1'),false);
 await storage.clearChatCache('u');assert.equal(await storage.loadChatCache('u','s'),null);
});

test('saving token telemetry never reads or rewrites story content, and merges with legacy snapshots on reload',async()=>{
 const device=indexedDBFixture(),use=appHarness({globals:{indexedDB:device.indexedDB}}),storage=await use('chat-cache.js');
 const history=Array.from({length:5000},(_,i)=>({id:'m'+i,content:'x'.repeat(1000)}));
 const legacy={...sent({at:90,tokens:10}),version:1};
 await storage.saveChatCache('u','s',{session:{id:'s'},history,recent:history.slice(-100),tokenUsage:legacy});
 assert.equal((await storage.loadChatCache('u','s')).tokenUsage.tokens,10);
 const accesses=[],putSizes=[],transaction=device.db.transaction;
 device.db.transaction=(...args)=>{const tx=transaction(...args),objectStore=tx.objectStore;tx.objectStore=name=>{
  const store=objectStore(name);return {...store,get:key=>{accesses.push([name,'get']);return store.get(key);},put:value=>{accesses.push([name,'put']);putSizes.push(JSON.stringify(value).length);return store.put(value);}};
 };return tx;};
 assert.equal(await storage.saveTokenUsage('u','s',{...legacy,at:100,tokens:123}),true);
 assert.ok(accesses.every(([name])=>name!=='sessions'));assert.ok(Math.max(...putSizes)<2048);
 await storage.saveChatCache('u','s',{session:{id:'s'},history,recent:[],tokenUsage:legacy});
 const reopened=await appHarness({globals:{indexedDB:device.indexedDB}})('chat-cache.js');
 assert.equal((await reopened.loadChatCache('u','s')).tokenUsage.tokens,123);
 await reopened.saveChatCache('other','s',{session:{id:'s'},recent:[]});await reopened.saveTokenUsage('other','s',{...legacy,tokens:456});
 await reopened.clearChatCache('u');assert.equal(await reopened.loadChatCache('u','s'),null);
 assert.equal((await reopened.loadChatCache('other','s')).tokenUsage.tokens,456);
});
test('context fingerprints are compact and change for context settings',async()=>{
 const {tokenContextFingerprint}=await appHarness()('ui/token-usage-cache.js');
 const text='Long prompt '.repeat(10000),a=tokenContextFingerprint([text,1]);
 assert.ok(a.length<45);assert.equal(a,tokenContextFingerprint([text,1]));assert.notEqual(a,tokenContextFingerprint([text,2]));assert.ok(!a.includes(text));
});

test('leaving a story cancels only pending calculations while retaining completed cached previews',async()=>{
 const cache=await factory();await cache.preview('u','s','v1',async()=>({done:true}));
 cache.cancelPending('u','s');assert.equal(cache.hasPreview('u','s','v1'),true);
 const gate=deferred();const pending=cache.preview('u','s','v2',async()=>{await gate.promise;return {};});
 await Promise.resolve();cache.cancelPending('u','s');gate.resolve();await assert.rejects(pending,/changed/);
 assert.equal(cache.hasPreview('u','s','v2'),false);
});
