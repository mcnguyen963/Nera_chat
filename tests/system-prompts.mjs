import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function load(fetch) {
  const module = new vm.SourceTextModule(await readFile(new URL('../js/system-prompts.js', import.meta.url), 'utf8'), {
    context:vm.createContext({ URL, fetch }),
    initializeImportMeta(meta) { meta.url = 'https://example.test/nera/js/system-prompts.js'; },
  });
  await module.link(() => { throw new Error('Unexpected dependency'); });
  await module.evaluate();
  return module.namespace;
}

const diskFetch = async url => ({ ok:true, text:async () => readFile(new URL('../system prompts/'+url.pathname.split('/').at(-1), import.meta.url), 'utf8') });

test('prompt files load once at a Pages subpath and preserve text and template data', async () => {
  const urls = [];
  const api = await load(async (url, options) => {
    assert.equal(options.cache, 'no-cache');
    assert.ok(url.href.startsWith('https://example.test/nera/system%20prompts/'));
    urls.push(url.href);
    return diskFetch(url);
  });
  assert.equal(urls.length, Object.keys(api.prompts).length);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(Object.isFrozen(api.prompts));
  for (const [key, value] of Object.entries(api.prompts)) {
    assert.ok(value.trim(), key);
  }
  assert.doesNotMatch(api.prompts.narrator, /plan/i);
  assert.match(api.prompts.plan, /Never output <plan>/);
  assert.match(api.prompts.plan, /Omit it for pure OOC/);
  assert.match(api.prompts.continuity, /A lower line is not automatically truer/);
  const text = '$& {{PROTAGONIST}} <scene>literal</scene>';
  assert.ok(api.renderPrompt(api.prompts.plan, { PLAN:text }).includes('\n'+text+'\nEND FIXED AUTHOR PLAN'));
  assert.equal(api.renderPrompt('{{CONTENT}} {{UNKNOWN}}', { CONTENT:text }), text+' {{UNKNOWN}}');
});

test('missing and empty Markdown prompts fail visibly without an inline fallback', async () => {
  await assert.rejects(load(async () => ({ ok:false, status:404 })), /Failed to load system prompt .*HTTP 404/);
  await assert.rejects(load(async () => ({ ok:true, text:async () => '\n  \n' })), /System prompt is empty/);
  await assert.rejects(load(async () => { throw new Error('network unavailable'); }), /network unavailable/);
});
