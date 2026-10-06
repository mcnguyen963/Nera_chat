import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
