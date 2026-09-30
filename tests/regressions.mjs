// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const elements = new Map();
  class Element {
    value = ''; checked = false; hidden = true; style = { setProperty() {}, removeProperty() {} }; children = []; dataset = {};
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
    querySelector() { return null; }
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
      const mins = { 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-chunk': 2000, 'set-recall-budget': 1 };
      if (id in mins) element.dataset.min = String(mins[id]);
      if (id === 'set-auto-threshold') element.dataset.max = '100';
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document.createElement = () => new Element();
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
  const calls = { reads: 0, writes: [], messages: [], requests: [], queries: [], subscriptions: [], sessionCallbacks: [], settingsCallbacks: [], latestCallbacks: [], sessionWrites: [], imports: [], exports: [], continuityTurns: [], continuityMessages: [], continuityListError: false, settingsDoc: null, fail: false, confirm: true, response: 'summary', migrationSource: null, migrationTranscript: [], migrationPreviews: [], migrationPublishes: [], saverTurns: [], saverRequireReview: false };
  const localCache = new Map();
  const context = vm.createContext({
    console, structuredClone, document,
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem: (key) => localCache.get(key) ?? null, setItem: (key, value) => localCache.set(key, value) },
    window: { addEventListener() {}, setTimeout() {}, clearTimeout() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }, crypto, URL,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    setTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, confirm: () => calls.confirm,
    fetch: async (_url, options) => {
      calls.requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: calls.response } }] }) };
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
    'db.js': { db: {} },
    'auth.js': { currentUid: () => 'test-user' },
    'tokenizer.js': { countTokens: async (text) => text.length },
    'sessions.js': { getSession: async () => calls.migrationSource ?? ({ title: 'Story', longTermPlan: 'Old plan' }), updateSession: async (...args) => { calls.sessionWrites.push(args); } },
    'import-export.js': { importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); } },
    'messages.js': {
      getMessages: async () => [], getMessagesReadOnly: async () => calls.migrationTranscript,
      getCheckpointMessages: async () => [], newMessageId: () => 'summary-id',
      addMessage: async (...args) => { calls.messages.push(args); return { id: 'summary-id' }; },
      subscribeLatestMessages: (sessionId, callback) => { calls.subscriptions.push(sessionId); calls.latestCallbacks.push(callback); return () => {}; },
    },
    'continuity/runtime.js': {
      storyStore: () => ({ listMessages: async () => {
        calls.continuityLists = (calls.continuityLists ?? 0) + 1;
        if (calls.continuityListError) { calls.continuityListError = false; throw new Error('read interrupted'); }
        return calls.continuityMessages;
      } }),
      watchContinuityHead: (_sessionId, _branchId, callback) => { queueMicrotask(callback); return () => {}; },
      switchContinuityBranch: async () => {}, enableContinuity: async () => {},
    },
    'continuity/turn-controller.js': {
      runContinuityTurn: async (request) => {
        calls.continuityTurns.push(request);
        request.onStatus('accepted');
        return { status: 'accepted' };
      },
    },
    'continuity/saver.js': {
      runBalancedTurn: async (request) => {
        calls.continuityTurns.push({ ...request, balanced: true });
        request.onStatus('accepted');
        return { status: 'accepted' };
      },
      runSaverTurn: async (request) => {
        calls.saverTurns.push(request);
        const status = calls.saverRequireReview ? 'needs_state_review' : 'accepted';
        request.onStatus(status);
        return { status, turnId: request.turnId,
          user: { id: `${request.turnId}_user`, role: 'user', content: request.input, order: 1 },
          assistant: { id: `${request.turnId}_assistant`, role: 'assistant', content: 'A waits.', order: 2 } };
      },
    },
    'continuity/migration.js': {
      prepareContinuityMigration: async (request) => {
        calls.migrationPreviews.push(request);
        request.onProgress?.({ receivedCharacters: 400, reasoningCharacters: 0, finishReason: 'stop',
          maxOutputTokens: 8192, usage: { completion_tokens: 150, completion_tokens_details: { reasoning_tokens: 50 } } });
        return { sourceMessageCount: request.legacyMessages.length, skippedSummaryCount: 0,
          state: { throughOrder: 4, records: [{ id: 'char_A' }], events: [{ id: 'death' }] }, messages: [] };
      },
    },
    'continuity/migration-runtime.js': {
      publishContinuityMigration: async (request) => { calls.migrationPublishes.push(request); return 'copy-id'; },
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
        initializeImportMeta(meta) { meta.url = new URL('../js/' + path, import.meta.url).href; },
        importModuleDynamically: async (specifier, parent) => {
          const resolved = specifier.startsWith('https:') ? specifier
            : new URL(specifier, 'https://local/' + parent.identifier).pathname.slice(1);
          const imported = await load(resolved);
          if (imported.status !== 'evaluated') await imported.evaluate();
          return imported;
        },
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
  await h.fire('btn-profile-copy');
  const copyId = h.el('set-profiles').value;
  h.el('set-model').value = 'model-b';
  h.el('set-profiles').value = 'default';
  await h.fire('set-profiles', 'change');
  assert.equal(h.el('set-model').value, 'model-a');
  assert.equal(h.calls.writes.length, 0);
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.keepRecentMessagesAfterSummary, 0);
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
  await h.fire('btn-save-session');
  assert.deepEqual(structuredClone(h.calls.sessionWrites[0]), ['story-id', { title: 'New title', longTermPlan: 'New plan' }]);
  await h.fire('nav-transfer');
  await h.fire('btn-export-st');
  assert.deepEqual(h.calls.exports, ['story-id']);
  h.el('file-import-st').files = [{ name: 'story.jsonl' }];
  await h.fire('file-import-st', 'change');
  assert.equal(h.calls.imports.length, 1);
});

test('existing story migration previews read-only history before publishing a selected copy', async () => {
  const h = await harness();
  h.state.sessionId = 'old-story';
  h.state.settings.modelId = 'test-model';
  h.state.settings.apiKey = 'test-key';
  h.calls.migrationSource = { title: 'Old story', nextOrder: 2, continuityEnabled: false };
  h.calls.migrationTranscript = [{ id: 'm1', order: 1, role: 'user', content: 'I arrive.' }];
  const selected = [];
  h.document.addEventListener('session-imported', (event) => selected.push(event.detail));
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  await h.fire('nav-story');
  await Promise.resolve();
  assert.equal(h.el('btn-open-migration').hidden, false);
  await h.fire('btn-open-migration');
  h.el('migration-note').value = 'A distrusts the player because the player killed her mother.';
  await h.fire('btn-preview-migration');
  assert.equal(h.calls.migrationPreviews.length, 1);
  assert.equal(h.el('migration-token-progress').hidden, false);
  assert.match(h.el('migration-token-progress').textContent, /150 output tokens reported/);
  assert.match(h.el('migration-token-progress').textContent, /50 reasoning tokens reported/);
  assert.equal(h.calls.migrationPreviews[0].legacyMessages[0].content, 'I arrive.');
  assert.match(h.el('migration-preview').textContent, /"events"/);
  assert.equal(h.calls.migrationPublishes.length, 0);
  h.el('migration-note').value += ' More detail.';
  await h.fire('btn-publish-migration');
  assert.equal(h.calls.migrationPublishes.length, 0);
  h.el('migration-note').value = 'A distrusts the player because the player killed her mother.';
  h.el('migration-mode').value = 'saver';
  await h.fire('btn-publish-migration');
  assert.equal(h.calls.migrationPublishes.length, 1);
  assert.equal(h.calls.migrationPublishes[0].continuityMode, 'saver');
  assert.deepEqual(selected, ['copy-id']);
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

test('Current narrator default loads and custom prompts stay unchanged', async () => {
  const h = await harness();
  const next = h.settings.DEFAULT_SETTINGS.narratorSystemPrompt;
  h.calls.settingsDoc = {};
  assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, next);
  h.localCache.clear();
  h.calls.settingsDoc = { narratorSystemPrompt: 'Custom narrator' };
  assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, 'Custom narrator');
});

test('Continuity prose defaults load while saved custom or blank preferences are preserved', async () => {
  const h = await harness();
  const next = h.settings.DEFAULT_SETTINGS.continuityStylePrompt;
  assert.ok(next.length > 0);
  h.calls.settingsDoc = {};
  assert.equal((await h.settings.loadSettings()).continuityStylePrompt, next);
  for (const saved of ['Custom continuity prose', '']) {
    h.localCache.clear();
    h.calls.settingsDoc = { continuityStylePrompt: saved };
    assert.equal((await h.settings.loadSettings()).continuityStylePrompt, saved);
  }
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

test('Optional recall and short memory default off and honor context and regeneration limits', async () => {
  const h = await harness();
  assert.equal(h.settings.DEFAULT_SETTINGS.chatRecallEnabled, false);
  assert.equal(h.settings.DEFAULT_SETTINGS.shortMemoryEnabled, false);
  assert.equal(h.settings.DEFAULT_SETTINGS.semanticSearchEnabled, false);
  assert.equal(h.settings.DEFAULT_SETTINGS.chatRecallBudgetTokens, 4000);
  const { buildContextForRequest } = await h.use('context-builder.js');
  const session = { id: 's', shortMemory: 'Current scene', shortMemoryThroughOrder: 5 };
  const messages = [{ id: 'recent', order: 10, role: 'user', content: 'New turn', tokenCount: 8 }];
  const recalledMessages = [
    { id: 'older', order: 2, role: 'assistant', content: 'Old detail' },
    { id: 'recent', order: 10, role: 'user', content: 'New turn' },
  ];
  const settings = { ...h.state.settings, narratorSystemPrompt: '', maxContextTokens: 600,
    maxResponseTokens: 100, chatRecallBudgetTokens: 100 };
  const off = await buildContextForRequest(session, settings, { messages, recalledMessages });
  assert.equal(off.apiMessages.some((m) => /short memory|Earlier assistant/.test(m.content)), false);
  const on = await buildContextForRequest(session, {
    ...settings, shortMemoryEnabled: true, chatRecallEnabled: true,
  }, { messages, recalledMessages });
  assert.equal(on.apiMessages.filter((m) => m.content.includes('Earlier assistant')).length, 1);
  assert.equal(on.apiMessages.some((m) => m.content.includes('Current short memory')), true);
  assert.ok(on.usedTokens <= settings.maxContextTokens - settings.maxResponseTokens);
  const regen = await buildContextForRequest(session, {
    ...settings, shortMemoryEnabled: true, chatRecallEnabled: true,
  }, { messages, recalledMessages, upToOrder: 5 });
  assert.equal(regen.apiMessages.some((m) => m.content.includes('Current short memory')), false);
});

test('Recall reserves room while keeping the latest user message in context', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const settings = { ...h.state.settings, narratorSystemPrompt: '', chatRecallEnabled: true,
    chatRecallBudgetTokens: 160, maxContextTokens: 600, maxResponseTokens: 100 };
  const messages = [
    { id: 'old', order: 1, role: 'assistant', content: 'old', tokenCount: 250 },
    { id: 'latest', order: 2, role: 'user', content: 'remember the gate', tokenCount: 100 },
  ];
  const base = await buildContextForRequest({ id: 's' }, settings, {
    messages, recallReserveTokens: settings.chatRecallBudgetTokens,
  });
  assert.equal(base.includedMessageIds.has('latest'), true);
  const final = await buildContextForRequest({ id: 's' }, settings, {
    messages, recallBudgetTokens: base.availableRecallTokens,
    recalledMessages: [{ id: 'earlier', order: 0, role: 'assistant', content: 'The gate has a hidden key.' }],
  });
  assert.equal(final.apiMessages.at(-1).content, 'remember the gate');
  assert.equal(final.apiMessages.some((m) => m.content.includes('hidden key')), true);
  assert.ok(final.usedTokens <= settings.maxContextTokens - settings.maxResponseTokens);
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

test('Plan thread stays out of visible text but remains in the next model context', async () => {
  const h = await harness();
  const { extractPlanThread, stripPlan } = await h.use('plan-parser.js');
  const reply = 'The door opens. <plan_thread>steering toward the reunion</plan_thread>';
  assert.equal(extractPlanThread(reply), 'steering toward the reunion');
  assert.equal(stripPlan(reply), 'The door opens.');
  const { buildContextForRequest } = await h.use('context-builder.js');
  const result = await buildContextForRequest({ id: 'story' }, h.state.settings, {
    messages: [{ id: 'm', order: 1, role: 'assistant', content: 'The door opens.', planThread: 'steering toward the reunion', tokenCount: 12 }],
  });
  assert.match(result.apiMessages.at(-1).content, /<plan_thread>steering toward the reunion<\/plan_thread>/);
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
});

test('Empty chat enables writing only after a story is selected', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  assert.equal(h.el('welcome').hidden, false);
  assert.equal(h.el('btn-welcome-new').hidden, false);
  assert.equal(h.el('chat-input').disabled, true,
    JSON.stringify(h.el('message-list').children.map((item) => item.textContent)));
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
  h.calls.sessionCallbacks.at(-1)?.({ exists: () => true, data: () => ({ title: 'story' }) });
  assert.deepEqual(h.calls.subscriptions, ['story']);
});

test('A continuity story sends an author note through the reviewed turn path', async () => {
  const h = await harness();
  h.state.settings.apiKey = 'test-key';
  h.state.settings.modelId = 'test-model';
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)?.({ id: 'story', exists: () => true, data: () => ({
    title: 'story', continuityEnabled: true, continuityBranchId: 'main',
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.el('composer-mode').value = 'author';
  h.el('chat-input').value = 'A knows the player killed her mother.';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.continuityTurns.length, 1,
    JSON.stringify(h.el('message-list').children.map((item) => item.textContent)));
  assert.equal(h.calls.continuityTurns[0].mode, 'author');
  assert.equal(h.calls.continuityTurns[0].input, 'A knows the player killed her mother.');
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.calls.subscriptions.length, 0);
});

test('A continuity send reuses its turn ID after an accepted save but failed refresh', async () => {
  const h = await harness();
  h.state.settings.apiKey = 'test-key';
  h.state.settings.modelId = 'test-model';
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)?.({ id: 'story', exists: () => true, data: () => ({
    title: 'story', continuityEnabled: true, continuityBranchId: 'main',
  }) });
  for (let attempt = 0; !h.calls.continuityLists && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(h.calls.continuityLists, 'Initial continuity history loaded before injecting the send refresh failure');
  h.el('composer-mode').value = 'player';
  h.el('chat-input').value = 'I greet A.';
  h.calls.continuityListError = true;
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.el('chat-input').value, 'I greet A.', JSON.stringify({ turns: h.calls.continuityTurns.length,
    readError: h.calls.continuityListError, messages: h.el('message-list').children.map((item) => item.textContent) }));
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.continuityTurns.length, 2);
  assert.equal(h.calls.continuityTurns[0].turnId, h.calls.continuityTurns[1].turnId);
});

test('Saver routes through one turn handler and pending review keeps the composer blocked', async () => {
  const h = await harness();
  h.state.settings.apiKey = 'test-key';
  h.state.settings.modelId = 'test-model';
  h.calls.saverRequireReview = true;
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)?.({ id: 'story', exists: () => true, data: () => ({
    title: 'story', continuityEnabled: true, continuityBranchId: 'main',
    continuityMode: 'saver', continuitySaverReviewEveryTurn: true,
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.el('composer-mode').value = 'player';
  h.el('chat-input').value = 'I wait.';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.saverTurns.length, 1);
  assert.equal(h.calls.saverTurns[0].reviewEveryTurn, true);
  assert.equal(h.calls.continuityTurns.length, 0);
  assert.equal(h.el('chat-input').disabled, true,
    JSON.stringify(h.el('message-list').children.map((item) => item.textContent)));
  assert.equal(h.el('btn-send').disabled, true);
  h.el('chat-input').value = 'Continue.';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.saverTurns.length, 1);
});

test('Saver mode and review preference are saved per story from Settings', async () => {
  const h = await harness();
  h.state.sessionId = 'story';
  h.calls.migrationSource = { title: 'story', continuityEnabled: true, continuityMode: 'reviewed' };
  const view = await h.use('ui/settings-view.js');
  view.initSettingsView(); view.openSettingsPopup();
  await h.fire('nav-story'); await Promise.resolve();
  assert.equal(h.el('continuity-mode-controls').hidden, false);
  assert.equal(h.el('set-saver-review-every-turn').checked, false);
  h.el('set-continuity-mode').value = 'saver';
  await h.fire('set-continuity-mode', 'change');
  h.el('set-saver-review-every-turn').checked = true;
  await h.fire('set-saver-review-every-turn', 'change');
  assert.deepEqual(structuredClone(h.calls.sessionWrites), [
    ['story', { continuityMode: 'saver' }], ['story', { continuitySaverReviewEveryTurn: true }],
  ]);
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
  h.calls.sessionCallbacks.at(-1)?.({ exists: () => true, data: () => ({ title: 'story-b' }) });
  assert.equal(h.calls.subscriptions.length, readsBeforeEvictedReturn + 1);
});


test('Balanced setting persists and chat routes it to the two-stage runner', async () => {
  const h = await harness();
  h.calls.migrationSource = { title: 'story', continuityEnabled: true, continuityMode: 'reviewed' };
  h.state.sessionId = 'story';
  const settingsView = await h.use('ui/settings-view.js');
  settingsView.initSettingsView(); settingsView.openSettingsPopup();
  await h.fire('nav-story'); await Promise.resolve();
  h.el('set-continuity-mode').value = 'balanced';
  await h.fire('set-continuity-mode', 'change');
  assert.deepEqual(structuredClone(h.calls.sessionWrites.at(-1)), ['story', { continuityMode: 'balanced' }]);
  h.state.sessionId = null;
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.state.settings.apiKey = 'test-key';
  h.state.settings.modelId = 'test-model';
  h.calls.sessionCallbacks.at(-1)({ id: 'story', exists: () => true, data: () => ({
    title: 'story', continuityEnabled: true, continuityMode: 'balanced', continuityBranchId: 'main',
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.el('composer-mode').value = 'player';
  h.el('chat-input').value = 'I wait.';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.continuityTurns.at(-1)?.balanced, true);
  assert.equal(h.calls.saverTurns.length, 0);
});
