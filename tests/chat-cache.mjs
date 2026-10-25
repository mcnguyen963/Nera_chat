import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('Device recovery backups retain three complete copies and survive Sync for their own account and story',async()=>{
 const {indexedDBFixture}=await import('./indexeddb-fixture.mjs'),{appHarness}=await import('./app-harness.mjs');
 const device=indexedDBFixture(),cache=await appHarness({globals:{indexedDB:device.indexedDB}})('chat-cache.js');
 await cache.saveStoryData('u','A',{confirmed:{session:{id:'A'}},unrelated:'keep'});
 for(let n=0;n<4;n++)assert.equal(await cache.saveDeviceRecoveryBackup('u','A',{session:{id:'A'},messages:[{content:'Version '+n}]}),true);
 await cache.saveDeviceRecoveryBackup('other','A',{session:{id:'A'},messages:[{content:'Other account'}]});
 const snapshot={session:{id:'A'},recent:[],history:[],hasEarlier:false};
 await cache.replaceStoryCache('u','A',snapshot,{confirmed:{session:{id:'A'},messages:[],turns:{}}},{discardPending:true});
 const saved=await cache.loadStoryData('u','A');assert.equal(saved.deviceRecoveryBackups.length,3);assert.equal(saved.deviceRecoveryBackups[0].snapshot.messages[0].content,'Version 3');assert.equal(saved.unrelated,'keep');
 assert.equal((await cache.loadStoryData('other','A')).deviceRecoveryBackups[0].snapshot.messages[0].content,'Other account');
});

test('new and legacy recovery backups survive cache eviction and reload, and explicit deletion stays account-scoped',async()=>{
 const {indexedDBFixture}=await import('./indexeddb-fixture.mjs'),{appHarness}=await import('./app-harness.mjs');
 const backup={at:'2026-10-25',snapshot:{session:{id:'legacy'},messages:[{content:'Only local copy'}]}};
 const device=indexedDBFixture({storyData:[['u:legacy',{key:'u:legacy',value:{confirmed:{session:{id:'legacy'}},deviceRecoveryBackups:[backup]}}]]});
 const cache=await appHarness({globals:{indexedDB:device.indexedDB}})('chat-cache.js');
 await cache.saveChatCache('u','legacy',{session:{id:'legacy'},recent:[]});
 await cache.saveChatCache('u','new',{session:{id:'new'},recent:[]});
 await cache.saveDeviceRecoveryBackup('u','new',{session:{id:'new'},messages:[{content:'New recovery copy'}]});
 await cache.saveDeviceRecoveryBackup('other','legacy',backup.snapshot);
 for(const sid of ['B','C','D'])await cache.saveChatCache('u',sid,{session:{id:sid},recent:[]});
 const reopened=await appHarness({globals:{indexedDB:device.indexedDB}})('chat-cache.js');
 for(const [sid,text]of [['legacy','Only local copy'],['new','New recovery copy']]){
  assert.equal(await reopened.loadChatCache('u',sid),null);
  const saved=await reopened.loadStoryData('u',sid);
  assert.equal(saved.deviceRecoveryBackups[0].snapshot.messages[0].content,text);assert.equal(saved.confirmed,undefined);
 }
 await reopened.clearChatCache('u');assert.ok((await reopened.loadStoryData('u','legacy')).deviceRecoveryBackups.length);
 await reopened.saveDeviceRecoveryBackup('u','legacy',{session:{id:'legacy'},messages:[{content:'Another backup'}]});
 assert.equal((await reopened.loadStoryData('u','legacy')).deviceRecoveryBackups.length,2);
 await reopened.deleteChatCache('u','legacy');assert.equal(await reopened.loadStoryData('u','legacy'),null);
 assert.ok((await reopened.loadStoryData('other','legacy')).deviceRecoveryBackups.length);
});

test('Clearing device chat caches removes only the current account entries', async () => {
  const entries = new Map([
    ['u:A', { uid: 'u' }], ['u:B', { uid: 'u' }], ['other:A', { uid: 'other' }],
  ]);
  const db = {
    transaction: () => {
      const transaction = {
        objectStore: () => ({
          delete: key=>entries.delete(key),
          getAllKeys:()=>{const request={};queueMicrotask(()=>{request.result=[...entries.keys()];request.onsuccess();transaction.oncomplete();});return request;},
          openCursor: () => {
            const request = {};
            const keys = [...entries.keys()];
            const advance = () => queueMicrotask(() => {
              const key = keys.shift();
              request.result = key ? {
                value: entries.get(key), delete: () => entries.delete(key), continue: advance,
              } : null;
              request.onsuccess();
              if (!key) transaction.oncomplete();
            });
            advance();
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  const context = vm.createContext({ indexedDB: { open: () => {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  } } });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/chat-cache.js', import.meta.url), 'utf8'), { context });
  await module.link(() => {}); await module.evaluate();
  await module.namespace.clearChatCache('u');
  assert.deepEqual([...entries.keys()], ['other:A']);
});

test('Sync replaces the open story history and auxiliary caches in one transaction and retains other stories and accounts',async()=>{
 const {indexedDBFixture}=await import('./indexeddb-fixture.mjs');
 const {appHarness}=await import('./app-harness.mjs');
 const db=indexedDBFixture({sessions:[['u:A',{key:'u:A',value:{session:{id:'A',historyRevision:1}}}],['u:B',{key:'u:B',value:{session:{id:'B'}}}],['other:A',{key:'other:A',value:{session:{id:'other'}}}]],storyData:[['u:A',{key:'u:A',value:{confirmed:{session:{id:'A'}},turns:{stale:{}},unrelated:'keep'}}],['u:B',{key:'u:B',value:{lore:{entries:['keep']}}}]]});
 const use=appHarness({globals:{indexedDB:db.indexedDB}}),cache=await use('chat-cache.js');
 const snapshot={session:{id:'A',historyRevision:8},recent:[],history:[],hasEarlier:false};const data={confirmed:{session:snapshot.session,messages:[],turns:{}},turns:{},storySettings:{revision:4},lore:{revision:2,entries:[]},chunkRanges:[]};
 await cache.replaceStoryCache('u','A',snapshot,data);
 assert.equal(db.stores.get('sessions').get('u:A').value.session.historyRevision,8);assert.equal(db.stores.get('storyData').get('u:A').value.storySettings.revision,4);assert.equal(db.stores.get('storyData').get('u:A').value.unrelated,'keep');
 assert.deepEqual(db.stores.get('storyData').get('u:A').value.turns,{});assert.equal(db.stores.get('sessions').get('u:B').value.session.id,'B');assert.equal(db.stores.get('sessions').get('other:A').value.session.id,'other');assert.deepEqual(db.stores.get('storyData').get('u:B').value.lore.entries,['keep']);
});
