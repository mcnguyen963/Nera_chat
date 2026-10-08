import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('R1 maps database failures and throttles global errors while retaining twenty safe diagnostics',async()=>{
 const e=await appHarness()('errors.js');assert.match(e.friendlyError({code:'firestore/permission-denied'}),/not allowed/);assert.match(e.friendlyError({code:'resource-exhausted'}),/daily database quota/);assert.match(e.friendlyError({code:'unavailable'}),/Offline/);
 let now=0;const handlers={},shown=[];e.installErrorHandlers({target:{addEventListener:(t,f)=>handlers[t]=f},show:text=>shown.push(text),now:()=>now});
 for(let i=0;i<25;i++)handlers.unhandledrejection({reason:Error('secret-key story-text')});assert.equal(shown.length,1);now=10000;handlers.error({error:{code:'permission-denied'}});assert.equal(shown.length,2);assert.equal(e.recentErrors().length,20);assert.doesNotMatch(JSON.stringify(e.recentErrors()),/secret-key|story-text/);
});
test('D4 missing and tombstoned story guards fail closed',async()=>{const e=await appHarness()('errors.js');for(const s of [null,undefined,{deleting:true}])assert.throws(()=>e.assertStory(s),x=>x.name==='StoryDeleted');assert.equal(e.assertStory({historyRevision:1}).historyRevision,1);});
test('P1 diagnostics whitelist excludes account keys and story text',async()=>{const v=await appHarness()('version.js');const d=v.diagnostics({sessionId:'s',settings:{apiKey:'SECRET'},session:{content:'STORY',memoryState:{failureStreak:2,lastError:'STORY SECRET'}}},{version:{sha:'abcd',builtAt:'today'},agent:'Test'});assert.doesNotMatch(JSON.stringify(d),/SECRET|STORY/);assert.equal(d.memory.failureStreak,2);});
test('P1 manifest full SHA equals the running short stamp',async()=>{const v=await appHarness()('version.js');assert.equal(v.versionChanged('12345678','12345678'.padEnd(40,'a')),false);assert.equal(v.versionChanged('12345678','87654321'.padEnd(40,'b')),true);});
