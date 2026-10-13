import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

async function client(globals = {}) { return appHarness({ globals })('llm-client.js'); }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('model endpoint retains base path and query; unconventional endpoints retain manual entry', async () => {
  const api = await client();
  assert.equal(api.modelsEndpoint('https://host/custom/v1/chat/completions?key=x'), 'https://host/custom/v1/models?key=x');
  assert.equal(api.modelsEndpoint('https://host/v1/chat/completions/'), 'https://host/v1/models');
  for (const url of ['https://host/v1/messages', 'https://host/chat/completions/extra']) assert.throws(() => api.modelsEndpoint(url), /manual/);
  assert.throws(() => api.modelsEndpoint('no url'), /valid endpoint/);
  assert.throws(() => api.modelsEndpoint('ftp://host/chat/completions'), /http/);
});

test('discovery GET uses optional authentication and normalizes only IDs and names', async () => {
  const calls = [];
  const api = await client({ fetch: async (...args) => { calls.push(args); return response({ data: [{ id: 'z', name: 'Zed', context_length: 4 }, { id: 'a' }, { id: 'z' }, { id: '' }, null, { id: 2 }, { id: '  ' }] }); } });
  const settings = { endpoint: 'https://host/v1/chat/completions', apiKey: ' key ' };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.fetchModels(settings))), [{ id: 'a', name: '' }, { id: 'z', name: 'Zed' }]);
  assert.equal(calls[0][0], 'https://host/v1/models');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer key');
  await api.fetchModels({ ...settings, apiKey: '' });
  assert.equal('Authorization' in calls[1][1].headers, false);
});

test('discovery reports auth, unavailable listings, malformed JSON/data and network errors', async () => {
  for (const [reply, message] of [
    [response({}, 401), /authentication/], [response({}, 403), /authentication/],
    [response({}, 404), /unavailable/], [response({}, 500), /HTTP 500/],
    [response({ models: [] }), /data array/],
    [{ ok: true, json: async () => { throw Error(); } }, /expected JSON/],
  ]) {
    const api = await client({ fetch: async () => reply });
    await assert.rejects(api.fetchModels({ endpoint: 'https://host/chat/completions' }), message);
  }
  const api = await client({ fetch: async () => { throw Error('offline'); } });
  await assert.rejects(api.fetchModels({ endpoint: 'https://host/chat/completions' }), /connection/);
});

test('timeout and cancellation settle even when transport ignores abort', async () => {
  let timeout, delay, cleared = false, transportSignal;
  const api = await client({ fetch: async (_, options) => { transportSignal = options.signal; return new Promise(() => {}); },
    setTimeout: (fn, ms) => { timeout = fn; delay = ms; return 1; }, clearTimeout: () => { cleared = true; } });
  const pending = api.fetchModels({ endpoint: 'https://host/chat/completions' });
  assert.equal(delay, 30000); timeout();
  await assert.rejects(pending, /30 seconds/);
  assert.equal(transportSignal.aborted, true); assert.equal(cleared, true);
  const controller = new AbortController();
  const next = api.fetchModels({ endpoint: 'https://host/chat/completions' }, { signal: controller.signal });
  controller.abort(); await assert.rejects(next, /cancelled/);
  await assert.rejects(api.fetchModels({ endpoint: 'https://host/chat/completions' }, { signal: controller.signal }), /cancelled/);
});

class Field {
  value = ''; textContent = ''; disabled = false; hidden = false; style = {}; options = []; selectedIndex = -1; events = {}; attrs = {};
  addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
  async fire(type, event = {}) { for (const fn of this.events[type] ?? []) await fn(event); }
  replaceChildren(...options) { this.options = options; this.value = ''; }
  setAttribute(name, value) { this.attrs[name] = value; }
  focus() { this.focused = true; }
}
async function pickerHarness(discover) {
  const fields = Object.fromEntries(['button', 'picker', 'search', 'list', 'status', 'model', 'endpoint', 'apiKey'].map(key => [key, new Field()]));
  fields.endpoint.value = 'https://host/v1/chat/completions'; fields.apiKey.value = 'unsaved-key'; fields.model.value = 'manual';
  let captures = 0, draft = 'manual';
  const api = await appHarness({ globals: { document: { createElement: () => new Field() } } })('ui/model-picker.js');
  const control = api.initModelPicker({ ...fields, onSelect: () => { captures++; draft = fields.model.value; } }, discover);
  return { ...fields, control, api, captures: () => captures, draft: () => draft };
}
const models = [{ id: 'a/model', name: 'Alpha' }, { id: 'b/model', name: 'Beta' }];

test('picker filters locally, displays exact IDs, selects into draft and keeps manual entry', async () => {
  let calls = 0, connection;
  const h = await pickerHarness(async settings => { calls++; connection = settings; return models; });
  await h.button.fire('click');
  assert.equal(connection.apiKey, 'unsaved-key'); assert.equal(connection.endpoint, h.endpoint.value);
  assert.equal(h.picker.hidden, false); assert.equal(h.search.focused, true);
  assert.equal(h.list.options[0].textContent, 'Alpha (a/model)');
  h.search.value = 'BETA'; await h.search.fire('input'); assert.equal(h.list.options.length, 1);
  h.search.value = 'a/model'; await h.search.fire('input'); assert.equal(h.list.options[0].value, 'a/model');
  h.search.value = 'missing'; await h.search.fire('input'); assert.equal(h.list.options.length, 0);
  h.search.value = ''; await h.search.fire('input');
  h.list.value = 'b/model'; await h.list.fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(h.model.value, 'b/model'); assert.equal(h.draft(), 'b/model'); assert.equal(h.captures(), 1);
  assert.equal(h.picker.hidden, true); assert.equal(h.model.disabled, false); assert.equal(calls, 1);
  assert.match(h.status.textContent, /Save settings/);
});

test('picker ignores duplicate fetches and stale results after credentials change or lifecycle reset', async () => {
  for (const invalidation of ['endpoint', 'apiKey', 'reset']) {
    const requests = [];
    const h = await pickerHarness((settings, { signal }) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })));
    const first = h.button.fire('click');
    assert.equal(h.button.disabled, true); assert.equal(h.button.textContent, 'Fetching…');
    await h.button.fire('click'); assert.equal(requests.length, 1);
    if (invalidation === 'reset') h.control.reset();
    else { h[invalidation].value += 'edited'; await h[invalidation].fire('input'); }
    assert.equal(requests[0].signal.aborted, true);
    const second = h.button.fire('click');
    requests[0].resolve(models); await first;
    assert.equal(h.picker.hidden, true); assert.equal(h.button.disabled, true);
    requests[1].resolve(models); await second;
    assert.equal(h.picker.hidden, false); assert.equal(h.model.value, 'manual');
  }
});

test('picker preserves Model ID on failures and empty listings; Escape dismisses and returns focus', async () => {
  for (const discover of [async () => { throw Error('authentication failed'); }, async () => []]) {
    const h = await pickerHarness(discover); await h.button.fire('click');
    assert.equal(h.model.value, 'manual'); assert.equal(h.captures(), 0); assert.equal(h.button.disabled, false);
    assert.ok(h.status.textContent); assert.equal(h.picker.hidden, true);
  }
  const h = await pickerHarness(async () => models); await h.button.fire('click');
  let stopped = false;
  await h.picker.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(h.picker.hidden, true); assert.equal(h.button.focused, true);
});
