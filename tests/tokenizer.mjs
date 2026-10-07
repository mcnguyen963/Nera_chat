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
    if (fail) throw new Error('CDN offline');
    return { countTokens: () => 3 };
  } });
  assert.deepEqual(await Promise.all([tokenizer.countTokens('long English text'), tokenizer.countTokens('long English text')]), [17, 17]);
  assert.equal(imports.length, 2);
  assert.equal(tokenizer.tokenizerReady(), false);
  time = 29999;
  assert.equal(await tokenizer.countTokens('long English text'), 17);
  assert.equal(imports.length, 2);
  time = 30000; fail = false;
  assert.equal(await tokenizer.countTokens('long English text'), 4);
  assert.equal(tokenizer.tokenizerReady(), true);
  assert.match(imports[2], /nera_retry=1/);
  assert.equal(await tokenizer.countTokens('long English text'), 4);
  assert.equal(imports.length, 3);
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
