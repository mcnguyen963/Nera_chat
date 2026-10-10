import { promptFetch, promptImportMeta } from './prompt-files.mjs';
// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness({ legacyNarratorHashes = null, chatCache = null, timers = null, globals = {}, sources = {} } = {}) {
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
    getBoundingClientRect() { return { top:0,height:40,width:320,bottom:40 }; }
    get nextSibling() { const a=this.parentNode?.children ?? []; return a[a.indexOf(this)+1] ?? null; }
    scrollTop = 0; scrollHeight = 500; clientHeight = 500;
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
      const mins = { 'set-rewrite-n': 0, 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-chunk': 2000, 'mem-batchTurns': 2, 'mem-lagTurns': 0, 'mem-updateMaxTokens': 256, 'mem-reorganizeMaxTokens': 256, 'mem-blockDepth': 1, 'mem-characters-budget': 0, 'mem-locations-budget': 0, 'mem-facts-budget': 0, 'mem-events-budget': 0, 'mem-characters-maxCards': 1, 'mem-locations-maxCards': 1 };
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
  const calls = { reads: 0, writes: [], messages: [], requests: [], queries: [], subscriptions: [], sessionCallbacks: [], settingsCallbacks: [], latestCallbacks: [], sessionWrites: [], imports: [], exports: [], settingsDoc: null, fail: false, prompt:'Story',confirm: true, response: 'summary', responseData: null, streamLines: null };
  const localCache = new Map();
  const context = vm.createContext({
    URL, console, structuredClone, document, TextDecoder, TextEncoder, AbortController, ...globals,
    navigator: { clipboard: { writeText: async text => { calls.clipboard=text; } }, ...globals.navigator },
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
    localStorage: { getItem: (key) => {if(calls.storageBlocked)throw Error('Storage blocked');return localCache.get(key) ?? null;}, setItem: (key, value) => {if(calls.storageBlocked)throw Error('Storage blocked');return localCache.set(key, value);},removeItem:key=>localCache.delete(key) },
    window: { addEventListener() {} }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    prompt:()=>calls.prompt,
    setTimeout: timers?.setTimeout ?? (() => {}), clearTimeout: timers?.clearTimeout ?? (() => {}), confirm: message => { (calls.confirmations ??= []).push(message);return calls.confirmResponses?.length ? calls.confirmResponses.shift() : calls.confirm; },
    fetch: async (_url, options) => {
      if (_url instanceof URL && _url.protocol === 'file:') {
        if (legacyNarratorHashes && _url.pathname.endsWith('/legacy-prompt-default-hashes.md')) return { ok:true, text:async () => legacyNarratorHashes.split(/\s+/).filter(Boolean).map(hash=>`narratorSystemPrompt ${hash}`).join("\n") };
        return promptFetch(_url, options);
      }
      calls.requests.push(JSON.parse(options.body));
      await calls.onRequest?.(JSON.parse(options.body));
      if(calls.streamReader)return {ok:true,body:{getReader:()=>calls.streamReader}};
      if (calls.streamLines) {
        const chunks = calls.streamLines.map((line) => new TextEncoder().encode(line));
        return { ok: true, body: { getReader: () => ({ read: async () => chunks.length
          ? { done: false, value: chunks.shift() } : { done: true } }) } };
      }
      return { ok: true, json: async () => calls.responseData ?? ({ choices: [{ message: { content: calls.response } }] }) };
    },
  });
  const firestore = {
    increment:n=>({increment:n}),serverTimestamp:()=>0,runTransaction:async(_db,run)=>run({get:async()=>({exists:()=>true,data:()=>calls.sessionDocs?.[state.sessionId] ?? {}}),update:(_ref,patch)=>calls.sessionWrites.push([state.sessionId,patch])}),
    doc: (...args) => args, collection() {},
    query: (...args) => { calls.queries.push(args); return args; },
    orderBy() {}, limitToLast: (count) => ({ limitToLast: count }), onSnapshot: (ref, callback, onError) => {if(ref?.[3]!=='settings')(calls.sessionErrors ??= []).push(onError); (ref?.[3] === 'settings' ? calls.settingsCallbacks : calls.sessionCallbacks).push(snap => { if (ref?.[3] !== 'settings' && snap.exists()) { calls.sessionDocs ??= {}; calls.sessionDocs[snap.id] = { id:snap.id,...snap.data(),historyRevision:calls.historyRevision ?? snap.data().historyRevision ?? 0 }; } return callback(snap); }); return () => {}; },
    getDoc: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    getDocFromServer: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    setDoc: async (_ref, settings) => {
      if (calls.fail) throw new Error('write denied');
      calls.writes.push(structuredClone(settings));
    },
  };
  const stubs = {
    'story-settings-store.js': {
      preserveLegacyStorySeed:async()=>({}),
      selectStorySettings:async sid=>{state.storySettingsId=sid;state.storySettings=sid ? {version:1,revision:1,values:Object.fromEntries(['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt','rewriteSystemPrompt','rewriteRecentMessages'].map(k=>[k,state.settings[k]]))} : null;},
      effectiveActiveSettings:()=>structuredClone({...state.settings,...(state.storySettings?.values ?? {})}),
      saveStorySettings:async(sid,base,changes)=>{if(sid!==state.sessionId)throw Error('Story changed');const result={values:{...base,...changes}};state.storySettings=result;return result;},
      ensureStorySettings:async()=>({version:1,revision:1,values:{}}),writeInitialStorySettings:async()=>{},
    },
    // The real pet controller is exercised independently in pets.mjs.
    'lore-store.js': {
      getLore:async () => calls.loreEntries ?? [],configureLoreWrites() {}, loreWritesPending: () => false, waitForLoreWrites: async () => {},
      subscribeLore: (_sid,cb) => { calls.loreSubscriptions ??= 0; calls.loreSubscriptions++; (calls.loreCallbacks ??= []).push(cb); Promise.resolve().then(() => cb(calls.loreEntries ?? [])); return () => {}; },
      createEntry: async (_sid,e) => { (calls.loreEntries ??= []).push(e); for (const cb of calls.loreCallbacks ?? []) cb(calls.loreEntries); return e.id; },
      saveEntry: async (...args) => { (calls.cardWrites ??= []).push(args); }, deleteEntry: async () => 'backup', mergeEntries: async () => 'backup', writeBackup: async () => 'backup', restoreBackup: async () => {}, listBackups:async()=>calls.onBackups?.() ?? [], removeDeletedLines: async () => 'backup', importLore: async () => 'backup', replaceLines: async () => 'backup',
    },
    'memory-updater.js': { dueRangeFor:()=>calls.memoryDue ? {} : null,lastRawAnswer: () => '', rebuildFrom:async()=>{}, configureMemoryUpdater() {}, isRunning: () => calls.memoryRunning === true, maybeStartAfterTurn: () => { if (calls.memoryDue) { calls.memoryStarts = (calls.memoryStarts ?? 0)+1; return true; } return false; }, stop:id=>{(calls.memoryStopped ??= []).push(id);}, stopAll() { calls.memoryStops=(calls.memoryStops ?? 0)+1; }, rebuild:async () => {}, updateNow: async () => {}, catchUp: async () => {calls.catchUps=(calls.catchUps ?? 0)+1;} },
    'ui/pet-view.js': {
      initPetView() {}, startPetTurn() {}, finishPetTurn:status=>{(calls.petFinishes ??= []).push(status);},
      refreshPetPlacement() {}, updatePetPhase() {}, invalidatePetLayout() {},
      loadPetCatalog: async () => [],
    },
    'db.js': { db: {} },
    'auth.js': { currentUid: () => 'test-user',currentUserInfo:()=>({uid:'test-user',email:'owner@example.test'}),logout:async()=>{calls.logouts=(calls.logouts ?? 0)+1;if(calls.failLogout)throw Error('Logout failed');} },
    'tokenizer.js': { countTokens: async (text) => text.length },
    'sessions.js': {
      subscribeSessions:cb=>{calls.sidebarCallback=cb;return ()=>{};},createSession:async()=>{calls.creates=(calls.creates ?? 0)+1;if(calls.onCreate)return calls.onCreate();if(calls.failCreate)throw Error('Create failed');return 'new-story';},renameSession:async()=>{calls.renames=(calls.renames ?? 0)+1;if(calls.failRename)throw Error('Rename failed');},deleteSession:async()=>{if(calls.failDelete)throw Error('Delete failed');},
      getSessionFromServer:async id => {calls.sessionReads=(calls.sessionReads ?? 0)+1;return calls.sessionDocs?.[id] ?? ({ id,title:'Story',longTermPlan:'Old plan',historyRevision:calls.historyRevision ?? 0 });},
      getSession: async id => calls.sessionDocs?.[id] ?? ({ title: 'Story', longTermPlan: 'Old plan' }),
      updateSession: async (...args) => { calls.sessionWrites.push(args); },
      duplicateSession: async (...args) => { calls.sessionCopies ??= []; calls.sessionCopies.push(args); return 'copied-session'; },
    },
    'import-export.js': {exportAllStories:async()=>{}, importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); } },
    'messages.js': {
      HistoryConflict:class HistoryConflict extends Error {},
      findSavedMessage:async(...args)=>{(calls.saveLookups ??= []).push(args);return calls.findSavedMessage?.(...args) ?? null;},
      ensureContinuityMetadata:async () => {},
      getMessages:async () => { const read = calls.historyReads = (calls.historyReads ?? 0)+1; const result = structuredClone(calls.serverHistory ?? calls.history ?? []); await calls.onHistoryRead?.(read); return result; }, getCheckpointMessages: async () => [], newMessageId: () => 'summary-id',
      addMessage:async (...args) => { if (calls.addMessage) return calls.addMessage(...args); if(args[1].role==='assistant' && args[2]?.expectedSource?.historyRevision !== undefined && args[2].expectedSource.historyRevision !== (calls.historyRevision ?? 0)) throw Object.assign(new Error('History changed'),{name:'HistoryConflict'}); calls.messages.push(args); const result = { ...args[1],id:args[1].role==='summary' && args[2]?.id ? args[2].id : calls.messageOrder ? 'message-'+(++calls.messageOrder) : 'summary-id',order:calls.messageOrder ?? 1,tokenCount:args[1]?.content?.length ?? 0,historyRevision:(calls.historyRevision ?? 0)+1 }; calls.historyRevision = result.historyRevision; if (calls.sessionDocs?.[args[0]]) Object.assign(calls.sessionDocs[args[0]],args[2]?.sessionUpdate ?? {},{historyRevision:result.historyRevision}); calls.history = [...(calls.history ?? []),result]; result.session={id:args[0],...(calls.sessionDocs?.[args[0]] ?? {}),historyRevision:result.historyRevision};return result; },
      overwriteMessage:async (...args) => {
        if(calls.overwriteMessage)return calls.overwriteMessage(...args);
        const [sid,id,message,_order,partial={},expectedSource]=args;
        if(expectedSource?.historyRevision !== undefined && expectedSource.historyRevision !== (calls.historyRevision ?? 0))throw Object.assign(new Error('History changed'),{name:'HistoryConflict'});
        (calls.overwrites ??= []).push(args);const old=(calls.history ?? []).find(m=>m.id===id);if(!old)throw new Error('Reply missing');
        const revision=(calls.historyRevision ?? 0)+1,replacement={...old,...message,historyRevision:revision};calls.historyRevision=revision;calls.history=calls.history.map(m=>m.id===id ? replacement : m);
        const session={id:sid,...calls.sessionDocs[sid],...partial,historyRevision:revision};calls.sessionDocs[sid]=session;return {replacement,session,historyRevision:revision};
      },
      deleteMessage:async (...args)=>{
        if(calls.deleteMessage)return calls.deleteMessage(...args);
        const [sid,id]=args;(calls.deletes ??= []).push(args);calls.history=(calls.history ?? []).filter(m=>m.id!==id);
        const revision=(calls.historyRevision ?? 0)+1;calls.historyRevision=revision;calls.sessionDocs[sid]={...calls.sessionDocs[sid],historyRevision:revision};
        return {session:calls.sessionDocs[sid],historyRevision:revision,replacement:null};
      },
      updateMessageScene:async(...args)=>calls.updateScene?.(...args),
      subscribeLatestMessages: (sessionId, callback, onError) => {(calls.latestErrors ??= []).push(onError); calls.subscriptions.push(sessionId); calls.latestCallbacks.push(value => { calls.history = value.messages; callback(value); }); return () => {}; },
    },
  };
  if (chatCache) stubs['chat-cache.js'] = chatCache;
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
      module = new vm.SourceTextModule(sources[path] ?? await readFile(new URL('../js/' + path, import.meta.url), 'utf8'), {
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
  state.settingsSource = "server";
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
  assert.match(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /interactive roleplay/);
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
  assert.deepEqual(structuredClone(h.calls.sessionWrites[0]), ['story-id', { title: 'New title', longTermPlan: 'New plan' }]);
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

test('Settings reload from Firestore, and quick model and thinking choices save to the shared account', async () => {
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
  assert.equal(h.calls.writes.length, 2);
  assert.equal(JSON.parse(h.localCache.get('roleplay-settings:test-user')).activeProfileId, 'second');
  h.calls.settingsDoc=h.calls.writes.at(-1);
  assert.equal((await h.settings.loadSettings()).modelId, 'model-b');
  assert.equal(h.calls.reads, 2);
  await h.settings.saveSettings({ ...h.state.settings, activeProfileId: 'second', modelId: 'model-b' });
  assert.equal(h.calls.writes.length, 3);
  h.calls.settingsDoc = h.calls.writes.at(-1);
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
    const messages = Array.from({ length:8 },(_,i) => ({ id:String(i),order:i+1,role:i%2 ? 'assistant' : 'user',content:'event' }));
    const result = await runSummarization({ id: 'session' }, {
      ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: keep,
    }, { messages });
    assert.equal(result.foldedCount, keep === 0 ? 6 : keep === 1 ? 4 : 2);
    assert.equal(result.newBreakpointOrder,result.foldedCount+2);
  });
}

test('Empty summarizer output does not advance checkpoint', async () => {
  const h = await harness();
  h.calls.response = '';
  const { runSummarization } = await h.use('summarizer.js');
  await assert.rejects(runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false, keepRecentMessagesAfterSummary: 0,
  }, { messages: Array.from({length:4},(_,i)=>({id:String(i),order:i+1,role:i%2?'assistant':'user',content:'event'})) }), /no reply/);
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
  assert.match(result.apiMessages.find(m=>m.content.includes('Earlier story')).content,/Story so far:\nEarlier story/);
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
  assert.deepEqual(Array.from(result.apiMessages.slice(1),(m) => m.content.replace(/^\[Opening exchange:[^\n]*\]\n/,'')), ['Opening', 'Background', '[Earlier turns omitted.]', 'Small recent', 'Latest']);
  assert.equal(result.droppedCount, 1);
  assert.ok(result.usedTokens <= settings.maxContextTokens);
  await assert.rejects(buildContextForRequest({ id: 's' }, settings, {
    messages: messages.map((m) => m.id === 'u3' ? { ...m,content:'Latest'.repeat(500),tokenCount:1 } : m), requireLatestUser: true,
  }), /opening story.*latest user message exceed/);
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
  assert.match(current.apiMessages[3].content,/Story so far/);
  assert.deepEqual(Array.from(current.apiMessages.slice(1).filter(m=>m.role!=='system'),m => m.content.replace(/^\[Opening exchange:[^\n]*\]\n/,'')),['The kingdom begins here','The first scene','Current turn']);
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
  assert.match(locked.apiMessages[0].content, /set by the user/);
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
  const budget = base.usedTokens + MESSAGE_FRAME_TOKENS * 5 + 100;
  const result = await buildContextForRequest({ id: 's' }, { ...h.state.settings, maxContextTokens: budget, maxResponseTokens: 100 }, { messages });
  assert.ok(result.windowedCount < messages.length);
  assert.ok(result.usedTokens <= budget);
});

test('Summarizer respects input and output budgets without a one-third context cap', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  const settings = { ...h.state.settings, narratorSystemPrompt:'Narrate.', summarizerSystemPrompt:'Summarize the established events.', modelId: 'test', streaming: false,
    maxContextTokens: 8000,maxResponseTokens:100,summarizerMaxTokens:4000,summarizerChunkTokens:900,
    keepRecentMessagesAfterSummary: 0 };
  const messages = Array.from({ length: 8 }, (_, i) => ({ id: String(i), order: i + 1,
    role: i%2 ? 'assistant' : 'user', content: 'event '.repeat(65) }));
  await runSummarization({ id: 's' }, settings, { messages });
  assert.ok(h.calls.requests.length > 1);
  for (const request of h.calls.requests) {
    assert.ok(request.max_tokens > Math.floor(settings.maxContextTokens / 3));
    assert.ok(request.max_tokens <= settings.summarizerMaxTokens);
    assert.ok(request.messages.reduce((sum, message) => sum + message.content.length, 0) <= 8000);
  }
});

test('Summarizer preserves configured output limits above the default', async () => {
  const h = await harness();
  const settingsApi = await h.use('settings.js');
  assert.equal(settingsApi.DEFAULT_SETTINGS.summarizerMaxTokens, 20000);
  assert.equal((await settingsApi.mergeDefaults({ summarizerMaxTokens: 100000 })).summarizerMaxTokens, 100000);
  assert.equal((await settingsApi.mergeDefaults({ summarizerMaxTokens: 5000 })).summarizerMaxTokens, 5000);
  const { runSummarization } = await h.use('summarizer.js');
  await runSummarization({ id: 's' }, {
    ...h.state.settings, narratorSystemPrompt:'Narrate.', modelId:'test', streaming:false,
    maxContextTokens:120000, summarizerMaxTokens:100000, keepRecentMessagesAfterSummary:0,
  }, { messages:Array.from({ length:6 }, (_, i) => ({ id:String(i),order:i+1,
    role:i%2 ? 'assistant' : 'user',content:'Established story event.' })) });
  assert.ok(h.calls.requests.length > 0);
  assert.ok(h.calls.requests.every(request => request.max_tokens === 100000));
});

test('Summarizer disables chat reasoning on every request', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  await runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 20000 },
    keepRecentMessagesAfterSummary: 0,
  }, { messages: Array.from({length:4},(_,i)=>({id:String(i),order:i+1,role:i%2?'assistant':'user',content:'A new event'})) });
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
  assert.doesNotMatch(result.apiMessages.at(-1).content, /<plan_thread>/);
  const sceneRequest=await buildContextForRequest({id:'story',longTermPlan:'Fixed plan',memory:{scene:true}},h.state.settings,{messages:[{id:'a',order:1,role:'assistant',content:'The door opens.',planThread:'steering toward the reunion'}]});
  assert.match(sceneRequest.apiMessages.at(-1).content, /<plan_thread>steering toward the reunion<\/plan_thread>/);
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

test('Auto-summary threshold counts input independently of reply capacity', async () => {
  const h = await harness();
  const { shouldAutoSummarize } = await h.use('summarizer.js');
  const { buildContextForRequest } = await h.use('context-builder.js');
  const emptySettings = { ...h.state.settings,narratorSystemPrompt:'' };
  const overhead = (await buildContextForRequest({ id:'s' },emptySettings,{ messages:[] })).usedTokens;
  const result = await shouldAutoSummarize({ id: 's' }, {
    ...h.state.settings,narratorSystemPrompt:'',maxContextTokens:overhead+2800,
    maxResponseTokens:800, autoSummaryThresholdPercent: 90, autoSummarizationEnabled: true,
  }, [{ id: 'm', order: 1, role: 'user', content:'large message'.repeat(140),tokenCount:1 }]);
  assert.equal(result, false);
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
  assert.equal(h.calls.sessionWrites.length,1); const patch=h.calls.sessionWrites[0][1]; assert.equal(patch.title,'New title'); assert.equal(patch['memory.protagonist'],'Nera'); assert.equal(patch['memory.scene'],true); assert.equal(patch['memory.autoUpdate'],undefined);
  assert.equal(h.calls.writes.length,0);
});
test('Memory panel-only save does not rewrite title or plan and invalid values stay dirty',async () => {
  const h=await harness(); h.state.sessionId='story-id'; const view=await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup(); await h.fire('nav-memory'); await Promise.resolve();
  h.el('mem-lorebooks').checked=true; await h.fire('btn-save-session'); assert.deepEqual(Object.keys(h.calls.sessionWrites[0][1]),['memory.lorebooks']);
  h.el('mem-batchTurns').value='not a number'; h.calls.confirm=false; await h.fire('btn-close-settings'); assert.equal(h.el('settings-tab').classList.contains('hidden'),false); await h.fire('btn-save-session'); assert.match(h.el('settings-saved-msg').textContent,/whole number/); assert.equal(h.calls.sessionWrites.length,1);
});
test('Memory model selector shares saved profiles and saves per story without switching the narrator',async()=>{
  const h=await harness();h.state.sessionId='story-id';h.state.settings.profiles.push({id:'scribe',name:'Memory scribe',modelId:'z-ai/glm-5.3-flash:floor'});
  const active=h.state.settings.activeProfileId,view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup(null,{panel:'memory'});await Promise.resolve();
  const select=h.el('mem-updateProfileId');assert.deepEqual(select.children.map(o=>o.value),['',...h.state.settings.profiles.map(p=>p.id)]);
  assert.match(select.children.at(-1).textContent,/Memory scribe.*:floor/);select.value='scribe';
  await h.fire('nav-story');await h.fire('nav-memory');assert.equal(select.value,'scribe');
  await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.length,1);assert.equal(h.calls.sessionWrites[0][1]['memory.updateProfileId'],'scribe');
  assert.equal(h.state.settings.activeProfileId,active);assert.equal(h.calls.writes.length,0);
  const panel=await h.use('ui/memory-settings-view.js');panel.fillMemory({updateProfileId:'scribe'});assert.equal(select.value,'scribe');assert.equal(panel.memoryDirty({updateProfileId:'scribe'}),false);
  h.state.settings.profiles.find(p=>p.id==='scribe').name='Renamed';await h.document.dispatchEvent({type:'settings-changed'});
  assert.equal(select.value,'scribe');assert.match(select.children.at(-1).textContent,/Renamed/);
  h.state.settings.profiles=h.state.settings.profiles.filter(p=>p.id!=='scribe');await h.document.dispatchEvent({type:'settings-changed'});
  assert.equal(select.value,'scribe');assert.equal(select.children.at(-1).disabled,true);assert.match(select.children.at(-1).textContent,/Unavailable/);
  select.value='';assert.equal(panel.memoryDirty({updateProfileId:'scribe'}),true);assert.equal(panel.readMemory().updateProfileId,'');
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
    assert.equal(h.calls.requests.length,mode === 'due' ? 1 : 2,mode); assert.equal(h.calls.memoryStarts ?? 0,mode === 'due' ? 1 : 0); assert.equal(h.state.busy,false);
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
  await assert.rejects(runSummarization({ id:'s',historyRevision:3 },{ ...h.state.settings,narratorSystemPrompt:'Narrate.',modelId:'test',streaming:false,maxContextTokens:20000,maxResponseTokens:100,keepRecentMessagesAfterSummary:0,summarizerChunkTokens:650 },{ messages:history,validateSource:async expected => { assert.equal(expected.historyRevision,3); if (++checked === 2) throw new Error('Source changed'); } }),/Source changed/);
  assert.equal(h.calls.requests.length,2); assert.equal(h.calls.messages.length,0);
  assert.ok(h.calls.requests.every(r => !r.messages.some(m => /1000-2000 words|DETAILED/.test(m.content))));
});

test('narrative AD replies save valid scene state; invalid metadata warns while preserving narration and the prior snapshot',async () => {
  const raw='date: Day 2 · time: night · place: Inn · present: Nera, Mira';
  for (const valid of [true,false]) {
    const h=await harness(),chat=await h.use('ui/chat-view.js');
    Object.assign(h.state.settings,{ modelId:'model',apiKey:'test-key',streaming:false }); h.calls.messageOrder=2;
    chat.initChatView();chat.setSession('story');await new Promise(resolve => setTimeout(resolve,0));
    h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',memory:{ scene:true,memoryBlock:true } }) });
    h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },
      { id:'a',order:2,role:'assistant',content:'At the inn',scene:'Day 2 · night · Inn · present: Nera, Mira, Kael',narratorTurn:1 }],hasEarlier:false });
    h.calls.response='Kael leaves the inn.'+(valid ? '\n<scene>'+raw+'</scene>' : '\n<scene_state>Kael left.</scene_state>');
    h.el('chat-input').value='<ad>Continue the scene. Have Kael leave.</ad>';
    await h.el('composer').dispatchEvent({ type:'submit',preventDefault() {} });
    const saved=h.calls.messages.find(c => c[1].role==='assistant')[1];
    assert.equal(saved.ooc,false);assert.equal(saved.scene,valid ? raw : null);
    if (!valid) { assert.equal(saved.sceneMeta.kind,'carried');assert.equal(saved.sceneMeta.fromOrder,2); }
    assert.ok(saved.content.startsWith('Kael leaves the inn.'));
    assert.equal(h.calls.requests.length,1,'No automatic model retry or repair call');
    const current=(await h.use('scene.js')).latestScene(chat.memorySnapshot().messages);
    assert.equal(current.missingStreak,valid ? 0 : 1);
    assert.equal(current.scene.present.includes('Kael'),!valid);
    if (!valid) assert.ok(h.el('message-list').children.some(x => /No scene tag in this reply/.test(x.textContent ?? '')));
  }
});

test('scene recovery runs only on clean narrative failures, preserves narration on schema failure and uses the maintenance slot',async () => {
  const raw = 'date: Day 2 · time: night · place: Inn · present: Nera, Mira';
  for (const mode of ['recover','bad-json','flagged','valid','ooc','running']) {
    const h = await harness(),chat = await h.use('ui/chat-view.js');
    Object.assign(h.state.settings,{ modelId:'model',apiKey:'fixture',streaming:false });h.calls.messageOrder=2;
    h.calls.memoryRunning=mode==='running';h.calls.memoryDue=mode==='recover';
    h.calls.onRequest = () => { h.calls.response = h.calls.requests.length === 1
      ? mode==='flagged' ? 'You say, "Leave."' : 'Mira waits by the door.'+(mode==='valid' ? '\n<scene>'+raw+'</scene>' : '')
      : mode==='bad-json' ? '{"extra":true}' : JSON.stringify({ date:'Day 2',time:'night',place:'Inn',present:['Nera','Mira'],planThread:null }); };
    chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
    h.calls.sessionCallbacks.at(-1)({ id:'story',exists:()=>true,data:()=>({ title:'Story',memory:{ scene:true,sceneFallback:true,protagonist:'Nera' } }) });
    h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',role:'user',order:1,content:'Start.' },{ id:'a',role:'assistant',order:2,content:'At the inn.',scene:raw }],hasEarlier:false });
    h.el('chat-input').value=mode==='ooc' ? '<ooc>Who is here?</ooc>' : 'Continue.';
    await h.el('composer').dispatchEvent({ type:'submit',preventDefault(){} });
    const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];
    assert.equal(h.calls.requests.length,['recover','bad-json','flagged','running'].includes(mode) ? 2 : 1,mode);
    assert.ok(saved.content.startsWith(mode==='flagged' ? 'You say' : 'Mira waits'),mode);
    if(mode==='recover') { assert.equal(saved.sceneMeta.kind,'inferred');assert.equal(h.calls.memoryStarts ?? 0,0);assert.equal(h.calls.requests[1].response_format.json_schema.strict,true); }
    if(['bad-json'].includes(mode)) { assert.equal(saved.scene,null);assert.equal(saved.sceneMeta.kind,'carried'); }
    if(mode==='flagged') { assert.equal(saved.acceptance,'accepted'); assert.ok(saved.reviewWarnings.length); assert.equal(saved.sceneMeta.kind,'inferred'); }
    if(mode==='valid') assert.equal(saved.sceneMeta.kind,'declared');
    if(mode==='ooc') assert.equal(saved.scene,null);
    assert.equal(h.state.busy,false);
  }
});

test('starting scene settings stage separately from canon and reject an incomplete opening before writing',async () => {
  const h = await harness();h.state.sessionId='story-id';const view=await h.use('ui/settings-view.js');
  view.initSettingsView();view.openSettingsPopup();await h.fire('nav-memory');await Promise.resolve();
  h.el('mem-scene').checked=true;h.el('mem-starting-date').value='18 September 731';h.el('mem-starting-place').value='West Reception Room';
  await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.length,0);assert.match(h.el('settings-saved-msg').textContent,/attendees/);
  h.el('mem-starting-present').value='Nera Veyrath, Isolde Veyless';h.el('mem-replyContract').value='user';
  await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.length,1);
  const patch=h.calls.sessionWrites[0][1];assert.deepEqual(Object.keys(patch),['memory.scene','memory.startingScene','memory.replyContract']);
  assert.match(patch['memory.startingScene'],/time: unknown/);assert.equal(patch['memory.replyContract'],'user');assert.equal(patch['memory.sceneFallback'],undefined);
});

test('model plan output cannot change fixed author instructions and pure OOC preserves established scene',async () => {
  const h = await harness(), chat = await h.use('ui/chat-view.js');
  Object.assign(h.state.settings,{ modelId:'model',apiKey:'test-key',streaming:false }); h.calls.messageOrder = 2;
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',longTermPlan:'Elise survives',allowLlmPlanUpdates:true,memory:{ scene:true,memoryBlock:true } }) });
  h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },{ id:'a',order:2,role:'assistant',content:'At the inn',scene:'Day 2 · night · Inn · present: Elise',narratorTurn:1 }],hasEarlier:false });
  h.calls.response = 'Liora believes Elise died.\n<plan>Elise dies</plan>\n<plan_thread>Preserve the mystery</plan_thread>\n<scene>Day 9 · noon · Palace · present: Liora</scene>';
  h.el('chat-input').value = '<ooc>What does Liora believe?</ooc>';
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
test('D2 history changing during generation keeps completed narration unsaved',async () => {
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
  assert.equal(h.calls.requests.length,1); assert.equal(replies.length,0);
  const unsaved=h.el('message-list').querySelector('.unsaved');assert.ok(unsaved);
  assert.equal(unsaved.querySelector('.msg-content').textContent,'Narration based on original plan.');
  assert.ok(unsaved.querySelectorAll('button').some(button=>button.textContent==='Save as new reply at the end'));
  assert.equal(chat.memorySnapshot().session.longTermPlan,'Original plan');
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

async function openImprovementChat(h, metadata = {}, messages = []) {
  const chat = await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('improvement');
  await new Promise(resolve => setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({ id:'improvement',exists:() => true,data:() => ({ title:'Story',...metadata }) });
  h.calls.latestCallbacks.at(-1)({ messages,hasEarlier:false });
  Object.assign(h.state.settings,{modelId:'model',apiKey:'key',streaming:false}); h.calls.messageOrder=messages.length || 1;
  return chat;
}

test('P0 failed user save restores the exact draft, and Retry uses a saved user turn once',async () => {
  const h=await harness(); await openImprovementChat(h);
  const draft='  A draft\nwith spacing.  '; h.el('chat-input').value=draft;
  h.calls.addMessage=async () => { throw new Error('save failed'); };
  await h.el('composer').dispatchEvent({type:'submit',preventDefault() {}});
  assert.equal(h.el('chat-input').value,draft); assert.equal(h.calls.requests.length,0);
  h.calls.addMessage=null; h.calls.responseData={ error:{message:'wrong key'} };
  await h.el('composer').dispatchEvent({type:'submit',preventDefault() {}});
  const retry=h.el('message-list').querySelectorAll('button').find(b => b.textContent==='Retry reply');
  assert.ok(retry); h.calls.responseData=null; h.calls.response='A reply.'; await retry.click();
  assert.equal(h.calls.messages.filter(c => c[1].role==='user').length,1);
  assert.equal(h.calls.messages.filter(c => c[1].role==='assistant').length,1);
});

test('P0 streaming bubble remains during persistence and swaps after the saved reply exists',async () => {
  const h=await harness(); await openImprovementChat(h,{},[{id:'user',order:1,role:'user',content:'Begin.'}]);
  let finish;
  h.calls.addMessage=async (_sid,message,options) => new Promise(resolve => { finish=() => resolve({...message,id:options.id,order:2,historyRevision:1}); });
  const retry=h.el('message-list').querySelectorAll('button').find(b => b.textContent==='Retry reply');
  const pending=retry.click(); await new Promise(resolve => setTimeout(resolve,0));
  assert.ok(h.el('message-list').children.some(n => n.className==='msg assistant' && !n.dataset.messageId));
  finish(); await pending;
  assert.equal(h.el('message-list').children.filter(n => n.className==='msg assistant').length,1);
  assert.ok(h.el('message-list').children.some(n => n.dataset.messageId==='summary-id'));
});

test('P0 cut-off reply persists without scene recovery and provider usage clears on story reset',async () => {
  const h=await harness(); const chat=await openImprovementChat(h,{memory:{scene:true,sceneFallback:true}},[{id:'user',order:1,role:'user',content:'Begin.'}]);
  h.calls.responseData={choices:[{finish_reason:'length',message:{content:'A cut-off scene.\n<scene>date:'}}],usage:{prompt_tokens:1234}};
  await h.el('message-list').querySelectorAll('button').find(b => b.textContent==='Retry reply').click();
  const saved=h.calls.messages.find(c => c[1].role==='assistant')[1];
  assert.equal(saved.truncated,true); assert.equal(saved.acceptance,'accepted'); assert.equal(h.calls.requests.length,1);
  assert.ok(h.el('message-list').querySelectorAll('span').some(n => /cut off/.test(n.textContent ?? '')));
  assert.equal(chat.memorySnapshot().providerUsage.promptTokens,1234);
  chat.setSession('other'); assert.equal(chat.memorySnapshot()?.providerUsage ?? null,null);
});

test('P0 custom narrator keeps its text while obsolete lost-plan rules are removed',async () => {
  const h=await harness(); const { buildContextForRequest }=await h.use('context-builder.js');
  const built=await buildContextForRequest({id:'s',longTermPlan:'Plan',memory:{scene:true}}, {...h.state.settings,narratorSystemPrompt:'Custom. If, at the start of a turn, neither a <plan> block nor a <plan_thread> line appears, treat that plan as lost until the user sets a new one.'},{messages:[{id:'u',order:1,role:'user',content:'Begin.'}]});
  assert.match(built.apiMessages[0].content,/Custom\./); assert.doesNotMatch(built.apiMessages[0].content,/treat that plan as lost/);
});

test('S5 valid scenes survive lint warnings, render a note, and plan threads require an active plan',async () => {
 const h=await harness();await openImprovementChat(h,{longTermPlan:'',memory:{scene:true,protagonist:'Nera'}},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.response='You decide to stay.\n<plan_thread>Unused target</plan_thread>\n<scene>date: unknown · time: unknown · place: Inn · present: Mira</scene>';
 await h.el('message-list').querySelectorAll('button').find(b => b.textContent==='Retry reply').click();
 const saved=h.calls.messages.find(c => c[1].role==='assistant')[1];assert.equal(saved.acceptance,'accepted');assert.equal(saved.sceneMeta.kind,'declared');assert.ok(saved.reviewWarnings.length);assert.equal(saved.planThread,null);
 assert.ok(h.el('message-list').querySelectorAll('p').some(n => n.textContent?.startsWith('Note: ')));
 assert.equal(h.el('message-list').querySelectorAll('button').some(b => b.textContent==='Accept reply'),false);
});

test('S1 pending review controls are hidden with Scene off and after a later user message',async () => {
 for(const [scene,later] of [[false,false],[true,true]]) {
  const h=await harness();await openImprovementChat(h,{memory:{scene}},[{id:'p',order:2,role:'assistant',content:'Flagged',acceptance:'pending'},...(later ? [{id:'u',order:3,role:'user',content:'Continue.'}] : [])]);
  assert.equal(h.el('message-list').querySelectorAll('button').some(b => b.textContent==='Accept reply'),false);
 }
});

test('S12 recent narration selects cards after current input mentions; rendering supports source labels',async () => {
 const h=await harness();const {makeEntry}=await h.use('lore-lines.js'),s=await h.use('lore-select.js'),{normalizeMemory}=await h.use('memory-settings.js');
 const cards=['Mira','Kael'].map(n => makeEntry('characters',n));cards[0].sections.appearance.text='Silver hair';
 const selection=s.selectEntries(cards,normalizeMemory({lorebooks:true}), 'Mira',null,'Kael arrives.');
 assert.deepEqual(Array.from(selection.selected.characters,x => x.reason),['mentioned','recent mention']);
 assert.doesNotMatch(s.renderEntry(cards[0]),/origin:/);assert.match(s.renderEntry(cards[0],null,'',{provenance:true}),/origin:/);
});
test('memory failure details appear on the first failure in the toast and settings panel',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
 const lastError='A memory note was empty or longer than 400 characters. No turns were marked updated.';
 const story={title:'Story',memory:{autoUpdate:true},memoryState:{extractedThroughOrder:0,failureStreak:1,paused:false,lastError}};
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>story});
 let detail;h.document.addEventListener('memory-toast',e=>{detail=e.detail;});
 await h.document.dispatchEvent({type:'memory-status',detail:{sessionId:'story',status:'failed',failureStreak:1,lastError}});
 assert.match(detail.text,/400 characters/);assert.equal(detail.action,'Open settings');
 const panel=await h.use('ui/memory-settings-view.js');panel.fillMemory(story.memory);
 assert.match(h.el('mem-update-status').textContent,/Last update failed:.*400 characters/);
 story.memoryState={...story.memoryState,paused:true,failureStreak:3};
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>story});panel.updateMemorySettingsHints();
 assert.match(h.el('mem-update-status').textContent,/Paused.*400 characters/);
});

test('U4 rendered message comparison tracks scene/review fields and memoizes turn computation',async () => {
 const h=await harness(),chat=await h.use('ui/chat-view.js'),base={role:'assistant',content:'Story'};
 for(const patch of [{revision:1},{acceptance:'pending'},{reviewWarnings:['warning']},{sceneMeta:{kind:'manual'}},{sceneCandidate:{scene:'new'}},{ooc:true},{truncated:true},{editedAt:true}]) assert.equal(chat.sameRenderedMessage(base,{...base,...patch}),false);
 const list=[{id:'a',role:'assistant',order:1}];assert.equal(chat.turnsFor(list),chat.turnsFor(list));assert.notEqual(chat.turnsFor(list),chat.turnsFor([...list]));
});

test('Final twenty-turn replay keeps narration plus maintenance at two calls and reconciles the session once per send',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js');Object.assign(h.state.settings,{modelId:'test',apiKey:'fixture-key',narratorSystemPrompt:'Narrate.',streaming:false,maxContextTokens:50000,maxResponseTokens:2000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:2});
 const scene='date: Day 1 · time: night · place: Inn · present: Mira';h.calls.messageOrder=2;h.calls.sessionDocs={story:{id:'story',title:'Story',memory:{scene:true,sceneFallback:true,autoUpdate:true},memoryState:{extractedThroughOrder:0},historyRevision:0}};
 chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>h.calls.sessionDocs.story});h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Opening'},{id:'a',order:2,role:'assistant',content:'Mira waits.',scene}],hasEarlier:false});
 const rows=[];let totalCalls=0;for(let turn=0;turn<20;turn++){
  const before=h.calls.requests.length,memoryBefore=h.calls.memoryStarts ?? 0,readsBefore=h.calls.sessionReads ?? 0;h.calls.memoryDue=turn%2===0;
  h.calls.onRequest=()=>{const body=h.calls.requests.at(-1);h.calls.response=body.response_format ? JSON.stringify({date:'Day 1',time:'night',place:'Inn',present:['Mira'],planThread:null}) : body.messages.at(-1).content.includes('New events to fold in:') ? 'Mira remains at the inn.' : 'Mira waits by the door.'+(turn%3 ? '\n<scene>'+scene+'</scene>' : '');};
  h.el('chat-input').value='Continue '+turn;await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
  const calls=h.calls.requests.length-before+(h.calls.memoryStarts ?? 0)-memoryBefore;assert.ok(calls>=1 && calls<=2,'Turn '+turn+': '+calls+' calls');totalCalls+=calls;rows.push({turn:turn+1,modelRequests:h.calls.requests.length-before,memoryJobs:(h.calls.memoryStarts ?? 0)-memoryBefore,totalCalls:calls,reconcileReads:(h.calls.sessionReads ?? 0)-readsBefore});assert.equal(h.state.busy,false);assert.equal((h.calls.sessionReads ?? 0)-readsBefore,1);
 }
 assert.ok(totalCalls>20);assert.equal(h.calls.messages.filter(c=>c[1].role==='assistant').length,20);await writeFile('/tmp/nera-twenty-turns.json',JSON.stringify({simulated:true,rows,totalCalls},null,2));
});
test('U7 cached or default settings cannot overwrite server preferences before an authoritative load',async()=>{
 const h=await harness();for(const source of ['cache','defaults']){h.state.settingsSource=source;await assert.rejects(h.settings.saveSettings(h.state.settings),/reload before saving/);}assert.equal(h.calls.writes.length,0);h.state.settingsSource='server';await h.settings.saveSettings(h.state.settings);assert.equal(h.calls.writes.length,1);
});

test('main adaptation: failed settings startup recovers server values for review before any write',async()=>{
 const h=await harness();h.state.settingsSource='cache';
 h.calls.settingsDoc={...h.settings.DEFAULT_SETTINGS,modelId:'saved-model',apiKey:'saved-key'};
 await assert.rejects(h.settings.saveSettings(h.state.settings),error=>error.code==='settings-reloaded');
 assert.equal(h.calls.writes.length,0);assert.equal(h.state.settingsSource,'server');
 assert.equal(h.state.settings.modelId,'saved-model');assert.equal(h.state.settings.apiKey,'saved-key');
 await h.settings.saveSettings(h.state.settings);assert.equal(h.calls.writes.length,1);
 assert.equal(h.calls.writes[0].profiles[0].modelId,'saved-model');
});
test('main adaptation: settings popup replaces fallback fields with recovered server settings',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js'),view=await h.use('ui/settings-view.js');chat.initChatView();view.initSettingsView();view.openSettingsPopup(h.el('opener'));
 h.state.settingsSource='defaults';h.calls.settingsDoc={...h.settings.DEFAULT_SETTINGS,modelId:'server-model',apiKey:'server-key'};
 await h.fire('btn-save-settings');assert.equal(h.calls.writes.length,0);
 assert.equal(h.el('set-model').value,'server-model');assert.equal(h.el('set-apikey').value,'server-key');
 await h.fire('btn-save-settings');assert.equal(h.calls.writes.length,1);
});
test('main adaptation: mobile editor grows with text and releases the fixed bubble height',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js');const create=h.document.createElement;
 h.document.createElement=tag=>{const node=create(tag);if(tag==='textarea'){node.scrollHeight=900;node.clientHeight=40;}return node;};
 chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story'})});
 h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Long message'}],hasEarlier:false});
 const bubble=h.el('message-list').children.find(node=>node.dataset.messageId==='u');
 await bubble.querySelector('.msg-actions').children.find(button=>button.textContent==='Edit').click();
 const editor=bubble.querySelector('.msg-editor');assert.equal(editor.style.height,'900px');assert.equal(bubble.style.height,'');
 editor.scrollHeight=1100;await editor.dispatchEvent({type:'input'});assert.equal(editor.style.height,'1100px');
 await bubble.querySelector('.msg-actions').children.find(button=>button.textContent==='Cancel').click();
 assert.equal(h.el('message-list').children.find(node=>node.dataset.messageId==='u').querySelector('.msg-editor'),null);
});
test('main adaptation: logout waits for started cache writes and prevents new scheduled writes',async()=>{
 const writes=[],scheduled=new Map();let finishWrite,sequence=0;
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:(uid,sid)=>{writes.push([uid,sid]);return new Promise(resolve=>{finishWrite=resolve;});},deleteChatCache:async()=>{}},timers:{setTimeout:(fn,ms)=>{const id=++sequence;scheduled.set(id,{fn,ms});return id;},clearTimeout:id=>scheduled.delete(id)}});
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('one');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'one',exists:()=>true,data:()=>({title:'One'})});h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Opening'}],hasEarlier:false});
 chat.setSession('two');assert.equal(writes.length,1);
 let ready=false;const prepared=chat.prepareChatLogout().then(()=>{ready=true;});await Promise.resolve();assert.equal(ready,false);
 finishWrite();await prepared;assert.equal(ready,true);
 await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'two',exists:()=>true,data:()=>({title:'Two'})});h.calls.latestCallbacks.at(-1)({messages:[],hasEarlier:false});
 for(const {fn,ms} of [...scheduled.values()])if(ms===250)fn();
 assert.equal(writes.length,1);assert.equal([...scheduled.values()].some(timer=>timer.ms===250),false);
});

test('D1 paid narration survives a failed save; Save again never calls the model',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Paid narration.';h.calls.memoryDue=true;
 let attempts=0;h.calls.addMessage=async(_sid,message,opts)=>{attempts++;if(attempts===1)throw Error('offline');return {...message,id:opts.id,order:2,historyRevision:1};};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const bubble=h.el('message-list').querySelector('.unsaved');assert.ok(bubble);assert.equal(bubble.querySelector('.msg-content').textContent,'Paid narration.');assert.equal(h.calls.memoryStarts ?? 0,0);assert.equal(h.calls.requests.length,1);
 await bubble.querySelectorAll('button').find(b=>b.textContent==='Save again').click();assert.equal(attempts,2);assert.equal(h.calls.requests.length,1);assert.equal(h.el('message-list').querySelector('.unsaved'),null);
});
test('D2 conflicted narration is kept locally and maintenance is skipped',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Conflicted paid narration.';h.calls.memoryDue=true;
 h.calls.addMessage=async(_sid,_message,opts)=>{assert.equal(opts.expectedSource.historyRevision,0);throw Object.assign(Error('History changed'),{name:'HistoryConflict'});};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 assert.ok(h.el('message-list').querySelector('.unsaved'));assert.ok(h.el('message-list').querySelectorAll('button').some(b=>b.textContent==='Save as new reply at the end'));assert.equal(h.calls.requests.length,1);assert.equal(h.calls.memoryStarts ?? 0,0);
});

test('B15 typing during user persistence survives the committed send',async()=>{
 const h=await harness();await openImprovementChat(h);h.el('chat-input').value='Sent text';
 h.calls.addMessage=async(_sid,message,opts)=>{if(message.role==='user')h.el('chat-input').value='Next draft';return {...message,id:message.role==='user'?'sent':opts.id,order:message.role==='user'?1:2,historyRevision:message.role==='user'?1:2};};
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.equal(h.el('chat-input').value,'Next draft');
});
test('B15 stale turn after user commit has already cleared its sent draft',async()=>{
 const h=await harness();const chat=await openImprovementChat(h);h.el('chat-input').value='Sent text';
 h.calls.addMessage=async(_sid,message)=>{await chat.prepareChatLogout();return {...message,id:'sent',order:1,historyRevision:1};};
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.equal(h.el('chat-input').value,'');assert.equal(h.calls.requests.length,0);
});
test('B1 saved reply survives background history read failure without a Retry state',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Saved reply.';
 h.calls.addMessage=async(_sid,message,opts)=>({...message,id:opts.id,order:2,historyRevision:4});h.calls.onHistoryRead=async read=>{if(read>1)throw Error('history offline');};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 assert.ok(h.el('message-list').children.some(n=>n.dataset.messageId==='summary-id'));assert.ok(h.el('message-list').children.some(n=>/Reply saved.*Background memory was skipped/.test(n.textContent ?? '')));assert.equal(h.calls.requests.length,1);
});
test('R3 blocked device storage does not prevent scene messages or memory settings rendering',async()=>{
 const h=await harness();h.calls.storageBlocked=true;const chat=await openImprovementChat(h,{memory:{scene:true}},[{id:'u',order:1,role:'user',content:'Begin.'},{id:'a',order:2,role:'assistant',content:'Hello',scene:'date: Day 1 · time: night · place: Inn'}]);
 assert.ok(h.el('message-list').querySelector('.scene-chip'));const settings=await h.use('ui/settings-view.js');settings.initSettingsView();settings.openSettingsPopup(null,{panel:'memory'});await Promise.resolve();assert.equal(h.el('mem-showScene').checked,true);
});

test('B17 remote settings preserve uncaptured typing; Reload normalizes a clean draft',async()=>{
 const h=await harness(),v=await h.use('ui/settings-view.js');v.initSettingsView();v.openSettingsPopup();await h.fire('nav-prompts');h.el('set-narrator-prompt').value='Typed local prompt';h.state.settings.narratorSystemPrompt='Remote prompt';
 await h.document.dispatchEvent({type:'settings-changed'});assert.equal(h.el('set-narrator-prompt').value,'Typed local prompt');
 const message=h.el('settings-saved-msg');const keep=message.querySelectorAll('button').find(b=>b.id==='settings-keep-mine');assert.ok(keep);await keep.click();assert.equal(h.el('set-narrator-prompt').value,'Typed local prompt');
 await h.document.dispatchEvent({type:'settings-changed'});await message.querySelectorAll('button').find(b=>b.id==='settings-reload-remote').click();assert.equal(h.el('set-narrator-prompt').value,'Remote prompt');h.calls.confirm=false;await h.fire('btn-close-settings');assert.equal(h.el('settings-tab').classList.contains('hidden'),true);
});
test('B17 settings recovery during save keeps the local draft for review',async()=>{
 const h=await harness(),v=await h.use('ui/settings-view.js');v.initSettingsView();v.openSettingsPopup();h.el('set-model').value='Keep this draft';h.state.settingsSource='cache';h.calls.settingsDoc={narratorSystemPrompt:'Server prompt'};
 await h.fire('btn-save-settings');assert.equal(h.el('set-model').value,'Keep this draft');assert.ok(h.el('settings-saved-msg').querySelectorAll('button').some(b=>b.id==='settings-reload-remote'));assert.equal(h.calls.writes.length,0);
});
test('R6 online pending metadata does not claim offline and server metadata clears the label',async()=>{
 const h=await harness();await openImprovementChat(h);const cb=h.calls.sessionCallbacks.at(-1);h.el('context-label').textContent='Tokens';cb({id:'improvement',metadata:{hasPendingWrites:true},exists:()=>true,data:()=>({title:'Rename'})});assert.doesNotMatch(h.el('context-label').textContent,/offline/);h.el('context-label').textContent='Tokens · offline';cb({id:'improvement',metadata:{},exists:()=>true,data:()=>({title:'Rename'})});assert.doesNotMatch(h.el('context-label').textContent,/offline/);
});
test('Q5 transaction session metadata stays outside cached story messages',async()=>{
 const h=await harness();const chat=await openImprovementChat(h);h.el('chat-input').value='Start';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.ok(chat.memorySnapshot().messages.length);assert.ok(chat.memorySnapshot().messages.every(m=>!('session'in m)));
});

test('Q3 P0.10 a regeneration snapshot preserves the stream through the overwrite commit',async()=>{
  const h=await harness(),initial=[{id:'u',order:1,role:'user',content:'Start'},{id:'a',order:2,role:'assistant',content:'Old reply'}];await openImprovementChat(h,{},initial);
  let releaseModel,modelStarted,releaseSave,saveStarted;const modelReady=new Promise(resolve=>modelStarted=resolve),saveReady=new Promise(resolve=>saveStarted=resolve);
  h.calls.response='Regenerated reply';h.calls.onRequest=async()=>{modelStarted();await new Promise(resolve=>releaseModel=resolve);};
  h.calls.overwriteMessage=async(sid,id,message)=>{saveStarted();await new Promise(resolve=>releaseSave=resolve);const replacement={...initial[1],...message};h.calls.historyRevision=1;h.calls.sessionDocs[sid].historyRevision=1;return {replacement,historyRevision:1,session:h.calls.sessionDocs[sid]};};
  await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Regenerate').click();await modelReady;
  const stream=h.el('message-list').children.find(n=>n.className==='msg assistant' && !n.dataset.messageId);assert.ok(stream);
  h.calls.latestCallbacks.at(-1)({messages:initial,hasEarlier:false});assert.equal(stream.parentNode,h.el('message-list'));
  releaseModel();await saveReady;h.calls.latestCallbacks.at(-1)({messages:initial,hasEarlier:false});assert.equal(stream.parentNode,h.el('message-list'));
  releaseSave();for(let i=0;i<40 && h.state.busy;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.state.busy,false);assert.equal(stream.parentNode,null);assert.equal(h.el('message-list').querySelector('[data-message-id="a"]').querySelector('.msg-content').textContent,'Regenerated reply');
});

test('Q3 P0.11 Retry after a manual summary sends the latest saved user exactly once',async()=>{
  const h=await harness(),history=Array.from({length:9},(_,i)=>({id:'m'+(i+1),order:i+1,role:i%2 ? 'assistant' : 'user',content:i===8 ? 'LATEST SAVED USER' : 'Earlier story '+i}));
  const chat=await openImprovementChat(h,{},history);Object.assign(h.state.settings,{narratorSystemPrompt:'Narrate.',keepRecentMessagesAfterSummary:1,maxContextTokens:50000,summarizerChunkTokens:50000});
  h.calls.response='Earlier events summary';await h.fire('btn-summarize');assert.equal(chat.memorySnapshot().session.breakpointOrder,8);
  h.calls.response='Retry reply';await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
  assert.equal(h.calls.requests.length,2);const sent=h.calls.requests.at(-1).messages;
  assert.equal(sent.filter(m=>m.content.includes('LATEST SAVED USER')).length,1);assert.equal(sent.at(-1).role,'user');assert.match(sent.at(-1).content,/LATEST SAVED USER/);
  assert.equal(h.calls.messages.filter(c=>c[1].role==='user').length,0);assert.equal(h.calls.messages.filter(c=>c[1].role==='assistant').length,1);
});

test('Q3 P0.13 folded deletion asks twice and a recent deletion asks once',async()=>{
  for(const folded of [true,false]){
    const h=await harness(),history=[{id:'u',order:1,role:'user',content:'Opening'},{id:'a',order:2,role:'assistant',content:'Opening reply'},{id:'folded',order:3,role:'user',content:'Old action'},{id:'reply',order:4,role:'assistant',content:'Old reply'},{id:'recent',order:5,role:'user',content:'Recent action'},{id:'sum',order:6,role:'summary',content:'Earlier events',coveredRange:{fromOrder:3,toOrder:4}}];
    await openImprovementChat(h,{activeSummaryMessageId:'sum',breakpointOrder:4},history);
    const row=h.el('message-list').querySelector('[data-message-id="'+(folded?'folded':'recent')+'"]');
    await row.querySelectorAll('button').find(b=>b.textContent==='Delete').click();
    assert.equal(h.calls.confirmations.length,folded ? 2 : 1);assert.equal(h.calls.deletes.length,1);
  }
});

test('Q3 P0.14 omitted history indicator shows turns not sent with actionable tooltip',async()=>{
  const h=await harness(),history=Array.from({length:40},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'story '+i+' '+ 'x'.repeat(300)}));
  const chat=await openImprovementChat(h,{},history);Object.assign(h.state.settings,{narratorSystemPrompt:'Narrate.',maxContextTokens:3000,maxResponseTokens:100,autoSummarizationEnabled:false});await chat.updateIndicator();
  assert.match(h.el('context-label').textContent,/input \/ [\d,]+ tokens/);assert.doesNotMatch(h.el('context-label').textContent,/max reply/);
  assert.match(h.el('context-label').textContent,/\d+ turns not sent/);assert.match(h.el('context-label').title,/Older turns no longer fit/);assert.match(h.el('context-label').title,/Turn on auto-summary or run Summarize/);
});

test('Q3 U1 chat-view acquires one busy token and cancels stale persistence before narration',async()=>{
  const h=await harness(),chat=await openImprovementChat(h);let releaseSave,started;const ready=new Promise(resolve=>started=resolve);let saves=0;
  h.calls.addMessage=async(_sid,message)=>{saves++;started();await new Promise(resolve=>releaseSave=resolve);return {...message,id:'u',order:1,historyRevision:1};};
  h.el('chat-input').value='Send once';const pending=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await ready;
  assert.equal(h.state.busy,true);assert.equal(chat.setSession('different'),false);assert.equal(h.state.sessionId,'improvement');
  await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.equal(saves,1);
  await chat.prepareChatLogout();releaseSave();await pending;
  assert.equal(h.state.busy,false);assert.equal(h.calls.requests.length,0);assert.equal(h.el('chat-input').value,'');
});

test('R1 failed story listener resubscribes after backoff and shows a friendly quota error',async()=>{
 let sequence=0;const scheduled=new Map();const h=await harness({timers:{setTimeout:(fn,ms)=>{const id=++sequence;scheduled.set(id,{fn,ms});return id;},clearTimeout:id=>scheduled.delete(id)}});await openImprovementChat(h);
 const before=h.calls.sessionCallbacks.length;h.calls.sessionErrors.at(-1)({code:'resource-exhausted',message:'raw SDK error'});
 assert.ok(h.el('message-list').children.some(n=>/free daily database quota/.test(n.textContent ?? '')));const retry=[...scheduled.values()].find(t=>t.ms===2000);assert.ok(retry);retry.fn();assert.equal(h.calls.sessionCallbacks.length,before+1);
});
test('B16 kept Stop and timeout partial replies use their actual stop reason',async()=>{
 for(const reason of ['user','timeout']){const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.onRequest=async()=>{throw Object.assign(Error('Interrupted'),{aborted:reason,partial:{content:'Partial story.',thinking:''}});};await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();assert.equal(h.calls.messages.at(-1)[1].truncated,true);assert.ok(h.el('message-list').children.some(n=>reason==='timeout'?/timed out after 120 s/.test(n.textContent ?? ''):/Partial reply saved \(stopped\)/.test(n.textContent ?? '')));assert.ok(!h.el('message-list').children.some(n=>/output limit/.test(n.textContent ?? '')));}
});
test('B14 scene-save revision jumps invalidate cached full history',async()=>{
 const h=await harness(),initial=[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Reply',scene:'date: Day 1 · time: night · place: Inn'}],chat=await openImprovementChat(h,{memory:{scene:true}},initial);await chat.prepareMemorySnapshot();
 const readsBefore=h.calls.historyReads;h.calls.serverHistory=[{...initial[0],content:'Remote action'},initial[1]];
 h.calls.updateScene=async()=>{h.calls.historyRevision=4;h.calls.sessionDocs.improvement.historyRevision=4;return {replacement:{...initial[1],scene:'date: Day 1 · time: night · place: Hall'},historyRevision:4,session:h.calls.sessionDocs.improvement};};
 await h.el('message-list').querySelector('.scene-chip').click();await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Save').click();assert.ok(h.calls.historyReads>readsBefore);assert.equal(chat.memorySnapshot().messages[0].content,'Remote action');
});
test('B2 indicator and post-turn usage both receive the current lore entries',async()=>{
 const source=await readFile(new URL('../js/context-builder.js',import.meta.url),'utf8');const observations=[];const h=await harness({globals:{recordUsage:opts=>observations.push(opts)},sources:{'context-builder.js':source.replace('  messages ??= await getMessages(session.id);','  globalThis.recordUsage(opts);\n  messages ??= await getMessages(session.id);')}});
 h.calls.loreEntries=[{id:'l',book:'facts',name:'Magic',alwaysLoad:true,sections:{text:{text:'Canon',lines:[]}}}];await openImprovementChat(h,{memory:{lorebooks:true}},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Reply.';await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();assert.ok(observations.length>=2);assert.ok(observations.every(o=>o.loreEntries?.some(e=>e.id==='l')));
});

test('R2 sidebar guards duplicate creation and catches failed create, rename and logout',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js'),side=await h.use('ui/sidebar.js');chat.initChatView();side.initSidebar();let finish,started;const ready=new Promise(resolve=>started=resolve);h.calls.onCreate=()=>{started();return new Promise(resolve=>finish=resolve);};
 const pending=h.fire('btn-new-session');await ready;await h.fire('btn-new-session');assert.equal(h.calls.creates,1);finish('s');await pending;assert.equal(h.el('btn-new-session').disabled,false);
 h.calls.onCreate=null;h.calls.failCreate=true;await h.fire('btn-new-session');assert.ok(h.document.body.querySelector('.toast').textContent.includes('Create failed'));
 h.calls.sidebarCallback([{id:'s',title:'Story'}]);h.calls.failRename=true;await h.el('session-list').querySelector('.ren').click();assert.ok(h.document.body.querySelector('.toast').textContent.includes('Rename failed'));
 h.calls.failLogout=true;await h.fire('btn-logout');assert.equal(h.calls.logouts,1);assert.ok(h.document.body.querySelector('.toast').textContent.includes('Logout failed'));assert.equal(h.el('btn-logout').disabled,false);
});

test('R2 a delayed backup listing cannot populate a different lorebook screen',async()=>{
 const h=await harness();await openImprovementChat(h);const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();let finish;h.calls.onBackups=()=>new Promise(resolve=>finish=resolve);lore.openLorebooks({screen:'backups'});assert.ok(finish);lore.openLorebooks({screen:'list',book:'characters'});finish([{id:'old',label:'STALE BACKUP',createdMs:1,count:1,parts:[]}]);await new Promise(resolve=>setImmediate(resolve));assert.ok(!h.el('lorebook-overlay').querySelectorAll('p').some(p=>/STALE BACKUP/.test(p.textContent ?? '')));
});
test('R7 closing Catch-up without starting leaves an existing memory update alone',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{autoUpdate:true},memoryState:{extractedThroughOrder:0}},[{id:'u',order:1,role:'user',content:'Start'}]);const panel=await h.use('ui/memory-settings-view.js');panel.initMemorySettings(()=>{});await h.fire('mem-catch-up');await new Promise(resolve=>setImmediate(resolve));const root=h.document.body.querySelector('.memory-sub-sheet');assert.ok(root);await root.querySelector('.settings-close').click();assert.equal(h.calls.memoryStopped?.length ?? 0,0);
});

test('B1 newer metadata after the reply commit is preserved and summary uses full refreshed history',async()=>{
 const h=await harness(),initial=Array.from({length:5},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i})),chat=await openImprovementChat(h,{},initial);Object.assign(h.state.settings,{narratorSystemPrompt:'Narrate.',maxContextTokens:20000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:2});
 const full=[...initial,{id:'paid',order:6,role:'assistant',content:'Paid reply'}, {id:'remote-u',order:7,role:'user',content:'Remote action'},{id:'remote-a',order:8,role:'assistant',content:'Remote reply'}];h.calls.serverHistory=full;
 h.calls.addMessage=async(sid,message,opts)=>{
   h.calls.messages.push([sid,message,opts]);
   if(message.role==='assistant'){h.calls.historyRevision=3;h.calls.sessionCallbacks.at(-1)({id:sid,exists:()=>true,data:()=>({title:'Latest title',historyRevision:3})});return {...message,id:'paid',order:6,historyRevision:1,session:{id:sid,title:'Old title',historyRevision:1}};}
   h.calls.historyRevision=4;h.calls.sessionDocs[sid]={...h.calls.sessionDocs[sid],...opts.sessionUpdate,historyRevision:4};return {...message,id:opts.id,order:9,historyRevision:4,session:h.calls.sessionDocs[sid]};
 };
 const reads=h.calls.historyReads;await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 assert.ok(h.calls.historyReads>reads);assert.equal(h.calls.requests.length,2);assert.match(h.calls.requests[1].messages[1].content,/Event 2|Event 4/);assert.equal(chat.memorySnapshot().session.title,'Latest title');assert.ok(!h.calls.petFinishes.includes('blocked'));
});

test('R2 Ctrl+S validation errors stay in the lorebook UI instead of rejecting unhandled',async()=>{
 const h=await harness();await openImprovementChat(h);const l=await h.use('lore-lines.js'),card=l.makeEntry('facts','Magic');h.calls.loreEntries=[card];const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();lore.openLorebooks({entryId:card.id});await new Promise(resolve=>setImmediate(resolve));
 const name=h.el('lorebook-overlay').querySelectorAll('label').find(label=>label.textContent==='Main name').querySelector('input');name.value='';await name.dispatchEvent({type:'input'});await h.document.dispatchEvent({type:'keydown',key:'s',ctrlKey:true,preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.match(h.document.body.querySelector('.toast').textContent,/Enter a name/);assert.equal(h.calls.cardWrites?.length ?? 0,0);
});

test('R4 successful story import visibly explains that paid background memory is off',async()=>{
 const h=await harness(),v=await h.use('ui/settings-view.js');v.initSettingsView();v.openSettingsPopup();h.el('file-import-st').files=[{name:'story.jsonl'}];await h.fire('file-import-st','change');assert.match(h.el('settings-saved-msg').textContent,/Imported\. Background memory is off.*Memory settings/);
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


test('Unsupported vibration is explained without disabling the synced setting', async () => {
  const h = await harness();
  const { vibrationSupport } = await h.use('stream-vibration.js');
  assert.equal(vibrationSupport({ userAgent: 'iPhone OS 18_6 Version/26.5' }), 'unsupported');
  assert.equal(vibrationSupport({ vibrate() {} }), 'native');
  (await h.use('ui/settings-view.js')).initSettingsView();
  assert.equal(h.el('stream-vibration-help').hidden, false);
  assert.notEqual(h.el('set-stream-vibration').disabled, true);
});


test('Story rewrite settings are editable and resettable with an explicit Markdown default',async()=>{
 const h=await harness();h.state.sessionId='story';h.state.storySettings={values:{...h.state.settings}};(await h.use('ui/chat-view.js')).initChatView();const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();await h.fire('nav-prompts');
 const rewrite=await h.use('rewrite.js');await rewrite.loadRewriteDefaultPrompt();
 const def=h.el('set-rewrite-prompt').value;assert.equal(def,(await readFile(new URL('../system prompts/rewrite.md',import.meta.url),'utf8')).trim());assert.equal(h.el('set-rewrite-prompt').disabled,false);
 h.el('set-rewrite-n').value='2.5';await h.fire('btn-save-settings');assert.match(h.el('settings-saved-msg').textContent,/whole number/);
 h.el('set-rewrite-n').value='0';h.el('set-rewrite-prompt').value='My custom prompt';h.el('set-stream-vibration').value='speed';await h.fire('btn-save-settings');
 assert.equal(h.state.storySettings.values.rewriteRecentMessages,0);assert.equal(h.state.storySettings.values.rewriteSystemPrompt,'My custom prompt');assert.equal(h.state.settings.rewriteRecentMessages,10);assert.equal(h.state.settings.streamVibrationMode,'spaces');
 await h.fire('btn-reset-rewrite-prompt');await rewrite.loadRewriteDefaultPrompt();assert.equal(h.el('set-rewrite-prompt').value,def);await h.fire('btn-save-settings');assert.equal(h.state.storySettings.values.rewriteSystemPrompt,def);
});
test('MAIN merge stops a rewrite during history loading without a model call',async()=>{
 const h=await rewriteChatHarness();h.state.settings.rewriteRecentMessages=10;let release,started;const ready=new Promise(resolve=>started=resolve);
 h.calls.onHistoryRead=()=>{started();return new Promise(resolve=>release=resolve);};
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',historyRevision:1})});
 const running=h.fire('btn-rewrite');await ready;await h.fire('btn-rewrite');await running;
 assert.equal(h.state.busy,false);assert.equal(h.el('chat-input').value,'I tell him about the story');assert.equal(h.calls.requests.length,0);release();
});
test('MAIN merge manual Sync refreshes full history without making a model call',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Opening'}]);
 h.calls.serverHistory=[{id:'u',order:1,role:'user',content:'Updated on phone'}];await chat.syncChatData();
 assert.match(h.el('message-list').querySelector('.msg-content').textContent,/Updated on phone/);assert.equal(h.calls.requests.length,0);assert.equal(h.state.busy,false);
});

test('MAIN merge retains narrative vibration callbacks without persisting hidden thinking',async()=>{
 const pulses=[],h=await harness({globals:{navigator:{vibrate:n=>pulses.push(n)}}});h.document.hidden=false;
 await openImprovementChat(h);Object.assign(h.state.settings,{modelId:'narrator',apiKey:'key',streaming:true,streamVibrationMode:'spaces'});
 h.calls.streamLines=['data: '+JSON.stringify({choices:[{delta:{reasoning:'thinking words ',content:'Narrative words '},finish_reason:'stop'}]})+'\n'];
 h.el('chat-input').value='Continue';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.ok(pulses.includes(10));assert.equal(pulses.at(-1),0);
 assert.equal(h.calls.messages.at(-1)[1].content,'Narrative words');
});

test('F3 missing tags store exactly one carry warning or recover reasoning without another call',async()=>{
 for(const thinking of [null,'Scene tag: date: October 738 · time: evening · place: Hall · present: Mira']){
  const h=await harness();await openImprovementChat(h,{memory:{scene:true,sceneFallback:true}},[{id:'u',order:1,role:'user',content:'Begin.'}]);
  // Recovery is disabled for carry case so it does not make a paid fallback.
  if(!thinking){h.calls.sessionDocs.improvement.memory.sceneFallback=false;h.calls.sessionCallbacks.at(-1)({id:'improvement',exists:()=>true,data:()=>h.calls.sessionDocs.improvement});}
  h.calls.responseData={choices:[{message:{content:'Mira waited.',reasoning:thinking}}]};
  await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
  const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];
  assert.equal(h.calls.requests.length,1);
  if(thinking){assert.equal(saved.sceneMeta.source,'thinking');assert.match(saved.scene,/date: October 738/);assert.equal(saved.reviewWarnings.filter(s=>s==="Scene taken from the model's reasoning.").length,1);}
  else{assert.equal(saved.sceneMeta.kind,'carried');assert.equal(saved.reviewWarnings.filter(s=>s==='No scene tag; previous scene carried.').length,1);}
 }
});
test('F7 a story switch clears the reconnect guard so the next listener can retry',async()=>{
 let sequence=0;const scheduled=new Map();
 const h=await harness({timers:{setTimeout:(fn,ms)=>{scheduled.set(++sequence,{fn,ms});return sequence;},clearTimeout:id=>scheduled.delete(id)}});
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('one');await new Promise(r=>setTimeout(r,0));
 h.calls.sessionErrors.at(-1)(Error('offline'));assert.ok([...scheduled.values()].some(t=>t.ms===2000));
 chat.setSession('two');await new Promise(r=>setTimeout(r,0));assert.equal([...scheduled.values()].filter(t=>t.ms===2000).length,0);
 h.calls.sessionErrors.at(-1)(Error('offline again'));assert.equal([...scheduled.values()].filter(t=>t.ms===2000).length,1);
 const timer=[...scheduled.values()].find(t=>t.ms===2000);const before=h.calls.sessionCallbacks.length;timer.fn();assert.equal(h.calls.sessionCallbacks.length,before+1);
});
for(const asNew of [false,true])test(`F8 ambiguous committed save is discovered before ${asNew?'save as new':'save again'}`,async()=>{
 const h=await harness();await openImprovementChat(h,{nextOrder:1},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Paid narration.';
 let saved,attempts=0;h.calls.addMessage=async(sid,message,opts)=>{attempts++;saved={...message,id:opts.id,order:2};h.calls.history.push(saved);h.calls.historyRevision=1;h.calls.sessionDocs[sid].historyRevision=1;throw Object.assign(Error('Ambiguous save'),{name:asNew?'HistoryConflict':'Error'});};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 h.calls.findSavedMessage=(sid,id,minOrder)=>{assert.equal(id,saved.id);assert.equal(minOrder,2);return saved;};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent===(asNew?'Save as new reply at the end':'Save again')).click();
 assert.equal(attempts,1);assert.equal(h.calls.requests.length,1);assert.equal(h.el('message-list').querySelector('.unsaved'),null);
 assert.equal(h.el('message-list').querySelectorAll('.msg-content').filter(n=>n.textContent==='Paid narration.').length,1);
});
test('F10 a dropped stream can be kept as truncated without scene recovery',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{scene:true,sceneFallback:true}},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.state.settings.streaming=true;
 h.calls.streamLines=['data: {"choices":[{"delta":{"content":"Mira waited."}}]}\n'];
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];assert.equal(saved.content,'Mira waited.');assert.equal(saved.truncated,true);assert.equal(saved.reviewWarnings.length,0);assert.equal(h.calls.requests.length,1);assert.ok(h.calls.confirmations.some(s=>/Keep the partial reply/.test(s)));
});

for(const mode of ['turn-already-stopped','summary-user-stop','summary-network-error'])test('F9 '+mode,async()=>{
 const source=await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8');
 const h=await harness({sources:{'ui/chat-view.js':source+'\nexport const testSummaryBackoff=sid=>summaryBackoff.get(sid);'}}),chat=await h.use('ui/chat-view.js');
 Object.assign(h.state.settings,{narratorSystemPrompt:'Narrate.',modelId:'model',apiKey:'key',streaming:false,maxContextTokens:10000,maxResponseTokens:1000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:0});
 h.calls.messageOrder=4;chat.initChatView();chat.setSession('story');await new Promise(r=>setTimeout(r,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story'})});
 h.calls.latestCallbacks.at(-1)({messages:[{id:'u1',order:1,role:'user',content:'Opening',tokenCount:7},{id:'a1',order:2,role:'assistant',content:'Story',tokenCount:5},{id:'u2',order:3,role:'user',content:'Next',tokenCount:4},{id:'a2',order:4,role:'assistant',content:'Story2',tokenCount:6}],hasEarlier:false});
 h.calls.onRequest=async body=>{
  if(h.calls.requests.length===1){h.calls.response='A complete reply.';if(mode==='turn-already-stopped')await h.fire('btn-stop');}
  else if(mode==='summary-user-stop')await h.fire('btn-stop');
  else if(mode==='summary-network-error')throw Error('network failed');
  else h.calls.response='Clean summary.';
 };
 // Stop the narrator after its provider call has returned but before maintenance.
 if(mode==='turn-already-stopped')h.calls.onRequest=async()=>{h.calls.response='A complete reply.';};
 if(mode==='turn-already-stopped')h.calls.addMessage=async(sid,message,opts)=>{
  const result={...message,id:opts?.id ?? 'u3',order:message.role==='user'?5:message.role==='assistant'?6:7,historyRevision:(h.calls.historyRevision ?? 0)+1};h.calls.historyRevision=result.historyRevision;h.calls.history.push(result);h.calls.sessionDocs[sid].historyRevision=result.historyRevision;h.calls.messages.push([sid,message,opts]);if(message.role==='assistant')await h.fire('btn-stop');return {...result,session:{...h.calls.sessionDocs[sid],...(opts?.sessionUpdate ?? {})}};
 };
 h.el('chat-input').value='Continue';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.calls.requests.length,2);
 assert.equal(chat.testSummaryBackoff('story') ?? 0,mode==='summary-network-error'?3:0);
 if(mode==='turn-already-stopped')assert.equal(h.calls.messages.filter(c=>c[1].role==='summary').length,1);
 if(mode==='summary-user-stop')assert.ok(h.el('message-list').children.some(n=>n.textContent==='Summary stopped.'));
});

test('E6 failed story deletion preserves its local unsaved reply',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='Paid reply.';h.calls.addMessage=async()=>{throw Error('offline');};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const side=await h.use('ui/sidebar.js');side.initSidebar();h.calls.sidebarCallback([{id:'improvement',title:'Story'}]);h.calls.failDelete=true;
 await h.el('session-list').querySelector('.del').click();
 const chat=await h.use('ui/chat-view.js');chat.setSession('improvement');await new Promise(r=>setTimeout(r,0));h.calls.sessionCallbacks.at(-1)({id:'improvement',exists:()=>true,data:()=>({title:'Story'})});h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Begin.'}],hasEarlier:false});
 assert.equal(h.el('message-list').querySelector('.unsaved')?.querySelector('.msg-content').textContent,'Paid reply.');
});
test('E7 full backup is blocked during an active turn',async()=>{
 const h=await harness();(await h.use('ui/chat-view.js')).initChatView();(await h.use('ui/settings-view.js')).initSettingsView();h.state.sessionId='s';h.state.busy=true;
 await h.fire('btn-export-full');assert.match(h.el('settings-saved-msg').textContent,/Finish the current turn first/);assert.notEqual(h.el('btn-export-full').disabled,true);
});
test('E8 inner Catch up and choose-start refuse a busy turn',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{autoUpdate:true,batchTurns:2,lagTurns:0},memoryState:{extractedThroughOrder:0}},[{id:'u',order:1,role:'user',content:'Begin'},{id:'a',order:2,role:'assistant',content:'Story'}]);
 const panel=await h.use('ui/memory-settings-view.js');panel.initMemorySettings(()=>{});await h.fire('mem-catch-up');await new Promise(r=>setImmediate(r));
 const button=h.document.body.querySelector('.memory-sub-sheet').querySelectorAll('button').find(b=>b.textContent==='Catch up');h.state.busy=true;await button.click();assert.equal(h.calls.catchUps ?? 0,0);assert.notEqual(button.disabled,true);
 const reads=h.calls.sessionReads;await h.fire('mem-choose-start');assert.equal(h.calls.sessionReads,reads);assert.match(h.document.body.querySelectorAll('.toast').at(-1).textContent,/Finish the current turn first/);
});
test('E10 old defaults with CRLF or trailing whitespace still migrate and custom prompts survive',async()=>{
 const outgoing=await readFile(new URL('./fixtures/summary-before-f20.md',import.meta.url),'utf8');
 for(const value of [outgoing.replace(/\n/g,'\r\n')+'\r\n',outgoing+'\n  ']){
  const h=await harness();const merged=await h.settings.mergeDefaults({summarizerSystemPrompt:value});assert.equal(merged.summarizerSystemPrompt,h.settings.DEFAULT_SETTINGS.summarizerSystemPrompt);
  assert.equal((await h.settings.mergeDefaults({summarizerSystemPrompt:value+'Custom.'})).summarizerSystemPrompt,value+'Custom.');
 }
});
test('E14 recent-window setting states that it counts user and reply messages',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/Keep recent messages \(user \+ reply\) after summary/);
});

test('F8 an ambiguous regeneration succeeds on retry without a second overwrite',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'},{id:'a',order:2,role:'assistant',content:'Old reply.'}]);h.calls.response='Regenerated reply.';
 let overwrites=0;h.calls.overwriteMessage=async(sid,id,message)=>{overwrites++;const found={...message,id,order:2};h.calls.history=h.calls.history.map(m=>m.id===id?found:m);h.calls.historyRevision=1;h.calls.sessionDocs[sid].historyRevision=1;throw Error('commit response lost');};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Regenerate').click();
 for(let i=0;i<40 && !h.el('message-list').querySelector('.unsaved');i++)await new Promise(r=>setImmediate(r));
 assert.ok(h.el('message-list').querySelector('.unsaved'));
 h.calls.findSavedMessage=(sid,id,order,opts)=>{assert.equal(id,'a');assert.equal(order,2);assert.equal(opts.overwrite,true);return h.calls.history.find(m=>m.id===id);};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Save again').click();
 assert.equal(overwrites,1);assert.equal(h.el('message-list').querySelector('.unsaved'),null);assert.equal(h.calls.requests.length,1);
});
test('F8 a real unsaved conflict still requires a new append, then saves exactly once',async()=>{
 const h=await harness();await openImprovementChat(h,{nextOrder:1},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.response='New paid reply.';
 let attempts=0;h.calls.addMessage=async(sid,message,opts)=>{attempts++;if(attempts<3)throw Object.assign(Error('History changed'),{name:'HistoryConflict'});assert.equal(opts.expectedSource.historyRevision,5);const found={...message,id:opts.id,order:10,historyRevision:6};h.calls.history.push(found);return {...found,session:{id:sid,historyRevision:6}};};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Save again').click();assert.ok(h.el('message-list').querySelector('.unsaved'));
 h.calls.sessionDocs.improvement.historyRevision=5;h.calls.sessionDocs.improvement.nextOrder=9;
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Save as new reply at the end').click();
 assert.equal(attempts,3);assert.equal(h.el('message-list').querySelector('.unsaved'),null);assert.equal(h.calls.history.filter(m=>m.content==='New paid reply.').length,1);assert.equal(h.calls.requests.length,1);
});
test('F6 all summary application paths show lint warnings without gating acceptance',async()=>{
 const source=await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8');const h=await harness({sources:{'ui/chat-view.js':source+'\nexport {applySummaryResult as testApplySummaryResult};'}}),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);
 chat.testApplySummaryResult({skipped:true,lintWarnings:[{line:1},{line:2}]});assert.ok(h.el('message-list').children.some(n=>n.textContent==='Summary has 2 suspect lines — review it in the summary editor.'));assert.equal(chat.memorySnapshot().session.memoryState?.paused,undefined);
});

for(const full of [false,true])test(`Manual ${full?'full-history':'normal'} summary Stop keeps the active checkpoint and discards unfinished output`,async()=>{
 const h=await harness(),history=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i}));history.push({id:'old-summary',order:13,role:'summary',content:'Existing facts',coveredRange:{fromOrder:1,toOrder:4}});
 const chat=await openImprovementChat(h,{activeSummaryMessageId:'old-summary',breakpointOrder:4},history);Object.assign(h.state.settings,{keepRecentMessagesAfterSummary:2,maxContextTokens:50000});
 let entered;const ready=new Promise(resolve=>entered=resolve);h.calls.onRequest=()=>{entered();return new Promise(()=>{});};
 const running=full ? h.document.dispatchEvent({type:'summarize-full'}) : h.fire('btn-summarize');await ready;
 assert.equal(h.el('btn-stop').classList.contains('hidden'),false);await h.fire('btn-stop');await running;
 assert.equal(h.state.busy,false);assert.equal(chat.memorySnapshot().session.activeSummaryMessageId,'old-summary');assert.equal(chat.memorySnapshot().session.breakpointOrder,4);assert.equal(h.calls.messages.length,0);assert.equal(h.calls.requests.length,1);
});

test('Stale scene confirmation opens carried values and dismissing makes no model or scene writes',async()=>{
 const h=await harness(),raw='date: Day 1 · time: morning · place: Inn · present: Mira',history=[{id:'a',order:1,role:'assistant',content:'At the inn',scene:raw},{id:'b',order:2,role:'assistant',content:'Mira waits',sceneMeta:{kind:'carried',stale:true}},{id:'c',order:3,role:'assistant',content:'Mira continues',sceneMeta:{kind:'carried',stale:true}}];
 await openImprovementChat(h,{memory:{scene:true}},history);const root=h.el('message-list'),notice=root.querySelector('.scene-stale-confirm');assert.ok(notice);
 const before=JSON.stringify(h.calls.history);await notice.querySelectorAll('button').find(b=>b.textContent==='Confirm scene').click();
 const latest=root.children.find(row=>row.dataset.messageId==='c');assert.equal(latest.querySelector('input').value,raw);await latest.querySelectorAll('button').find(b=>b.textContent==='Cancel').click();assert.equal(JSON.stringify(h.calls.history),before);assert.equal(h.calls.requests.length,0);
 // A fresh render displays the confirmation again until explicitly dismissed.
 h.calls.latestCallbacks.at(-1)({messages:history.map(m=>({...m,content:m.content+' '})),hasEarlier:false});
 const dismiss=root.querySelector('.scene-stale-confirm').querySelectorAll('button').find(b=>b.textContent==='Dismiss');await dismiss.click();assert.equal(root.querySelector('.scene-stale-confirm'),null);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.messages.length,0);
});
