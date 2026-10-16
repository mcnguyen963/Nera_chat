import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
