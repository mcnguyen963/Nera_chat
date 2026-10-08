import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { appHarness } from './app-harness.mjs';

test('Tokenizer retries after cooldown and coalesces imports without retaining fallback estimates', async () => {
  const context = vm.createContext({ TextEncoder });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/tokenizer.js', import.meta.url), 'utf8'), { context });
  await module.link(() => { throw new Error('No static dependencies'); });
  await module.evaluate();
  let time = 0, fail = true;
  const imports = [];
  const tokenizer = module.namespace.createTokenizer({ now: () => time, importer: async url => {
    imports.push(url);
    if (fail) throw new Error('Local asset unavailable');
    return { countTokens: () => 3 };
  } });
  assert.deepEqual(await Promise.all([tokenizer.countTokens('long English text'), tokenizer.countTokens('long English text')]), [17, 17]);
  assert.equal(imports.length, 1);
  assert.equal(tokenizer.tokenizerReady(), false);
  time = 29999;
  assert.equal(await tokenizer.countTokens('long English text'), 17);
  assert.equal(imports.length, 1);
  time = 30000; fail = false;
  assert.equal(await tokenizer.countTokens('long English text'), 4);
  assert.equal(tokenizer.tokenizerReady(), true);
  assert.match(imports[1], /nera_retry=1/);
  assert.equal(await tokenizer.countTokens('long English text'), 4);
  assert.equal(imports.length, 2);
});

test('Tokenizer recovery recounts identical context text and ignores inflated stored counts', async () => {
  let ready = false;
  const counts = [];
  const use = appHarness({ stubs: {
    'messages.js': { getMessages: async () => [] },
    'tokenizer.js': {
      tokenizerReady: () => ready,
      countTokens: async text => { counts.push(String(text)); return ready ? 4 : String(text).length; },
    },
  } });
  const { buildContextForRequest } = await use('context-builder.js');
  const messages = [{ id:'u', order:1, role:'user', content:'Long English sentence', tokenCount:99999 }];
  const settings = { narratorSystemPrompt:'Narrate.', maxContextTokens:120000, maxResponseTokens:8192 };
  const fallback = await buildContextForRequest({ id:'s' }, settings, { messages });
  const beforeRecovery = counts.length;
  ready = true;
  const recovered = await buildContextForRequest({ id:'s' }, settings, { messages });
  assert.ok(recovered.usedTokens < fallback.usedTokens);
  assert.ok(counts.slice(beforeRecovery).includes(messages[0].content));
  assert.equal(recovered.usedTokens, recovered.apiMessages.length * 12 + 8);
  const beforeCached = counts.length;
  await buildContextForRequest({ id:'s' }, settings, { messages });
  assert.equal(counts.length, beforeCached);
});

test('Tokenizer encoder failures clear readiness so byte estimates never become cached token counts',async () => {
 const use=appHarness();const {createTokenizer}=await use('tokenizer.js');let time=0,imports=0;
 const tokenizer=createTokenizer({now:() => time,importer:async () => ++imports===1 ? {countTokens:() => {throw new Error('encoder failed');}} : {countTokens:() => 2}});
 assert.equal(await tokenizer.countTokens('Words'),5);assert.equal(tokenizer.tokenizerReady(),false);
 time=30001;assert.equal(await tokenizer.countTokens('Words'),3);assert.equal(tokenizer.tokenizerReady(),true);
});


test('Tokenizer loads only the pinned local vendor module, including retries', async () => {
 const use=appHarness();const {createTokenizer}=await use('tokenizer.js');let time=0;const urls=[];
 const tokenizer=createTokenizer({now:()=>time,importer:async url=>{urls.push(url);throw new Error('Local asset unavailable');}});
 await tokenizer.countTokens('hello');time=30000;await tokenizer.countTokens('hello');
 assert.deepEqual(urls,['./vendor/gpt-tokenizer-2.9.0.js','./vendor/gpt-tokenizer-2.9.0.js?nera_retry=1']);
});

test('Pinned cl100k_base vendor encodes known tokens without network dependencies',async () => {
 const source=await readFile(new URL('../js/vendor/gpt-tokenizer-2.9.0.js',import.meta.url),'utf8');
 assert.match(source,/MIT License/);
 const context=vm.createContext({TextEncoder,TextDecoder});const mod=new vm.SourceTextModule(source,{context});
 await mod.link(()=>{throw new Error('Vendor bundle must have no external imports');});await mod.evaluate();
 assert.deepEqual(Array.from(mod.namespace.encode('hello world')),[15339,1917]);
 assert.equal(mod.namespace.countTokens('hello world'),2);
});

test('CSP restricts executable sources while allowing custom LLM connections and Firebase frames',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
 assert.ok(policy);assert.match(policy,/script-src 'self' https:\/\/www\.gstatic\.com;/);
 assert.match(policy,/connect-src \*;/);assert.match(policy,/frame-src 'self' https:\/\/\*\.firebaseapp\.com;/);
 assert.match(policy,/object-src 'none';/);assert.match(policy,/base-uri 'self'/);
});
