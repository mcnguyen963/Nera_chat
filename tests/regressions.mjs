import { promptFetch, promptImportMeta } from './prompt-files.mjs';
// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness({ legacyNarratorHashes = null } = {}) {
  const elements = new Map();
  class Element {
    value = ''; checked = false; hidden = true; style = {}; children = []; dataset = {};
    classList = { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, toggle(name, force) { if (force ?? !this.values.has(name)) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } };
    listeners = {};
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    async dispatchEvent(event) {
      for (const fn of this.listeners[event.type] ?? []) await fn(event);
    }
    replaceChildren(...children) { for (const c of this.children) c.parentNode=null; this.children = []; this.append(...children); }
    setAttribute(key,value) { (this.attributes ??= {})[key]=value; }
    scrollIntoView() {}
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get selectedOptions() { return this.children.filter(c => c.value === this.value); }
    replaceWith(replacement) { const p = this.parentNode; if (!p) return; const index = p.children.indexOf(this); p.children.splice(index,1,replacement); replacement.parentNode=p; this.parentNode=null; }
    focus() { document.activeElement = this; }
    closest() { return { firstChild: { textContent: this.id } }; }
    getClientRects() { return [1]; }
    matches(selector) {
      if (selector.startsWith('.')) return (this.className ?? '').split(' ').includes(selector.slice(1)) || this.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      const data = selector.match(/^\[data-([^=]+)="([^"\]]+)"\]$/); if (data) { const key=data[1].replace(/-([a-z])/g,(_,c) => c.toUpperCase()); return this.dataset[key] === data[2]; }
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { const matches = []; const visit = e => { for (const c of e.children ?? []) { if (selector.split(',').some(s => c.matches?.(s.trim()))) matches.push(c); visit(c); } }; visit(this); return matches; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    removeEventListener(type,fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
    click() { return this.dispatchEvent({ type: 'click', stopPropagation() {}, preventDefault() {} }); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    insertBefore(child, anchor) { child.remove(); const index = anchor ? this.children.indexOf(anchor) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child; }
    append(...children) { for (const c of children) { c.parentNode=this; this.children.push(c); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
    reportValidity() { return this.id === 'set-endpoint' || (Number.isInteger(Number(this.value)) && Number(this.value) >= 0); }
  }
  const document = new Element();
  document.getElementById = (id) => {
    if (!elements.has(id)) {
      const element = new Element();
      element.id = id;
      const mins = { 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-chunk': 2000, 'mem-batchTurns': 2, 'mem-lagTurns': 0, 'mem-updateMaxTokens': 256, 'mem-reorganizeMaxTokens': 256, 'mem-blockDepth': 1, 'mem-characters-budget': 0, 'mem-locations-budget': 0, 'mem-facts-budget': 0, 'mem-events-budget': 0, 'mem-characters-maxCards': 1, 'mem-locations-maxCards': 1 };
      if (id in mins) element.dataset.min = String(mins[id]);
      if (id === 'set-auto-threshold') element.dataset.max = '100';
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document.createElement = tag => { const e = new Element(); e.tagName = tag.toUpperCase(); return e; };
  const panelNames = ['model', 'context', 'prompts', 'story', 'memory', 'transfer', 'account'];
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
  document.querySelector = selector => { const [first,...rest] = selector.split(' '); const root = first.startsWith('#') ? elements.get(first.slice(1)) : document.body?.querySelector(first); return rest.length ? root?.querySelector(rest.join(' ')) : root; };
  document.body = new Element();
  const calls = { reads: 0, writes: [], messages: [], requests: [], queries: [], subscriptions: [], sessionCallbacks: [], settingsCallbacks: [], latestCallbacks: [], sessionWrites: [], imports: [], exports: [], settingsDoc: null, fail: false, confirm: true, response: 'summary', responseData: null, streamLines: null };
  const localCache = new Map();
  const context = vm.createContext({
    URL, console, structuredClone, document, TextDecoder, TextEncoder, AbortController,
    navigator: { clipboard: { writeText: async text => { calls.clipboard=text; } } },
    requestAnimationFrame: fn => { fn(); return 1; },
    localStorage: { getItem: (key) => localCache.get(key) ?? null, setItem: (key, value) => localCache.set(key, value) },
    window: { addEventListener() {} }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    setTimeout() {}, confirm: () => calls.confirm,
    fetch: async (_url, options) => {
      if (_url instanceof URL && _url.protocol === 'file:') {
        if (legacyNarratorHashes && _url.pathname.endsWith('/legacy-narrator-default-hashes.md')) return { ok:true, text:async () => legacyNarratorHashes };
        return promptFetch(_url, options);
      }
      calls.requests.push(JSON.parse(options.body));
      await calls.onRequest?.(JSON.parse(options.body));
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
    orderBy() {}, limitToLast: (count) => ({ limitToLast: count }), onSnapshot: (ref, callback) => { (ref?.[3] === 'settings' ? calls.settingsCallbacks : calls.sessionCallbacks).push(snap => { if (ref?.[3] !== 'settings' && snap.exists()) { calls.sessionDocs ??= {}; calls.sessionDocs[snap.id] = { id:snap.id,...snap.data(),historyRevision:calls.historyRevision ?? snap.data().historyRevision ?? 0 }; } return callback(snap); }); return () => {}; },
    getDoc: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    getDocFromServer: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    setDoc: async (_ref, settings) => {
      if (calls.fail) throw new Error('write denied');
      calls.writes.push(structuredClone(settings));
    },
  };
  const stubs = {
    // The real pet controller is exercised independently in pets.mjs.
    'lore-store.js': {
      getLore:async () => calls.loreEntries ?? [],configureLoreWrites() {}, loreWritesPending: () => false, waitForLoreWrites: async () => {},
      subscribeLore: (_sid,cb) => { calls.loreSubscriptions ??= 0; calls.loreSubscriptions++; (calls.loreCallbacks ??= []).push(cb); Promise.resolve().then(() => cb(calls.loreEntries ?? [])); return () => {}; },
      createEntry: async (_sid,e) => { (calls.loreEntries ??= []).push(e); for (const cb of calls.loreCallbacks ?? []) cb(calls.loreEntries); return e.id; },
      saveEntry: async (...args) => { (calls.cardWrites ??= []).push(args); }, deleteEntry: async () => 'backup', mergeEntries: async () => 'backup', writeBackup: async () => 'backup', restoreBackup: async () => {}, listBackups: async () => [], removeDeletedLines: async () => 'backup', importLore: async () => 'backup', replaceLines: async () => 'backup',
    },
    'memory-updater.js': { lastRawAnswer: () => '', configureMemoryUpdater() {}, isRunning: () => calls.memoryRunning === true, maybeStartAfterTurn: () => { if (calls.memoryDue) { calls.memoryStarts = (calls.memoryStarts ?? 0)+1; return true; } return false; }, stop() {}, rebuild:async () => {}, updateNow: async () => {}, catchUp: async () => {} },
    'ui/pet-view.js': {
      initPetView() {}, startPetTurn() {}, finishPetTurn() {},
      refreshPetPlacement() {}, updatePetPhase() {}, invalidatePetLayout() {},
      loadPetCatalog: async () => [],
    },
    'db.js': { db: {} },
    'auth.js': { currentUid: () => 'test-user' },
    'tokenizer.js': { countTokens: async (text) => text.length },
    'sessions.js': {
      getSessionFromServer:async id => calls.sessionDocs?.[id] ?? ({ id,title:'Story',longTermPlan:'Old plan',historyRevision:calls.historyRevision ?? 0 }),
      getSession: async id => calls.sessionDocs?.[id] ?? ({ title: 'Story', longTermPlan: 'Old plan' }),
      updateSession: async (...args) => { calls.sessionWrites.push(args); },
      duplicateSession: async (...args) => { calls.sessionCopies ??= []; calls.sessionCopies.push(args); return 'copied-session'; },
    },
    'import-export.js': { importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); } },
    'messages.js': {
      ensureContinuityMetadata:async () => {},
      getMessages:async () => { const read = calls.historyReads = (calls.historyReads ?? 0)+1; const result = structuredClone(calls.serverHistory ?? calls.history ?? []); await calls.onHistoryRead?.(read); return result; }, getCheckpointMessages: async () => [], newMessageId: () => 'summary-id',
      addMessage:async (...args) => { calls.messages.push(args); const result = { ...args[1],id:calls.messageOrder ? 'message-'+(++calls.messageOrder) : 'summary-id',order:calls.messageOrder ?? 1,tokenCount:args[1]?.content?.length ?? 0,historyRevision:(calls.historyRevision ?? 0)+1 }; calls.historyRevision = result.historyRevision; if (calls.sessionDocs?.[args[0]]) calls.sessionDocs[args[0]].historyRevision = result.historyRevision; calls.history = [...(calls.history ?? []),result]; return result; },
      subscribeLatestMessages: (sessionId, callback) => { calls.subscriptions.push(sessionId); calls.latestCallbacks.push(value => { calls.history = value.messages; callback(value); }); return () => {}; },
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
        context, identifier: path, initializeImportMeta:promptImportMeta,
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
  assert.match(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /dark fantasy roleplay/);
  assert.doesNotMatch(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /plan/i);
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
  assert.deepEqual(structuredClone(h.calls.sessionWrites[0]), ['story-id', { title: 'New title', longTermPlan: 'New plan', allowLlmPlanUpdates: false }]);
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
  await h.calls.settingsCallbacks[0]({ exists: () => true, data: () => remote, metadata: { fromCache: false, hasPendingWrites: false } });
  assert.equal(h.state.settings.modelId, 'remote-model');
  assert.equal(JSON.parse(h.localCache.get('roleplay-settings:test-user')).modelId, 'remote-model');
});

test('Both obsolete narrator defaults migrate while custom prompts remain unchanged', async () => {
  const legacy = ['former app default', 'former app default with obsolete recovery rule'];
  const hashes = await Promise.all(legacy.map(async text => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  }));
  const h = await harness({ legacyNarratorHashes:hashes.join('\n') });
  const next = h.settings.DEFAULT_SETTINGS.narratorSystemPrompt;
  for (const old of legacy) {
    h.localCache.clear();
    h.calls.settingsDoc = { narratorSystemPrompt:old };
    assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, next);
  }
  for (const custom of ['Custom narrator', legacy[0]+' custom addition', '']) {
    h.localCache.clear();
    h.calls.settingsDoc = { narratorSystemPrompt:custom };
    assert.equal((await h.settings.loadSettings()).narratorSystemPrompt, custom);
  }
});

for (const keep of [0, 1, 3]) {
  test(`Summary keeps at least ${keep} recent messages and completes turns`, async () => {
    const h = await harness();
    const { runSummarization } = await h.use('summarizer.js');
    const messages = Array.from({ length:6 },(_,i) => ({ id:String(i),order:i+1,role:i%2 ? 'assistant' : 'user',content:'event' }));
    const result = await runSummarization({ id: 'session' }, {
      ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: keep,
    }, { messages });
    assert.equal(result.foldedCount, keep === 0 ? 6 : keep === 1 ? 4 : 2);
    assert.equal(result.newBreakpointOrder,result.foldedCount);
  });
}

test('Empty summarizer output does not advance checkpoint', async () => {
  const h = await harness();
  h.calls.response = '';
  const { runSummarization } = await h.use('summarizer.js');
  await assert.rejects(runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: [{ id: 'm', order: 1, role: 'user', content: 'event' }] }), /no reply/);
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
  assert.match(result.apiMessages[1].content,/Historical summary through message order 200.*\nEarlier story/s);
  assert.equal(result.apiMessages.at(-1).content, 'turn 149');
});

test('Sliding context preserves the opening exchange and latest user while ejecting the middle', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  const settings = { ...h.state.settings, maxContextTokens: base.usedTokens + 225 + 100, maxResponseTokens: 100 };
  const messages = [
    { id: 'u1', order: 1, role: 'user', content: 'Opening', tokenCount: 25 },
    { id: 'a1', order: 2, role: 'assistant', content: 'Background', tokenCount: 25 },
    { id: 'u2', order: 3, role: 'user', content: 'Middle'.repeat(80),tokenCount:1 },
    { id: 'a2', order: 4, role: 'assistant', content: 'Small recent', tokenCount: 40 },
    { id: 'u3', order: 5, role: 'user', content: 'Latest', tokenCount: 30 },
  ];
  const result = await buildContextForRequest({ id: 's' }, settings, { messages, requireLatestUser: true });
  assert.deepEqual(Array.from(result.apiMessages.slice(1),(m) => m.content.replace(/^\[Opening exchange:[^\n]*\]\n/,'')), ['Opening', 'Background', 'Small recent', 'Latest']);
  assert.equal(result.droppedCount, 1);
  assert.ok(result.usedTokens + settings.maxResponseTokens <= settings.maxContextTokens);
  await assert.rejects(buildContextForRequest({ id: 's' }, settings, {
    messages: messages.map((m) => m.id === 'u3' ? { ...m,content:'Latest'.repeat(500),tokenCount:1 } : m), requireLatestUser: true,
  }), /opening story, summary and latest user message exceed/);
});

test('Opening exchange survives a summary checkpoint and regeneration preserves fixed plan', async () => {
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
  assert.match(current.apiMessages[1].content,/Historical summary/);
  assert.deepEqual(Array.from(current.apiMessages.slice(2),m => m.content.replace(/^\[Opening exchange:[^\n]*\]\n/,'')),['The kingdom begins here','The first scene','Current turn']);
  const regen = await buildContextForRequest(session, h.state.settings, {
    messages, upToOrder: 2, planOverride: 'Original plan', requireLatestUser: true,
  });
  assert.match(regen.apiMessages[0].content,/Future plan/);
  assert.doesNotMatch(regen.apiMessages[0].content,/Original plan/);
  assert.equal(regen.apiMessages.some((m) => m.content.includes('Story summary')), false);
});

test('Story plan is fixed even with the legacy model update flag', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const locked = await buildContextForRequest({ id: 's', longTermPlan: 'The reunion happens on day 20' }, h.state.settings, { messages: [] });
  assert.match(locked.apiMessages[0].content, /fixed author instructions/);
  assert.match(locked.apiMessages[0].content, /day 20/);
  const editable = await buildContextForRequest({ id: 's', longTermPlan: 'The reunion happens on day 20', allowLlmPlanUpdates: true }, h.state.settings, { messages: [] });
  assert.equal(editable.apiMessages[0].content,locked.apiMessages[0].content);
});

test('Context budget reserves message framing as short turns accumulate', async () => {
  const h = await harness();
  const { buildContextForRequest, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } = await h.use('context-builder.js');
  const base = await buildContextForRequest({ id: 's' }, h.state.settings, { messages: [] });
  assert.ok(base.usedTokens >= MESSAGE_FRAME_TOKENS + REQUEST_FRAME_TOKENS);
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), order: i + 1, role: 'user', content: 'x', tokenCount: 1 }));
  const budget = base.usedTokens + 100 + MESSAGE_FRAME_TOKENS * 5 + 100;
  const result = await buildContextForRequest({ id: 's' }, { ...h.state.settings, maxContextTokens: budget, maxResponseTokens: 100 }, { messages });
  assert.ok(result.windowedCount < messages.length);
  assert.ok(result.usedTokens + 100 <= budget);
});

test('Summarizer bounds each request to the configured context', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  const settings = { ...h.state.settings, narratorSystemPrompt:'Narrate.', modelId: 'test', streaming: false,
    maxContextTokens: 8000,maxResponseTokens:100,summarizerMaxTokens:1000,summarizerChunkTokens:500,
    keepRecentMessagesAfterSummary: 0 };
  const messages = Array.from({ length: 4 }, (_, i) => ({ id: String(i), order: i + 1,
    role: 'user', content: 'event '.repeat(65) }));
  await runSummarization({ id: 's' }, settings, { messages });
  assert.ok(h.calls.requests.length > 1);
  assert.ok(h.calls.requests.every((request) => request.max_tokens <= Math.floor(8000 / 3) &&
    request.messages.reduce((sum, message) => sum + message.content.length, 0) + request.max_tokens <= 8000));
});

test('Summarizer disables chat reasoning on every request', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  await runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 20000 },
    keepRecentMessagesAfterSummary: 0,
  }, { messages: [{ id: '1', order: 1, role: 'user', content: 'A new event' }] });
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

test('Author direction tags are normalized in model context', async () => {
  const h = await harness();
  const { buildContextForRequest } = await h.use('context-builder.js');
  const messages = [
    { id: 'm1', order: 1, role: 'user', content: '<ad>What happened between Nera and Elise?<ad>', tokenCount: 50 },
    { id: 'm2', order: 2, role: 'user', content: '<ad>Continue the scene</ad>', tokenCount: 30 },
  ];
  const result = await buildContextForRequest({ id: 'story' }, h.state.settings, { messages });
  assert.match(result.apiMessages[0].content, /out-of-character author instruction/);
  assert.match(result.apiMessages[1].content,/<ad>What happened between Nera and Elise\?<\/ad>$/);
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

test('Auto-summary threshold accounts for system instructions and reserved reply tokens', async () => {
  const h = await harness();
  const { shouldAutoSummarize } = await h.use('summarizer.js');
  const { buildContextForRequest } = await h.use('context-builder.js');
  const emptySettings = { ...h.state.settings,narratorSystemPrompt:'' };
  const overhead = (await buildContextForRequest({ id:'s' },emptySettings,{ messages:[] })).usedTokens;
  const result = await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings,narratorSystemPrompt:'',maxContextTokens:overhead+2800,
    maxResponseTokens:800, autoSummaryThresholdPercent: 90, autoSummarizationEnabled: true,
  }, [{ id: 'm', order: 1, role: 'user', content:'large message'.repeat(140),tokenCount:1 }]);
  assert.equal(result, true);
  assert.equal(await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings, autoSummarizationEnabled: false,
  }, [{ id: 'm', order: 1, role: 'user', content:'large message'.repeat(140),tokenCount:1 }]), false);
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
  assert.equal(h.calls.subscriptions.length,readsBeforeReturn+1);
  await open('story-c');
  await open('story-d');
  const readsBeforeEvictedReturn = h.calls.subscriptions.length;
  chat.setSession('story-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.subscriptions.length, readsBeforeEvictedReturn + 1);
});

test('Memory panel stages defaults, preserves edits across panels, saves story and memory in one write',async () => {
  const h = await harness(); h.state.sessionId='story-id'; const view=await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup(); await h.fire('nav-memory'); await Promise.resolve();
  assert.equal(h.el('mem-scene').checked,false); assert.equal(h.el('mem-autoUpdate').checked,false); assert.equal(Number(h.el('mem-characters-budget').value),4000);
  h.el('mem-scene').checked=true; h.el('mem-protagonist').value='Nera'; await h.fire('nav-story'); h.el('set-session-title').value='New title'; await h.fire('nav-memory');
  assert.equal(h.el('mem-scene').checked,true); assert.equal(h.el('set-session-title').value,'New title'); await h.fire('btn-save-session');
  assert.equal(h.calls.sessionWrites.length,1); const patch=h.calls.sessionWrites[0][1]; assert.equal(patch.title,'New title'); assert.equal(patch.memory.protagonist,'Nera'); assert.equal(patch.memory.scene,true); assert.equal(patch.memory.autoUpdate,false);
  assert.equal(h.calls.writes.length,0);
});
test('Memory panel-only save does not rewrite title or plan and invalid values stay dirty',async () => {
  const h=await harness(); h.state.sessionId='story-id'; const view=await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup(); await h.fire('nav-memory'); await Promise.resolve();
  h.el('mem-lorebooks').checked=true; await h.fire('btn-save-session'); assert.deepEqual(Object.keys(h.calls.sessionWrites[0][1]),['memory']);
  h.el('mem-batchTurns').value='not a number'; h.calls.confirm=false; await h.fire('btn-close-settings'); assert.equal(h.el('settings-tab').classList.contains('hidden'),false); await h.fire('btn-save-session'); assert.match(h.el('settings-saved-msg').textContent,/whole number/); assert.equal(h.calls.sessionWrites.length,1);
});
test('legacy stories attach no lore listener and memory stories attach exactly one',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  const callback=h.calls.sessionCallbacks.at(-1); callback({ id:'story',exists:() => true,data:() => ({ title:'Story' }) }); assert.equal(h.calls.loreSubscriptions ?? 0,0);
  callback({ id:'story',exists:() => true,data:() => ({ title:'Story',memory:{ autoUpdate:true } }) }); assert.equal(h.calls.loreSubscriptions,1);
  callback({ id:'story',exists:() => true,data:() => ({ title:'Story',memory:{ autoUpdate:true },memoryState:{ failureStreak:1 } }) }); assert.equal(h.calls.loreSubscriptions,1);
});
test('chat turn ledger gives a due or running update priority over auto-summary, while legacy still summarizes',async () => {
  for (const mode of ['due','running','legacy']) {
    const h=await harness(), chat=await h.use('ui/chat-view.js');
    Object.assign(h.state.settings,{ narratorSystemPrompt:'Narrate.',modelId:'model',apiKey:'test-key',streaming:false,maxContextTokens:10000,maxResponseTokens:1000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:0 });
    h.calls.memoryDue=mode === 'due'; h.calls.memoryRunning=mode === 'running'; h.calls.messageOrder=4; h.calls.response='A complete reply.';
    chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
    h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',...(mode !== 'legacy' ? { memory:{ autoUpdate:true },memoryState:{ extractedThroughOrder:0 } } : {}) }) });
    h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u1',order:1,role:'user',content:'Opening',tokenCount:7 },{ id:'a1',order:2,role:'assistant',content:'Story',tokenCount:5 },{ id:'u2',order:3,role:'user',content:'Next',tokenCount:4 },{ id:'a2',order:4,role:'assistant',content:'Story2',tokenCount:6 }],hasEarlier:false });
    await Promise.resolve(); h.el('chat-input').value='Continue'; await h.el('composer').dispatchEvent({ type:'submit',preventDefault() {} });
    assert.equal(h.calls.requests.length,mode === 'legacy' ? 2 : 1,mode); assert.equal(h.calls.memoryStarts ?? 0,mode === 'due' ? 1 : 0); assert.equal(h.state.busy,false);
  }
});

test('Memory panel reloads for another story and prompt defaults hydrate and reset globally',async () => {
  const h=await harness(); h.calls.sessionDocs={ one:{ title:'One',memory:{ protagonist:'Nera',scene:true } },two:{ title:'Two',memory:{ protagonist:'Mira',scene:false } } }; h.state.sessionId='one'; const view=await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup(null,{ panel:'memory' }); await new Promise(resolve => setTimeout(resolve,0)); assert.equal(h.el('mem-protagonist').value,'Nera');
  h.state.sessionId='two'; await h.document.dispatchEvent({ type:'session-changed',detail:{ sessionId:'two',session:h.calls.sessionDocs.two } }); assert.equal(h.el('mem-protagonist').value,'Mira'); assert.equal(h.el('mem-scene').checked,false);
  await h.fire('nav-prompts'); h.el('set-memory-update-prompt').value='custom'; await h.fire('btn-reset-settings'); assert.match(h.el('set-memory-update-prompt').value,/one note per line/); assert.match(h.el('set-memory-reorganize-prompt').value,/author's own text/);
});
test('lorebook editor stages canon text and saves only on Save; closing dirty editor asks to discard',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'), { makeEntry }=await h.use('lore-lines.js'), lore=await h.use('ui/lorebook-view.js');
  const card=makeEntry('characters','Mira'); card.sections.appearance.text='Red hair'; h.calls.loreEntries=[card];
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0)); h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story' }) }); h.calls.latestCallbacks.at(-1)({ messages:[],hasEarlier:false }); lore.initLorebookView(); lore.openLorebooks(); await new Promise(resolve => setTimeout(resolve,0)); lore.openLorebooks({ entryId:card.id });
  const root=h.el('lorebook-overlay'); const sections=root.querySelectorAll('.lore-section'); const appearance=sections[1].querySelector('textarea'); assert.equal(appearance.value,'Red hair'); appearance.value='Silver hair'; await appearance.dispatchEvent({ type:'input' }); assert.equal(h.calls.cardWrites,undefined);
  h.calls.confirm=false; await root.querySelector('.settings-close').click(); assert.equal(root.classList.contains('hidden'),false);
  const save=root.querySelectorAll('button').find(b => b.textContent === 'Save'); await save.click(); assert.equal(h.calls.cardWrites[0][1].sections.appearance.text,'Silver hair'); assert.equal(h.calls.cardWrites[0][2].sections.appearance.text,'Red hair');
});
test('context viewer includes composer draft and Copy request is the exact computed API text',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'), viewer=await h.use('ui/context-viewer.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0)); h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story' }) }); h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },{ id:'a',order:2,role:'assistant',content:'Opening' }],hasEarlier:false });
  h.el('chat-input').value='Ask Mira'; viewer.initContextViewer(); viewer.openContextViewer(); await new Promise(resolve => setTimeout(resolve,0)); const root=h.el('context-viewer'); assert.ok(root.querySelectorAll('p').some(p => p.textContent === 'including your draft'));
  await root.querySelectorAll('button').find(b => b.textContent === 'Copy request as text').click(); assert.match(h.calls.clipboard,/=== USER ===\nAsk Mira$/); assert.equal(h.calls.requests.length,0); assert.equal(h.calls.loreSubscriptions ?? 0,0);
});

test('candidate summary must fit the full narrative request before its checkpoint activates',async () => {
  const h = await harness(), { runSummarization } = await h.use('summarizer.js');
  h.calls.response = 'oversized '.repeat(1000);
  const history = Array.from({ length:8 },(_,i) => ({ id:'m'+i,order:i+1,role:i%2 ? 'assistant' : 'user',content:'Event '+i }));
  await assert.rejects(runSummarization({ id:'s' },{ ...h.state.settings,modelId:'test',streaming:false,maxContextTokens:5000,maxResponseTokens:100,keepRecentMessagesAfterSummary:2 },{ messages:history }),/exceed/);
  assert.equal(h.calls.messages.length,0);
});
test('multi-call summary rejects source changes and never advances its checkpoint',async () => {
  const h = await harness(), { runSummarization } = await h.use('summarizer.js');
  const history = Array.from({ length:6 },(_,i) => ({ id:'m'+i,order:i+1,role:i%2 ? 'assistant' : 'user',content:'Event '.repeat(50) }));
  let checked = 0;
  await assert.rejects(runSummarization({ id:'s',historyRevision:3 },{ ...h.state.settings,narratorSystemPrompt:'Narrate.',modelId:'test',streaming:false,maxContextTokens:9000,maxResponseTokens:100,keepRecentMessagesAfterSummary:0,summarizerChunkTokens:400 },{ messages:history,validateSource:async expected => { assert.equal(expected.historyRevision,3); if (++checked === 2) throw new Error('Source changed'); } }),/Source changed/);
  assert.equal(h.calls.requests.length,2); assert.equal(h.calls.messages.length,0);
  assert.ok(h.calls.requests.every(r => !r.messages.some(m => /1000-2000 words|DETAILED/.test(m.content))));
});

test('model plan output cannot change fixed author instructions and pure OOC preserves established scene',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js');
  Object.assign(h.state.settings,{ modelId:'model',apiKey:'test-key',streaming:false }); h.calls.messageOrder = 2;
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',longTermPlan:'Elise survives',allowLlmPlanUpdates:true,memory:{ scene:true,memoryBlock:true } }) });
  h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },{ id:'a',order:2,role:'assistant',content:'At the inn',scene:'Day 2 · night · Inn · present: Elise',narratorTurn:1 }],hasEarlier:false });
  h.calls.response = 'Liora believes Elise died.\n<plan>Elise dies</plan>\n<plan_thread>Preserve the mystery</plan_thread>\n<scene>Day 9 · noon · Palace · present: Liora</scene>';
  h.el('chat-input').value = '<ad>What does Liora believe?<ad>';
  await h.el('composer').dispatchEvent({ type:'submit',preventDefault() {} });
  const saved = h.calls.messages.find(c => c[1].role === 'assistant')[1];
  assert.equal(saved.ooc,true); assert.equal(saved.scene,null); assert.equal(saved.content,'Liora believes Elise died.');
  assert.equal(h.calls.sessionWrites.some(c => c[1].longTermPlan),false);
  const live = chat.memorySnapshot(); assert.equal(live.session.longTermPlan,'Elise survives');
  const { latestScene } = await h.use('scene.js'); assert.equal(latestScene(live.messages).scene.place,'Inn'); assert.equal(latestScene(live.messages).missingStreak,0);
  assert.match(h.calls.requests[0].messages[0].content,/Elise survives/);
});

test('cached history reconciles outside recent subscription and unchanged revisions avoid history downloads',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  const all = Array.from({ length:20 },(_,i) => ({ id:'m'+i,order:i+1,role:i%2 ? 'assistant' : 'user',content:'old '+i,revision:0,narratorTurn:Math.floor(i/2)+1 }));
  h.calls.serverHistory = all;
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',historyRevision:1 }) });
  h.calls.latestCallbacks.at(-1)({ messages:all.slice(-4),hasEarlier:true }); await new Promise(resolve => setTimeout(resolve,0));
  const first = await chat.prepareMemorySnapshot(); assert.equal(first.messages[0].content,'old 0');
  const reads = h.calls.historyReads; await chat.prepareMemorySnapshot(); assert.equal(h.calls.historyReads,reads);
  h.calls.sessionDocs.story.historyRevision = 2; h.calls.serverHistory = all.map(m => m.id === 'm0' ? { ...m,content:'Edited on another device',revision:1 } : m);
  const refreshed = await chat.prepareMemorySnapshot(); assert.equal(refreshed.messages[0].content,'Edited on another device'); assert.equal(h.calls.historyReads,reads+1);
});
test('request settings, author inputs and history changing during generation do not discard completed narration',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js'); Object.assign(h.state.settings,{ modelId:'model',apiKey:'test-key',streaming:false }); h.calls.messageOrder = 2;
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',longTermPlan:'Original plan' }) });
  h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },{ id:'a',order:2,role:'assistant',content:'Scene' }],hasEarlier:false });
  h.calls.response = 'Narration based on original plan.'; h.calls.onRequest = async () => {
    Object.assign(h.state.settings,{ modelId:'next-model',temperature:0.7 });
    Object.assign(h.calls.sessionDocs.story,{ longTermPlan:'New author plan',memory:{ scene:true },loreRevision:2,historyRevision:5 });
    h.calls.historyRevision = 5;
  };
  h.el('chat-input').value = 'Continue'; await h.el('composer').dispatchEvent({ type:'submit',preventDefault() {} });
  const replies = h.calls.messages.filter(c => c[1].role === 'assistant');
  assert.equal(h.calls.requests.length,1); assert.equal(replies.length,1);
  assert.equal(replies[0][1].content,'Narration based on original plan.');
  assert.equal(replies[0][2]?.expectedSource,undefined);
  assert.equal(chat.memorySnapshot().session.longTermPlan,'New author plan');
  assert.equal(h.state.busy,false);
});

test('a revision arriving during history loading retries automatically and shares the refreshed result',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  const initial = [{ id:'u',order:1,role:'user',content:'Opening',revision:0 },{ id:'a',order:2,role:'assistant',content:'Old',revision:0 }];
  let release, started;
  const ready = new Promise(resolve => started = resolve);
  h.calls.serverHistory = initial;
  h.calls.onHistoryRead = async read => { if (read === 1) { started(); await new Promise(resolve => release = resolve); } };
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',historyRevision:1,memory:{ scene:true } }) });
  h.calls.latestCallbacks.at(-1)({ messages:initial,hasEarlier:false });
  await ready;
  h.calls.serverHistory = [initial[0],{ ...initial[1],content:'Fresh',revision:1 }];
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',historyRevision:2,memory:{ scene:true } }) });
  const requests = [chat.prepareMemorySnapshot(),chat.prepareMemorySnapshot()];
  release();
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.messages[1].content === 'Fresh'));
  assert.equal(h.calls.historyReads,2);
  const reads = h.calls.historyReads; await chat.prepareMemorySnapshot(); assert.equal(h.calls.historyReads,reads);
});

test('cached, pending and delayed lower-revision metadata do not roll back server-reconciled history',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  const messages = [{ id:'u',order:1,role:'user',content:'Server version',revision:2 }]; h.calls.serverHistory = messages;
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',historyRevision:3 }) });
  h.calls.latestCallbacks.at(-1)({ messages,hasEarlier:false }); await chat.prepareMemorySnapshot();
  const reads = h.calls.historyReads;
  for (const metadata of [{ fromCache:true },{ hasPendingWrites:true },{}]) {
    h.calls.sessionCallbacks.at(-1)({ id:'story',metadata,exists:() => true,data:() => ({ title:'Stale',historyRevision:1 }) });
    assert.equal(chat.memorySnapshot().session.historyRevision,3);
    assert.equal(chat.memorySnapshot().messages[0].content,'Server version');
  }
  chat.syncActiveSession({ id:'story',historyRevision:1,title:'Delayed sidebar' });
  assert.equal(chat.memorySnapshot().session.title,'Story'); assert.equal(h.calls.historyReads,reads);
});

test('an old session load cannot clear the new session shared history job',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js'); chat.initChatView();
  const releases = new Map(), starts = new Map();
  const readyA = new Promise(resolve => starts.set(1,resolve)), readyB = new Promise(resolve => starts.set(2,resolve));
  h.calls.onHistoryRead = async read => { starts.get(read)?.(); if (read <= 2) await new Promise(resolve => releases.set(read,resolve)); };
  const open = async id => {
    chat.setSession(id); await new Promise(resolve => setTimeout(resolve,0));
    h.calls.serverHistory = [{ id:id+'-u',order:1,role:'user',content:id }];
    h.calls.sessionCallbacks.at(-1)({ id,exists:() => true,data:() => ({ title:id,historyRevision:1,memory:{ scene:true } }) });
    h.calls.latestCallbacks.at(-1)({ messages:h.calls.serverHistory,hasEarlier:false });
  };
  await open('a'); await readyA;
  await open('b'); await readyB;
  releases.get(1)(); await new Promise(resolve => setTimeout(resolve,0));
  const snapshot = chat.prepareMemorySnapshot(); await new Promise(resolve => setTimeout(resolve,0));
  assert.equal(h.calls.historyReads,2,'new callers must join the still-running B read');
  releases.get(2)(); const result = await snapshot; assert.equal(result.session.id,'b'); assert.equal(result.messages[0].content,'b');
});
