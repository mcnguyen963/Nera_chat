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
