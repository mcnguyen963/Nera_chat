// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const elements = new Map();
  class Element {
    scrollTop = 0; scrollHeight = 500; clientHeight = 500;
    value = ''; checked = false; hidden = true; style = {}; children = []; dataset = {};
    classList = { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, toggle(name, force) { if (force ?? !this.values.has(name)) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } };
    listeners = {};
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(listener => listener !== fn); }
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
      const mins = { 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-rewrite-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-chunk': 2000 };
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
    console, structuredClone, document, TextDecoder, AbortController,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    localStorage: { getItem: (key) => localCache.get(key) ?? null, setItem: (key, value) => localCache.set(key, value), removeItem: key => localCache.delete(key) },
    window: { addEventListener() {} }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    setTimeout(fn, delay) { const timer = { fn, delay }; (calls.timers ??= []).push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; }, confirm: (text) => { (calls.confirmations ??= []).push(text); return calls.confirm; },
    fetch: async (_url, options) => {
      if (_url === './rewrite_default_prompt.md') {
        calls.promptReads = (calls.promptReads ?? 0) + 1;
        return { ok: !calls.promptError, text: async () => calls.defaultRewritePrompt ?? 'Default rewrite prompt' };
      }
      calls.requests.push(JSON.parse(options.body));
      if (calls.streamReader) return { ok: true, body: { getReader: () => calls.streamReader } };
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
    getDocFromServer: async () => {
      calls.reads++;
      if (calls.serverError) throw new Error(calls.serverError);
      return calls.serverSnapshot ?? { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc };
    },
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
    'chat-cache.js': {
      loadChatCache: async () => null, saveChatCache: async (...args) => { (calls.cacheSaves ??= []).push(args); }, deleteChatCache: async () => {},
      clearChatCache: async uid => { (calls.cacheClears ??= []).push(uid); if (calls.cacheClearError) throw new Error('cache denied'); },
    },
    'auth.js': { currentUid: () => 'test-user', currentUserInfo: () => ({ email: 'test@example.com' }), logout() { calls.logouts = (calls.logouts ?? 0) + 1; } },
    'tokenizer.js': { countTokens: async (text) => calls.tokenCount ? calls.tokenCount(text) : text.length,
      tokenizerReady: () => calls.tokenizerReady !== false },
    'sessions.js': {
      subscribeSessions: callback => { calls.sidebarCallback = callback; },
      createSession() {}, renameSession() {}, deleteSession() {},
      getSession: async () => ({ title: 'Story', longTermPlan: 'Old plan' }),
      updateSession: async (...args) => { calls.sessionWrites.push(args); },
      duplicateSession: async (...args) => { calls.sessionCopies ??= []; calls.sessionCopies.push(args); return 'copied-session'; },
    },
    'import-export.js': { importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); },
      exportFullBackup: async (id) => { (calls.fullExports ??= []).push(id); } },
    'messages.js': {
      getMessages: async () => { calls.historyReads = (calls.historyReads ?? 0) + 1; return calls.historyPending ?? calls.historyMessages ?? []; },
      getCheckpointMessages: async () => [], newMessageId: () => 'summary-id',
      getMessagesAfterOrder: async (...args) => {
        (calls.catchUps ??= []).push(args);
        return calls.catchUp ? calls.catchUp(...args) : calls.freshMessages ?? [];
      },
      addMessage: async (...args) => { calls.messages.push(args); return calls.addMessage ? calls.addMessage(...args) : { id: 'summary-id' }; },
      subscribeLatestMessages: (sessionId, callback) => { calls.subscriptions.push(sessionId); calls.latestCallbacks.push(callback); return () => {}; },
      editPlanThread: async (...args) => {
        calls.privateNoteWrites ??= [];
        calls.privateNoteWrites.push(args);
        const message = { ...calls.noteMessage, planThread: args[2] || null, tokenCount: 100, editedAt: true };
        return { message, summaryReset: false };
      },
      editMessage: async (...args) => calls.editMessage(...args),
      overwriteMessage: async (...args) => { (calls.overwrites ??= []).push(args);
        return calls.overwriteMessage ? calls.overwriteMessage(...args) : { tokenCount: args[2].content.length }; },
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
  return { use, state, settings, calls, localCache, document, setNavigator: nav => { context.navigator = nav; }, el: document.getElementById,
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
  assert.equal((await h.settings.loadSettings()).modelId, 'model-b');
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
  assert.equal(result.apiMessages[1].content, 'turn 0');
  assert.equal(result.apiMessages[2].content, 'Story so far:\nEarlier story');
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
    { id: 'u2', order: 3, role: 'user', content: 'Middle'.repeat(20), tokenCount: 80 },
    { id: 'a2', order: 4, role: 'assistant', content: 'Small recent', tokenCount: 40 },
    { id: 'u3', order: 5, role: 'user', content: 'Latest', tokenCount: 30 },
  ];
  const result = await buildContextForRequest({ id: 's' }, settings, { messages, requireLatestUser: true });
  assert.deepEqual(Array.from(result.apiMessages.filter(m => m.role !== 'system'), (m) => m.content), ['Opening', 'Background', 'Small recent', 'Latest']);
  assert.equal(result.droppedCount, 1);
  assert.ok(result.usedTokens <= settings.maxContextTokens);
  await assert.rejects(buildContextForRequest({ id: 's' }, settings, {
    messages: messages.map((m) => m.id === 'u3' ? { ...m, content: 'Latest'.repeat(100), tokenCount: 500 } : m), requireLatestUser: true,
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
    ['The kingdom begins here', 'The first scene', 'Story so far:\nStory summary', '[Earlier turns are represented by the summary.]', 'Current turn']);
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
  const partial = await chatCompletion({ settings, messages: [] });
  assert.equal(partial.content, 'cut');
  assert.equal(partial.finishReason, 'length');
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
  }, [{ id: 'm', order: 1, role: 'user', content: 'large message'.repeat(30), tokenCount: 300 }]);
  assert.equal(result, true);
  assert.equal(await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings, autoSummarizationEnabled: false,
  }, [{ id: 'm', order: 1, role: 'user', content: 'large message'.repeat(30), tokenCount: 300 }]), false);
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
      : ['Create copy', 'Copy', 'Edit', 'Delete', 'Retry reply']);
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
  assert.equal(result.entries[3].content, 'Story so far:\nEarlier events.');
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

test('Sync replaces cached history and metadata with server data and invalidates other cached chats', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  const open = async id => {
    chat.setSession(id);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.calls.sessionCallbacks.at(-1)({ id, exists: () => true, data: () => ({ title: id, longTermPlan: 'Old plan' }) });
    h.calls.latestCallbacks.at(-1)({ messages: [
      { id: 'old', order: 1, role: 'assistant', content: 'Stale story' },
    ], hasEarlier: false });
  };
  await open('B'); await open('A');
  const staleSession = h.calls.sessionCallbacks.at(-1);
  const staleMessages = h.calls.latestCallbacks.at(-1);
  h.calls.serverSnapshot = { id: 'A', exists: () => true, data: () => ({
    title: 'Updated elsewhere', longTermPlan: 'Server plan', activeSummaryMessageId: 'sum', breakpointOrder: 2,
  }) };
  h.calls.historyMessages = [
    { id: 'u', order: 1, role: 'user', content: 'Original opening' },
    { id: 'a', order: 2, role: 'assistant', content: 'Server story' },
    { id: 'sum', order: 3, role: 'summary', content: 'Server summary' },
    { id: 'latest', order: 4, role: 'assistant', content: 'Latest from other device' },
  ];
  let metadata;
  h.document.addEventListener('session-changed', event => { metadata = event.detail.session; });
  await h.document.dispatchEvent({ type: 'sync-chat' });
  assert.equal(h.calls.historyReads, 1);
  assert.equal(chat.getStoryPrivateNote().message.content, 'Latest from other device');
  assert.equal(metadata.longTermPlan, 'Server plan');
  assert.equal(metadata.activeSummaryMessageId, 'sum');
  assert.equal(h.state.busy, false);
  staleSession({ id: 'A', exists: () => true, data: () => ({ longTermPlan: 'Old plan' }) });
  staleMessages({ messages: [{ id: 'old', order: 1, role: 'assistant', content: 'Stale callback' }], hasEarlier: false });
  h.calls.latestCallbacks.at(-1)({ messages: [{ id: 'latest', order: 4, role: 'assistant', content: 'Firebase cache' }], hasEarlier: false, fromCache: true });
  assert.equal(chat.getStoryPrivateNote().message.content, 'Latest from other device');
  h.calls.latestCallbacks.at(-1)({ messages: [
    { id: 'latest', order: 4, role: 'assistant', content: 'Fresh live update' },
  ], hasEarlier: false, fromCache: false });
  assert.equal(chat.getStoryPrivateNote().message.content, 'Fresh live update');
  const count = h.calls.subscriptions.length;
  chat.setSession('B');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.subscriptions.length, count + 1);
  assert.equal(h.calls.requests.length, 0);
});

test('Failed sync preserves displayed history and releases busy state', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('A');
  await new Promise(resolve => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'A', exists: () => true, data: () => ({ title: 'A' }) });
  h.calls.latestCallbacks.at(-1)({ messages: [
    { id: 'a', order: 1, role: 'assistant', content: 'Keep displayed story' },
  ], hasEarlier: false });
  h.calls.serverError = 'offline';
  await chat.syncChatData();
  assert.equal(chat.getStoryPrivateNote().message.content, 'Keep displayed story');
  assert.equal(h.state.busy, false);
  assert.equal(h.calls.subscriptions.length, 2);
});

test('Rewrite request preserves the draft, selects N individual story messages, and rejects excess input', async () => {
  const h = await harness();
  const { buildRewriteMessages } = await h.use('rewrite.js');
  const history = [
    { order: 3, role: 'assistant', content: '<think>secret</think>Visible<plan>hidden</plan>', planThread: 'private' },
    { order: 1, role: 'user', content: 'Older' },
    { order: 4, role: 'summary', content: 'Excluded summary' },
    { order: 2, role: 'user', content: '<ad>Direction</ad>' },
  ];
  const settings = { ...h.state.settings, rewriteRecentMessages: 2, rewriteSystemPrompt: 'Expand my idea' };
  const messages = await buildRewriteMessages(settings, history, '  I tell him  ');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { role: 'system', content: 'Expand my idea' },
    { role: 'user', content: '<ad>Direction</ad>' },
    { role: 'assistant', content: 'Visible' },
    { role: 'user', content: '  I tell him  ' },
  ]);
  assert.equal((await buildRewriteMessages({ ...settings, rewriteRecentMessages: 0 }, history, 'Idea')).length, 2);
  assert.equal((await buildRewriteMessages({ ...settings, rewriteRecentMessages: 1000 }, history, 'Idea')).length, 5);
  await assert.rejects(buildRewriteMessages({ ...settings, maxContextTokens: 1 }, history, 'Idea'), /Reduce recent messages/);
  await assert.rejects(buildRewriteMessages({ ...settings, rewriteRecentMessages: -1 }, history, 'Idea'), /nonnegative/);
  await assert.rejects(buildRewriteMessages({ ...settings, rewriteSystemPrompt: ' ' }, history, 'Idea'), /system prompt/);
});

test('Markdown rewrite prompt is cached, retryable, and bypassed by custom prompts', async () => {
  const h = await harness();
  const rewrite = await h.use('rewrite.js');
  h.calls.promptError = true;
  await assert.rejects(rewrite.loadRewriteDefaultPrompt(), /Try again/);
  h.calls.promptError = false;
  assert.equal(await rewrite.loadRewriteDefaultPrompt(), 'Default rewrite prompt');
  assert.equal(await rewrite.loadRewriteDefaultPrompt(), 'Default rewrite prompt');
  assert.equal(h.calls.promptReads, 2);
  const messages = await rewrite.buildRewriteMessages(h.state.settings, [], 'Idea');
  assert.equal(messages[0].content, 'Default rewrite prompt');
  await rewrite.buildRewriteMessages({ ...h.state.settings, rewriteSystemPrompt: 'Custom' }, [], 'Idea');
  assert.equal(h.calls.promptReads, 2);
});

async function rewriteChatHarness() {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('story');
  await new Promise(resolve => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'story', exists: () => true, data: () => ({ title: 'Story' }) });
  h.calls.latestCallbacks.at(-1)({ messages: [], hasEarlier: false });
  Object.assign(h.state.settings, { modelId: 'rewrite-model', apiKey: 'key', streaming: false, rewriteSystemPrompt: 'Expand', rewriteRecentMessages: 0 });
  h.el('chat-input').value = 'I tell him about the story';
  await h.fire('chat-input', 'input');
  return { ...h, chat };
}

test('Rewrite streams clean content to composer, forces streaming, and restores the original without writes', async () => {
  const h = await rewriteChatHarness();
  h.calls.streamLines = [
    'data: {"choices":[{"delta":{"reasoning":"private thoughts"}}]}\n',
    'data: {"choices":[{"delta":{"content":"<think>hidden</think>I lean closer."}}]}\n',
    'data: {"choices":[{"delta":{"content":"<plan>hidden</plan>"},"finish_reason":"stop"}]}\n',
  ];
  await h.fire('btn-rewrite');
  assert.equal(h.el('chat-input').value, 'I lean closer.');
  assert.equal(h.el('chat-input').readOnly, false);
  assert.equal(h.el('btn-restore-draft').hidden, false);
  assert.equal(h.calls.requests[0].stream, true);
  assert.equal(h.calls.requests[0].model, 'rewrite-model');
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.calls.sessionWrites.length, 0);
  await h.fire('btn-restore-draft');
  assert.equal(h.el('chat-input').value, 'I tell him about the story');
  assert.equal(h.el('btn-restore-draft').hidden, true);
  await h.fire('btn-rewrite');
  await h.fire('chat-input', 'input');
  assert.equal(h.el('btn-restore-draft').hidden, true);
});

test('Rewrite restores original on partial failure, empty cleaned output, and Stop', async () => {
  for (const lines of [
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n'],
    ['data: {"choices":[{"delta":{"content":"<think>only thoughts</think>"},"finish_reason":"stop"}]}\n'],
    ['data: {"error":{"message":"denied"}}\n'],
  ]) {
    const h = await rewriteChatHarness();
    h.calls.streamLines = lines;
    await h.fire('btn-rewrite');
    assert.equal(h.el('chat-input').value, 'I tell him about the story');
    assert.equal(h.state.busy, false);
    assert.equal(h.el('btn-restore-draft').hidden, true);
  }
  const h = await rewriteChatHarness();
  let finishRead;
  let reads = 0;
  h.calls.streamReader = { read: async () => {
    if (reads++ === 0) return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"I lean closer."}}]}\n') };
    return new Promise(resolve => { finishRead = resolve; });
  } };
  const running = h.fire('btn-rewrite');
  while (!finishRead) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.el('chat-input').value, 'I lean closer.');
  assert.equal(h.el('chat-input').readOnly, true);
  assert.equal(h.el('btn-send').disabled, true);
  assert.equal(h.chat.setSession('other'), false);
  await h.fire('btn-rewrite');
  finishRead({ done: true });
  await running;
  assert.equal(h.el('chat-input').value, 'I tell him about the story');
  assert.equal(h.state.busy, false);
  assert.equal(h.el('btn-rewrite').textContent, 'Rewrite');
});

test('Rewrite settings validate N, preserve custom prompt, and reset to Markdown default', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js'); chat.initChatView();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.el('set-rewrite-prompt').value, 'Default rewrite prompt');
  h.el('set-rewrite-n').value = '2.5';
  await h.fire('btn-save-settings');
  assert.match(h.el('settings-saved-msg').textContent, /whole number/);
  h.el('set-rewrite-n').value = '0';
  h.el('set-rewrite-prompt').value = 'My custom prompt';
  h.el('set-stream-vibration').value = 'speed';
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.rewriteRecentMessages, 0);
  assert.equal(h.state.settings.rewriteSystemPrompt, 'My custom prompt');
  assert.equal(h.state.settings.streamVibrationMode, 'speed');
  await h.fire('btn-reset-rewrite-prompt');
  await new Promise(resolve => setTimeout(resolve, 0));
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.rewriteSystemPrompt, null);
});

test('Stream vibration coalesces spaces, varies with speed, and cancels on hiding or completion', async () => {
  const h = await harness();
  const { createStreamVibration } = await h.use('stream-vibration.js');
  let time = 0, nextId = 0;
  const timers = new Map(), pulses = [];
  const doc = { hidden: false, addEventListener(_event, fn) { this.listener = fn; }, removeEventListener() { this.listener = null; } };
  const options = { document: doc, navigator: { vibrate: duration => pulses.push([time, duration]) }, now: () => time,
    schedule: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    cancel: id => timers.delete(id),
  };
  const advance = to => { time = to; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } };
  const spaces = createStreamVibration('spaces', options);
  spaces.feed('NoSpace'); assert.equal(pulses.length, 0);
  spaces.feed(' '); spaces.feed('lots of spaces ');
  assert.deepEqual(pulses, [[0, 10]]);
  assert.equal(timers.size, 1);
  advance(80); assert.deepEqual(pulses.at(-1), [80, 10]);
  spaces.feed(' thinking ');
  doc.hidden = true; doc.listener();
  assert.equal(timers.size, 0); assert.deepEqual(pulses.at(-1), [80, 0]);
  spaces.feed(' writing '); advance(500);
  doc.hidden = false;
  assert.equal(pulses.length, 3);
  spaces.feed(' resumed '); spaces.feed(' pending '); spaces.stop();
  assert.equal(timers.size, 0); assert.equal(doc.listener, null);
  const before = pulses.length; advance(1000); spaces.feed(' stopped ');
  assert.equal(pulses.length, before);
  const speed = createStreamVibration('speed', options);
  speed.feed('a'); const slow = pulses.at(-1)[1];
  advance(1100); speed.feed('x'.repeat(200));
  assert.ok(pulses.at(-1)[1] > slow);
  assert.ok(pulses.at(-1)[1] <= 25);
  speed.stop();
  for (const mode of ['off', 'spaces', 'speed']) {
    const unsupported = createStreamVibration(mode, { ...options, navigator: {} });
    unsupported.feed('some text '); unsupported.stop();
  }
  const rejected = createStreamVibration('spaces', { ...options, navigator: { vibrate() { throw new Error('blocked'); } } });
  rejected.feed(' '); rejected.stop();
});

test('Rewrite thinking and writing both trigger space vibration through the stream callbacks', async () => {
  for (const thinking of [true, false]) {
    const h = await rewriteChatHarness();
    const pulses = [];
    h.document.hidden = false;
    h.setNavigator({ vibrate: duration => pulses.push(duration) });
    h.calls.streamLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: thinking ? 'thinking words' : 'thinking', content: thinking ? 'Reply' : 'Reply words' }, finish_reason: 'stop' }] })}\n`,
    ];
    await h.fire('btn-rewrite');
    assert.deepEqual(pulses, [10, 0]);
    assert.doesNotMatch(h.el('chat-input').value, /thinking/);
    assert.equal((h.document.listeners.visibilitychange ?? []).length, 0);
  }
});

test('Stop restores the composer immediately while history is still loading', async () => {
  const h = await rewriteChatHarness();
  h.state.settings.rewriteRecentMessages = 10;
  // Mark older history available, forcing a history read rather than an empty cache.
  h.calls.latestCallbacks.at(-1)({ messages: [], hasEarlier: true });
  let finishHistory;
  h.calls.historyPending = new Promise(resolve => { finishHistory = resolve; });
  const running = h.fire('btn-rewrite');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.state.busy, true);
  await h.fire('btn-rewrite');
  await running;
  assert.equal(h.state.busy, false);
  assert.equal(h.el('chat-input').value, 'I tell him about the story');
  assert.equal(h.calls.requests.length, 0);
  finishHistory([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.requests.length, 0);
});

async function openTurnChat(h, metadata = {}, messages = []) {
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('turn-story');
  await new Promise(resolve => setTimeout(resolve, 0));
  h.calls.sessionCallbacks.at(-1)({ id: 'turn-story', exists: () => true,
    data: () => ({ title: 'Story', ...metadata }) });
  h.calls.latestCallbacks.at(-1)({ messages, hasEarlier: false });
  h.calls.serverSnapshot = { exists: () => true, data: () => metadata };
  h.state.settings.modelId = 'test'; h.state.settings.apiKey = 'test-key';
  h.state.settings.streaming = false;
  return chat;
}

test('Stream bubble survives saving and is replaced once the saved message exists', async () => {
  const h = await harness();
  await openTurnChat(h);
  let finishSave;
  h.calls.addMessage = async (_id, message, options) => message.role === 'user'
    ? { id: 'user', order: 1, tokenCount: 4 }
    : new Promise(resolve => { finishSave = () => resolve({ id: options.id, order: 2, tokenCount: 7 }); });
  h.el('chat-input').value = 'Turn';
  const pending = h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const list = h.el('message-list');
  assert.ok(list.children.some(node => !node.dataset.messageId && node.className === 'msg assistant'));
  finishSave(); await pending;
  assert.equal(list.children.filter(node => node.className === 'msg assistant').length, 1);
  assert.ok(list.children.find(node => node.dataset.messageId === 'summary-id'));
});

test('Viewport measurements ignore zoom and preserve keyboard offset at normal scale', async () => {
  const h = await harness();
  const { viewportVars } = await h.use('viewport.js');
  assert.equal(viewportVars({ scale: 1.5, height: 300, offsetTop: 40 }), null);
  assert.deepEqual(structuredClone(viewportVars({ scale: 1, height: 450, offsetTop: 30 })),
    { height: '450px', offsetTop: '30px' });
  assert.equal(viewportVars({ scale: 1, height: 0 }), null);
});

test('Unsupported vibration is explained without disabling the synced setting', async () => {
  const h = await harness();
  const { vibrationSupport } = await h.use('stream-vibration.js');
  assert.equal(vibrationSupport({ userAgent: 'iPhone OS 18_6 Version/26.5' }), 'unsupported');
  assert.equal(vibrationSupport({ vibrate() {} }), 'native');
  (await h.use('ui/settings-view.js')).initSettingsView();
  assert.equal(h.el('stream-vibration-help').hidden, false);
  assert.notEqual(h.el('set-stream-vibration').disabled, true);
});

test('Cached story catches up through metadata once and acknowledges deleted order gaps', async () => {
  const h = await harness();
  const chat = await openTurnChat(h, { nextOrder: 1 }, [{ id: 'u', order: 1, role: 'user', content: 'Opening' }]);
  chat.setSession('other'); chat.setSession('turn-story');
  h.calls.freshMessages = [{ id: 'a', order: 2, role: 'assistant', content: 'Phone reply' }];
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 2 });
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 2 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.catchUps.length, 1);
  assert.ok(h.el('message-list').children.some(node => node.dataset.messageId === 'a'));
  h.calls.freshMessages = [];
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 5 });
  await new Promise(resolve => setTimeout(resolve, 0));
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 5 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.catchUps.length, 2);
});

test('Metadata arriving during catch-up triggers one follow-up query', async () => {
  const h = await harness();
  const chat = await openTurnChat(h);
  let finish;
  h.calls.catchUp = () => h.calls.catchUps.length === 1 ? new Promise(resolve => { finish = resolve; }) : [];
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 2 });
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 3 });
  finish([{ id: 'remote', order: 2, role: 'assistant', content: 'Remote reply' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.catchUps.map(args => args[1]), [0, 2]);
});

test('A stale send loads remote turns and does not write a user message', async () => {
  const h = await harness();
  await openTurnChat(h);
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 1 }) };
  h.calls.freshMessages = [{ id: 'phone', order: 1, role: 'user', content: 'Phone turn' }];
  h.el('chat-input').value = 'My draft';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.calls.requests.length, 0);
  assert.ok(h.el('message-list').children.some(node => node.dataset.messageId === 'phone'));
});

test('Failed user save restores the exact draft and stale-send drafts survive', async () => {
  const h = await harness();
  await openTurnChat(h);
  h.calls.addMessage = async () => { throw new Error('write denied'); };
  h.el('chat-input').value = '  My draft\n';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.el('chat-input').value, '  My draft\n');
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 2 }) };
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(h.el('chat-input').value, '  My draft\n');
});

test('A failed reply renders the saved user with Retry; retry reuses that turn', async () => {
  const h = await harness();
  await openTurnChat(h);
  h.calls.responseData = { error: { message: 'provider unavailable' } };
  h.calls.addMessage = async (_id, message, options) => message.role === 'user'
    ? { id: 'user', order: 1, tokenCount: 4 }
    : { id: options.id, order: 2, tokenCount: 7 };
  h.el('chat-input').value = 'My turn';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  const user = h.el('message-list').children.find(node => node.dataset.messageId === 'user');
  const retry = user.querySelector('.msg-actions').children.find(button => button.textContent === 'Retry reply');
  assert.ok(retry);
  h.calls.responseData = null;
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 1 }) };
  await retry.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(h.calls.requests.length, 2);
  assert.equal(h.calls.requests[1].messages.at(-1).content, 'My turn');
  assert.equal(h.calls.messages.filter(args => args[1].role === 'user').length, 1);
  const updated = h.el('message-list').children.find(node => node.dataset.messageId === 'user');
  assert.equal(updated.querySelector('.msg-actions').children.some(button => button.textContent === 'Retry reply'), false);
});

test('Truncated summaries cannot replace the checkpoint and incomplete plans remain absent', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  h.calls.responseData = { choices: [{ finish_reason: 'length', message: { content: 'Incomplete facts' } }] };
  await assert.rejects(runSummarization({ id: 's' }, { ...h.state.settings,
    modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [
    { id: 'u1', order: 1, role: 'user', content: 'Opening' },
    { id: 'a1', order: 2, role: 'assistant', content: 'Opening reply' },
    { id: 'u2', order: 3, role: 'user', content: 'Fold this' },
  ] }), /checkpoint was not changed/);
  assert.equal(h.calls.messages.length, 0);
  const { extractPlan } = await h.use('plan-parser.js');
  assert.equal(extractPlan('Story <plan>unfinished'), null);
});

test('A non-streaming length-limited reply is saved and visibly marked', async () => {
  const h = await harness();
  await openTurnChat(h);
  h.calls.responseData = { choices: [{ finish_reason: 'length', message: { content: 'Partial story <plan>unfinished' } }] };
  h.calls.addMessage = async (_id, message, options) => message.role === 'user'
    ? { id: 'user', order: 1, tokenCount: 4 }
    : { id: options.id, order: 2, tokenCount: 7 };
  h.el('chat-input').value = 'Continue';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  const reply = h.calls.messages.find(args => args[1].role === 'assistant')[1];
  assert.equal(reply.content, 'Partial story'); assert.equal(reply.truncated, true);
  const node = h.el('message-list').children.find(item => item.dataset.messageId === 'summary-id');
  assert.match(node.querySelector('.msg-meta').children[0].textContent, /cut off/);
});

test('Reasoning budget must leave output room while input and output limits remain independent', async () => {
  const h = await harness();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  h.el('set-reasoning-enabled').checked = true;
  h.el('set-reasoning-mode').value = 'max_tokens';
  h.el('set-reasoning-maxtokens').value = '8192';
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.el('settings-saved-msg').textContent, /must be lower/);
  h.el('set-reasoning-maxtokens').value = '4096';
  h.el('set-max-context').value = '1024';
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length, 1);
});

test('Known total model window bounds summary input plus reserved output', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  const settings = { ...h.state.settings, modelId: 'test', streaming: false,
    maxContextTokens: 2000, modelContextTokens: 2100, summarizerMaxTokens: 600,
    keepRecentMessagesAfterSummary: 0 };
  const messages = Array.from({ length: 8 }, (_, i) => ({ id: String(i), order: i + 1,
    role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(300) }));
  await runSummarization({ id: 's' }, settings, { messages });
  assert.ok(h.calls.requests.length > 1);
  for (const request of h.calls.requests) {
    const input = request.messages.reduce((sum, message) => sum + message.content.length + 8, 8);
    assert.ok(input <= settings.maxContextTokens);
    assert.ok(input + request.max_tokens <= settings.modelContextTokens);
  }
});

test('Tokenizer recovery recounts identical text and ignores old inflated stored counts', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [{ id: 'u', order: 1, role: 'user', content: 'Long English sentence', tokenCount: 99999 }];
  h.calls.tokenizerReady = false;
  const fallback = await buildContextForRequest({ id: 's' }, h.state.settings, { messages });
  assert.equal(fallback.entries.at(-1).tokens, messages[0].content.length);
  h.calls.tokenizerReady = true; h.calls.tokenCount = () => 4;
  const recovered = await buildContextForRequest({ id: 's' }, h.state.settings, { messages });
  assert.equal(recovered.entries.at(-1).tokens, 4);
  assert.equal(recovered.entries[0].tokens, 4);
});

test('Gap markers count toward input and distinguish summary coverage from later omitted turns', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [
    { id: 'u1', order: 1, role: 'user', content: 'Opening' },
    { id: 'a1', order: 2, role: 'assistant', content: 'First reply' },
    { id: 'u2', order: 3, role: 'user', content: 'Folded event' },
    { id: 'sum', order: 4, role: 'summary', content: 'Summary' },
    { id: 'a2', order: 5, role: 'assistant', content: 'x'.repeat(500) },
    { id: 'u3', order: 6, role: 'user', content: 'Current' },
  ];
  const session = { id: 's', activeSummaryMessageId: 'sum', breakpointOrder: 3 };
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  const result = await buildContextForRequest(session,
    { ...h.state.settings, maxContextTokens: base.usedTokens + 220 }, { messages, requireLatestUser: true });
  const marker = result.entries.find(entry => entry.source === 'Omitted turns marker');
  assert.match(marker.content, /Later omitted turns are not covered/);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.usedTokens, result.contributions.reduce((sum, item) => sum + item.tokens, 0));
  assert.ok(result.usedTokens <= base.usedTokens + 220);
  const allFit = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: messages.filter(m => m.role !== 'summary') });
  assert.equal(allFit.entries.some(entry => entry.source === 'Omitted turns marker'), false);
});

test('Request-time plan rules remove the legacy lost-plan instruction while preserving custom prompts', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const result = await buildContextForRequest({ id: 's', longTermPlan: 'Reach the harbor' }, h.state.settings, { messages: [] });
  assert.match(result.apiMessages[0].content, /Their absence never means the plan was lost/);
  assert.doesNotMatch(result.apiMessages[0].content, /treat that plan as lost from context|remains active even if older/);
  const custom = await buildContextForRequest({ id: 's' }, { ...h.state.settings, narratorSystemPrompt: 'My custom narrator' }, { messages: [] });
  assert.match(custom.apiMessages[0].content, /^My custom narrator/);
});

test('Folded deletes explain checkpoint loss; opening edits do not claim their text is hidden', async () => {
  const h = await harness();
  await openTurnChat(h, { activeSummaryMessageId: 'sum', breakpointOrder: 3 }, [
    { id: 'u1', order: 1, role: 'user', content: 'Opening' },
    { id: 'a1', order: 2, role: 'assistant', content: 'First scene' },
    { id: 'u2', order: 3, role: 'user', content: 'Folded' },
    { id: 'sum', order: 4, role: 'summary', content: 'Summary' },
    { id: 'a2', order: 5, role: 'assistant', content: 'Recent' },
  ]);
  const action = (id, text) => h.el('message-list').children.find(node => node.dataset.messageId === id)
    .querySelector('.msg-actions').children.find(button => button.textContent === text);
  h.calls.confirm = false;
  await action('u2', 'Delete').dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.match(h.calls.confirmations.at(-1), /clears the summary/);
  await action('a2', 'Delete').dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(h.calls.confirmations.at(-1), 'Delete this message permanently?');
  await action('u1', 'Edit').dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(h.el('message-list').querySelector('.status-line'), null);
});

for (const unlocked of [false, true]) {
  test(`Old replies can regenerate only when the story plan is locked (updates=${unlocked})`, async () => {
    const h = await harness();
    await openTurnChat(h, { nextOrder: 2, longTermPlan: 'Fixed plan', allowLlmPlanUpdates: unlocked }, [
      { id: 'u', order: 1, role: 'user', content: 'Opening' },
      { id: 'a', order: 2, role: 'assistant', content: 'Old reply' },
    ]);
    const node = h.el('message-list').children.find(item => item.dataset.messageId === 'a');
    await node.querySelector('.msg-actions').children.find(button => button.textContent === 'Regenerate')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.calls.requests.length, unlocked ? 0 : 1);
    assert.equal(h.calls.overwrites?.length ?? 0, unlocked ? 0 : 1);
    if (!unlocked) assert.match(h.calls.requests[0].messages[0].content, /Fixed plan/);
  });
}

test('Dropped-turn warning explains recovery when automatic summarization is off', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: String(index), order: index + 1,
    role: 'user', content: 'x'.repeat(100) }));
  const chat = await openTurnChat(h, { nextOrder: 10 }, messages);
  h.state.settings.maxContextTokens = base.usedTokens + 260;
  await chat.updateIndicator();
  assert.match(h.el('context-label').textContent, /turns not sent/);
  assert.match(h.el('context-indicator').title, /Turn on auto-summary/);
  h.state.settings.autoSummarizationEnabled = true;
  await chat.updateIndicator();
  assert.doesNotMatch(h.el('context-indicator').title, /Turn on auto-summary/);
});

test('Provider usage belongs only to its captured request and clears on story reset', async () => {
  const h = await harness();
  const view = await h.use('ui/context-view.js');
  view.initContextInspector(async () => ({}));
  const context = { usedTokens: 10, max: 100, entries: [], contributions: [], omitted: {} };
  const first = view.captureContextRequest(context, { model: 'first', messages: [] });
  const second = view.captureContextRequest(context, { model: 'second', messages: [] });
  h.el('context-dialog').open = true; h.el('context-mode').value = 'sent';
  view.captureContextUsage(first, { prompt_tokens: 111 });
  view.captureContextUsage(second, { prompt_tokens: 222 });
  assert.match(h.el('context-status').textContent, /Provider counted: 222/);
  assert.doesNotMatch(h.el('context-status').textContent, /111/);
  view.resetContextInspector();
  view.captureContextUsage(second, { prompt_tokens: 333 });
  await h.fire('context-mode', 'change');
  assert.match(h.el('context-status').textContent, /No request has been sent/);
});

test('A snapshot during regeneration cannot remove the stream before overwrite completes', async () => {
  const h = await harness();
  const messages = [
    { id: 'u', order: 1, role: 'user', content: 'Opening' },
    { id: 'a', order: 2, role: 'assistant', content: 'Old reply' },
  ];
  await openTurnChat(h, { nextOrder: 2 }, messages);
  let finish;
  h.calls.overwriteMessage = () => new Promise(resolve => { finish = resolve; });
  const button = h.el('message-list').children.find(node => node.dataset.messageId === 'a')
    .querySelector('.msg-actions').children.find(node => node.textContent === 'Regenerate');
  await button.dispatchEvent({ type: 'click', stopPropagation() {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  h.calls.latestCallbacks.at(-1)({ messages, hasEarlier: false });
  assert.ok(h.el('message-list').children.some(node => !node.dataset.messageId && node.className === 'msg assistant'));
  h.calls.latestCallbacks.at(-1)({ messages: [messages[0], { ...messages[1], content: 'summary' }], hasEarlier: false });
  assert.ok(h.el('message-list').children.some(node => !node.dataset.messageId && node.className === 'msg assistant'));
  finish({ tokenCount: 7 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.el('message-list').children.filter(node => node.className === 'msg assistant').length, 1);
});

test('Catch-up failure after switching stories cannot show an error in the new story', async () => {
  const h = await harness();
  const chat = await openTurnChat(h);
  let fail;
  h.calls.catchUp = () => new Promise((_resolve, reject) => { fail = reject; });
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 2 });
  chat.setSession('other');
  fail(new Error('Old story network error'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.el('message-list').children.some(node => node.className === 'msg error'), false);
});

test('Send waits for an existing catch-up and retains the draft for review', async () => {
  const h = await harness();
  const chat = await openTurnChat(h);
  let finish;
  h.calls.catchUp = () => new Promise(resolve => { finish = resolve; });
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 1 });
  h.el('chat-input').value = 'Review my draft';
  const pending = h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  finish([{ id: 'remote', order: 1, role: 'user', content: 'Remote turn' }]);
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 1 }) };
  await pending;
  assert.equal(h.calls.messages.length, 0);
  assert.equal(h.el('chat-input').value, 'Review my draft');
});

test('Retry context retains the latest user even after a manual summary folds that turn', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const result = await buildContextForRequest({ id: 's', activeSummaryMessageId: 'sum', breakpointOrder: 3 },
    h.state.settings, { requireLatestUser: true, messages: [
      { id: 'u1', order: 1, role: 'user', content: 'Opening' },
      { id: 'a1', order: 2, role: 'assistant', content: 'First reply' },
      { id: 'u2', order: 3, role: 'user', content: 'Unanswered turn' },
      { id: 'sum', order: 4, role: 'summary', content: 'Summary of earlier turns' },
    ] });
  assert.equal(result.apiMessages.at(-1).role, 'user');
  assert.equal(result.apiMessages.at(-1).content, 'Unanswered turn');
  assert.equal(result.droppedCount, 0);
  assert.equal(result.usedTokens, result.contributions.reduce((sum, entry) => sum + entry.tokens, 0));
});

test('Restoring a cached story consumes metadata already held by the sidebar', async () => {
  const h = await harness();
  const chat = await openTurnChat(h, { nextOrder: 1 }, [{ id: 'u', order: 1, role: 'user', content: 'Opening' }]);
  (await h.use('ui/sidebar.js')).initSidebar();
  chat.setSession('other');
  h.calls.sidebarCallback([{ id: 'turn-story', nextOrder: 3, title: 'Story' }, { id: 'other', title: 'Other' }]);
  h.calls.freshMessages = [{ id: 'a', order: 3, role: 'assistant', content: 'Already written on phone' }];
  chat.setSession('turn-story');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.catchUps.length, 1);
  assert.ok(h.el('message-list').children.some(node => node.dataset.messageId === 'a'));
});

test('Inspector keeps summaries and omission markers in their actual position among story turns', async () => {
  const h = await harness();
  const { computeContextUsage } = await h.use('context-builder.js');
  const context = await computeContextUsage({ id: 's', activeSummaryMessageId: 'sum', breakpointOrder: 3 },
    h.state.settings, [
      { id: 'u1', order: 1, role: 'user', content: 'Opening' },
      { id: 'a1', order: 2, role: 'assistant', content: 'First reply' },
      { id: 'u2', order: 3, role: 'user', content: 'Folded event' },
      { id: 'sum', order: 4, role: 'summary', content: 'Summary' },
      { id: 'u3', order: 5, role: 'user', content: 'Current turn' },
    ]);
  const view = await h.use('ui/context-view.js');
  view.initContextInspector(async () => context);
  await h.fire('context-indicator');
  const group = h.el('context-body').children.find(node => node.className?.includes('context-turn-group'));
  const labels = group.querySelector('.context-turn-list').children.map(node => node.children[0].textContent);
  assert.match(labels[0], /Opening exchange/);
  assert.match(labels[1], /Opening exchange/);
  assert.match(labels[2], /Active story summary/);
  assert.match(labels[3], /Omitted turns marker/);
  assert.match(labels[4], /Recent user messages/);
});


test('Send after the newest message was deleted is not stale', async () => {
  const h = await harness();
  await openTurnChat(h, { nextOrder: 1 }, [{ id: 'u', order: 1, role: 'user', content: 'Opening' }]);
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 3 }) };
  h.calls.freshMessages = [];
  h.calls.addMessage = async (_id, message) => ({ id: message.role, order: message.role === 'user' ? 4 : 5, tokenCount: 4 });
  h.el('chat-input').value = 'Next';
  await h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  const users = h.calls.messages.filter(args => args[1].role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0][2].expectedNextOrder, 3);
  assert.equal(h.calls.messages.filter(args => args[1].role === 'assistant').length, 1);
});

test('A running zero-message catch-up does not make the send stale', async () => {
  const h = await harness();
  const chat = await openTurnChat(h);
  let finish;
  h.calls.catchUp = () => new Promise(resolve => { finish = resolve; });
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 3 });
  h.calls.serverSnapshot = { exists: () => true, data: () => ({ nextOrder: 3 }) };
  h.el('chat-input').value = 'Next';
  const pending = h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  finish([]);
  await pending;
  assert.equal(h.calls.messages.filter(args => args[1].role === 'user').length, 1);
  assert.equal(h.calls.messages[0][2].expectedNextOrder, 3);
});


for (const streaming of [false, true]) {
  test(`Provider finish reasons are normalized and failures blocked (streaming=${streaming})`, async () => {
    const h = await harness();
    const { chatCompletion } = await h.use('llm-client.js');
    const settings = { ...h.state.settings, modelId: 'test', streaming };
    for (const [reason, expected] of [['end_turn', 'end_turn'], ['eos', 'eos'], ['STOP', 'stop'], ['stop_sequence', 'stop_sequence'], ['future_reason', 'future_reason'], ['MAX_TOKENS', 'length'], ['MAX_OUTPUT_TOKENS', 'length'], ['CONTENT_FILTER', null]]) {
      h.calls.responseData = { choices: [{ message: { content: 'Reply' }, finish_reason: reason }] };
      h.calls.streamLines = streaming ? [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Reply' }, finish_reason: reason }] })}\n`] : null;
      if (expected === null) await assert.rejects(chatCompletion({ settings, messages: [] }), /content_filter/);
      else {
        const result = await chatCompletion({ settings, messages: [] });
        assert.equal(result.content, 'Reply');
        assert.equal(result.finishReason, expected);
      }
    }
  });
}


test('Message editor fits overflowing text and Cancel restores the bubble', async () => {
  const h = await harness();
  const createElement = h.document.createElement;
  h.document.createElement = tag => {
    const node = createElement(tag);
    if (tag === 'textarea') { node.scrollHeight = 900; node.clientHeight = 40; }
    return node;
  };
  await openTurnChat(h, { nextOrder: 1 }, [{ id: 'u', order: 1, role: 'user', content: 'Long message' }]);
  const node = h.el('message-list').children.find(node => node.dataset.messageId === 'u');
  h.el('message-list').scrollTop = 123;
  await node.querySelector('.msg-actions').children.find(button => button.textContent === 'Edit').dispatchEvent({ type: 'click', stopPropagation() {} });
  const editor = node.querySelector('.msg-editor');
  assert.equal(editor.style.height, '900px');
  assert.equal(node.style.height, '');
  assert.equal(h.el('message-list').scrollTop, 123);
  editor.scrollHeight = 1100;
  await editor.dispatchEvent({ type: 'input' });
  assert.equal(editor.style.height, '1100px');
  await node.querySelector('.msg-actions').children.find(button => button.textContent === 'Cancel').dispatchEvent({ type: 'click', stopPropagation() {} });
  const restored = h.el('message-list').children.find(node => node.dataset.messageId === 'u');
  assert.equal(restored.querySelector('.msg-editor'), null);
  assert.ok(restored.querySelector('.msg-content'));
  assert.equal(restored.style.height, undefined);
});


test('Long story context reuses token counts on the second build', async () => {
  const h = await harness();
  let counts = 0;
  h.calls.tokenCount = text => { counts++; return text.length; };
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = Array.from({ length: 1500 }, (_, i) => ({ id: `m${i}`, order: i + 1,
    role: i % 2 ? 'assistant' : 'user', content: `Unique short message ${i}` }));
  await buildContextForRequest({ id: 'story' }, h.state.settings, { messages });
  const first = counts;
  assert.ok(first >= 1500);
  await buildContextForRequest({ id: 'story' }, h.state.settings, { messages });
  assert.equal(counts - first, 0);
});


test('Failed settings load blocks writes and recovery loads saved values for review', async () => {
  const h = await harness();
  h.calls.serverError = 'offline';
  await assert.rejects(h.settings.loadSettings(), /offline/);
  h.state.settingsLoadFailed = true;
  await assert.rejects(h.settings.saveSettings(h.state.settings), /saving is blocked/);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.state.settingsSaving, false);
  assert.equal(h.state.settingsLoadFailed, true);
  h.calls.serverError = null;
  h.calls.settingsDoc = { modelId: 'saved-model', apiKey: 'saved-secret' };
  await assert.rejects(h.settings.saveSettings(h.state.settings), /Review them and save again/);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.state.settings.modelId, 'saved-model');
  assert.equal(h.state.settings.apiKey, 'saved-secret');
  assert.equal(h.state.settingsLoadFailed, false);
  await h.settings.saveSettings(h.state.settings);
  assert.equal(h.calls.writes[0].apiKey, 'saved-secret');
});

test('Settings popup replaces the default draft with recovered server settings', async () => {
  const h = await harness();
  (await h.use('ui/chat-view.js')).initChatView();
  const view = await h.use('ui/settings-view.js');
  view.initSettingsView(); view.openSettingsPopup();
  h.el('set-model').value = 'default-draft';
  h.state.settingsLoadFailed = true;
  h.calls.settingsDoc = { modelId: 'saved-model', apiKey: 'saved-secret' };
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.el('set-model').value, 'saved-model');
  assert.equal(h.el('set-apikey').value, 'saved-secret');
  assert.match(h.el('settings-saved-msg').textContent, /Review them/);
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes[0].apiKey, 'saved-secret');
});


test('Quick profile and thinking survive reload and remote saves until explicit save', async () => {
  const h = await harness();
  const server = { profiles: [{ id: 'a', modelId: 'model-a' }, { id: 'b', modelId: 'model-b' }], activeProfileId: 'a' };
  h.calls.settingsDoc = server;
  h.state.settings = await h.settings.loadSettings();
  const quick = structuredClone(h.state.settings);
  quick.activeProfileId = 'b';
  h.settings.mirrorFromActiveProfile(quick);
  quick.reasoning = { ...quick.reasoning, enabled: true, effort: 'high' };
  h.settings.useLocalSettings(quick);
  const loaded = await h.settings.loadSettings();
  assert.equal(loaded.activeProfileId, 'b');
  assert.equal(loaded.modelId, 'model-b');
  assert.equal(loaded.reasoning.effort, 'high');
  h.settings.watchSettings();
  h.calls.settingsCallbacks.at(-1)({ exists: () => true, data: () => server, metadata: {} });
  assert.equal(h.state.settings.activeProfileId, 'b');
  assert.equal(h.state.settings.reasoning.enabled, true);
  const explicit = h.settings.hydrateProfiles({ ...structuredClone(h.settings.DEFAULT_SETTINGS), ...structuredClone(server) });
  await h.settings.saveSettings(explicit);
  assert.equal(h.localCache.has('roleplay-quick:test-user'), false);
  assert.equal((await h.settings.loadSettings()).activeProfileId, 'a');
});

test('Quick overrides ignore missing, deleted and malformed choices', async () => {
  const h = await harness();
  const settings = h.state.settings;
  const before = structuredClone(settings);
  assert.deepEqual(structuredClone(h.settings.applyQuickOverrides(settings)), before);
  h.localCache.set('roleplay-quick:test-user', JSON.stringify({ activeProfileId: 'deleted', reasoning: { enabled: true } }));
  assert.deepEqual(structuredClone(h.settings.applyQuickOverrides(settings)), before);
  h.localCache.set('roleplay-quick:test-user', '{broken');
  assert.deepEqual(structuredClone(h.settings.applyQuickOverrides(settings)), before);
});


for (const timeout of [false, true]) {
  test(`Hung assistant reply unlocks without saving on ${timeout ? 'idle timeout' : 'Stop'}`, async () => {
    const h = await harness();
    await openTurnChat(h);
    h.state.settings.streaming = true;
    h.calls.addMessage = async (_id, message) => ({ id: message.role, order: 1, tokenCount: 4 });
    let reading = false;
    h.calls.streamReader = { read: () => { reading = true; return new Promise(() => {}); } };
    h.el('chat-input').value = 'Turn';
    const pending = h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
    while (!reading) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.state.busy, true);
    assert.equal(h.el('btn-stop-reply').hidden, false);
    if (timeout) h.calls.timers.find(timer => timer.delay === 120000 && !timer.cleared).fn();
    else await h.fire('btn-stop-reply');
    await pending;
    assert.equal(h.state.busy, false);
    assert.equal(h.el('btn-send').disabled, false);
    assert.equal(h.el('btn-stop-reply').hidden, true);
    assert.equal(h.calls.messages.filter(args => args[1].role === 'assistant').length, 0);
    const user = h.el('message-list').children.find(node => node.dataset.messageId === 'user');
    assert.ok(user.querySelector('.msg-actions').children.some(button => button.textContent === 'Retry reply'));
    assert.match(h.el('message-list').children.find(node => node.className === 'msg error').textContent, timeout ? /stopped responding/ : /Reply stopped/);
    assert.ok(h.calls.timers.filter(timer => timer.delay === 120000).every(timer => timer.cleared));
  });
}


for (const fails of [false, true]) {
  test(`Logout removes account caches and still signs out when cache cleanup ${fails ? 'fails' : 'succeeds'}`, async () => {
    const h = await harness();
    (await h.use('ui/chat-view.js')).initChatView();
    (await h.use('ui/sidebar.js')).initSidebar();
    h.localCache.set('roleplay-settings:test-user', 'secret');
    h.localCache.set('roleplay-quick:test-user', 'choice');
    h.localCache.set('roleplay-settings:other-user', 'other');
    h.calls.cacheClearError = fails;
    await h.fire('btn-logout');
    assert.deepEqual(h.calls.cacheClears, ['test-user']);
    assert.equal(h.localCache.has('roleplay-settings:test-user'), false);
    assert.equal(h.localCache.has('roleplay-quick:test-user'), false);
    assert.equal(h.localCache.get('roleplay-settings:other-user'), 'other');
    assert.equal(h.calls.logouts, 1);
  });
}


test('Settings recovery cannot use cached defaults created after the failed startup', async () => {
  const h = await harness();
  h.calls.serverError = 'offline';
  h.state.settingsLoadFailed = true;
  h.settings.useLocalSettings(h.state.settings);
  await assert.rejects(h.settings.saveSettings(h.state.settings), /saving is blocked/);
  await assert.rejects(h.settings.saveSettings(h.state.settings), /saving is blocked/);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.state.settingsLoadFailed, true);
});

test('Logout cancels pending cache writes so cleared stories are not saved again', async () => {
  const h = await harness();
  const chat = await openTurnChat(h);
  (await h.use('ui/sidebar.js')).initSidebar();
  const pending = h.calls.timers.filter(timer => timer.delay === 250 && !timer.cleared);
  assert.ok(pending.length > 0);
  await h.fire('btn-logout');
  assert.ok(pending.every(timer => timer.cleared));
  for (const timer of pending) timer.fn();
  chat.syncActiveSession({ id: 'turn-story', nextOrder: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.cacheSaves?.length ?? 0, 0);
});

test('Reply deltas reset the idle timeout and stopped late responses cannot save', async () => {
  const h = await harness();
  await openTurnChat(h);
  h.state.settings.streaming = true;
  h.calls.addMessage = async (_id, message) => ({ id: message.role, order: 1, tokenCount: 4 });
  let finish, reads = 0;
  h.calls.streamReader = { read: () => {
    if (reads++ === 0) return Promise.resolve({ done: false, value: new TextEncoder().encode(
      'data: {"choices":[{"delta":{"reasoning":"Thinking","content":"Partial"}}]}\n') });
    return new Promise(resolve => { finish = resolve; });
  } };
  h.el('chat-input').value = 'Turn';
  const pending = h.el('composer').dispatchEvent({ type: 'submit', preventDefault() {} });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
  const timers = h.calls.timers.filter(timer => timer.delay === 120000);
  assert.equal(timers.length, 3);
  assert.ok(timers[0].cleared && timers[1].cleared);
  assert.equal(timers[2].cleared, undefined);
  await h.fire('btn-stop-reply');
  await pending;
  finish({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Late"},"finish_reason":"stop"}]}\n') });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.messages.filter(args => args[1].role === 'assistant').length, 0);
  assert.equal(h.state.busy, false);
  assert.equal(h.calls.timers.filter(timer => timer.delay === 120000).length, 3);
});
