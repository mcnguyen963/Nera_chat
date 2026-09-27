// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const elements = new Map();
  class Element {
    value = ''; checked = false; hidden = true; style = {}; children = [];
    classList = { add() {}, remove() {}, toggle() {}, contains: () => true };
    listeners = {};
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    async dispatchEvent(event) {
      for (const fn of this.listeners[event.type] ?? []) await fn(event);
    }
    replaceChildren(...children) { this.children = children; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    remove() {}
    reportValidity() { return Number.isInteger(Number(this.value)) && Number(this.value) >= 0; }
  }
  const document = new Element();
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.createElement = () => new Element();
  document.querySelectorAll = () => [];
  document.querySelector = () => null;
  document.body = new Element();
  const calls = { writes: [], messages: [], requests: [], fail: false, response: 'summary' };
  const context = vm.createContext({
    console, structuredClone, document,
    window: { addEventListener() {} }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    setTimeout() {}, confirm: () => true,
    fetch: async (_url, options) => {
      calls.requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: calls.response } }] }) };
    },
  });
  const firestore = {
    doc: (...args) => args, collection() {}, query() {}, orderBy() {}, onSnapshot: () => () => {},
    getDoc: async () => ({ exists: () => false }),
    setDoc: async (_ref, settings) => {
      if (calls.fail) throw new Error('write denied');
      calls.writes.push(structuredClone(settings));
    },
  };
  const stubs = {
    'db.js': { db: {} },
    'auth.js': { currentUid: () => 'test-user' },
    'tokenizer.js': { countTokens: async (text) => text.length },
    'sessions.js': { getSession: async () => null, updateSession: async () => {} },
    'import-export.js': { importSillyTavern() {}, exportSillyTavern() {} },
    'messages.js': {
      getMessages: async () => [], newMessageId: () => 'summary-id',
      addMessage: async (...args) => { calls.messages.push(args); return { id: 'summary-id' }; },
    },
  };
  const cache = new Map();
  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    const pending = createModule(path);
    cache.set(path, pending);
    return pending;
  }
  async function createModule(path) {
    const stub = path.startsWith('https:') ? firestore : stubs[path];
    let module;
    if (stub) {
      module = new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context, identifier: path });
    } else {
      module = new vm.SourceTextModule(await readFile(new URL('../js/' + path, import.meta.url), 'utf8'), {
        context, identifier: path,
      });
    }
    await module.link((specifier, parent) => {
      const resolved = specifier.startsWith('https:') ? specifier
        : new URL(specifier, 'https://local/' + parent.identifier).pathname.slice(1);
      return load(resolved);
    });
    return module;
  }
  async function use(path) {
    const module = await load(path);
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  }
  const { state } = await use('state.js');
  const settings = await use('settings.js');
  state.settings = settings.hydrateProfiles(structuredClone(settings.DEFAULT_SETTINGS));
  return { use, state, settings, calls, document, el: document.getElementById,
    fire: (id, type = 'click') => document.getElementById(id).dispatchEvent({ type }) };
}

test('Settings and chat synchronize profiles, reasoning and actual request configuration', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  const view = await h.use('ui/settings-view.js');
  chat.initChatView(); view.initSettingsView();
  h.el('set-model').value = 'model-a';
  h.el('set-apikey').value = 'test-key';
  h.el('set-keep-n').value = '0';
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.keepRecentMessagesAfterSummary, 0);
  assert.match(h.el('chip-model').textContent, /model-a/);
  h.el('set-narrator-prompt').value = 'Custom narrator';
  await h.fire('btn-profile-copy');
  const copyId = h.state.settings.activeProfileId;
  h.el('set-model').value = 'model-b';
  await h.fire('btn-save-settings');
  h.el('quick-profile').value = 'default';
  await h.fire('quick-profile', 'change');
  assert.equal(h.el('set-model').value, 'model-a');
  assert.equal(h.state.settings.narratorSystemPrompt, 'Custom narrator');
  h.el('quick-thinking').value = 'high';
  await h.fire('quick-thinking', 'change');
  assert.equal(h.el('set-reasoning-effort').value, 'high');
  assert.equal(h.el('set-reasoning-enabled').checked, true);
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.effort, 'high');
  h.el('set-profiles').value = copyId;
  await h.fire('set-profiles', 'change');
  assert.equal(h.state.settings.modelId, 'model-b');
  assert.equal(h.el('quick-profile').value, copyId);
  await h.fire('btn-profile-delete');
  assert.equal(h.state.settings.modelId, 'model-a');
  const { buildRequestBody } = await h.use('llm-client.js');
  const body = buildRequestBody(h.state.settings, []);
  assert.equal(body.model, 'model-a');
  assert.equal(body.reasoning.effort, 'high');
});

test('Failed saves preserve live settings and profiles', async () => {
  const h = await harness();
  (await h.use('ui/chat-view.js')).initChatView();
  (await h.use('ui/settings-view.js')).initSettingsView();
  const before = structuredClone(h.state.settings);
  h.calls.fail = true;
  h.el('set-model').value = 'unsaved';
  await h.fire('btn-save-settings');
  assert.deepEqual(structuredClone(h.state.settings), before);
  await h.fire('btn-profile-copy');
  assert.deepEqual(structuredClone(h.state.settings), before);
  h.el('quick-thinking').value = 'high';
  await h.fire('quick-thinking', 'change');
  assert.deepEqual(structuredClone(h.state.settings), before);
  assert.equal(h.el('quick-thinking').value, 'off');
});

test('New accounts have a persisted profile and partial profiles cannot inherit another key', async () => {
  const h = await harness();
  const loaded = await h.settings.loadSettings();
  assert.equal(loaded.profiles[0].id, loaded.activeProfileId);
  const s = { ...loaded, apiKey: 'previous-key', profiles: [{ id: 'partial', modelId: 'other' }], activeProfileId: 'partial' };
  h.settings.mirrorFromActiveProfile(s);
  assert.equal(s.apiKey, '');
});

for (const keep of [0, 1, 3]) {
  test(`Summary keeps exactly ${keep} recent messages`, async () => {
    const h = await harness();
    const { runSummarization } = await h.use('summarizer.js');
    const messages = Array.from({ length: 5 }, (_, i) => ({ id: String(i), order: i + 1, role: 'user', content: 'event' }));
    const result = await runSummarization({ id: 'session' }, {
      ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: keep,
    }, { messages });
    assert.equal(result.foldedCount, 5 - keep);
    assert.equal(result.newBreakpointOrder, 5 - keep);
  });
}

test('Empty summarizer output does not advance checkpoint', async () => {
  const h = await harness();
  h.calls.response = '';
  const { runSummarization } = await h.use('summarizer.js');
  await assert.rejects(runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [{ id: 'm', order: 1, role: 'user', content: 'event' }] }), /empty summary/);
  assert.equal(h.calls.messages.length, 0);
});

test('Missing checkpoint and regeneration before checkpoint recover original history', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const session = { id: 's', activeSummaryMessageId: 'summary', breakpointOrder: 2 };
  const messages = [1, 2, 3].map((order) => ({ id: String(order), order, role: 'user', content: `event${order}`, tokenCount: 6 }));
  const missing = await buildContextForRequest(session, h.state.settings, { messages });
  assert.equal(missing.windowedCount, 3);
  messages.push({ id: 'summary', order: 4, role: 'summary', content: 'future events', tokenCount: 13 });
  const regen = await buildContextForRequest(session, h.state.settings, { messages, upToOrder: 2 });
  assert.equal(regen.windowedCount, 1);
  assert.equal(regen.apiMessages.some((m) => m.content.includes('future events')), false);
});

test('Streaming plan tags remain hidden even when split across chunks', async () => {
  const h = await harness();
  const { stripPlan } = await h.use('plan-parser.js');
  for (const tag of ['plan', 'plan_thread']) {
    const text = `<${tag}>secret</${tag}>`;
    for (let i = 1; i <= text.length; i++) assert.equal(stripPlan('Hello ' + text.slice(0, i)), 'Hello');
    assert.equal(stripPlan('Hello ' + text + 'World'), 'Hello World');
  }
});

test('Concurrent settings writes cannot silently overwrite each other', async () => {
  const h = await harness();
  const first = h.settings.saveSettings({ ...h.state.settings, modelId: 'first' });
  await assert.rejects(h.settings.saveSettings({ ...h.state.settings, modelId: 'second' }), /already in progress/);
  await first;
  assert.equal(h.state.settings.modelId, 'first');
  assert.equal(h.calls.writes.length, 1);
});

test('Auto-summary triggers when sliding window drops history below the threshold', async () => {
  const h = await harness();
  const { shouldAutoSummarize } = await h.use('summarizer.js');
  const result = await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings, narratorSystemPrompt: '', maxContextTokens: 1000,
    maxResponseTokens: 800, autoSummaryThresholdPercent: 90,
  }, [{ id: 'm', order: 1, role: 'user', content: 'large message', tokenCount: 300 }]);
  assert.equal(result, true);
});

test('Empty chat enables writing only after a story is selected', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  assert.equal(h.el('welcome').hidden, false);
  assert.equal(h.el('btn-welcome-new').hidden, false);
  assert.equal(h.el('chat-input').disabled, true);
  assert.equal(h.el('btn-send').disabled, true);
  assert.equal(chat.setSession('story'), true);
  assert.equal(h.el('btn-welcome-new').hidden, true);
  assert.equal(h.el('chat-input').disabled, false);
  assert.equal(h.el('btn-send').disabled, false);
  assert.equal(chat.setSession(null), true);
  assert.equal(h.el('btn-welcome-new').hidden, false);
  assert.equal(h.el('chat-input').disabled, true);
});
