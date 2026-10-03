// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const elements = new Map();
  class Element {
    value = ''; checked = false; hidden = true; style = {}; children = []; dataset = {};
    classList = { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, toggle(name, force) { if (force ?? !this.values.has(name)) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } };
    listeners = {};
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    async dispatchEvent(event) {
      for (const fn of this.listeners[event.type] ?? []) await fn(event);
    }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    focus() { document.activeElement = this; }
    closest() { return { firstChild: { textContent: this.id } }; }
    getClientRects() { return [1]; }
    querySelectorAll() { return []; }
    querySelector(selector) { return this.children.find((child) => selector.startsWith('.')
      ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase())
      ?? this.children.map(child => child.querySelector?.(selector)).find(Boolean) ?? null; }
    getBoundingClientRect() { return { width: 100, height: 40, top: 0 }; }
    replaceWith(next) { const parent = this.parentNode; if (parent) { parent.children[parent.children.indexOf(this)] = next; next.parentNode = parent; this.parentNode = null; } }
    showModal() { this.open = true; }
    close() { this.open = false; void this.dispatchEvent({ type: 'close' }); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    insertBefore(child, anchor) { child.remove(); const index = anchor ? this.children.indexOf(anchor) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child; }
    append(...children) { this.children.push(...children); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
    reportValidity() { return this.id === 'set-endpoint' || (Number.isInteger(Number(this.value)) && Number(this.value) >= 0); }
  }
  const document = new Element();
  document.getElementById = (id) => {
    if (!elements.has(id)) {
      const element = new Element();
      element.id = id;
      const mins = { 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-chunk': 2000 };
      if (id in mins) element.dataset.min = String(mins[id]);
      if (id === 'set-auto-threshold') element.dataset.max = '100';
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document.createElement = (tag) => { const element = new Element(); element.tagName = tag.toUpperCase(); return element; };
  const panelNames = ['model', 'context', 'prompts', 'story', 'transfer', 'account'];
  const navButtons = panelNames.map((name) => {
    const button = document.getElementById(`nav-${name}`);
    button.dataset.settingsPanel = name;
    return button;
  });
  const panels = panelNames.map((name) => {
    const panel = document.getElementById(`panel-${name}`);
    panel.dataset.panel = name;
    return panel;
  });
  document.querySelectorAll = (selector) => selector === '[data-settings-panel]' ? navButtons : selector === '[data-panel]' ? panels : [];
  document.getElementById('settings-tab').classList.add('hidden');
  document.querySelector = () => null;
  document.body = new Element();
  const calls = { reads: 0, writes: [], messages: [], requests: [], queries: [], subscriptions: [], sessionCallbacks: [], settingsCallbacks: [], latestCallbacks: [], sessionWrites: [], imports: [], exports: [], settingsDoc: null, fail: false, confirm: true, response: 'summary', responseData: null, streamLines: null };
  const localCache = new Map();
  const context = vm.createContext({
    console, structuredClone, document, TextDecoder,
    localStorage: { getItem: (key) => localCache.get(key) ?? null, setItem: (key, value) => localCache.set(key, value) },
    window: { addEventListener() {} }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    setTimeout() {}, confirm: () => calls.confirm,
    fetch: async (_url, options) => {
      calls.requests.push(JSON.parse(options.body));
      if (calls.streamLines) {
        const chunks = calls.streamLines.map((line) => new TextEncoder().encode(line));
        return { ok: true, body: { getReader: () => ({ read: async () => chunks.length
          ? { done: false, value: chunks.shift() } : { done: true } }) } };
      }
      return { ok: true, json: async () => calls.responseData ?? ({ choices: [{ message: { content: calls.response } }] }) };
    },
  });
  const firestore = {
    doc: (...args) => args, collection() {},
    query: (...args) => { calls.queries.push(args); return args; },
    orderBy() {}, limitToLast: (count) => ({ limitToLast: count }), onSnapshot: (ref, callback) => { (ref?.[3] === 'settings' ? calls.settingsCallbacks : calls.sessionCallbacks).push(callback); return () => {}; },
    getDoc: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    getDocFromServer: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    setDoc: async (_ref, settings) => {
      if (calls.fail) throw new Error('write denied');
      calls.writes.push(structuredClone(settings));
    },
  };
  const stubs = {
    // The real pet controller is exercised independently in pets.mjs.
    'ui/pet-view.js': {
      initPetView() {}, startPetTurn() {}, finishPetTurn() {},
      refreshPetPlacement() {}, updatePetPhase() {}, invalidatePetLayout() {},
      loadPetCatalog: async () => [],
    },
    'db.js': { db: {} },
    'auth.js': { currentUid: () => 'test-user' },
    'tokenizer.js': { countTokens: async (text) => text.length },
    'sessions.js': {
      getSession: async () => ({ title: 'Story', longTermPlan: 'Old plan' }),
      updateSession: async (...args) => { calls.sessionWrites.push(args); },
      duplicateSession: async (...args) => { calls.sessionCopies ??= []; calls.sessionCopies.push(args); return 'copied-session'; },
    },
    'import-export.js': { importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); } },
    'messages.js': {
      getMessages: async () => { calls.historyReads = (calls.historyReads ?? 0) + 1; return calls.historyPending ?? calls.historyMessages ?? []; },
      getCheckpointMessages: async () => [], newMessageId: () => 'summary-id',
      addMessage: async (...args) => { calls.messages.push(args); return { id: 'summary-id' }; },
      subscribeLatestMessages: (sessionId, callback) => { calls.subscriptions.push(sessionId); calls.latestCallbacks.push(callback); return () => {}; },
      editPlanThread: async (...args) => {
        calls.privateNoteWrites ??= [];
        calls.privateNoteWrites.push(args);
        const message = { ...calls.noteMessage, planThread: args[2] || null, tokenCount: 100, editedAt: true };
        return { message, summaryReset: false };
      },
      editMessage: async (...args) => calls.editMessage(...args),
      deleteMessage: async (...args) => calls.deleteMessage(...args),
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
  return { use, state, settings, calls, localCache, document, el: document.getElementById,
    fire: (id, type = 'click') => document.getElementById(id).dispatchEvent({ type }) };
}

test('Settings drafts survive tabs and profiles, reset locally, and reach requests after save', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  const view = await h.use('ui/settings-view.js');
  chat.initChatView(); view.initSettingsView();
  view.openSettingsPopup(h.el('opener'));
  h.el('set-model').value = 'model-a';
  h.el('set-apikey').value = 'test-key';
  h.el('set-advanced-enabled').checked = true;
  await h.fire('set-advanced-enabled', 'change');
  h.el('set-temperature').value = '0.7';
  h.el('set-top-p').value = '0';
  h.el('set-frequency-penalty').value = '-2';
  h.el('set-presence-penalty').value = '2';
  h.el('set-keep-n').value = '0';
  h.el('set-auto-summary-enabled').checked = true;
  await h.fire('btn-profile-copy');
  const copyId = h.el('set-profiles').value;
  h.el('set-model').value = 'model-b';
  h.el('set-profiles').value = 'default';
  await h.fire('set-profiles', 'change');
  assert.equal(h.el('set-model').value, 'model-a');
  assert.equal(h.calls.writes.length, 0);
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.keepRecentMessagesAfterSummary, 0);
  assert.equal(h.state.settings.autoSummarizationEnabled, true);
  assert.equal(h.state.settings.profiles.length, 2);
  assert.equal(h.state.settings.profiles.find(p => p.id === copyId).modelId, 'model-b');
  assert.match(h.el('chip-model').textContent, /model-a/);
  const { buildRequestBody } = await h.use('llm-client.js');
  const body = buildRequestBody(h.state.settings, []);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0);
  assert.equal(body.frequency_penalty, -2);
  assert.equal(body.presence_penalty, 2);
  assert.equal(buildRequestBody({ ...h.state.settings, temperature: null, topP: null }, []).temperature, undefined);
  await h.fire('btn-reset-settings');
  assert.equal(h.el('set-model').value, 'model-a');
  assert.equal(h.el('set-temperature').value, '');
  assert.equal(h.state.settings.temperature, 0.7);
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.temperature, null);
  h.el('quick-thinking').value = 'high';
  await h.fire('quick-thinking', 'change');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.effort, 'high');
});

test('Invalid sampling and failed saves preserve the popup draft and live settings', async () => {
  const h = await harness();
  (await h.use('ui/chat-view.js')).initChatView();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  const before = structuredClone(h.state.settings);
  h.el('set-advanced-enabled').checked = true;
  await h.fire('set-advanced-enabled', 'change');
  h.el('set-temperature').value = '2.1';
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.el('settings-saved-msg').textContent, /Temperature|set-temperature/);
  h.el('set-temperature').value = '1.2';
  h.calls.fail = true;
  await h.fire('btn-save-settings');
  assert.deepEqual(structuredClone(h.state.settings), before);
  assert.equal(h.el('set-temperature').value, '1.2');
  assert.equal(h.el('settings-tab').classList.contains('hidden'), false);
  assert.match(h.el('settings-saved-msg').textContent, /Save failed/);
});

test('Thinking and sampling controls use only enabled request parameters', async () => {
  const h = await harness();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  assert.equal(h.settings.DEFAULT_SETTINGS.maxResponseTokens, 8192);
  assert.match(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /treat that plan as lost from context/);
  assert.equal(h.el('thinking-options').classList.contains('hidden'), true);
  assert.equal(h.el('advanced-options').classList.contains('hidden'), true);
  h.el('set-reasoning-enabled').checked = true;
  await h.fire('set-reasoning-enabled', 'change');
  assert.equal(h.el('thinking-options').classList.contains('hidden'), false);
  assert.equal(h.el('set-reasoning-maxtokens').disabled, true);
  h.el('set-reasoning-maxtokens').value = 'invalid but unused';
  h.el('set-temperature').value = '1.5';
  await h.fire('btn-save-settings');
  const { buildRequestBody } = await h.use('llm-client.js');
  let body = buildRequestBody(h.state.settings, []);
  assert.deepEqual(structuredClone(body.reasoning), { effort: 'medium' });
  assert.equal(body.temperature, undefined);
  h.el('set-reasoning-mode').value = 'max_tokens';
  await h.fire('set-reasoning-mode', 'change');
  assert.equal(h.el('set-reasoning-maxtokens').disabled, false);
  h.el('set-reasoning-maxtokens').value = '4096';
  h.el('set-advanced-enabled').checked = true;
  await h.fire('set-advanced-enabled', 'change');
  await h.fire('btn-save-settings');
  body = buildRequestBody(h.state.settings, []);
  assert.deepEqual(structuredClone(body.reasoning), { max_tokens: 4096 });
  assert.equal(body.temperature, 1.5);
});

test('Category navigation keeps edits; resets affect only the active draft tab', async () => {
  const h = await harness();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  h.el('set-model').value = 'kept-model';
  await h.fire('nav-context');
  assert.equal(h.el('panel-context').classList.contains('hidden'), false);
  assert.equal(h.el('panel-model').classList.contains('hidden'), true);
  h.el('set-keep-n').value = '2';
  await h.fire('nav-prompts');
  h.el('set-narrator-prompt').value = 'Custom';
  await h.fire('btn-reset-settings');
  assert.equal(h.el('set-narrator-prompt').value, h.settings.DEFAULT_SETTINGS.narratorSystemPrompt);
  await h.fire('nav-context');
  assert.equal(h.el('set-keep-n').value, '2');
  await h.fire('btn-reset-settings');
  assert.equal(h.el('set-keep-n').value, '10');
  assert.equal(h.el('set-auto-summary-enabled').checked, false);
  await h.fire('nav-model');
  assert.equal(h.el('set-model').value, 'kept-model');
  assert.equal(h.calls.writes.length, 0);
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.modelId, 'kept-model');
  assert.equal(h.state.settings.keepRecentMessagesAfterSummary, 10);
});

test('Closing a dirty popup asks to discard and returns focus', async () => {
  const h = await harness();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView();
  const opener = h.el('opener'); view.openSettingsPopup(opener);
  h.el('set-model').value = 'unsaved';
  h.calls.confirm = false;
  await h.fire('btn-close-settings');
  assert.equal(h.el('settings-tab').classList.contains('hidden'), false);
  h.calls.confirm = true;
  await h.fire('btn-close-settings');
  assert.equal(h.el('settings-tab').classList.contains('hidden'), true);
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.state.settings.modelId, '');
  view.openSettingsPopup(opener);
  assert.equal(h.el('set-model').value, '');
});

test('Story footer saves the active story and transfer actions remain wired', async () => {
  const h = await harness();
  h.state.sessionId = 'story-id';
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  await h.fire('nav-story');
  await Promise.resolve();
  assert.equal(h.el('btn-save-session').classList.contains('hidden'), false);
  assert.equal(h.el('btn-save-settings').classList.contains('hidden'), true);
  h.el('set-session-title').value = 'New title';
  h.el('set-session-plan').value = 'New plan';
  h.el('set-allow-llm-plan-updates').checked = true;
  await h.fire('btn-save-session');
  assert.deepEqual(structuredClone(h.calls.sessionWrites[0]), ['story-id', { title: 'New title', longTermPlan: 'New plan', allowLlmPlanUpdates: true }]);
  await h.fire('nav-transfer');
  await h.fire('btn-export-st');
  assert.deepEqual(h.calls.exports, ['story-id']);
  h.el('file-import-st').files = [{ name: 'story.jsonl' }];
  await h.fire('file-import-st', 'change');
  assert.equal(h.calls.imports.length, 1);
});

test('New accounts have a persisted profile and partial profiles cannot inherit another key', async () => {
  const h = await harness();
  const loaded = await h.settings.loadSettings();
  assert.equal(loaded.profiles[0].id, loaded.activeProfileId);
  const s = { ...loaded, apiKey: 'previous-key', profiles: [{ id: 'partial', modelId: 'other' }], activeProfileId: 'partial' };
  h.settings.mirrorFromActiveProfile(s);
  assert.equal(s.apiKey, '');
});

test('Settings reload from Firestore, while quick model and thinking changes stay local', async () => {
  const h = await harness();
  h.calls.settingsDoc = {
    profiles: [
      { id: 'first', name: 'First', modelId: 'model-a' },
      { id: 'second', name: 'Second', modelId: 'model-b' },
    ],
    activeProfileId: 'first',
  };
  h.state.settings = await h.settings.loadSettings();
  assert.equal(h.calls.reads, 1);
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  h.el('quick-profile').value = 'second';
  await h.fire('quick-profile', 'change');
  assert.equal(h.state.settings.modelId, 'model-b');
  h.el('quick-thinking').value = 'high';
  await h.fire('quick-thinking', 'change');
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(JSON.parse(h.localCache.get('roleplay-settings:test-user')).activeProfileId, 'second');
  assert.equal((await h.settings.loadSettings()).modelId, 'model-a');
  assert.equal(h.calls.reads, 2);
  await h.settings.saveSettings({ ...h.state.settings, activeProfileId: 'second', modelId: 'model-b' });
  assert.equal(h.calls.writes.length, 1);
  h.calls.settingsDoc = h.calls.writes[0];
  assert.equal((await h.settings.loadSettings()).modelId, 'model-b');
  assert.equal(h.calls.reads, 3);
});

test('A new account loads Firestore even when device cache is available', async () => {
  const h = await harness();
  await h.settings.loadSettings();
  h.calls.settingsDoc = h.calls.writes[0];
  await h.settings.loadSettings();
  assert.equal(h.calls.reads, 2);
  assert.equal(h.calls.writes.length, 1);
});

test('An open device receives saved settings from another device', async () => {
  const h = await harness();
  h.state.settings = await h.settings.loadSettings();
  h.settings.watchSettings();
  const remote = { ...h.state.settings, modelId: 'remote-model' };
  h.settings.mirrorToActiveProfile(remote);
  h.calls.settingsCallbacks[0]({ exists: () => true, data: () => remote, metadata: { fromCache: false, hasPendingWrites: false } });
  assert.equal(h.state.settings.modelId, 'remote-model');
  assert.equal(JSON.parse(h.localCache.get('roleplay-settings:test-user')).modelId, 'remote-model');
});

test('An existing default narrator prompt gains the missing plan thread rule without changing custom prompts', async () => {
  const h = await harness();
  const next = h.settings.DEFAULT_SETTINGS.narratorSystemPrompt;
  const old = next.slice(0, next.indexOf(' If, at the start of a turn'));
  h.calls.settingsDoc = { narratorSystemPrompt: old };
  assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, next);
  h.localCache.clear();
  h.calls.settingsDoc = { narratorSystemPrompt: 'Custom narrator' };
  assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, 'Custom narrator');
});

for (const keep of [0, 1, 3]) {
  test(`Summary keeps exactly ${keep} recent messages`, async () => {
    const h = await harness();
    const { runSummarization } = await h.use('summarizer.js');
    const messages = Array.from({ length: 5 }, (_, i) => ({ id: String(i), order: i + 1, role: 'user', content: 'event' }));
    const result = await runSummarization({ id: 'session' }, {
      ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: keep,
    }, { messages });
    assert.equal(result.foldedCount, 4 - keep); // first user stays uncompressed
    assert.equal(result.newBreakpointOrder, 5 - keep);
  });
}

test('Empty summarizer output does not advance checkpoint', async () => {
  const h = await harness();
  h.calls.response = '';
  const { runSummarization } = await h.use('summarizer.js');
  await assert.rejects(runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [
    { id: 'opening', order: 1, role: 'user', content: 'Opening' },
    { id: 'm', order: 2, role: 'user', content: 'event' },
  ] }), /no reply/);
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

test('Context uses the checkpoint and every later message supplied by the cache', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const session = { id: 's', activeSummaryMessageId: 'summary', breakpointOrder: 200 };
  const messages = [
    { id: 'summary', order: 201, role: 'summary', content: 'Earlier story', tokenCount: 13 },
    ...Array.from({ length: 150 }, (_, i) => ({
      id: `m${i}`, order: 202 + i, role: 'user', content: `turn ${i}`, tokenCount: 1,
    })),
  ];
  const result = await buildContextForRequest(session, {
    ...h.state.settings, maxContextTokens: 100000, maxResponseTokens: 1000,
  }, { messages });
  assert.equal(result.windowedCount, 150);
  assert.equal(result.apiMessages[1].content, 'Story so far:\nEarlier story');
  assert.equal(result.apiMessages.at(-1).content, 'turn 149');
});

test('Sliding context preserves the opening exchange and latest user while ejecting the middle', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  const settings = { ...h.state.settings, maxContextTokens: base.usedTokens + 115, maxResponseTokens: 100 };
  const messages = [
    { id: 'u1', order: 1, role: 'user', content: 'Opening', tokenCount: 25 },
    { id: 'a1', order: 2, role: 'assistant', content: 'Background', tokenCount: 25 },
    { id: 'u2', order: 3, role: 'user', content: 'Middle', tokenCount: 80 },
    { id: 'a2', order: 4, role: 'assistant', content: 'Small recent', tokenCount: 40 },
    { id: 'u3', order: 5, role: 'user', content: 'Latest', tokenCount: 30 },
  ];
  const result = await buildContextForRequest({ id: 's' }, settings, { messages, requireLatestUser: true });
  assert.deepEqual(Array.from(result.apiMessages.slice(1), (m) => m.content), ['Opening', 'Background', 'Small recent', 'Latest']);
  assert.equal(result.droppedCount, 1);
  assert.ok(result.usedTokens <= settings.maxContextTokens);
  await assert.rejects(buildContextForRequest({ id: 's' }, settings, {
    messages: messages.map((m) => m.id === 'u3' ? { ...m, tokenCount: 500 } : m), requireLatestUser: true,
  }), /opening story and latest user message exceed/);
});

test('Opening exchange survives a summary checkpoint and regeneration uses the prior plan', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [
    { id: 'u1', order: 1, role: 'user', content: 'The kingdom begins here', tokenCount: 30 },
    { id: 'a1', order: 2, role: 'assistant', content: 'The first scene', tokenCount: 30 },
    { id: 'u2', order: 3, role: 'user', content: 'Later event', tokenCount: 20 },
    { id: 'sum', order: 4, role: 'summary', content: 'Story summary', tokenCount: 20 },
    { id: 'u3', order: 5, role: 'user', content: 'Current turn', tokenCount: 20 },
  ];
  const session = { id: 's', longTermPlan: 'Future plan', activeSummaryMessageId: 'sum', breakpointOrder: 3 };
  const current = await buildContextForRequest(session, h.state.settings, { messages, requireLatestUser: true });
  assert.deepEqual(Array.from(current.apiMessages.slice(1), (m) => m.content),
    ['Story so far:\nStory summary', 'The kingdom begins here', 'The first scene', 'Current turn']);
  const regen = await buildContextForRequest(session, h.state.settings, {
    messages, upToOrder: 2, planOverride: 'Original plan', requireLatestUser: true,
  });
  assert.match(regen.apiMessages[0].content, /Original plan/);
  assert.doesNotMatch(regen.apiMessages[0].content, /Future plan/);
  assert.equal(regen.apiMessages.some((m) => m.content.includes('Story summary')), false);
});

test('Story plan is locked by default and model edits require the story toggle', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const locked = await buildContextForRequest({ id: 's', longTermPlan: 'The reunion happens on day 20' }, h.state.settings, { messages: [] });
  assert.match(locked.apiMessages[0].content, /plan is fixed/);
  assert.match(locked.apiMessages[0].content, /day 20/);
  const editable = await buildContextForRequest({ id: 's', longTermPlan: 'The reunion happens on day 20', allowLlmPlanUpdates: true }, h.state.settings, { messages: [] });
  assert.match(editable.apiMessages[0].content, /may update it/);
  assert.doesNotMatch(editable.apiMessages[0].content, /plan is fixed/);
});

test('Context budget reserves message framing as short turns accumulate', async () => {
  const h = await harness();
  const { buildContextForRequest, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } = await h.use('context-builder.js');
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  assert.ok(base.usedTokens >= MESSAGE_FRAME_TOKENS + REQUEST_FRAME_TOKENS);
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), order: i + 1, role: 'user', content: 'x', tokenCount: 1 }));
  const budget = base.usedTokens + 20 + MESSAGE_FRAME_TOKENS * 5;
  const result = await buildContextForRequest({ id: 's' }, { ...h.state.settings, maxContextTokens: budget, maxResponseTokens: 100 }, { messages });
  assert.ok(result.windowedCount < messages.length);
  assert.ok(result.usedTokens <= budget);
});

test('Summarizer bounds each request to the configured context', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  const settings = { ...h.state.settings, modelId: 'test', streaming: false,
    maxContextTokens: 2000, summarizerMaxTokens: 1000, summarizerChunkTokens: 1000,
    keepRecentMessagesAfterSummary: 0 };
  const messages = Array.from({ length: 4 }, (_, i) => ({ id: String(i), order: i + 1,
    role: 'user', content: 'event '.repeat(65) }));
  await runSummarization({ id: 's' }, settings, { messages });
  assert.ok(h.calls.requests.length > 1);
  assert.ok(h.calls.requests.every((request) => request.max_tokens <= Math.floor(2000 / 3) &&
    request.messages.reduce((sum, message) => sum + message.content.length + 8, 8) <= 2000));
});

test('Summarizer disables chat reasoning on every request', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  await runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 20000 },
    keepRecentMessagesAfterSummary: 0,
  }, { messages: [
    { id: 'opening', order: 1, role: 'user', content: 'Opening' },
    { id: '1', order: 2, role: 'user', content: 'A new event' },
  ] });
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.requests[0].reasoning, undefined);
});

test('Incomplete streamed replies are rejected', async () => {
  const h = await harness();
  const { chatCompletion } = await h.use('llm-client.js');
  const settings = { ...h.state.settings, modelId: 'test', streaming: true };
  h.calls.streamLines = ['data: {"choices":[{"delta":{"content":"partial"}}]}\n'];
  await assert.rejects(chatCompletion({ settings, messages: [] }), /ended before completion/);
  h.calls.streamLines = ['data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n', 'data: [DONE]\n'];
  await assert.rejects(chatCompletion({ settings, messages: [] }), /output limit/);
});

test('Model errors and abnormal endings are rejected before a reply is saved', async () => {
  const h = await harness();
  const { chatCompletion } = await h.use('llm-client.js');
  const settings = { ...h.state.settings, modelId: 'test', streaming: false };
  h.calls.responseData = { error: { message: 'quota exceeded' } };
  await assert.rejects(chatCompletion({ settings, messages: [] }), /quota exceeded/);
  h.calls.responseData = { choices: [{ finish_reason: 'content_filter', message: { content: 'partial' } }] };
  await assert.rejects(chatCompletion({ settings, messages: [] }), /content_filter/);
  h.calls.responseData = { choices: [{ finish_reason: 'stop', message: { content: '' } }] };
  await assert.rejects(chatCompletion({ settings, messages: [] }), /no reply/);
  settings.streaming = true;
  h.calls.streamLines = ['data: {"error":{"message":"provider failed"}}\n', 'data: [DONE]\n'];
  await assert.rejects(chatCompletion({ settings, messages: [] }), /provider failed/);
  h.calls.streamLines = ['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"content_filter"}]}\n', 'data: [DONE]\n'];
  await assert.rejects(chatCompletion({ settings, messages: [] }), /content_filter/);
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

test('Plan thread is stored for reference and excluded from model context', async () => {
  const h = await harness();
  const { extractPlanThread, stripPlan } = await h.use('plan-parser.js');
  const reply = 'The door opens. <plan_thread>steering toward the reunion</plan_thread>';
  assert.equal(extractPlanThread(reply), 'steering toward the reunion');
  assert.equal(stripPlan(reply), 'The door opens.');
  const { buildContextForRequest } = await h.use('context-builder.js');
  const result = await buildContextForRequest({ id: 'story' }, h.state.settings, {
    messages: [{ id: 'm', order: 1, role: 'assistant', content: 'The door opens.', planThread: 'steering toward the reunion', tokenCount: 12 }],
  });
  assert.equal(result.apiMessages.at(-1).content, 'The door opens.');
});

test('Author direction tags are normalized in model context', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [
    { id: 'm1', order: 1, role: 'user', content: '<ad>What happened between Nera and Elise?<ad>', tokenCount: 50 },
    { id: 'm2', order: 2, role: 'user', content: '<ad>Continue the scene</ad>', tokenCount: 30 },
  ];
  const result = await buildContextForRequest({ id: 'story' }, h.state.settings, { messages });
  assert.match(result.apiMessages[0].content, /out-of-story author direction/);
  assert.equal(result.apiMessages[1].content, '<ad>What happened between Nera and Elise?</ad>');
  assert.equal(result.apiMessages[2].content, '<ad>Continue the scene</ad>');
  assert.equal(messages[0].content, '<ad>What happened between Nera and Elise?<ad>');
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
    maxResponseTokens: 800, autoSummaryThresholdPercent: 90, autoSummarizationEnabled: true,
  }, [{ id: 'm', order: 1, role: 'user', content: 'large message', tokenCount: 300 }]);
  assert.equal(result, true);
  assert.equal(await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings, autoSummarizationEnabled: false,
  }, [{ id: 'm', order: 1, role: 'user', content: 'large message', tokenCount: 300 }]), false);
});

test('This story saves private notes for reference without resending them', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'story', exists: () => true, data: () => ({ title: 'Story', longTermPlan: 'Old plan' }) });
  h.calls.noteMessage = { id: 'reply', order: 2, role: 'assistant', content: 'The story continues.', planThread: 'Original note' };
  h.calls.latestCallbacks.at(-1)({ messages: [h.calls.noteMessage], hasEarlier: false });
  const view = await h.use('ui/settings-view.js');
  view.initSettingsView(); view.openSettingsPopup();
  await h.fire('nav-story');
  await Promise.resolve();
  assert.equal(h.el('set-session-private-note').value, 'Original note');
  assert.equal(h.el('set-session-private-note').disabled, false);
  h.el('set-session-private-note').value = 'Edited direction for the next scene';
  h.calls.latestCallbacks.at(-1)({ messages: [h.calls.noteMessage], hasEarlier: false });
  assert.equal(h.el('set-session-private-note').value, 'Edited direction for the next scene');
  h.state.busy = true;
  await h.document.dispatchEvent({ type: 'chat-busy-changed' });
  assert.equal(h.el('set-session-private-note').disabled, true);
  assert.equal(h.el('btn-save-session').disabled, true);
  h.state.busy = false;
  await h.document.dispatchEvent({ type: 'chat-busy-changed' });
  await h.fire('btn-save-session');
  assert.equal(h.calls.privateNoteWrites[0][2], 'Edited direction for the next scene');
  assert.equal(chat.getStoryPrivateNote().message.planThread, 'Edited direction for the next scene');
  const { buildContextForRequest } = await h.use('context-builder.js');
  const result = await buildContextForRequest({ id: 'story', longTermPlan: 'Old plan' }, h.state.settings, {
    messages: [{ id: 'user', role: 'user', content: 'Continue.', order: 1 }, chat.getStoryPrivateNote().message],
  });
  assert.equal(result.apiMessages.at(-1).content, 'The story continues.');
  assert.doesNotMatch(result.apiMessages.at(-1).content, /Original note/);
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

test('Opening a chat uses the chunked message subscription', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.subscriptions, ['story']);
});

test('message actions keep consistent order and create copies through the selected message', async () => {
  for (const role of ['user', 'assistant']) {
    const h = await harness();
    const chat = await h.use('ui/chat-view.js');
    chat.initChatView();
    chat.setSession('story');
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.calls.sessionCallbacks.at(-1)({ id: 'story', exists: () => true, data: () => ({ title: 'Story' }) });
    h.calls.latestCallbacks.at(-1)({
      messages: [{ id: 'chosen-message', order: 7, role, content: 'Chosen turn' }], hasEarlier: false,
    });
    const message = h.el('message-list').children.find((node) => node.dataset.messageId === 'chosen-message');
    const actions = message.children[0].children[1].children;
    assert.deepEqual(Array.from(actions, (button) => button.textContent), role === 'assistant'
      ? ['Create copy', 'Copy', 'Edit', 'Delete', 'Regenerate']
      : ['Create copy', 'Copy', 'Edit', 'Delete']);
    const click = { type: 'click', stopPropagation() {} };
    h.state.busy = true;
    await actions[0].dispatchEvent(click);
    assert.equal(h.calls.sessionCopies, undefined);
    h.state.busy = false;
    await actions[0].dispatchEvent(click);
    assert.deepEqual(h.calls.sessionCopies, [['story', null, 'chosen-message']]);
    assert.equal(h.state.sessionId, 'copied-session');
  }
});

test('Switching back to a recently opened session reuses its cached messages', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  const open = async (id) => {
    chat.setSession(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionCallback = h.calls.sessionCallbacks.at(-1);
    sessionCallback?.({ id, exists: () => true, data: () => ({ title: id, nextOrder: 1 }) });
    const latestCallback = h.calls.latestCallbacks.at(-1);
    latestCallback?.({ messages: [{ id: `${id}-m`, order: 1, role: 'user', content: id }], hasEarlier: false });
  };
  await open('story-a');
  await open('story-b');
  const readsBeforeReturn = h.calls.subscriptions.length;
  chat.setSession('story-a');
  assert.equal(h.calls.subscriptions.length, readsBeforeReturn);
  await open('story-c');
  await open('story-d');
  const readsBeforeEvictedReturn = h.calls.subscriptions.length;
  chat.setSession('story-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.subscriptions.length, readsBeforeEvictedReturn + 1);
});

test('Story cleaner removes explicit thinking, nested blocks, and incomplete streaming tags', async () => {
  const h = await harness();
  const { storyText, stripThinking } = await h.use('story-text.js');
  const story = 'The door opens.';
  for (const tag of ['think', 'thinking']) {
    const block = `<${tag}>private analysis</${tag}>`;
    for (let i = 1; i <= block.length; i++) {
      assert.equal(storyText(story + ' ' + block.slice(0, i)), story);
    }
    assert.equal(storyText(block + story), story);
  }
  assert.equal(storyText('<THINK mode="deep">outer<thinking>inner</thinking>secret</THINK>' + story), story);
  assert.equal(storyText(story + '<think>unfinished reasoning'), story);
  assert.equal(storyText(story + '<thinking mode="deep"'), story);
  assert.equal(storyText('<think>hidden</think>' + story + '<plan_thread>note</plan_thread><plan>new plan</plan>'), story);
  assert.equal(stripThinking('<think><plan>fake</plan></think>' + story + '<plan>real</plan>'), story + '<plan>real</plan>');
});

test('Context contributions match cleaned request text and legacy private-note counts are ignored', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [
    { id: 'u1', order: 1, role: 'user', content: 'Opening' },
    { id: 'a1', order: 2, role: 'assistant', content: '<think>analysis</think>The door opens.',
      thinking: 'stored reasoning', planThread: 'private steering', tokenCount: 99999 },
    { id: 'u2', order: 3, role: 'user', content: 'Older turn' },
    { id: 'sum', order: 4, role: 'summary', content: '<thinking>summary reasoning</thinking>Earlier events.' },
    { id: 'u3', order: 5, role: 'user', content: '<ad>Continue</ad>' },
    { id: 'a3', order: 6, role: 'assistant', content: 'The room is quiet.<plan_thread>private target</plan_thread>',
      tokenCount: 99999, reasoning_details: [{ text: 'internal details' }] },
    { id: 'empty', order: 7, role: 'assistant', content: '<think>no story</think>' },
  ];
  const result = await buildContextForRequest({ id: 's', longTermPlan: 'Meet the queen',
    activeSummaryMessageId: 'sum', breakpointOrder: 3 }, h.state.settings, { messages });
  assert.equal(result.entries[1].content, 'Story so far:\nEarlier events.');
  assert.equal(result.entries.find((entry) => entry.id === 'a1').tokens, 'The door opens.'.length);
  assert.equal(result.entries.find((entry) => entry.id === 'a3').content, 'The room is quiet.');
  assert.equal(result.omitted['Summary checkpoint'], 1);
  assert.equal(result.omitted['Empty story text'], 1);
  assert.equal(result.contributions.reduce((sum, row) => sum + row.tokens, 0), result.usedTokens);
  assert.equal(result.apiMessages.reduce((sum, message) => sum + message.content.length + 8, 8), result.usedTokens);
  assert.deepEqual(Array.from(result.entries, (entry) => entry.content), Array.from(result.apiMessages, (message) => message.content));
  assert.doesNotMatch(JSON.stringify(result), /stored reasoning|private steering|summary reasoning|private target|internal details|no story/);
  assert.match(result.apiMessages[0].content, /Meet the queen/);
  const regen = await buildContextForRequest({ id: 's' }, h.state.settings, { messages, upToOrder: 3 });
  assert.equal(regen.omitted['Regeneration cutoff'], 5);
});

test('Input selection and summary thresholds do not depend on the output limit', async () => {
  const h = await harness();
  const { buildContextForRequest, computeContextUsage } = await h.use('context-builder.js');
  const messages = Array.from({ length: 15 }, (_, i) => ({ id: String(i), order: i + 1,
    role: 'user', content: 'event '.repeat(20) }));
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  const settings = { ...h.state.settings, maxContextTokens: base.usedTokens + 500, maxResponseTokens: 1,
    autoSummaryThresholdPercent: 90 };
  const small = await computeContextUsage({ id: 's' }, settings, messages);
  const large = await computeContextUsage({ id: 's' }, { ...settings, maxResponseTokens: 500000 }, messages);
  assert.equal(small.usedTokens, large.usedTokens);
  assert.equal(small.overThreshold, large.overThreshold);
  assert.equal(small.usedTokens >= small.threshold, small.overThreshold);
  assert.equal(JSON.stringify(small.apiMessages), JSON.stringify(large.apiMessages));
  assert.ok(large.usedTokens <= settings.maxContextTokens);
  const oversized = await computeContextUsage({ id: 's' }, { ...settings, maxContextTokens: 10 }, messages);
  assert.equal(oversized.exceedsInputLimit, true);
  await assert.rejects(buildContextForRequest({ id: 's' }, { ...settings, maxContextTokens: 10 }, {
    messages, requireLatestUser: true,
  }), /exceed the context budget/);
});

test('Streaming and non-streaming fetch bodies contain only story history and snapshots match serialized messages', async () => {
  for (const streaming of [false, true]) {
    const h = await harness();
    const { chatCompletion } = await h.use('llm-client.js');
    if (streaming) h.calls.streamLines = [
      'data: {"choices":[{"delta":{"reasoning":"new reasoning","content":"The story continues."},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ];
    else h.calls.responseData = { choices: [{ finish_reason: 'stop', message: {
      content: 'The story continues.', reasoning: 'new reasoning',
    } }] };
    const messages = [
      { role: 'system', content: 'Narrate the story.' },
      { role: 'user', content: '<think>This is user text</think>' },
      { role: 'assistant', content: '<think>old thought</think>The door opens.<plan_thread>old plan</plan_thread>',
        thinking: 'stored thought', reasoning: 'provider reasoning', reasoning_content: 'extra reasoning',
        reasoning_details: [{ text: 'reasoning details' }], planThread: 'private note' },
    ];
    let snapshot;
    const result = await chatCompletion({ settings: { ...h.state.settings, streaming, modelId: 'test', apiKey: 'secret-key' },
      messages, onRequest: (request) => { snapshot = request; } });
    const request = h.calls.requests[0];
    assert.equal(JSON.stringify(snapshot.messages), JSON.stringify(request.messages));
    assert.equal(request.messages[1].content, messages[1].content);
    assert.deepEqual(request.messages[2], { role: 'assistant', content: 'The door opens.' });
    assert.doesNotMatch(JSON.stringify(request), /old thought|old plan|stored thought|extra reasoning|reasoning details|private note/);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-key/);
    assert.equal(result.thinking, 'new reasoning');
    messages[2].content = 'edited after sending';
    assert.equal(snapshot.messages[2].content, 'The door opens.');
  }
});

test('Summarizer sends cleaned story and previous summary and saves only clean output', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  h.calls.response = '<think>new hidden reasoning</think>The door opened.<plan_thread>new hidden note</plan_thread>';
  const result = await runSummarization({ id: 's', activeSummaryMessageId: 'old', breakpointOrder: 1 }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [
    { id: 'old', order: 2, role: 'summary', content: '<think>old hidden reasoning</think>Earlier story.' },
    { id: 'a', order: 3, role: 'assistant', content: '<thinking>inline reasoning</thinking>The door opens.',
      thinking: 'saved reasoning', planThread: 'saved note' },
  ] });
  assert.match(h.calls.requests[0].messages[1].content, /Earlier story\./);
  assert.match(h.calls.requests[0].messages[1].content, /Assistant: The door opens\./);
  assert.doesNotMatch(JSON.stringify(h.calls.requests), /old hidden reasoning|inline reasoning|saved reasoning|saved note/);
  assert.equal(result.summaryMessage.content, 'The door opened.');
  const savedCount = h.calls.messages.length;
  h.calls.response = '<thinking>reasoning only</thinking>';
  await assert.rejects(runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [
    { id: 'u', order: 1, role: 'user', content: 'Opening' },
    { id: 'a', order: 2, role: 'assistant', content: 'Opening reply' },
    { id: 'u2', order: 3, role: 'user', content: 'Continue.' },
  ] }), /empty summary/);
  assert.equal(h.calls.messages.length, savedCount);
});

test('Context indicator displays input only and opening the inspector reuses loaded history', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  const { buildContextForRequest } = await h.use('context-builder.js');
  h.state.settings.maxContextTokens = 125000;
  h.state.settings.maxResponseTokens = 15000;
  const base = await buildContextForRequest({ id: 'story' }, h.state.settings, { messages: [] });
  const content = 'x'.repeat(45956 - base.usedTokens - 8);
  chat.initChatView(); chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'story', exists: () => true, data: () => ({ title: 'Story' }) });
  h.calls.latestCallbacks.at(-1)({ messages: [{ id: 'u', role: 'user', order: 1, content }], hasEarlier: false });
  await chat.updateIndicator();
  assert.equal(h.el('context-label').textContent, '45,956 input / 125,000 tokens');
  assert.ok(Math.abs(parseFloat(h.el('context-fill').style.width) - 36.7648) < 0.000001);
  const opener = h.el('context-indicator'); opener.focus();
  await h.fire('context-indicator');
  assert.equal(h.el('context-dialog').open, true);
  assert.match(h.el('context-status').textContent, /45,956 input \/ 125,000 tokens/);
  assert.equal(h.calls.historyReads ?? 0, 0);
  const detail = h.el('context-body').children.find((element) => element.tagName === 'DETAILS');
  detail.open = true; await detail.dispatchEvent({ type: 'toggle' });
  assert.equal(detail.querySelector('pre').textContent.includes('narrator'), true);
  await h.fire('context-close');
  assert.equal(h.document.activeElement, opener);
  await h.fire('context-indicator');
  assert.equal(h.calls.historyReads ?? 0, 0);
  chat.setSession('another-story');
  assert.equal(h.el('context-dialog').open, false);
});

test('Inspector latest sent is immutable, excludes credentials, and is cleared on reset', async () => {
  const h = await harness();
  const { computeContextUsage } = await h.use('context-builder.js');
  const inspector = await h.use('ui/context-view.js');
  const context = await computeContextUsage({ id: 's' }, h.state.settings, [
    { id: 'u', role: 'user', order: 1, content: 'Continue.' },
  ]);
  let loads = 0;
  inspector.initContextInspector(async () => { loads++; return context; });
  await h.fire('context-indicator');
  inspector.captureContextRequest(context, { model: 'sent-model', messages: context.apiMessages });
  context.entries.at(-1).content = 'changed afterward';
  context.apiMessages.at(-1).content = 'changed afterward';
  h.el('context-mode').value = 'sent'; await h.fire('context-mode', 'change');
  assert.match(h.el('context-status').textContent, /sent-model.*latest story request sent/);
  const groups = h.el('context-body').children.filter((element) => element.className?.includes('context-turn-group'));
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(Boolean(group.open), false);
  assert.match(group.children[0].textContent, /Conversation turns · 1 messages/);
  const details = group.children[1].children;
  details.at(-1).open = true; await details.at(-1).dispatchEvent({ type: 'toggle' });
  assert.equal(details.at(-1).querySelector('pre').textContent, 'Continue.');
  assert.equal(loads, 1);
  inspector.resetContextInspector();
  await h.fire('context-indicator');
  h.el('context-mode').value = 'sent'; await h.fire('context-mode', 'change');
  assert.match(h.el('context-status').textContent, /No request has been sent/);
});

test('Inspector drops a pending preview when the active story is reset', async () => {
  const h = await harness();
  const { computeContextUsage } = await h.use('context-builder.js');
  const inspector = await h.use('ui/context-view.js');
  const context = await computeContextUsage({ id: 's' }, h.state.settings, []);
  let resolve;
  inspector.initContextInspector(() => new Promise((done) => { resolve = done; }));
  const opening = h.fire('context-indicator');
  inspector.resetContextInspector();
  resolve(context); await opening;
  assert.equal(h.el('context-dialog').open, false);
  assert.equal(h.el('context-body').children.length, 0);
});

for (const operation of ['Edit', 'Delete']) {
  test(`${operation} completion after switching chats preserves the active story and summary`, async () => {
    const h = await harness();
    const chat = await h.use('ui/chat-view.js');
    const { buildContextForRequest } = await h.use('context-builder.js');
    chat.initChatView();
    const open = async (id, content) => {
      chat.setSession(id);
      await new Promise(resolve => setTimeout(resolve, 0));
      h.calls.sessionCallbacks.at(-1)({ id, exists: () => true, data: () => ({
        title: id, activeSummaryMessageId: 'sum', breakpointOrder: 1,
      }) });
      h.calls.latestCallbacks.at(-1)({ messages: [
        { id: 'shared', order: 1, role: 'assistant', content, planBefore: '' },
        { id: 'sum', order: 2, role: 'summary', content: `${id} summary` },
      ], hasEarlier: false });
    };
    await open('A', 'A original');
    const node = h.el('message-list').children.findLast(item => item.dataset.messageId === 'shared');
    const actions = node.querySelector('.msg-meta').querySelector('.msg-actions');
    const click = button => button.dispatchEvent({ type: 'click', stopPropagation() {} });
    let resolve;
    let writtenId;
    const write = id => { writtenId = id; return new Promise(done => { resolve = done; }); };
    h.calls.editMessage = write; h.calls.deleteMessage = write;
    let pending;
    if (operation === 'Edit') {
      await click(actions.children.find(button => button.textContent === 'Edit'));
      node.querySelector('.msg-editor').value = 'A edited secret';
      pending = click(actions.children.find(button => button.textContent === 'Save'));
    } else {
      pending = click(actions.children.find(button => button.textContent === 'Delete'));
    }
    await open('B', 'B independent story');
    resolve({ tokenCount: 15, summaryReset: true });
    await pending;
    assert.equal(writtenId, 'A');
    assert.equal(chat.getStoryPrivateNote().message.content, 'B independent story');
    // Persist and restore B's snapshot, then inspect the actual assembled context.
    chat.setSession('A'); chat.setSession('B');
    await chat.updateIndicator();
    await h.fire('context-indicator');
    const text = JSON.stringify(h.el('context-body').children, (key, value) =>
      ['parentNode', 'listeners'].includes(key) ? undefined : value);
    assert.doesNotMatch(text, /A edited secret/);
    // Summary remains visible in the context indicator's cached preview.
    const expected = await buildContextForRequest({ id: 'B', activeSummaryMessageId: 'sum', breakpointOrder: 1 },
      h.state.settings, { messages: [
        { id: 'shared', order: 1, role: 'assistant', content: 'B independent story' },
        { id: 'sum', order: 2, role: 'summary', content: 'B summary' },
      ] });
    assert.match(h.el('context-label').textContent, new RegExp(`^${expected.usedTokens.toLocaleString()} input`));
  });
}

for (const full of [false, true]) {
  test(`Summarization excludes the permanent opening exchange (full=${full})`, async () => {
    const h = await harness();
    const { runSummarization } = await h.use('summarizer.js');
    const messages = [
      { id: 'u1', order: 1, role: 'user', content: 'UNCOMPRESSED OPENING USER' },
      { id: 'a1', order: 2, role: 'assistant', content: 'UNCOMPRESSED OPENING REPLY' },
      { id: 'u2', order: 3, role: 'user', content: 'Fold this event' },
      { id: 'a2', order: 4, role: 'assistant', content: 'Fold this outcome' },
      { id: 'u3', order: 5, role: 'user', content: 'Keep recent user' },
      { id: 'a3', order: 6, role: 'assistant', content: 'Keep recent reply' },
    ];
    h.calls.historyMessages = messages;
    const result = await runSummarization({ id: 's' }, {
      ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 2,
    }, { full });
    assert.equal(result.foldedCount, 2);
    assert.equal(result.newBreakpointOrder, 4);
    const request = JSON.stringify(h.calls.requests);
    assert.doesNotMatch(request, /UNCOMPRESSED|Keep recent/);
    assert.match(request, /Fold this event/);
    assert.match(request, /Fold this outcome/);
    const openingOnly = await runSummarization({ id: 's' }, {
      ...h.state.settings, keepRecentMessagesAfterSummary: 0,
    }, { full, messages: messages.slice(0, 2) });
    assert.equal(openingOnly.skipped, true);
    assert.equal(h.calls.requests.length, 1);
  });
}

test('Regeneration blocks chat switches while loading history', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('A');
  await new Promise(resolve => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'A', exists: () => true, data: () => ({ title: 'A' }) });
  h.calls.latestCallbacks.at(-1)({ messages: [
    { id: 'a', order: 2, role: 'assistant', content: 'Latest reply', planBefore: '' },
  ], hasEarlier: true });
  let resolve;
  h.calls.historyPending = new Promise(done => { resolve = done; });
  const node = h.el('message-list').children.find(item => item.dataset.messageId === 'a');
  const button = node.querySelector('.msg-actions').children.find(item => item.textContent === 'Regenerate');
  await button.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(h.state.busy, true);
  assert.equal(chat.setSession('B'), false);
  assert.equal(h.state.sessionId, 'A');
  // A newer reply makes this regeneration invalid after history loads.
  resolve([{ id: 'newer', order: 3, role: 'assistant', content: 'Newer reply' }]);
  await new Promise(done => setTimeout(done, 0));
  assert.equal(h.state.busy, false);
  assert.equal(h.calls.requests.length, 0);
});

test('Rolling summary excludes opening anchors after an existing checkpoint', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  h.calls.historyMessages = [
    { id: 'u1', order: 1, role: 'user', content: 'OPENING USER' },
    { id: 'a1', order: 2, role: 'assistant', content: 'OPENING REPLY' },
    { id: 'u2', order: 3, role: 'user', content: 'Already folded' },
    { id: 'sum', order: 4, role: 'summary', content: 'Prior events' },
    { id: 'u3', order: 5, role: 'user', content: 'New user event' },
    { id: 'a3', order: 6, role: 'assistant', content: 'New assistant event' },
  ];
  const result = await runSummarization({ id: 's', activeSummaryMessageId: 'sum', breakpointOrder: 3 }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  });
  assert.equal(result.foldedCount, 2);
  assert.equal(result.newBreakpointOrder, 6);
  const request = JSON.stringify(h.calls.requests);
  assert.match(request, /Prior events/);
  assert.match(request, /New user event/);
  assert.match(request, /New assistant event/);
  assert.doesNotMatch(request, /OPENING|Already folded/);
});
