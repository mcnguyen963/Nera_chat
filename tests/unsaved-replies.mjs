import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('D1 unsaved replies survive a module reload and are cleared per account and story',async()=>{
 const docs=new Map(),request=read=>{const r={};queueMicrotask(()=>{r.result=read();r.onsuccess?.();});return r;},db={transaction:()=>{const tx={objectStore:()=>({get:k=>request(()=>docs.get(k)),put:(v,k)=>docs.set(k,structuredClone(v)),delete:k=>docs.delete(k)})};setTimeout(()=>tx.oncomplete?.(),0);return tx;}};
 const globals={indexedDB:{open:()=>request(()=>db)}},a=await appHarness({globals})('unsaved-replies.js');const value={sid:'s',message:{content:'Paid story.'},sourceRevision:3};await a.storeUnsavedReply('owner','s',value);await a.storeUnsavedReply('other','s',{...value,message:{content:'Other'}});
 const b=await appHarness({globals})('unsaved-replies.js');assert.equal((await b.loadUnsavedReply('owner','s')).message.content,'Paid story.');assert.ok(docs.has('nera.unsaved.owner.s'));await b.storeUnsavedReply('owner','s',null);assert.equal(await b.loadUnsavedReply('owner','s'),null);assert.equal((await b.loadUnsavedReply('other','s')).message.content,'Other');
});
test('D1 blocked IndexedDB remains best effort',async()=>{const a=await appHarness({globals:{indexedDB:{open:()=>{throw Error('Blocked');}}}})('unsaved-replies.js');await a.storeUnsavedReply('u','s',{message:{content:'Paid'}});assert.equal(await a.loadUnsavedReply('u','s'),null);});
