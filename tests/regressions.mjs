import { promptFetch, promptImportMeta } from './prompt-files.mjs';
// Run: node --experimental-vm-modules --test tests/regressions.mjs
// Exercise the browser modules with isolated Firestore and DOM substitutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import {indexedDBFixture} from './indexeddb-fixture.mjs';

export async function harness({ legacyNarratorHashes = null, chatCache = null, timers = null, globals = {}, sources = {}, extraStubs = {},firestoreOverrides = {} } = {}) {
  const elements = new Map();
  class Element {
    value = ''; checked = false; hidden = true; style = {}; children = []; dataset = {};
    classList = { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); }, toggle(name, force) { if (force ?? !this.values.has(name)) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } };
    listeners = {};
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    async dispatchEvent(event) {
      for (const fn of this.listeners[event.type] ?? []) await fn(event);
      await new Promise(resolve=>setImmediate(resolve));
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
      const mins = { 'set-rewrite-n': 0, 'set-max-resp': 1, 'set-reasoning-maxtokens': 1, 'set-max-context': 256, 'set-auto-threshold': 1, 'set-keep-n': 0, 'set-summarizer-maxtokens': 256, 'set-summarizer-thinking': 0, 'set-summarizer-chunk': 2000, 'mem-loreNotesPerSection': 0, 'mem-loreLookbackMessages': 0, 'mem-batchTurns': 2, 'mem-lagTurns': 0, 'mem-updateMaxTokens': 256, 'mem-reorganizeMaxTokens': 256, 'mem-blockDepth': 1, 'mem-characters-budget': 0, 'mem-locations-budget': 0, 'mem-facts-budget': 0, 'mem-events-budget': 0, 'mem-characters-maxCards': 1, 'mem-locations-maxCards': 1 };
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
  const localCache = new Map(),stopTimers=new Map();let stopTimerId=0;
  const context = vm.createContext({
    URL, Blob, console, structuredClone, document, TextDecoder, TextEncoder, AbortController, ...globals,
    navigator: { clipboard: { writeText: async text => { calls.clipboard=text; } }, ...globals.navigator },
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
    localStorage: { getItem: (key) => {if(calls.storageBlocked)throw Error('Storage blocked');return localCache.get(key) ?? null;}, setItem: (key, value) => {if(calls.storageBlocked)throw Error('Storage blocked');return localCache.set(key, value);},removeItem:key=>localCache.delete(key) },
    window: { addEventListener(type,fn) { ((calls.windowListeners ??= {})[type] ??= []).push(fn); } }, crypto,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    prompt:()=>calls.prompt,
    setTimeout: timers?.setTimeout ?? ((fn,ms)=>{if(ms===500){const id=++stopTimerId;stopTimers.set(id,fn);return id;}if(ms===300 || ms===0)return setTimeout(fn,0);}), clearTimeout: timers?.clearTimeout ?? (id=>{stopTimers.delete(id);clearTimeout(id);}), confirm: message => { (calls.confirmations ??= []).push(message);return calls.confirmResponses?.length ? calls.confirmResponses.shift() : calls.confirm; },
    fetch: async (_url, options) => {
      if (options?.method === 'GET') {
        (calls.modelRequests ??= []).push({ url: _url, options });
        return calls.modelFetch ? calls.modelFetch(options.signal) : { ok: true, json: async () => ({ data: calls.models ?? [] }) };
      }
      if (_url instanceof URL && _url.protocol === 'file:') {
        if (legacyNarratorHashes && _url.pathname.endsWith('/legacy-prompt-default-hashes.md')) return { ok:true, text:async () => legacyNarratorHashes.split(/\s+/).filter(Boolean).map(hash=>`narratorSystemPrompt ${hash}`).join("\n") };
        return promptFetch(_url, options);
      }
      calls.requests.push(JSON.parse(options.body));
      await calls.onRequest?.(JSON.parse(options.body));
      if(calls.streamReader && JSON.parse(options.body).stream)return {ok:true,body:{getReader:()=>calls.streamReader}};
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
    orderBy() {}, limitToLast: (count) => ({ limitToLast: count }), onSnapshot: (ref, callback, onError) => {if(ref?.[3]!=='settings')(calls.sessionErrors ??= []).push(onError); (ref?.[3] === 'settings' ? calls.settingsCallbacks : calls.sessionCallbacks).push(snap => { if (ref?.[3] !== 'settings' && snap.exists()) { calls.sessionDocs ??= {}; calls.sessionDocs[snap.id] = { id:snap.id,storySettingsRevision:1,...snap.data(),historyRevision:calls.historyRevision ?? snap.data().historyRevision ?? 0 }; } return callback(snap); }); return () => {}; },
    getDoc: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    getDocFromServer: async () => { calls.reads++; return { exists: () => !!calls.settingsDoc, data: () => calls.settingsDoc }; },
    setDoc: async (_ref, settings) => {
      await calls.onSettingsSave?.(settings);
      if (calls.fail) throw new Error('write denied');
      calls.writes.push(structuredClone(settings));
    },
  };
  Object.assign(firestore,firestoreOverrides);
  let fixtureSession,fixtureMessages,fixtureLore;
  const stubs = {
    'story-settings-store.js': {
      preserveLegacyStorySeed:async()=>({}),
      selectStorySettings:async (sid,{force=false}={})=>{
        let fixtureReady=Promise.resolve();if(sid && !force){let ready;fixtureReady=new Promise(resolve=>ready=resolve);calls.sessionCallbacks.push(snap=>{calls.sessionDocs ??= {};calls.sessionDocs[sid]={id:sid,storageVersion:2,continuityVersion:2,lookupVersion:1,storySettingsRevision:1,...snap.data(),historyRevision:calls.historyRevision ?? snap.data().historyRevision ?? 0};fixtureSession?.(calls.sessionDocs[sid],snap.metadata);});calls.latestCallbacks.push(value=>{calls.history=value.messages;const delivery=fixtureMessages?.(value);ready();return delivery?.catch(error=>{if(state.sessionId===sid)throw error;});});}
        state.storySettingsId=sid;state.storySettings=sid ? {version:1,revision:1,values:Object.fromEntries(['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt','rewriteSystemPrompt','rewriteRecentMessages'].map(k=>[k,state.settings[k]]))} : null;await fixtureReady;},
      effectiveActiveSettings:()=>structuredClone({...state.settings,...(state.storySettings?.values ?? {})}),
      saveStorySettings:async(sid,base,changes)=>{if(sid!==state.sessionId)throw Error('Story changed');const result={values:{...base,...changes}};state.storySettings=result;return result;},
      invalidateStorySettingsLoads(){},readStorySettingsRefresh:async()=>{await calls.onPromptsRefresh?.();return calls.serverPrompts ?? {revision:calls.sessionDocs?.[state.sessionId]?.storySettingsRevision ?? 1,values:state.storySettings?.values ?? {}};},applyStorySettingsRefresh:(sid,value)=>{state.storySettingsId=sid;state.storySettings=value;state.storySettingsLoadFailed=false;},
      ensureStorySettings:async()=>({version:1,revision:1,values:{}}),writeInitialStorySettings:async()=>{},
    },
    // The real pet controller is exercised independently in pets.mjs.
    'lore-store.js': {
      getLore:async () => {calls.loreCallbacks ??= [entries=>fixtureLore?.(entries)];calls.loreReads=(calls.loreReads ?? 0)+1;await calls.onLoreRead?.();return calls.loreEntries ?? [];},configureLoreWrites() {},holdLoreWrites:()=>({ready:calls.lorePending ? calls.onLoreWait?.() : Promise.resolve(),release(){}}), loreWritesPending: () => calls.lorePending===true, waitForLoreWrites: async () => calls.onLoreWait?.(),
      subscribeLore: (_sid,cb) => { calls.loreSubscriptions ??= 0; calls.loreSubscriptions++; (calls.loreCallbacks ??= []).push(cb); Promise.resolve().then(() => cb(calls.loreEntries ?? [])); return () => {}; },
      createEntry: async (_sid,e) => { (calls.loreEntries ??= []).push(e); for (const cb of calls.loreCallbacks ?? []) cb(calls.loreEntries); return e.id; },
      saveEntry: async (...args) => { (calls.cardWrites ??= []).push(args); return await calls.onCardSave?.(...args); }, deleteEntry: async (...args) => {await calls.onCardDelete?.(...args);return 'backup';}, mergeEntries: async () => 'backup', writeBackup: async () => 'backup', restoreBackup: async (...args) => { (calls.cardRestores ??= []).push(args); }, listBackups:async()=>calls.onBackups?.() ?? [], removeDeletedLines: async () => 'backup', importCard:async (origin,plan,guard)=>{await calls.onCardImport?.(origin,plan,guard);if(!guard.isCurrent())throw new Error('Card import cancelled.');(calls.cardImports ??= []).push([origin,plan]);calls.loreEntries=(calls.loreEntries ?? []).filter(e=>e.id!==plan.id).concat(plan.data);for(const cb of calls.loreCallbacks ?? [])cb(calls.loreEntries);return 'card-backup';}, importLore: async (...args) => {await calls.onBookImport?.(...args);if(!args[3].isCurrent())throw new Error('Import cancelled.');(calls.bookImports ??= []).push(args);return 'backup';}, replaceLines: async () => 'backup',
    },
    'memory-updater.js': { dueRangeFor:()=>calls.memoryDue ? {} : null,lastRawAnswer: () => '', rebuildFrom:async()=>{}, configureMemoryUpdater() {}, isRunning: () => calls.memoryRunning === true, maybeStartAfterTurn: () => { if (calls.memoryDue) { calls.memoryStarts = (calls.memoryStarts ?? 0)+1; return true; } return false; }, stopAndWait:async id=>{(calls.memoryStopped ??= []).push(id);await calls.onMemoryStop?.();},stop:id=>{(calls.memoryStopped ??= []).push(id);}, stopAll() { calls.memoryStops=(calls.memoryStops ?? 0)+1; }, rebuild:async () => {}, updateNow: async () => {}, catchUp: async () => {calls.catchUps=(calls.catchUps ?? 0)+1;} },
    'ui/pet-view.js': {
      initPetView() {}, startPetTurn() {}, finishPetTurn:status=>{(calls.petFinishes ??= []).push(status);},
      refreshPetPlacement() {}, updatePetPhase() {}, invalidatePetLayout() {},
      loadPetCatalog: async () => [],
    },
    'db.js': { db: {} },
    'auth.js': { currentUid: () => calls.uid ?? 'test-user',currentUserInfo:()=>({uid:'test-user',email:'owner@example.test'}),logout:async()=>{calls.logouts=(calls.logouts ?? 0)+1;if(calls.failLogout)throw Error('Logout failed');} },
    'tokenizer.js': { tokenizerStatus:()=>calls.tokenizerStatus ?? 'ok', estimateTokens:text=>{calls.estimateCalls=(calls.estimateCalls ?? 0)+1;return Math.ceil(text.length*0.306);}, countTokens: async (text) => calls.onTokenCount ? calls.onTokenCount(text) : text.length, setTokenCountingMode: mode=>{calls.tokenCountingMode=mode;} },
    'sessions.js': {
      subscribeSessions:cb=>{calls.sidebarCallback=cb;return ()=>{};},createSession:async()=>{calls.creates=(calls.creates ?? 0)+1;if(calls.onCreate)return calls.onCreate();if(calls.failCreate)throw Error('Create failed');return 'new-story';},renameSession:async()=>{calls.renames=(calls.renames ?? 0)+1;if(calls.failRename)throw Error('Rename failed');},deleteSession:async()=>{if(calls.failDelete)throw Error('Delete failed');},
      getSessionFromServer:async id => {calls.sessionReads=(calls.sessionReads ?? 0)+1;return calls.sessionDocs?.[id] ?? ({ id,title:'Story',longTermPlan:'Old plan',historyRevision:calls.historyRevision ?? 0 });},
      getSession: async id => calls.sessionDocs?.[id] ?? ({ title: 'Story', longTermPlan: 'Old plan' }),
      updateSession: async (...args) => { calls.sessionWrites.push(args); },
      duplicateSession: async (...args) => { calls.sessionCopies ??= []; calls.sessionCopies.push(args); return 'copied-session'; },
    },
    'import-export.js': {exportAllStories:async()=>{}, importSillyTavern: async (file) => { calls.imports.push(file); return 'imported'; }, exportSillyTavern: async (id) => { calls.exports.push(id); } },
    'messages.js': {
      getMessageForEdit:async (...args) => {
        (calls.editReads ??= []).push(args);
        if (calls.getMessageForEdit) return calls.getMessageForEdit(...args);
        return structuredClone((calls.serverHistory ?? calls.history ?? []).find(message => message.id === args[1]));
      },
      editMessage:async (...args) => {
        (calls.edits ??= []).push(args);
        if (calls.editMessage) return calls.editMessage(...args);
        const [sid, id, content, order, metadata] = args;
        const base = (calls.serverHistory ?? calls.history).find(message => message.id === id);
        if (metadata.expectedRevision !== (base.revision ?? 0)) throw Object.assign(new Error('This message was edited elsewhere.'), {name:'MessageEditConflict', currentMessage:base});
        const replacement = {...base, content, order, revision:(base.revision ?? 0)+1};
        calls.history = calls.history.map(message => message.id === id ? replacement : message);
        const historyRevision = (calls.historyRevision ?? 0)+1;
        calls.historyRevision = historyRevision;
        const session = {...calls.sessionDocs[sid], historyRevision}; calls.sessionDocs[sid] = session;
        return {replacement, session, historyRevision};
      },
      HistoryConflict:class HistoryConflict extends Error {},
      findSavedMessage:async(...args)=>{(calls.saveLookups ??= []).push(args);return calls.findSavedMessage?.(...args) ?? null;},
      ensureContinuityMetadata:async () => {},
      clearMessageChunkCache(){},restoreMessageChunkCache:async()=>{},
      getMessages:async () => { const read = calls.historyReads = (calls.historyReads ?? 0)+1; const result = structuredClone(calls.serverHistory ?? calls.history ?? []); await calls.onHistoryRead?.(read); return result; }, getCheckpointMessages: async () => [], newMessageId: () => 'local-'+(++calls.localSequence || (calls.localSequence=1)),
      addMessage:async (...args) => { await calls.onMessageSave?.(...args); if (calls.addMessage) return calls.addMessage(...args); if(args[1].role==='assistant' && args[2]?.expectedSource?.historyRevision !== undefined && args[2].expectedSource.historyRevision !== (calls.historyRevision ?? 0)) throw Object.assign(new Error('History changed'),{name:'HistoryConflict'}); calls.messages.push(args); const result = { ...args[1],id:args[2]?.id ? args[2].id : calls.messageOrder ? 'message-'+(++calls.messageOrder) : 'summary-id',order:calls.messageOrder ?? 1,tokenCount:args[1]?.content?.length ?? 0,historyRevision:(calls.historyRevision ?? 0)+1 }; calls.historyRevision = result.historyRevision; if (calls.sessionDocs?.[args[0]]) Object.assign(calls.sessionDocs[args[0]],args[2]?.sessionUpdate ?? {},{historyRevision:result.historyRevision}); calls.history = [...(calls.history ?? []),structuredClone(result)]; result.session={id:args[0],...(calls.sessionDocs?.[args[0]] ?? {}),historyRevision:result.historyRevision};const committed=structuredClone(result);Object.assign(committed.session,{nextOrder:result.order,nextNarratorTurn:(committed.session.nextNarratorTurn ?? 1)+(args[1].role==='assistant'?1:0)});await calls.onMessageSaved?.(committed);return committed; },
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
  stubs['messages.js'].readMessageSnapshot=async sid=>{await calls.onMessagesRefresh?.();return {messages:await stubs['messages.js'].getMessages(sid),chunkRanges:[],records:[]};};
  stubs['messages.js'].applyMessageSnapshot=()=>{};
  const loreSnapshots=new Map();
  stubs['lore-store.js'].getLoreSnapshot=async(sid,{source='cache'}={})=>{
    const id=sid?.id ?? sid,key=(calls.uid ?? 'test-user')+':'+id;
    if(source==='cache' && loreSnapshots.has(key))return structuredClone(loreSnapshots.get(key));
    const snapshot={version:1,initialized:true,entryRevisions:{},entries:structuredClone(await stubs['lore-store.js'].getLore(id)),loadedRevision:calls.sessionDocs?.[id]?.loreRevision ?? 0,lastCommittedRevision:calls.sessionDocs?.[id]?.loreRevision ?? 0,schemaVersion:2,generation:null};
    if(source==='cache')loreSnapshots.set(key,snapshot);return snapshot;
  };
  stubs['lore-store.js'].publishLoreSnapshot=async(sid,snapshot,{commit}={})=>{await commit?.();loreSnapshots.set((sid.uid ?? calls.uid ?? 'test-user')+':'+(sid.id ?? sid),structuredClone(snapshot));return snapshot;};
  stubs['lore-store.js'].readLoreEntry=async(_sid,id)=>structuredClone(calls.loreEntries?.find(e=>e.id===id) ?? null);
  stubs['lore-store.js'].forgetLoreCache=async(uid,sid)=>{loreSnapshots.delete(uid+':'+sid);};
  Object.assign(stubs,extraStubs);
  if(chatCache)stubs['chat-cache.js']={replaceStoryCache:async()=>{},loadStoryData:async()=>null,saveStoryData:async()=>true,saveDeviceRecoveryBackup:async(...args)=>{(calls.deviceBackups ??= []).push(args);return true;},storyQueueStorage:{load:async()=>null,put:async()=>true,ack:async()=>true},...chatCache};
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
    if(path==='ui/chat-view.js' && !cache.has(path)) {
      const source=sources[path] ?? await readFile(new URL('../js/'+path,import.meta.url),'utf8');
      sources[path]=source+`
export function seedLoreFixture(entries){loreEntries=entries;verifiedLoreRevision=session?.loreRevision ?? 0;}\nexport function seedSessionFixture(value,metadata){if(metadata?.fromCache || metadata?.hasPendingWrites || (value.historyRevision ?? 0)<(session?.historyRevision ?? 0))return;sessionSnapshotVersion++;session=value;syncLore();updateRewriteControls();void updateIndicator();}
export async function seedMessagesFixture(value){lastMessages=value.messages;hasEarlier=value.hasEarlier;latestReady=true;historyMessages=null;historyRevision=null;renderMessages(lastMessages);const all=value.hasEarlier ? await messagesApi.getMessages(state.sessionId) : value.messages;historyMessages=all;if(session){session={...session,nextOrder:Math.max(session.nextOrder ?? 0,...all.map(m=>m.order ?? 0))};}historyRevision=session?.historyRevision ?? 0;const store=storyStore(state.sessionId);if(store && !store.status.pending)store.adopt({session,messages:all,turns:store.view.turns});renderMessages(lastMessages);if(!cacheWritesPaused)await ensureLocalStory();void updateIndicator();}`;
    }
    const module = await load(path);
    if (module.status !== 'evaluated') await module.evaluate();
    if(path==='ui/chat-view.js'){fixtureLore=module.namespace.seedLoreFixture;fixtureSession=module.namespace.seedSessionFixture;fixtureMessages=module.namespace.seedMessagesFixture;}
    return module.namespace;
  }
  const { state } = await use('state.js');
  const settings = await use('settings.js');
  state.settings = settings.hydrateProfiles(structuredClone(settings.DEFAULT_SETTINGS));
  state.settingsSource = "server";
  return { use, state, settings, calls, localCache, document, el: document.getElementById,
    stopAfterGuard:async()=>{for(const [id,fn]of [...stopTimers]){stopTimers.delete(id);fn();}return document.getElementById('btn-stop').dispatchEvent({type:'click'});},
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
  h.el('set-summarizer-maxtokens').value = '60000';
  h.el('set-summarizer-thinking').value = '12000';
  h.el('set-token-counting').value='accurate';
  h.el('set-auto-summary-enabled').checked = true;
  await h.fire('btn-profile-copy');
  const copyId = h.el('set-profiles').value;
  h.el('set-model').value = 'model-b';
  h.el('set-profiles').value = 'default';
  await h.fire('set-profiles', 'change');
  assert.equal(h.el('set-model').value, 'model-a');
  assert.equal(h.calls.writes.length, 0);
  h.el('set-summarizer-thinking').value='60000';
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length,0);
  assert.match(h.el('settings-saved-msg').textContent,/thinking tokens must be lower/);
  h.el('set-summarizer-thinking').value='12000';
  await h.fire('btn-save-settings');
  assert.equal(h.state.settings.keepRecentMessagesAfterSummary, 0);
  assert.equal(h.state.settings.summarizerMaxTokens,60000);
  assert.equal(h.state.settings.summarizerThinkingTokens,12000);
  assert.equal(h.calls.writes.at(-1).summarizerThinkingTokens,12000);
  assert.equal(h.state.settings.tokenCountingMode,'accurate');
  assert.equal(h.calls.tokenCountingMode,'accurate');
  assert.equal(h.calls.writes.at(-1).tokenCountingMode,'accurate');
  assert.equal(h.state.settings.autoSummarizationEnabled, true);
  assert.equal(h.state.settings.profiles.length, 2);
  assert.equal(h.state.settings.profiles.find(p => p.id === copyId).modelId, 'model-b');
  assert.match(h.el('quick-profile').selectedOptions[0].textContent, /model-a/);
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

test('Inline model and thinking selectors restore per-profile choices and recover after failed saves', async () => {
  const h = await harness();
  h.calls.settingsDoc = {
    profiles: [
      {id:'first',name:'First',modelId:'model-a',reasoning:{enabled:true,mode:'effort',effort:'low'}},
      {id:'second',name:'Second',modelId:'model-b',reasoning:{enabled:false,mode:'effort',effort:'medium'}},
    ],
    activeProfileId:'first',
  };
  h.state.settings = await h.settings.loadSettings();
  (await h.use('ui/chat-view.js')).initChatView();
  assert.equal(h.el('quick-thinking').value,'low');
  h.el('quick-profile').value='second'; await h.fire('quick-profile','change');
  assert.equal(h.el('quick-thinking').value,'off');
  h.el('quick-thinking').value='max_tokens'; await h.fire('quick-thinking','change');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.mode,'max_tokens');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.enabled,true);
  h.el('quick-thinking').value='none'; await h.fire('quick-thinking','change');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.effort,'none');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.enabled,true);
  h.el('quick-thinking').value='off'; await h.fire('quick-thinking','change');
  assert.equal(h.settings.activeProfile(h.state.settings).reasoning.enabled,false);
  h.el('quick-profile').value='first'; await h.fire('quick-profile','change');
  assert.equal(h.el('quick-thinking').value,'low');
  assert.equal(h.el('quick-profile').selectedOptions[0].textContent,'model-a · First');
  h.calls.fail=true;
  h.el('quick-thinking').value='high'; await h.fire('quick-thinking','change');
  assert.equal(h.el('quick-thinking').value,'low');
  assert.equal(h.state.settings.reasoning.effort,'low');
  h.el('quick-profile').value='second'; await h.fire('quick-profile','change');
  assert.equal(h.el('quick-profile').value,'first');
  assert.equal(h.el('quick-thinking').value,'low');
  assert.equal(h.state.settings.modelId,'model-a');
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
  assert.match(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /interactive (?:dark fantasy )?roleplay/);
  assert.match(h.settings.DEFAULT_SETTINGS.narratorSystemPrompt, /RESOLVE IN THE SCENE: NO DEFERRAL/);
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
  assert.equal(h.el('quick-profile').selectedOptions[0].textContent, 'model-b · Second');
  assert.equal(h.el('quick-thinking').value, 'off');
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
    maxContextTokens: 14000,maxResponseTokens:100,summarizerMaxTokens:7000,summarizerThinkingTokens:2000,summarizerChunkTokens:900,
    keepRecentMessagesAfterSummary: 0 };
  const messages = Array.from({ length: 8 }, (_, i) => ({ id: String(i), order: i + 1,
    role: i%2 ? 'assistant' : 'user', content: 'event '.repeat(65) }));
  await runSummarization({ id: 's' }, settings, { messages });
  assert.ok(h.calls.requests.length > 1);
  for (const request of h.calls.requests) {
    assert.ok(request.max_tokens > Math.floor(settings.maxContextTokens / 3),JSON.stringify({max:request.max_tokens,model:request.model,input:request.messages.reduce((n,m)=>n+m.content.length,0)}));
    assert.ok(request.max_tokens <= settings.summarizerMaxTokens);
    assert.ok(request.messages.reduce((sum, message) => sum + message.content.length, 0) <= 14000);
  }
});

test('Summarizer preserves configured output limits above the default', async () => {
  const h = await harness();
  const settingsApi = await h.use('settings.js');
  assert.equal(settingsApi.DEFAULT_SETTINGS.summarizerMaxTokens, 50000);
  assert.equal(settingsApi.DEFAULT_SETTINGS.summarizerThinkingTokens,20000);
  assert.equal((await settingsApi.mergeDefaults({summarizerMaxTokens:5000})).summarizerThinkingTokens,2000);
  assert.equal((await settingsApi.mergeDefaults({summarizerMaxTokens:50000,summarizerThinkingTokens:0})).summarizerThinkingTokens,0);
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

test('Summarizer uses its own default thinking budget instead of chat reasoning', async () => {
  const h = await harness();
  const { runSummarization } = await h.use('summarizer.js');
  await runSummarization({ id: 's' }, {
    ...h.state.settings, modelId: 'test', streaming: false,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 20000 },
    keepRecentMessagesAfterSummary: 0,
  }, { messages: Array.from({length:4},(_,i)=>({id:String(i),order:i+1,role:i%2?'assistant':'user',content:'A new event'})) });
  assert.equal(h.calls.requests.length, 1);
  assert.deepEqual(h.calls.requests[0].reasoning, {max_tokens:20000});
  assert.equal(h.calls.requests[0].max_tokens,50000);
  assert.doesNotMatch(h.calls.requests[0].messages[1].content,/within 30000 output tokens|MAX_OUTPUT_TOKENS|ceiling/);
  assert.match(h.calls.requests[0].messages[1].content,/compact, complete replacement summary/);
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

test('Opening a chat loads once without a realtime message subscription', async () => {
  const h = await harness();
  const chat = await h.use('ui/chat-view.js');
  chat.initChatView();
  chat.setSession('story');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.calls.subscriptions, []);assert.equal(h.calls.sessionReads ?? 0,0);
});

test('message header actions keep consistent order and create copies through the selected message', async () => {
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
    const header = message.querySelector('.msg-meta');
    const controls = header.querySelector('.msg-actions');
    assert.ok(controls);
    assert.equal(controls.parentNode, header);
    assert.equal(message.children.some(node => node.matches('.msg-actions')), false);
    assert.equal(controls.children[0].dataset.icon, 'copy');
    assert.equal(message.querySelector('.msg-content').textContent, 'Chosen turn');
    const actions = controls.querySelector('.message-menu-panel').children;
    assert.deepEqual(Array.from(actions, (button) => button.textContent), role === 'assistant'
      ? ['Create story copy', 'Edit', 'Delete', 'Regenerate']
      : ['Create story copy', 'Edit', 'Delete', 'Retry reply']);
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
  assert.equal(h.calls.subscriptions.length,readsBeforeReturn);
  await open('story-c');
  await open('story-d');
  const readsBeforeEvictedReturn = h.calls.subscriptions.length;
  chat.setSession('story-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.subscriptions.length, readsBeforeEvictedReturn);
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
test('legacy stories load no lore and memory stories load it once without a listener',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
  const callback=h.calls.sessionCallbacks.at(-1); callback({ id:'story',exists:() => true,data:() => ({ title:'Story' }) }); assert.equal(h.calls.loreSubscriptions ?? 0,0);
  callback({ id:'story',exists:() => true,data:() => ({ title:'Story',memory:{ autoUpdate:true } }) }); assert.equal(h.calls.loreSubscriptions ?? 0,0);
  callback({ id:'story',exists:() => true,data:() => ({ title:'Story',memory:{ autoUpdate:true },memoryState:{ failureStreak:1 } }) }); assert.equal(h.calls.loreSubscriptions ?? 0,0);
});
test('chat turn ledger gives a due or running update priority over auto-summary, while legacy still summarizes',async () => {
  // The harness counts characters as tokens; keep scheduling coverage independent of the default prompt's size.
  for (const mode of ['due','running','legacy']) {
    const h=await harness(), chat=await h.use('ui/chat-view.js');
    Object.assign(h.state.settings,{ narratorSystemPrompt:'Narrate.',summarizerSystemPrompt:'Summarize the established events.',modelId:'model',apiKey:'test-key',streaming:false,maxContextTokens:10000,maxResponseTokens:1000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:0 });
    h.calls.memoryDue=mode === 'due'; h.calls.memoryRunning=mode === 'running'; h.calls.messageOrder=4; h.calls.response='A complete reply.';
    chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0));
    h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story',...(mode !== 'legacy' ? { memory:{ autoUpdate:true },memoryState:{ extractedThroughOrder:0 } } : {}) }) });
    h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u1',order:1,role:'user',content:'Opening',tokenCount:7 },{ id:'a1',order:2,role:'assistant',content:'Story',tokenCount:5 },{ id:'u2',order:3,role:'user',content:'Next',tokenCount:4 },{ id:'a2',order:4,role:'assistant',content:'Story2',tokenCount:6 }],hasEarlier:false });
    await Promise.resolve(); h.el('chat-input').value='Continue'; await h.el('composer').dispatchEvent({ type:'submit',preventDefault() {} });
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(h.calls.requests.length,mode === 'due' ? 1 : 2,mode); assert.equal(h.calls.memoryStarts ?? 0,mode === 'due' ? 1 : 0); assert.equal(h.state.busy,false);
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
test('context viewer excludes unsent input and Copy request matches the saved-context preview',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'), viewer=await h.use('ui/context-viewer.js'); chat.initChatView(); chat.setSession('story'); await new Promise(resolve => setTimeout(resolve,0)); h.calls.sessionCallbacks.at(-1)({ id:'story',exists:() => true,data:() => ({ title:'Story' }) }); h.calls.latestCallbacks.at(-1)({ messages:[{ id:'u',order:1,role:'user',content:'Start' },{ id:'a',order:2,role:'assistant',content:'Opening' }],hasEarlier:false });
  h.el('chat-input').value='Ask Mira'; viewer.initContextViewer(); viewer.openContextViewer(); await new Promise(resolve => setTimeout(resolve,0)); const root=h.el('context-viewer');await root.querySelectorAll('button').find(b=>b.textContent==='Calculate current preview').click(); assert.ok(root.querySelectorAll('p').some(p => p.textContent.includes('excludes unsent input')));
  await root.querySelectorAll('button').find(b => b.textContent === 'Copy request as text').click(); assert.ok(!h.calls.clipboard.includes('Ask Mira'));assert.ok(h.calls.clipboard.includes('Opening')); assert.equal(h.calls.requests.length,0); assert.equal(h.calls.loreSubscriptions ?? 0,0);
});

test('grouped context viewer lazily reveals exact request text and preserves navigation across refresh',async () => {
  const h=await harness(), chat=await h.use('ui/chat-view.js'), viewer=await h.use('ui/context-viewer.js');
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve=>setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story'})});
  h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Start'}, {id:'a',order:2,role:'assistant',content:'Opening'}],hasEarlier:false});
  h.el('chat-input').value='<script>Draft as literal text</script>';
  viewer.initContextViewer(); viewer.openContextViewer(); await new Promise(resolve=>setTimeout(resolve,0));
  const root=h.el('context-viewer');await root.querySelectorAll('button').find(b=>b.textContent==='Calculate current preview').click();const get=key=>root.querySelectorAll('details').find(d=>d.dataset.contextKey===key);
  assert.equal(get('lorebooks').open,true);
  for(const key of ['instructions','summary','book-characters','book-locations','book-facts','book-events','scene','conversation','updates','full-request']) assert.equal(get(key).open,false,key);
  assert.equal(root.querySelectorAll('pre').length,0,'Long text is lazy');
  const conversation=get('conversation');conversation.open=true;await conversation.dispatchEvent({type:'toggle'});
  assert.equal(root.querySelectorAll('.context-turn-list').length,1);
  const draft=root.querySelectorAll('details').find(d=>d.children[0]?.textContent?.includes('Opening exchange'));
  draft.open=true;await draft.dispatchEvent({type:'toggle'});
  assert.ok(['Start','Opening'].includes(draft.querySelector('pre').textContent));assert.ok(!root.querySelectorAll('pre').some(p=>p.textContent==='<script>Draft as literal text</script>'));
  root.querySelector('.memory-content').scrollTop=120;
  root.querySelectorAll('.context-turn-list').find(d=>d.dataset.scrollKey==='opening').scrollTop=35;
  draft.querySelector('summary').focus();
  await root.querySelectorAll('button').find(b=>b.textContent==='Last sent').click();await root.querySelectorAll('button').find(b=>b.textContent==='View cached current preview').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(get('conversation').open,true);
  assert.equal(get(draft.dataset.contextKey).open,true);
  assert.equal(h.document.activeElement.dataset.focusKey,draft.dataset.contextKey);
  assert.equal(root.querySelector('.memory-content').scrollTop,120);
  assert.equal(root.querySelectorAll('.context-turn-list').find(d=>d.dataset.scrollKey==='opening').scrollTop,35);
  const full=get('full-request');full.open=true;await full.dispatchEvent({type:'toggle'});
  const request=root.querySelectorAll('.context-turn-list').find(d=>d.dataset.scrollKey==='request');
  for(const d of request.querySelectorAll('details')) {d.open=true;await d.dispatchEvent({type:'toggle'});}
  const built=await (await h.use('context-builder.js')).buildContextForRequest(chat.memorySnapshot().session,chat.memorySnapshot().settings,{messages:chat.memorySnapshot().messages,draftText:''});
  assert.deepEqual(request.querySelectorAll('pre').map(p=>p.textContent),Array.from(built.apiMessages,m=>m.content));
  await root.querySelectorAll('button').find(b=>b.textContent==='Copy request as text').click();
  assert.equal(h.calls.clipboard,built.apiMessages.map(m=>'=== '+m.role.toUpperCase()+' ===\n'+m.content).join('\n\n'));
  assert.equal(h.calls.requests.length,0);
  chat.setSession('other');await new Promise(resolve=>setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({id:'other',exists:()=>true,data:()=>({title:'Other'})});
  h.calls.latestCallbacks.at(-1)({messages:[],hasEarlier:false});
  await h.document.dispatchEvent({type:'session-changed'});await new Promise(resolve=>setTimeout(resolve,0));
  await root.querySelectorAll('button').find(b=>b.textContent==='Calculate current preview').click();
  assert.equal(get('conversation').open,false);
  assert.equal(get('lorebooks').open,true);
  assert.equal(root.querySelector('.memory-content').scrollTop,0);
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
    const saved=h.calls.messages.find(c => c[1].role==='assistant')?.[1];assert.ok(saved,JSON.stringify({messages:h.calls.messages,ui:h.el('message-list').children.map(x=>x.textContent),requests:h.calls.requests.length}));
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
    const saved=h.calls.messages.find(c=>c[1].role==='assistant')?.[1];assert.ok(saved,JSON.stringify({messages:h.calls.messages,ui:h.el('message-list').children.map(x=>x.textContent),requests:h.calls.requests.length}));
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
  await (h.calls.settingsDoc ??= h.settings.storedSettings(h.state.settings),chat.syncChatData());const refreshed = await chat.prepareMemorySnapshot(); assert.equal(refreshed.messages[0].content,'Edited on another device'); assert.equal(h.calls.historyReads,reads+1);
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


async function openImprovementChat(h, metadata = {}, messages = []) {
  const chat = await h.use('ui/chat-view.js'); chat.initChatView(); chat.setSession('improvement');
  await new Promise(resolve => setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({ id:'improvement',exists:() => true,data:() => ({ title:'Story',...metadata }) });
  h.calls.latestCallbacks.at(-1)({ messages,hasEarlier:false });
  Object.assign(h.state.settings,{modelId:'model',apiKey:'key',streaming:false});h.settings.mirrorToActiveProfile(h.state.settings); h.calls.messageOrder=messages.length || 1;
  return chat;
}



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
 const list=[{id:'a',role:'assistant',order:1}];assert.equal(chat.turnsFor(list),chat.turnsFor(list));assert.equal(chat.turnsFor(list),chat.turnsFor([...list]));assert.notEqual(chat.turnsFor(list),chat.turnsFor([{...list[0],narratorTurn:2}]));
});

test('Final twenty-turn replay keeps narration plus maintenance at two calls and uses no separate reconciliation read on ordinary sends',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js');Object.assign(h.state.settings,{modelId:'test',apiKey:'fixture-key',narratorSystemPrompt:'Narrate.',streaming:false,maxContextTokens:50000,maxResponseTokens:2000,autoSummarizationEnabled:true,autoSummaryThresholdPercent:1,keepRecentMessagesAfterSummary:2});
 const scene='date: Day 1 · time: night · place: Inn · present: Mira';h.calls.messageOrder=2;h.calls.sessionDocs={story:{id:'story',title:'Story',storySettingsRevision:1,memory:{scene:true,sceneFallback:true,autoUpdate:true},memoryState:{extractedThroughOrder:0},historyRevision:0}};
 chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>h.calls.sessionDocs.story});h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Opening'},{id:'a',order:2,role:'assistant',content:'Mira waits.',scene}],hasEarlier:false});
 const rows=[];let totalCalls=0;for(let turn=0;turn<20;turn++){
  const before=h.calls.requests.length,memoryBefore=h.calls.memoryStarts ?? 0,readsBefore=h.calls.sessionReads ?? 0;h.calls.memoryDue=turn%2===0;
  h.calls.onRequest=()=>{const body=h.calls.requests.at(-1);h.calls.response=body.response_format ? JSON.stringify({date:'Day 1',time:'night',place:'Inn',present:['Mira'],planThread:null}) : body.messages.at(-1).content.includes('New events to fold in:') ? 'Mira remains at the inn.' : 'Mira waits by the door.'+(turn%3 ? '\n<scene>'+scene+'</scene>' : '');};
  h.el('chat-input').value='Continue '+turn;await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
  const calls=h.calls.requests.length-before+(h.calls.memoryStarts ?? 0)-memoryBefore;assert.ok(calls>=1 && calls<=2,'Turn '+turn+': '+calls+' calls');totalCalls+=calls;rows.push({turn:turn+1,modelRequests:h.calls.requests.length-before,memoryJobs:(h.calls.memoryStarts ?? 0)-memoryBefore,totalCalls:calls,reconcileReads:(h.calls.sessionReads ?? 0)-readsBefore});assert.equal(h.state.busy,false);assert.equal((h.calls.sessionReads ?? 0)-readsBefore,0);
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
 await bubble.querySelector('.message-menu-panel').children.find(button=>button.textContent==='Edit').click();
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
 for(const {fn,ms} of [...scheduled.values()])if(ms===1000)fn();
 assert.equal(writes.length,1);assert.equal([...scheduled.values()].some(timer=>timer.ms===1000),false);
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
test('Q5 transaction session metadata stays outside cached story messages',async()=>{
 const h=await harness();const chat=await openImprovementChat(h);h.el('chat-input').value='Start';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.ok(chat.memorySnapshot().messages.length);assert.ok(chat.memorySnapshot().messages.every(m=>!('session'in m)));
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

test('summary checkpoints start collapsed, preserve expansion on rerender, and open for editing',async()=>{
 const h=await harness(),history=[{id:'a',order:1,role:'assistant',content:'Latest narration'},{id:'sum',order:2,role:'summary',content:'A long summary\n'.repeat(200)}];
 await openImprovementChat(h,{activeSummaryMessageId:'sum',breakpointOrder:1},history);
 const row=()=>h.el('message-list').querySelector('[data-message-id="sum"]');
 let details=row().querySelector('.summary-details');assert.equal(details.open,false);assert.equal(details.querySelector('summary').textContent,'Show summary');assert.equal(details.querySelector('.msg-content').textContent,history[1].content);
 details.open=true;await details.dispatchEvent({type:'toggle'});await h.document.dispatchEvent({type:'scene-preference'});
 details=row().querySelector('.summary-details');assert.equal(details.open,true);assert.equal(details.querySelector('summary').textContent,'Hide summary');
 details.open=false;await details.dispatchEvent({type:'toggle'});await row().querySelectorAll('button').find(b=>b.textContent==='Edit').click();
 assert.equal(row().querySelector('.summary-details').open,true);assert.equal(row().querySelector('.msg-editor').value,history[1].content);
 await row().querySelectorAll('button').find(b=>b.textContent==='Cancel').click();assert.equal(row().querySelector('.summary-details').open,true);
});
test('the current checkpoint divider marks the covered-history boundary and disappears after reset',async()=>{
 const h=await harness(),history=[{id:'u1',role:'user',order:1,content:'Old action'},{id:'a1',role:'assistant',order:2,content:'Summarized reply',narratorTurn:7},{id:'u2',role:'user',order:3,content:'Retained action'},{id:'a2',role:'assistant',order:4,content:'Retained reply',narratorTurn:8},{id:'sum',role:'summary',order:5,content:'Summary'}];
 await openImprovementChat(h,{activeSummaryMessageId:'sum',breakpointOrder:2},history);
 const list=h.el('message-list'),divider=list.querySelector('.checkpoint-divider');assert.ok(divider);assert.equal(divider.nextSibling.dataset.messageId,'u2');assert.match(divider.textContent,/Current checkpoint.*T7/);
 await h.document.dispatchEvent({type:'scene-preference'});assert.equal(list.querySelectorAll('.checkpoint-divider').length,1);
 await h.document.dispatchEvent({type:'reset-summary'});assert.equal(list.querySelector('.checkpoint-divider'),null);assert.equal(list.querySelector('[data-message-id="sum"]').querySelector('.msg-meta').querySelector('span').textContent,'Summary checkpoint');
});

test('Q3 P0.14 omitted history indicator shows turns not sent with actionable tooltip',{timeout:10000},async()=>{
  const h=await harness(),history=Array.from({length:40},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'story '+i+' '+ 'x'.repeat(300)}));
  const chat=await openImprovementChat(h,{},history);Object.assign(h.state.settings,{narratorSystemPrompt:'Narrate.',maxContextTokens:3000,maxResponseTokens:100,autoSummarizationEnabled:false});
  // Background preparation can yield across tasks; wait for its result on slower CI runners.
  const updated=new Promise(resolve=>h.document.addEventListener('token-usage-changed',resolve));
  await chat.updateIndicator();await updated;
  assert.match(h.el('context-label').textContent,/input \/ [\d,]+ tokens/);assert.doesNotMatch(h.el('context-label').textContent,/max reply/);
  assert.match(h.el('context-label').textContent,/\d+ turns not sent/);assert.match(h.el('context-label').title,/Older turns no longer fit/);assert.match(h.el('context-label').title,/Turn on auto-summary or run Summarize/);
});


test('B16 kept Stop and timeout partial replies use their actual stop reason',async()=>{
 for(const reason of ['user','timeout']){const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.calls.onRequest=async()=>{throw Object.assign(Error('Interrupted'),{aborted:reason,partial:{content:'Partial story.',thinking:''}});};await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();assert.equal(h.calls.messages.at(-1)[1].truncated,true);assert.ok(h.el('message-list').children.some(n=>reason==='timeout'?/timed out after 120 s/.test(n.textContent ?? ''):/Partial reply saved \(stopped\)/.test(n.textContent ?? '')));assert.ok(!h.el('message-list').children.some(n=>/output limit/.test(n.textContent ?? '')));}
});
test('B14 scene-save revision jumps defer coherent reconciliation until dependent work',async()=>{
 const h=await harness(),initial=[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Reply',scene:'date: Day 1 · time: night · place: Inn'}],chat=await openImprovementChat(h,{memory:{scene:true}},initial);await chat.prepareMemorySnapshot();
 const readsBefore=h.calls.historyReads ?? 0;h.calls.serverHistory=[{...initial[0],content:'Remote action'},initial[1]];
 h.calls.updateScene=async()=>{h.calls.historyRevision=4;h.calls.sessionDocs.improvement.historyRevision=4;return {replacement:{...initial[1],scene:'date: Day 1 · time: night · place: Hall'},baseHistoryRevision:3,historyRevision:4,session:h.calls.sessionDocs.improvement};};
 await h.el('message-list').querySelector('.scene-chip').click();await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Save').click();assert.equal(h.calls.historyReads ?? 0,readsBefore);assert.equal(chat.memorySnapshot().historyComplete,false);assert.match(chat.memorySnapshot().messages[1].scene,/Hall/);assert.equal(h.state.busy,false);h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);await chat.prepareMemorySnapshot();assert.ok(h.calls.historyReads>readsBefore);assert.equal(chat.memorySnapshot().messages[0].content,'Remote action');
});
test('initial estimates receive lore and disabled auto-summary avoids a post-turn recount',async()=>{
 const source=await readFile(new URL('../js/context-builder.js',import.meta.url),'utf8');const observations=[];const h=await harness({globals:{recordUsage:opts=>observations.push(opts)},sources:{'context-builder.js':source.replace('  messages ??= await getMessages(session.id);','  globalThis.recordUsage(opts);\n  messages ??= await getMessages(session.id);')}});
 h.calls.loreEntries=[{id:'l',book:'facts',name:'Magic',alwaysLoad:true,sections:{text:{text:'Canon',lines:[]}}}];const chat=await openImprovementChat(h,{memory:{lorebooks:true}},[{id:'u',order:1,role:'user',content:'Begin.'}]);await chat.updateIndicator();await new Promise(resolve=>setTimeout(resolve,10));const before=observations.length;h.calls.response='Reply.';await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();await new Promise(resolve=>setTimeout(resolve,10));assert.ok(before>0);assert.equal(observations.length,before);assert.ok(observations.every(o=>o.loreEntries?.some(e=>e.id==='l')));
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


test('R2 Ctrl+S validation errors stay in the lorebook UI instead of rejecting unhandled',async()=>{
 const h=await harness();await openImprovementChat(h);const l=await h.use('lore-lines.js'),card=l.makeEntry('facts','Magic');h.calls.loreEntries=[card];const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();lore.openLorebooks({entryId:card.id});await new Promise(resolve=>setImmediate(resolve));
 const name=h.el('lorebook-overlay').querySelectorAll('label').find(label=>label.textContent==='Main name').querySelector('input');name.value='';await name.dispatchEvent({type:'input'});await h.document.dispatchEvent({type:'keydown',key:'s',ctrlKey:true,preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.match(h.document.body.querySelector('.toast').textContent,/Enter a name/);assert.equal(h.calls.cardWrites?.length ?? 0,0);
});

for(const book of ['facts','events'])test(`${book} editor saves recall aliases without changing the main name or thread status`,async()=>{
 const h=await harness();await openImprovementChat(h);const l=await h.use('lore-lines.js');
 const card=l.makeEntry(book,book==='facts'?'Arvayne succession law':'Founders Reception',book==='events'?{kind:'thread',status:'closed'}:{});
 h.calls.loreEntries=[card];const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();lore.openLorebooks({entryId:card.id});await new Promise(resolve=>setImmediate(resolve));
 const root=h.el('lorebook-overlay'),alias=root.querySelectorAll('label').find(label=>label.textContent==='+ add alias').querySelector('input');
 alias.value=book==='facts'?'succession charter':'Founding Banquet';await namedButton(root,'+ add alias').click();await namedButton(root,'Save').click();
 const [,saved]=h.calls.cardWrites.at(-1);assert.equal(saved.name,card.name);assert.equal(saved.status,card.status);assert.deepEqual(Array.from(saved.aliases),[alias.value]);
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
test('a saved prompt closes Settings without falsely reporting unsaved numeric fields',async()=>{
 const h=await harness();h.state.sessionId='story';h.state.storySettingsId='story';h.state.storySettings={values:(await h.use('story-settings.js')).defaultStorySettings()};
 const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();await h.fire('nav-prompts');
 h.el('set-narrator-prompt').value='My saved story prompt';await h.fire('btn-save-settings');assert.match(h.el('settings-saved-msg').textContent,/Story prompts saved/);
 h.calls.confirm=false;const before=h.calls.confirmations?.length ?? 0;await h.fire('btn-close-settings');
 assert.equal(h.el('settings-tab').classList.contains('hidden'),true);assert.equal(h.calls.confirmations?.length ?? 0,before);
});
test('a saved shared setting closes Settings without phantom newer edits',async()=>{
 const h=await harness(),view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();h.el('set-model').value='saved-model';
 await h.fire('btn-save-settings');assert.equal(h.el('settings-saved-msg').textContent,'Saved ✓');
 h.calls.confirm=false;const before=h.calls.confirmations?.length ?? 0;await h.fire('btn-close-settings');
 assert.equal(h.el('settings-tab').classList.contains('hidden'),true);assert.equal(h.calls.confirmations?.length ?? 0,before);
});
test('saving shared settings preserves a genuinely unsaved story prompt and its close warning',async()=>{
 const h=await harness();h.state.sessionId='story';h.state.storySettingsId='story';h.state.storySettings={values:(await h.use('story-settings.js')).defaultStorySettings()};
 const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();await h.fire('nav-prompts');h.el('set-narrator-prompt').value='Still an unsaved prompt';
 await h.fire('nav-model');h.el('set-model').value='saved-model';await h.fire('btn-save-settings');assert.equal(h.el('settings-saved-msg').textContent,'Saved. New edits are unsaved.');
 h.calls.confirm=false;await h.fire('btn-close-settings');assert.equal(h.el('settings-tab').classList.contains('hidden'),false);assert.equal(h.el('set-narrator-prompt').value,'Still an unsaved prompt');
 await h.fire('nav-prompts');await h.fire('btn-save-settings');assert.equal(h.state.storySettings.values.narratorSystemPrompt,'Still an unsaved prompt');
 await h.fire('btn-close-settings');assert.equal(h.el('settings-tab').classList.contains('hidden'),true);
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
 h.calls.serverHistory=[{id:'u',order:1,role:'user',content:'Updated on phone'}];await (h.calls.settingsDoc ??= h.settings.storedSettings(h.state.settings),chat.syncChatData());
 assert.match(h.el('message-list').querySelector('.msg-content').textContent,/Updated on phone/,JSON.stringify({snapshot:chat.memorySnapshot().messages,dom:h.el('message-list').querySelectorAll('.msg-content').map(n=>n.textContent),reads:h.calls.historyReads}));assert.equal(h.calls.requests.length,0);assert.equal(h.state.busy,false);
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

test('F10 a dropped stream can be kept as truncated without scene recovery',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{scene:true,sceneFallback:true}},[{id:'u',order:1,role:'user',content:'Begin.'}]);h.state.settings.streaming=true;
 h.calls.streamLines=['data: {"choices":[{"delta":{"content":"Mira waited."}}]}\n'];
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];assert.equal(saved.content,'Mira waited.');assert.equal(saved.truncated,true);assert.equal(saved.reviewWarnings.length,0);assert.equal(h.calls.requests.length,1);assert.ok(h.calls.confirmations.some(s=>/Keep the partial reply/.test(s)));
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

test('F6 all summary application paths show lint warnings without gating acceptance',async()=>{
 const source=await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8');const h=await harness({sources:{'ui/chat-view.js':source+'\nexport {applySummaryResult as testApplySummaryResult};'}}),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);
 chat.testApplySummaryResult({skipped:true,lintWarnings:[{line:1},{line:2}]});assert.ok(h.el('message-list').children.some(n=>n.textContent==='Summary has 2 suspect lines — review it in the summary editor.'));assert.equal(chat.memorySnapshot().session.memoryState?.paused,undefined);
});

for(const full of [false,true])test(`Manual ${full?'full-history':'normal'} summary Stop keeps the active checkpoint and discards unfinished output`,async()=>{
 const h=await harness(),history=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i}));history.push({id:'old-summary',order:13,role:'summary',content:'Existing facts',coveredRange:{fromOrder:1,toOrder:4}});
 const chat=await openImprovementChat(h,{activeSummaryMessageId:'old-summary',breakpointOrder:4},history);Object.assign(h.state.settings,{keepRecentMessagesAfterSummary:2,maxContextTokens:50000});
 let entered;const ready=new Promise(resolve=>entered=resolve);h.calls.onRequest=()=>{entered();return new Promise(()=>{});};
 const running=full ? h.document.dispatchEvent({type:'summarize-full'}) : h.fire('btn-summarize');await ready;
 assert.equal(h.el('btn-stop').classList.contains('hidden'),false);await h.stopAfterGuard();await running;
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

async function continueChatHarness({scene=false}={}) {
  const h=await rewriteChatHarness();
  h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'<OOC>Explain this</OOC>'},{id:'a',order:2,role:'assistant',content:'Saved prefix.  ',thinking:'Earlier thinking',narratorTurn:1,...(scene ? {scene:'date: Day 1 · time: night · place: Inn · present: Nera'} : {})}],hasEarlier:false});
  h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',memory:{scene,sceneFallback:false}})});
  h.el('chat-input').value='  ';await h.fire('chat-input','input');h.calls.response='New passage.';
  return h;
}
for(const streaming of [false,true])test(`Continue appends without a user write, temporary request only (stream ${streaming})`,async()=>{
  const h=await continueChatHarness();h.state.settings.streaming=streaming;
  if(streaming)h.calls.streamLines=['data: {"choices":[{"delta":{"content":"New passage."},"finish_reason":"stop"}]}\n'];
  assert.equal(h.el('btn-rewrite').textContent,'Continue');assert.equal(h.el('btn-rewrite').disabled,false);
  await h.fire('btn-rewrite');
  assert.equal(h.calls.messages.length,0);assert.equal(h.calls.history.length,2);
  const saved=h.calls.history.at(-1);assert.equal(saved.content,'Saved prefix.  \n\nNew passage.');assert.equal(saved.narratorTurn,1);assert.equal(saved.id,'a');assert.equal(saved.order,2);
  assert.equal(saved.lastContinuation.contentOffset,'Saved prefix.  '.length);
  const req=h.calls.requests[0];assert.equal(req.messages.at(-1).role,'user');assert.match(req.messages.at(-1).content,/Continue the latest assistant reply/);assert.equal(req.messages.filter(m=>m.content.includes('Continue the latest assistant reply')).length,1);
  assert.ok(req.messages.some(m=>m.role==='assistant' && m.content.includes('Saved prefix.')));
  const builder=await h.use('context-builder.js');const ordinary=await builder.buildContextForRequest({id:'story'},h.state.settings,{messages:h.calls.history});assert.ok(ordinary.apiMessages.every(m=>!m.content.includes('Continue the latest assistant reply')));
  assert.equal(h.el('btn-rewrite').disabled,false);
});
test('Repeated Continue and Regenerate replace only the newest passage',async()=>{
  const h=await continueChatHarness();await h.fire('btn-rewrite');h.calls.response='Second passage.';await h.fire('btn-rewrite');
  assert.equal(h.calls.history.at(-1).content,'Saved prefix.  \n\nNew passage.\n\nSecond passage.');
  h.calls.response='Replacement.';
  const reply=h.el('message-list').children.find(n=>n.dataset.messageId==='a');
  await reply.querySelectorAll('button').find(n=>n.textContent==='Regenerate').click();await new Promise(r=>setImmediate(r));
  assert.equal(h.calls.history.at(-1).content,'Saved prefix.  \n\nNew passage.\n\nReplacement.');assert.equal(h.calls.history.length,2);assert.equal(h.calls.messages.length,0);
  assert.ok(h.calls.requests.at(-1).messages.some(m=>m.role==='assistant' && m.content.includes('New passage.') && !m.content.includes('Second passage.')));
});
test('Continue disables at summary checkpoint, while editing and with non-assistant latest turn',async()=>{
  const h=await continueChatHarness();h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',breakpointOrder:2})});assert.equal(h.el('btn-rewrite').disabled,true);
  h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story'})});h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:3,role:'user',content:'Waiting'}],hasEarlier:false});assert.equal(h.el('btn-rewrite').disabled,true);
  h.el('chat-input').value='Rewrite me';await h.fire('chat-input','input');assert.equal(h.el('btn-rewrite').textContent,'Rewrite');assert.equal(h.el('btn-rewrite').disabled,false);
});
test('Continue uses ending scene rather than interpreting the old OOC directive',async()=>{
  const h=await continueChatHarness({scene:true});h.calls.response='The candle dims.\n<scene>date: Day 1 · time: night · place: Inn · present: Nera</scene>';await h.fire('btn-rewrite');
  assert.equal(h.calls.history.at(-1).ooc,false);assert.match(h.calls.history.at(-1).scene,/Inn/);assert.match(h.calls.requests[0].messages.at(-1).content,/scene/i);
});
for(const keep of [false,true])test('Continue interrupted output restores or accepts partial '+keep,async()=>{
 const h=await continueChatHarness();h.state.settings.streaming=true;h.calls.confirm=keep;h.calls.streamLines=['data: {"choices":[{"delta":{"content":"Partial passage"}}]}\n'];await h.fire('btn-rewrite');
 assert.equal(h.calls.history.at(-1).content,keep ? 'Saved prefix.  \n\nPartial passage' : 'Saved prefix.  ');assert.equal(h.calls.overwrites?.length ?? 0,keep ? 1 : 0);
 if(keep)assert.equal(h.calls.history.at(-1).truncated,true);
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent===h.calls.history.at(-1).content));
});
test('Continue previews inline and restores on Stop',async()=>{
 const h=await continueChatHarness();h.state.settings.streaming=true;h.calls.confirm=false;
 let read=0,release,started;const ready=new Promise(r=>started=r);
 h.calls.streamReader={read:async()=>{if(!read++){return {done:false,value:new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Preview passage"}}]}\n')};}started();return new Promise(r=>release=r);},cancel:async()=>release?.({done:true})};
 const running=h.fire('btn-rewrite');await ready;
 assert.equal(h.el('message-list').children.filter(n=>n.className==='msg assistant').length,1);
 assert.equal(h.el('message-list').querySelector('.msg-content').textContent,'<OOC>Explain this</OOC>');
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Saved prefix.  \n\nPreview passage'));
 assert.equal(h.el('btn-rewrite').disabled,true);await h.stopAfterGuard();await running;
 assert.equal(h.calls.overwrites?.length ?? 0,0);assert.equal(h.calls.history.at(-1).content,'Saved prefix.  ');
});

async function cardUI() {
 const h=await harness(),l=await h.use('lore-lines.js'),f=await h.use('lore-format.js');
 const card=l.makeEntry('characters','Mira'),other=l.makeEntry('characters','Other');card.sections.notes.text='Before';h.calls.loreEntries=[card,other];
 await openImprovementChat(h);const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();lore.openLorebooks({entryId:card.id});await new Promise(r=>setImmediate(r));
 return {h,l,f,lore,card,other,root:h.el('lorebook-overlay')};
}
const namedButton=(root,text)=>root.querySelectorAll('button').find(b=>b.textContent===text);
test('single-card paste import previews explicit destination, honors rename, opens result and Undo uses captured story',async()=>{
 const {h,f,card,other,root}=await cardUI();await namedButton(root,'Import into this card…').click();const dialog=h.document.body.querySelector('.memory-sub-sheet');
 const incoming=structuredClone(card);incoming.name=other.name;incoming.sections.notes.text='<script>text only</script>';
 dialog.querySelector('textarea').value=f.serializeCard(incoming,{format:'json',storyId:'improvement'});await namedButton(dialog,'Read pasted text').click();
 assert.ok(dialog.querySelectorAll('pre').some(e=>e.textContent.includes('<script>text only</script>')));assert.equal(dialog.querySelector('select').value,card.id);assert.equal(dialog.querySelectorAll('select')[1].value,'replace');
 await namedButton(dialog,'Import card').click();assert.equal(h.calls.cardImports.length,1);assert.equal(h.calls.cardImports[0][1].id,card.id);assert.equal(root.querySelector('.lore-editor').querySelector('h2').textContent,other.name);
 h.state.sessionId='other-story';await namedButton(h.document.body.querySelector('.toast'),'Undo').click();assert.equal(h.calls.cardRestores[0][0].id,'improvement');assert.equal(h.calls.cardRestores[0][0].uid,'test-user');
});
test('single-card transfers block unsaved editor changes and export defaults to Markdown',async()=>{
 const {h,root}=await cardUI();await namedButton(root,'Export card…').click();const dialog=h.document.body.querySelector('.memory-sub-sheet');assert.equal(dialog.querySelector('select').children[0].value,'md');await namedButton(dialog,'Cancel').click();
 const section=root.querySelectorAll('.lore-section').at(-1).querySelector('textarea');section.value='Unsaved';await section.dispatchEvent({type:'input'});
 await namedButton(root,'Import into this card…').click();assert.match(h.document.body.querySelector('.toast').textContent,/Save or discard/);await namedButton(root,'Export card…').click();assert.match(h.document.body.querySelector('.toast').textContent,/Save or discard/);assert.equal(h.calls.cardImports,undefined);
});
for(const change of ['story','account','destination','cancel'])test('single-card async file read cancels on '+change+' switch',async()=>{
 const {h,f,lore,card,other,root}=await cardUI();await namedButton(root,'Import into this card…').click();const dialog=h.document.body.querySelector('.memory-sub-sheet'),picker=dialog.querySelector('input');let finish;picker.files=[{size:100,text:()=>new Promise(r=>finish=r)}];const pending=picker.dispatchEvent({type:'change'});
 if(change==='story')h.state.sessionId='another';if(change==='account')h.calls.uid='another';if(change==='destination')lore.openLorebooks({entryId:other.id});if(change==='cancel')await namedButton(dialog,'Cancel').click();
 finish(f.serializeCard(card,{storyId:'improvement'}));await pending;assert.equal(h.calls.cardImports,undefined);assert.match(h.document.body.querySelector('.toast').textContent,/cancelled/);
});
test('book list import requires an explicit choice for ambiguous name matches',async()=>{
 const {h,f,lore,card,other,root}=await cardUI();other.aliases=[card.name];await h.document.dispatchEvent({type:'local-lore-saved',detail:{uid:'test-user',sessionId:'improvement',revision:1,snapshot:{entries:[card,other],loadedRevision:0}}});lore.openLorebooks({screen:'list',book:'characters'});await namedButton(root,'Import card…').click();const dialog=h.document.body.querySelector('.memory-sub-sheet');dialog.querySelector('textarea').value=f.serializeCard(card,{storyId:'different'});await namedButton(dialog,'Read pasted text').click();assert.equal(dialog.querySelector('select').value,'');assert.equal(namedButton(dialog,'Import card').disabled,true);assert.ok(dialog.querySelectorAll('p').some(e=>/Several cards match/.test(e.textContent)));
 const select=dialog.querySelector('select');select.value='__new';await select.dispatchEvent({type:'change'});await namedButton(dialog,'Import card').click();assert.equal(h.calls.cardImports.length,1);assert.notEqual(h.calls.cardImports[0][1].id,card.id);
});

test('changing the import preview while a write is queued cancels its captured destination',async()=>{
 const {h,f,root,card}=await cardUI();await namedButton(root,'Import into this card…').click();const dialog=h.document.body.querySelector('.memory-sub-sheet');dialog.querySelector('textarea').value=f.serializeCard(card,{storyId:'improvement'});await namedButton(dialog,'Read pasted text').click();
 let release;h.calls.onCardImport=()=>new Promise(r=>release=r);const pending=namedButton(dialog,'Import card').click();const mode=dialog.querySelectorAll('select')[1];mode.value='merge';await mode.dispatchEvent({type:'change'});release();await pending;assert.equal(h.calls.cardImports,undefined);assert.match(h.document.body.querySelector('.toast').textContent,/cancelled/);
});
test('lore message lookback hydrates, stages and saves per story while rejecting invalid counts',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{lorebooks:true,loreLookbackMessages:8}});const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup(null,{panel:'memory'});await new Promise(r=>setImmediate(r));
 assert.equal(Number(h.el('mem-loreLookbackMessages').value),8);h.el('mem-loreLookbackMessages').value='12';await h.fire('nav-story');await h.fire('nav-memory');assert.equal(Number(h.el('mem-loreLookbackMessages').value),12);await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.at(-1)[1]['memory.loreLookbackMessages'],12);
 h.el('mem-loreLookbackMessages').value='0';await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.at(-1)[1]['memory.loreLookbackMessages'],0);const count=h.calls.sessionWrites.length;
 for(const value of ['-1','1.5','not a number']){h.el('mem-loreLookbackMessages').value=value;await h.fire('btn-save-session');assert.match(h.el('settings-saved-msg').textContent,/whole number/);assert.equal(h.calls.sessionWrites.length,count);}
});

test('generated note limit stages, saves, reloads independently by story and rejects invalid input',async()=>{
 const h=await harness();h.calls.sessionDocs={one:{id:'one',title:'One',memory:{}},two:{id:'two',title:'Two',memory:{loreNotesPerSection:7}}};h.state.sessionId='one';
 const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup(null,{panel:'memory'});await new Promise(r=>setImmediate(r));
 assert.equal(Number(h.el('mem-loreNotesPerSection').value),3);
 h.el('mem-loreNotesPerSection').value='2';await h.fire('nav-story');await h.fire('nav-memory');assert.equal(Number(h.el('mem-loreNotesPerSection').value),2);
 await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.at(-1)[1]['memory.loreNotesPerSection'],2);
 h.calls.sessionDocs.one.memory.loreNotesPerSection=2;
 h.state.sessionId='two';await h.document.dispatchEvent({type:'session-changed',detail:{sessionId:'two',session:h.calls.sessionDocs.two}});assert.equal(Number(h.el('mem-loreNotesPerSection').value),7);
 h.el('mem-loreNotesPerSection').value='0';await h.fire('btn-save-session');assert.equal(h.calls.sessionWrites.at(-1)[1]['memory.loreNotesPerSection'],0);
 const saves=h.calls.sessionWrites.length;
 for(const value of ['-1','1.5','not a number','9007199254740992']){h.el('mem-loreNotesPerSection').value=value;await h.fire('btn-save-session');assert.match(h.el('settings-saved-msg').textContent,/whole number/);assert.equal(h.calls.sessionWrites.length,saves);}
 h.state.sessionId='one';await h.document.dispatchEvent({type:'session-changed',detail:{sessionId:'one',session:h.calls.sessionDocs.one}});assert.equal(Number(h.el('mem-loreNotesPerSection').value),2);
});

test('character selection captures the exact sent request and keeps its report after preview changes',async()=>{
  const h=await harness(),lore=await h.use('lore-lines.js'),core=await h.use('character-core.js'),e=lore.makeEntry('characters','Mira',{id:'mira',alwaysLoad:true});
  e.sections.personality.text='Independent; cannot command the council.';e.sections.appearance.text='Silver eyes.';e.sections.notes.text='Background '.repeat(100);e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'personality'),core.coreSource(e,'appearance')])];h.calls.loreEntries=[e];
  const chat=await openImprovementChat(h,{memory:{lorebooks:true,characterSelection:true,books:{characters:{budget:200,maxCards:8}}}},[{id:'user',order:1,role:'user',content:'Mira asks the council.'}]);
  h.calls.response='A council reply.';await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
  assert.equal(h.calls.requests.length,1);const live=chat.memorySnapshot(),sent=JSON.parse(JSON.stringify(live.sentContext));assert.deepEqual(sent.requestBody,h.calls.requests[0]);assert.deepEqual(sent.apiMessages,h.calls.requests[0].messages);assert.ok(sent.report.characterSelection.characters[0].coreCoverage.constraints);
  const original=JSON.stringify(sent);h.el('chat-input').value='A new draft with ribbons.';e.sections.personality.text='Edited after sending.';
  const viewer=await h.use('ui/context-viewer.js');viewer.initContextViewer();viewer.openContextViewer();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(JSON.stringify(chat.memorySnapshot().sentContext),original);assert.equal(h.calls.requests.length,1);
  const root=h.el('context-viewer'),last=root.querySelectorAll('details').find(d=>d.dataset.contextKey==='last-sent');assert.ok(last);last.open=true;await last.dispatchEvent({type:'toggle'});assert.ok(last.querySelectorAll('summary').some(s=>s.textContent==='Read exact serialized request body'));
  chat.setSession('other');assert.equal(chat.memorySnapshot()?.sentContext ?? null,null);
});

test('core review requires explicit user review and coverage before persisting source references',async()=>{
  const h=await harness(),lore=await h.use('lore-lines.js'),core=await h.use('character-core.js'),ui=await h.use('ui/character-core-editor.js'),e=lore.makeEntry('characters','Mira');e.sections.personality.text='She is independent; cannot read minds.';
  const parent=h.el('core-test');ui.renderCoreEditor(parent,e);const choose=parent.querySelector('select');choose.value=choose.children[0].value;await choose.dispatchEvent({type:'change'});
  await parent.querySelectorAll('button').find(b=>b.textContent==='Add source to bundle').click();
  const approve=()=>parent.querySelectorAll('button').find(b=>b.textContent==='Approve core bundle');await approve().click();assert.equal(e.coreReferences,undefined);
  const labels=parent.querySelectorAll('label');labels.find(l=>l.textContent==='This bundle covers personality').querySelector('input').checked=true;labels.find(l=>l.textContent==='This bundle covers constraints').querySelector('input').checked=true;
  labels.find(l=>l.textContent.startsWith('I reviewed the complete bundle')).querySelector('input').checked=true;await approve().click();
  assert.equal(e.coreReferences.length,1);assert.equal(core.resolveCore(e,e.coreReferences[0]).valid,true);assert.equal(h.calls.requests.length,0);
  e.sections.personality.text+=' Changed.';ui.renderCoreEditor(h.el('core-other'),e);assert.ok(h.el('core-other').querySelectorAll('p').some(p=>p.textContent.startsWith('Needs review')));
});

test('Context indicator excludes unsent input, skips typing recounts, and refreshes after replies',async()=>{
  const jobs=new Map();let next=0;const tracker={drafts:[],continuations:0};
  const original=await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8');
  const source=original.replace('computeContextUsage, normalizeAdDirective','computeContextUsage as actualUsage, normalizeAdDirective').replace('import {continuationTarget,','import {continuationTarget as actualTarget,')+`\nfunction computeContextUsage(...args){tracker.drafts.push(args[3].draftText);return actualUsage(...args);}\nfunction continuationTarget(...args){tracker.continuations++;return actualTarget(...args);}\n`;
  const h=await harness({sources:{'ui/chat-view.js':source},globals:{tracker},timers:{setTimeout:(fn,ms)=>{jobs.set(++next,{fn,ms});return next;},clearTimeout:id=>jobs.delete(id)}});
  const chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'},{id:'a',order:2,role:'assistant',content:'Opening.'}]);
  await chat.updateIndicator();const previous=h.el('context-label').textContent;tracker.drafts.length=0;
  h.document.activeElement=h.el('chat-input');await h.fire('chat-input','focus');
  h.el('chat-input').value='First draft';await h.fire('chat-input','input');const continuations=tracker.continuations;
  h.el('chat-input').value='Latest draft\nwith more text';await h.fire('chat-input','input');assert.equal(tracker.continuations,continuations);
  await chat.updateIndicator();await h.document.dispatchEvent({type:'settings-changed'});
  h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Begin.'},{id:'a',order:2,role:'assistant',content:'Remote opening update.'}],hasEarlier:false});
  await new Promise(r=>setImmediate(r));assert.equal(tracker.drafts.length,0);assert.equal(h.el('context-label').textContent,previous);
  // Explicit refresh may run while focused, but never includes the draft.
  for(const [id,j]of [...jobs])if(j.ms===300){jobs.delete(id);j.fn();}
  await new Promise(r=>setImmediate(r));assert.deepEqual(tracker.drafts,['']);
  tracker.drafts.length=0;
  h.el('chat-input').value='Unsent typing';await h.fire('chat-input','input');
  await h.fire('chat-input','blur');await new Promise(r=>setImmediate(r));assert.equal(tracker.drafts.length,0);
  h.document.activeElement=h.el('chat-input');h.el('chat-input').value='Exact latest action';await h.fire('chat-input','input');
  h.calls.response='New reply.';let sent=false;const sending=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}}).finally(()=>sent=true);
  for(let i=0;i<100 && !sent;i++){for(const [id,j]of [...jobs])if(j.ms===0){jobs.delete(id);j.fn();}await new Promise(r=>setImmediate(r));}
  assert.equal(sent,true);await sending;
  assert.equal(h.calls.messages[0][1].content,'Exact latest action');assert.ok(h.calls.requests[0].messages.some(m=>m.role==='user'&&m.content==='Exact latest action'));
  for(const [id,j]of [...jobs])if(j.ms===300){jobs.delete(id);j.fn();}
  await new Promise(r=>setImmediate(r));
  assert.equal(tracker.drafts.length,0,'Use the completed request estimate without a post-turn recount');
  assert.match(h.el('context-label').title,/unsent input/);assert.match(h.el('context-label').textContent,/last sent/);
});

async function oldMessageEditor({read, save}={}) {
  const h=await harness(), chat=await h.use('ui/chat-view.js');
  chat.initChatView(); chat.setSession('story'); await new Promise(resolve=>setTimeout(resolve,0));
  h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',historyRevision:2})});
  h.calls.latestCallbacks.at(-1)({messages:[{id:'old',role:'user',order:1,content:'Cached old turn',revision:0},{id:'last',role:'assistant',order:200,content:'Newest reply'}],hasEarlier:true});
  h.calls.serverHistory=[{id:'old',role:'user',order:1,content:'Current server turn',revision:2},{id:'last',role:'assistant',order:200,content:'Newest reply'}];
  if(read)h.calls.getMessageForEdit=read;
  if(save)h.calls.editMessage=save;
  const list=h.el('message-list');list.scrollHeight=2000;list.clientHeight=500;list.scrollTop=280;
  const bubble=list.children.find(node=>node.dataset.messageId==='old');
  const pending=bubble.querySelector('.message-menu-panel').children.find(button=>button.textContent==='Edit').click();
  return {h,chat,bubble,pending};
}






test('Late old-message editor reads cannot mutate another story with a copied message ID',async()=>{
  let resolve;const read=new Promise(done=>{resolve=done;});
  const {h,chat,pending}=await oldMessageEditor({read:()=>read});
  chat.setSession('other');h.el('message-list').replaceChildren();resolve({id:'old',role:'user',order:1,revision:9,content:'Old story server value'});await pending;
  assert.equal(h.state.sessionId,'other');assert.equal(h.el('message-list').querySelector('.msg-editor'),null);assert.equal(h.calls.edits,undefined);
});


test('Edit focuses an editable field synchronously and keeps it editable during the server refresh',async()=>{
  let resolve;const server=new Promise(done=>{resolve=done;});
  const {h,bubble,pending}=await oldMessageEditor({read:()=>server});
  const editor=bubble.querySelector('.msg-editor');
  assert.equal(h.document.activeElement,editor);assert.notEqual(editor.readOnly,true);
  editor.value='Typed while loading';
  resolve({id:'old',role:'user',order:1,revision:0,content:'Cached old turn'});await pending;
  assert.equal(editor.value,'Typed while loading');assert.equal(h.document.activeElement,editor);assert.notEqual(editor.readOnly,true);
});

test('Deleted-turn lore warning completes without loading full history',async()=>{
  const h=await harness(),chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('story');await new Promise(r=>setTimeout(r,0));
  h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',historyRevision:2})});
  h.calls.latestCallbacks.at(-1)({messages:[{id:'a',role:'assistant',order:200,content:'Delete me'}],hasEarlier:true});
  await h.document.dispatchEvent({type:'lorebook-visibility',detail:{open:true}});
  h.calls.loreCallbacks.at(-1)([{id:'mira',book:'characters',name:'Mira',sections:{notes:{text:'',lines:[{id:'note',text:'A fact',src:200}]}}}]);
  const before=h.calls.historyReads ?? 0;
  let warning;h.document.addEventListener('memory-toast',event=>{warning=event.detail;});
  const bubble=h.el('message-list').children.find(n=>n.dataset.messageId==='a');
  await bubble.querySelector('.message-menu-panel').children.find(b=>b.textContent==='Delete').click();
  assert.equal(h.calls.historyReads ?? 0,before);assert.equal(h.state.busy,false);assert.match(warning.text,/1 memory notes/);
});

async function sendFixture({memory = {lorebooks:true}} = {}) {
  const h=await harness();
  const chat=await openImprovementChat(h,{storySettingsRevision:1,memory,loreRevision:1,historyRevision:0},[
    {id:'opening',role:'user',content:'Opening',order:1}]);
  await chat.prepareMemorySnapshot();
  h.calls.messageOrder=1;
  const before={story:h.calls.sessionReads ?? 0,history:h.calls.historyReads ?? 0,lore:h.calls.loreReads ?? 0};
  return {h,chat,before,send:async()=>{h.el('chat-input').value='Saved action';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});}};
}
test('save-first Send uses valid history and lore without separate reads',async()=>{
  const {h,before,send}=await sendFixture();await send();
  assert.equal(h.calls.sessionReads ?? 0,before.story);assert.equal(h.calls.historyReads ?? 0,before.history);assert.equal(h.calls.loreReads ?? 0,before.lore);
  assert.equal(h.calls.messages.filter(c=>c[1].role==='user').length,1);assert.equal(h.calls.requests.length,1);
  assert.equal(h.calls.requests[0].messages.filter(m=>m.content==='Saved action').length,1);
});
test('save-first Send uses loaded local prompts despite a newer settings revision without forced refresh',async()=>{
 const {h,chat,before,send}=await sendFixture();h.calls.sessionDocs.improvement.storySettingsRevision=2;
 await send();assert.equal(h.calls.requests.length,1);assert.equal(h.calls.messages.filter(c=>c[1].role==='user').length,1);assert.equal(h.el('chat-input').value,'');assert.equal(h.state.busy,false);
 assert.equal(h.calls.sessionReads ?? 0,before.story);assert.equal(h.calls.historyReads ?? 0,before.history);assert.equal(h.calls.loreReads ?? 0,before.lore);
 assert.equal(chat.memorySnapshot().messages.at(-1).role,'assistant');
});

test('background memory status changes while building context do not cancel a saved Send',async()=>{
 const source=await readFile(new URL('../js/context-builder.js',import.meta.url),'utf8');let h,changed=false;
 h=await harness({globals:{changeMemoryStatus:()=>{if(changed)return;changed=true;h.calls.sessionCallbacks.at(-1)({data:()=>({...h.calls.sessionDocs.improvement,memoryState:{failureStreak:1,lastError:'Background status'}})});}},sources:{'context-builder.js':source.replace('export async function buildContextForRequest(', 'async function capturedBuildContext(')+`
export async function buildContextForRequest(...args){const result=await capturedBuildContext(...args);globalThis.changeMemoryStatus();return result;}
`}});
 await openImprovementChat(h,{},[{id:'u',role:'user',order:1,content:'Opening'}]);h.el('chat-input').value='Continue';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(changed,true);assert.equal(h.calls.requests.length,1);assert.equal(h.state.busy,false);assert.equal(h.calls.messages.filter(c=>c[1].role==='user').length,1);
});

test('history changes during a read do not repeat the bulk download or label it as newer history',async()=>{
 const source=await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8');
 const h=await harness({sources:{'ui/chat-view.js':source+`
export async function readHistoryOnceFixture(){historyMessages=null;historyRevision=null;return ensureHistory(true);}`}}),chat=await openImprovementChat(h,{},[{id:'old',role:'assistant',order:1,content:'Cached'}]);await settle();
 const before=h.calls.historyReads ?? 0;h.calls.serverHistory=[{id:'server',role:'assistant',order:1,content:'Captured history'}];
 h.calls.onHistoryRead=()=>h.calls.sessionCallbacks.at(-1)({data:()=>({...h.calls.sessionDocs.improvement,historyRevision:(h.calls.sessionDocs.improvement.historyRevision ?? 0)+1})});
 const messages=await chat.readHistoryOnceFixture();assert.equal(h.calls.historyReads,before+1);assert.equal(messages[0].content,'Captured history');assert.equal(chat.memorySnapshot().historyComplete,false);assert.equal(h.state.busy,false);
});
test('save-first Send preserves automatic memory-start initialization',async()=>{
  const h=await harness();const chat=await openImprovementChat(h,{storySettingsRevision:1,memory:{autoUpdate:true,lagTurns:2},memoryState:{}},[]);
  let pointer;h.calls.onRequest=()=>{pointer=chat.memorySnapshot().session.memoryState.extractedThroughOrder;};
  h.el('chat-input').value='Start';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
  assert.ok(h.calls.messages.some(([,m,opts])=>m.role==='user' && opts.sessionUpdate?.memoryState?.extractedThroughOrder===0));
  assert.equal(pointer,0);assert.equal(h.calls.requests.length,1);
});
test('save-first Send preserves newer subscription metadata at the committed history revision',async()=>{
  const {h,chat,before,send}=await sendFixture();
  h.calls.onMessageSaved=result=>{
    if(result.role==='user')h.calls.sessionCallbacks.at(-1)({id:'improvement',exists:()=>true,data:()=>({...result.session,title:'Newer title'})});
  };
  await send();assert.equal(h.calls.sessionReads ?? 0,before.story);assert.equal(h.calls.requests.length,1);assert.equal(chat.memorySnapshot().session.title,'Newer title');
});

async function bookPreview({book='characters',mode='merge',empty=false}={}) {
 const ctx=await cardUI(),{h,f,l,lore,root}=ctx;
 const fact=l.makeEntry('facts','World'),closed=l.makeEntry('events','Closed quest',{kind:'thread',status:'closed'}),timeline=l.makeEntry('events','Timeline',{kind:'timeline'});
 const scheduled=l.makeEntry('plan','Festival',{schedule:{start:'21/10/738',end:'22/10/738',status:'pending',phases:[]}});scheduled.sections.text.text='Keep the invitation pending.';
 h.calls.loreEntries=[ctx.card,ctx.other,fact,closed,timeline,scheduled];for(const cb of h.calls.loreCallbacks ?? [])cb(h.calls.loreEntries);
 lore.openLorebooks({screen:'list',book});await namedButton(root,'Import book…').click();
 const selects=root.querySelectorAll('select');assert.equal(selects[0].value,'merge');assert.equal(selects[1].value,'mine');selects[0].value=mode;
 await namedButton(root,'Paste text').click();const paste=h.document.body.querySelectorAll('.memory-sub-sheet').at(-1);paste.querySelector('textarea').value=f.toJson(empty?[]:h.calls.loreEntries,{books:empty?[book]:undefined});await namedButton(paste,'Read').click();
 return {...ctx,preview:h.document.body.querySelectorAll('.memory-sub-sheet').at(-1)};
}
for(const book of ['characters','locations','facts','events','plan'])test('category action previews only '+book+' and uses captured destination',async()=>{
 const {h,preview}=await bookPreview({book,mode:'replace'});assert.equal(preview.querySelectorAll('summary').length,1);await namedButton(preview,'Import').click();assert.equal(h.calls.bookImports.length,1);const [origin,plan,,guard]=h.calls.bookImports[0];assert.equal(origin.id,'improvement');assert.equal(origin.uid,'test-user');assert.equal(plan.book,book);assert.equal(guard.book,book);assert.ok(plan.writes.every(w=>w.delete || w.data.book===book));
 const ctx=await bookPreview({book,mode:'replace',empty:true});assert.ok(ctx.preview.querySelector('summary').textContent.includes('0 new'));if(book==='characters')assert.ok(ctx.preview.querySelector('summary').textContent.includes('2 removed'));
});
for(const change of ['lore','choices','story','account','category','close'])test('book preview rejects '+change+' changes',async()=>{
 const {h,lore,root,preview}=await bookPreview();const importButton=namedButton(preview,'Import');
 if(change==='lore'){h.calls.loreEntries[0].name='Changed';for(const cb of h.calls.loreCallbacks ?? [])cb(h.calls.loreEntries);}
 if(change==='choices')root.querySelectorAll('select')[0].value='replace';
 if(change==='story')h.state.sessionId='another';
 if(change==='account')h.calls.uid='another';
 if(change==='category')lore.openLorebooks({screen:'list',book:'facts'});
 if(change==='close')await namedButton(preview,'Cancel').click();
 await importButton.click();assert.equal(h.calls.bookImports,undefined);assert.match(h.document.body.querySelector('.toast').textContent,/changed|cancelled/);
});
test('book Undo uses captured story and category after navigating away',async()=>{
 const {h,lore,preview}=await bookPreview();await namedButton(preview,'Import').click();lore.openLorebooks({screen:'list',book:'facts'});h.state.sessionId='another';await namedButton(h.document.body.querySelector('.toast'),'Undo').click();assert.equal(h.calls.cardRestores[0][0].id,'improvement');assert.equal(h.calls.cardRestores[0][3].book,'characters');
});
for(const book of ['characters','locations','facts','events','plan'])for(const format of ['md','json'])test('Export book includes hidden '+book+' cards in '+format,async()=>{
 const {h,l,f,lore,root,card,other}=await cardUI(),exports=[];
 const timeline=l.makeEntry('events','Timeline',{kind:'timeline'}),closed=l.makeEntry('events','Closed',{kind:'thread',status:'closed'}),open=l.makeEntry('events','Open',{kind:'thread',status:'open'}),fact=l.makeEntry('facts','World'),place=l.makeEntry('locations','Inn');
 const scheduled=l.makeEntry('plan','Festival',{schedule:{start:'21/10/738',end:'22/10/738',status:'pending',phases:[]}});scheduled.sections.text.text='Keep the invitation pending.';
 h.calls.loreEntries=[card,other,timeline,closed,open,fact,place,scheduled];for(const cb of h.calls.loreCallbacks ?? [])cb(h.calls.loreEntries);
 lore.openLorebooks({screen:'list',book,filter:'always'});const search=root.querySelector('input');search.value='No match';await search.dispatchEvent({type:'input'});
 const create=h.document.createElement;h.document.createElement=tag=>{const e=create(tag);if(tag==='a')e.click=async()=>exports.push({name:e.download,text:await (await fetch(e.href)).text()});return e;};
 await namedButton(root,'Export book…').click();const dialog=h.document.body.querySelectorAll('.memory-sub-sheet').at(-1);const select=dialog.querySelector('select');select.value=format;await select.dispatchEvent({type:'change'});await namedButton(dialog,'Export book').click();await new Promise(r=>setImmediate(r));
 assert.equal(exports.length,1);assert.match(exports[0].name,new RegExp('-'+book+'-.*\\.'+format+'$'));const parsed=format==='md'?f.fromMarkdown(exports[0].text):f.fromJson(exports[0].text);assert.deepEqual(Array.from(parsed.entries,e=>e.name).sort(),h.calls.loreEntries.filter(e=>e.book===book).map(e=>e.name).sort());
});
test('queued category import cancels when navigation changes before store execution',async()=>{
 const {h,lore,preview}=await bookPreview({mode:'replace'});let release;h.calls.onBookImport=()=>new Promise(r=>release=r);const pending=namedButton(preview,'Import').click();lore.openLorebooks({screen:'list',book:'facts'});release();await pending;assert.equal(h.calls.bookImports,undefined);
});
test('partial category import exposes Undo with originating account and category',async()=>{
 const {h,preview}=await bookPreview();h.calls.onBookImport=()=>{throw Object.assign(new Error('Import partially completed; backup retained.'),{backupId:'partial'});};await namedButton(preview,'Import').click();assert.match(h.document.body.querySelector('.toast').textContent,/partially completed/);await namedButton(h.document.body.querySelector('.toast'),'Undo').click();assert.equal(h.calls.cardRestores[0][1],'partial');assert.equal(h.calls.cardRestores[0][3].book,'characters');
});
test('Refresh book preview reviews updated choices before writing',async()=>{
 const {h,root,preview}=await bookPreview();root.querySelectorAll('select')[0].value='replace';await namedButton(preview,'Refresh preview').click();const fresh=h.document.body.querySelectorAll('.memory-sub-sheet').at(-1);assert.match(fresh.querySelector('summary').textContent,/2 removed/);await namedButton(fresh,'Import').click();assert.equal(h.calls.bookImports.length,1);assert.equal(h.calls.bookImports[0][1].writes.filter(w=>w.delete).length,2);
});

test('model discovery selection stays in the profile draft until explicit Save settings', async () => {
  const h = await harness();
  (await h.use('ui/chat-view.js')).initChatView();
  const view = await h.use('ui/settings-view.js'); view.initSettingsView(); view.openSettingsPopup();
  const liveModel = h.state.settings.modelId, reads = h.calls.reads;
  h.el('set-endpoint').value = 'https://host/custom/chat/completions?foo=bar';
  h.el('set-apikey').value = 'draft-key';
  h.calls.models = [{ id: 'provider/selected', name: 'Selected' }];
  await h.fire('btn-fetch-models');
  assert.equal(h.calls.modelRequests[0].url, 'https://host/custom/models?foo=bar');
  assert.equal(h.calls.modelRequests[0].options.headers.Authorization, 'Bearer draft-key');
  h.el('model-list').value = 'provider/selected'; await h.fire('model-list');
  assert.equal(h.el('set-model').value, 'provider/selected');
  assert.equal(h.state.settings.modelId, liveModel);
  assert.equal(h.calls.reads, reads); assert.equal(h.calls.writes.length, 0);
  await h.fire('btn-profile-copy');
  assert.equal(h.el('set-model').value, 'provider/selected');
  await h.fire('btn-save-settings');
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].profiles[0].modelId, 'provider/selected');
  assert.equal(h.state.settings.modelId, 'provider/selected');
  assert.equal(h.state.settings.apiKey, 'draft-key');
});

test('settings profile switch, defaults, close and reload cancel model discovery', async () => {
  for (const action of ['profile', 'defaults', 'close', 'reload']) {
    const h = await harness(), view = await h.use('ui/settings-view.js');
    view.initSettingsView(); view.openSettingsPopup();
    let resolve, signal;
    h.calls.modelFetch = captured => { signal = captured; return new Promise(done => { resolve = done; }); };
    const pending = h.fire('btn-fetch-models');
    if (action === 'profile') await h.fire('set-profiles', 'change');
    if (action === 'defaults') await h.fire('btn-reset-settings');
    if (action === 'close') await h.fire('btn-close-settings');
    if (action === 'reload') await h.document.dispatchEvent({ type: 'settings-changed' });
    assert.equal(signal.aborted, true, action);
    resolve({ ok: true, json: async () => ({ data: [{ id: 'stale' }] }) });
    await pending;
    assert.equal(h.el('model-picker').hidden, true, action);
    assert.equal(h.el('btn-fetch-models').disabled, false, action);
    assert.equal(h.el('model-status').textContent, '', action);
  }
});

for(const time of ['15:40','3:40pm','3:40 PM']) for(const mode of ['normal','stream','thinking','recovery'])
test(`numeric scene collection ${time} via ${mode} survives reload and next request`,async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js');
 const raw=`date: 21/10/738 · time: ${time} · place: Inn · present: Mira`;
 const prose='Mira waits by the door.';
 Object.assign(h.state.settings,{modelId:'model',apiKey:'fixture',streaming:mode==='stream'});
 h.calls.messageOrder=2;
 chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',memory:{scene:true,sceneFallback:true}})});
 const old={id:'a',order:2,role:'assistant',content:'At the inn.',scene:'date: 21 October 738 · time: 15:40 · place: Inn · present: Mira'};
 h.calls.latestCallbacks.at(-1)({messages:[{id:'u',role:'user',order:1,content:'Start.'},old],hasEarlier:false});
 h.calls.onRequest=()=>{
  if(mode==='thinking') h.calls.responseData={choices:[{message:{content:prose,reasoning:'Scene tag: '+raw}}]};
  else if(mode==='recovery') h.calls.response=h.calls.requests.length===1?prose:JSON.stringify({date:'21/10/738',time,place:'Inn',present:['Mira'],planThread:null});
  else h.calls.response=prose+'\n<scene>'+raw+'</scene>';
 };
 if(mode==='stream') {
  const split=time.indexOf(':')+1;
  const parts=[prose+'\n<sc','ene>date: 21/10/738 · time: '+time.slice(0,split),time.slice(split)+' · place: Inn · present: Mira</sce','ne>'];
  h.calls.streamLines=[...parts.map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n'),
   'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n','data: [DONE]\n\n'];
 }
 h.el('chat-input').value='Continue.';
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];
 assert.equal(saved.scene,raw);assert.equal(saved.content,prose);
 assert.equal(h.calls.requests.length,mode==='recovery'?2:1,'Readable tags and reasoning need no recovery call');
 assert.equal(saved.sceneMeta.kind,mode==='recovery'?'inferred':'declared');
 if(mode==='thinking')assert.equal(saved.sceneMeta.source,'thinking');
 const reloaded=JSON.parse(JSON.stringify([{id:'u',role:'user',order:1,content:'Start.'},old,{...saved,id:'saved',order:4},{id:'next',role:'user',order:5,content:'Continue.'}]));
 const scene=await h.use('scene.js');assert.equal(scene.latestScene(reloaded).scene.raw,raw);
 const built=await (await h.use('context-builder.js')).buildContextForRequest({memory:{scene:true}},h.state.settings,{messages:reloaded,loreEntries:[],requireLatestUser:true});
 const client=await h.use('llm-client.js');
 const body=client.buildRequestBody(h.state.settings,built.apiMessages);
 assert.ok(body.messages.some(m=>m.content.includes(raw)),'Next serialized request retains written date and time');
});

test('Director-mode Send saves the player first, persists the contract before narration, and ignores conflicting scene tags',async()=>{
 let pending=null,h;
 const seed={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
 h=await harness({extraStubs:{'director-store.js':{discardPendingDirector:async()=>{},getDirectorTurn:async()=>pending,savePendingDirectorTurn:async(_sid,turn,source)=>{assert.equal(h.calls.messages.filter(c=>c[1].role==='user').length,1);pending={...turn,source,status:'pending'};return pending;}}}});
 Object.assign(h.state.settings,{modelId:'narrator',apiKey:'key',streaming:false,narrationMode:'director',directorProfileId:'director-profile',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,activeProfileId:'narrator-profile',profiles:[{id:'narrator-profile',endpoint:'https://narrator.test',apiKey:'key',modelId:'narrator'},{id:'director-profile',endpoint:'https://director.test',apiKey:'small-key',modelId:'director'}]});
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',directorState:seed,memory:{scene:true}})});
 h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Start'},{id:'a',order:2,role:'assistant',content:'At dinner',scene:'date: 21/10/738 · time: Hour 20 · place: Inn · present: Nera'}],hasEarlier:false});h.calls.messageOrder=2;
 h.calls.onRequest=body=>{if(body.model==='director'){assert.equal(pending,null);h.calls.response=JSON.stringify({version:1,action:'narrate',transition:'completed',objective:'Finish dinner',stopCondition:'Stop before the next player action',memoryIds:[],requiredMemoryIds:[],updates:{scene:{time:'21:00'}}});}else{assert.ok(pending);h.calls.response='The plates are cleared.\n<scene>date: 22/10/738 · time: Hour 4 · place: Palace · present: Stranger</scene>';}};
 h.el('chat-input').value='Finish dinner';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.calls.requests.length,2,JSON.stringify({pending,requests:h.calls.requests.map(r=>r.model),messages:h.el('message-list').children.map(n=>n.textContent)}));assert.equal(h.calls.requests[0].model,'director');assert.equal(h.calls.requests[1].model,'narrator');
 const saved=h.calls.messages.find(c=>c[1].role==='assistant')[1];assert.match(saved.scene,/time: 21:00/);assert.match(saved.scene,/place: Inn/);assert.ok(saved.directorTurnId);assert.ok(saved.reviewWarnings.some(w=>/disagreed/.test(w)));
 assert.ok(chat.memorySnapshot().sentContext.director.requestBody);assert.equal(h.state.busy,false);
});

test('Cut-off Director Re-plan preserves the original reply and provides Continue replacement recovery',async()=>{
 let h,pending;const seed={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
 const old={id:'old-director',version:1,status:'completed',before:seed,after:seed,contract:{version:1,action:'narrate',transition:'unchanged',objective:'Dinner',stopCondition:'Stop',memoryIds:[],requiredMemoryIds:[],updates:{}},assistantId:'a',previousCheckpoint:null};
 h=await harness({extraStubs:{'director-store.js':{getDirectorTurn:async(_sid,id)=>id===old.id?old:pending,savePendingDirectorTurn:async(_sid,t,source)=>{pending={...t,status:'pending',source};h.calls.sessionDocs.story.directorPending=t.id;return pending;},discardPendingDirector:async()=>{}}}});
 Object.assign(h.state.settings,{modelId:'narrator',apiKey:'key',streaming:false,narrationMode:'director',directorProfileId:'small',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,activeProfileId:'large',profiles:[{id:'large',endpoint:'https://narrator.test',apiKey:'key',modelId:'narrator'},{id:'small',endpoint:'https://director.test',apiKey:'key',modelId:'director'}]});
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('story');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',directorState:seed,directorCheckpoint:old.id,memory:{scene:true}})});
 h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Dinner'},{id:'a',order:2,role:'assistant',content:'Original dinner reply',directorTurnId:old.id,narratorTurn:1}],hasEarlier:false});
 h.calls.onRequest=body=>{h.calls.responseData={choices:[{message:{content:body.model==='director'?JSON.stringify({...old.contract,updates:{scene:{time:'21:00'}}}):'Incomplete replacement'},finish_reason:body.model==='director'?'stop':'length'}]};};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Re-plan').click();
 for(let i=0;i<100 && h.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal((h.calls.overwrites ?? []).length,0);assert.equal(chat.memorySnapshot().session.directorState.scene.time,'20:00');
 assert.ok(h.el('message-list').querySelectorAll('button').some(b=>b.textContent==='Continue replacement'),JSON.stringify({requests:h.calls.requests.map(r=>r.model),messages:h.el('message-list').children.map(n=>n.textContent)}));assert.equal(h.state.busy,false);
 h.calls.onRequest=()=>{h.calls.responseData={choices:[{message:{content:'The replacement finishes.'},finish_reason:'stop'}]};};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Continue replacement').click();
 for(let i=0;i<100 && h.state.busy;i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(h.calls.requests.length,3);assert.equal(h.calls.overwrites.length,1);assert.ok(h.calls.overwrites[0][2].content.includes('Incomplete replacement'));assert.ok(h.calls.overwrites[0][2].content.includes('The replacement finishes.'));assert.equal(h.calls.overwrites[0][2].truncated,false);
});

test('Director and Narrator inline selectors save story roles without switching the shared active connection',async()=>{
 const h=await harness();h.state.sessionId='story';h.state.storySettingsId='story';h.state.storySettings={values:{narrationMode:'director',narratorProfileId:'',directorProfileId:'default'}};
 const base=h.state.settings.profiles[0];h.state.settings.profiles.push({...base,id:'second',name:'Second',modelId:'second-model'});const active=h.state.settings.activeProfileId;
 (await h.use('ui/chat-view.js')).initChatView();
 assert.equal(h.el('quick-director-control').classList.contains('hidden'),false);
 h.el('quick-profile').value='second';await h.fire('quick-profile','change');assert.equal(h.state.storySettings.values.narratorProfileId,'second');assert.equal(h.state.settings.activeProfileId,active);
 h.el('quick-director-profile').value='second';await h.fire('quick-director-profile','change');assert.equal(h.state.storySettings.values.directorProfileId,'second');assert.equal(h.state.settings.activeProfileId,active);
 h.el('quick-thinking').value='medium';await h.fire('quick-thinking','change');assert.equal(h.state.settings.profiles.find(p=>p.id==='second').reasoning.effort,'medium');
});

test('Test profile presets remain draft-only until saved and are selectable separately in story prompts',async()=>{
 const h=await harness();h.state.sessionId='story';h.state.storySettingsId='story';h.state.storySettings={values:(await h.use('story-settings.js')).defaultStorySettings()};
 Object.assign(h.state.settings,{endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:'fake-openrouter-key',modelId:'original-model',maxOutputPrice:.4});h.settings.mirrorToActiveProfile(h.state.settings);
 (await h.use('ui/chat-view.js')).initChatView();const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();const count=h.state.settings.profiles.length;
 await h.fire('btn-role-test-profiles');assert.equal(h.state.settings.profiles.length,count);await h.fire('btn-save-settings');assert.equal(h.state.settings.profiles.length,count+2);
 const d=h.state.settings.profiles.find(p=>p.modelId==='anthropic/claude-haiku-5.5:floor'),n=h.state.settings.profiles.find(p=>p.modelId==='deepseek/deepseek-v4.1-flash:floor');assert.equal(d.reasoning.effort,'medium');assert.equal(n.reasoning.effort,'high');
 await h.fire('nav-prompts');h.el('set-narration-mode').value='director';h.el('set-director-profile').value=d.id;h.el('set-narrator-profile').value=n.id;h.el('set-director-output').value='8192';await h.fire('btn-save-settings');
 assert.equal(h.state.storySettings.values.directorProfileId,d.id);assert.equal(h.state.storySettings.values.narratorProfileId,n.id);assert.equal(h.state.settings.modelId,'original-model');
});

// Local-first replacements for the former save-first and realtime-history cases.
test('Local-first Send starts generation while the user cloud write is unresolved',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start'}]);
 let release;h.calls.addMessage=(_sid,m,opts)=>new Promise(resolve=>{release=()=>resolve({...m,id:opts.id,order:2,historyRevision:1});});
 h.calls.response='Local narration';h.el('chat-input').value='Next action';
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.calls.requests.length,1);assert.equal(h.state.busy,false);assert.equal(h.el('chat-input').value,'');
 assert.ok(chat.memorySnapshot().messages.some(m=>m.role==='assistant' && m.content==='Local narration'));
 assert.equal((await h.use('local-story-store.js')).storyStore('improvement').status.pending,2);
 // Leave no unresolved dependency in subsequent work for this isolated harness.
 h.calls.addMessage=null;release();await new Promise(resolve=>setImmediate(resolve));
});
test('Cloud failure retains the displayed user and narration; retrying sync makes no LLM call',async()=>{
 const h=await harness(),chat=await openImprovementChat(h);
 h.calls.addMessage=async()=>{throw Object.assign(Error('permission denied'),{code:'permission-denied'});};
 h.calls.response='Retained prose';h.el('chat-input').value='My action';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 const store=(await h.use('local-story-store.js')).storyStore('improvement');
 assert.ok(store.status.error);assert.equal(store.status.pending,2);assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='Retained prose'));
 assert.equal(h.calls.requests.length,1);h.calls.addMessage=null;await store.flush();assert.equal(store.status.pending,0);assert.equal(h.calls.requests.length,1);
});
test('Cached edits close immediately, keep scrolling unlocked, and reach the next request before syncing',async()=>{
 const {h,chat,bubble,pending}=await oldMessageEditor();await pending;
 const editor=bubble.querySelector('.msg-editor');assert.equal(editor.value,'Cached old turn');
 let release;h.calls.editMessage=()=>new Promise(resolve=>{release=()=>resolve({});});
 editor.value='Locally corrected turn';await bubble.querySelector('.msg-actions').children.find(b=>b.textContent==='Save').click();
 assert.equal(h.el('message-list').querySelector('.msg-editor'),null);assert.equal(h.state.busy,false);assert.equal(h.calls.editReads,undefined);
 assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='Locally corrected turn'),JSON.stringify({messages:chat.memorySnapshot().messages,edits:h.calls.edits,ui:h.el('message-list').children.map(x=>x.textContent)}));
 Object.assign(h.state.settings,{modelId:'model',apiKey:'key',streaming:false});h.calls.response='Based on correction';h.el('chat-input').value='Continue';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.ok(h.calls.requests[0].messages.some(m=>m.content.includes('Locally corrected turn')));
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Locally corrected turn'));
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Based on correction'));release();
});
test('Opening a story reconnects a background queue to visible edits and the next reply',async()=>{
 const h=await harness(),local=await h.use('local-story-store.js');
 const messages=[{id:'u',order:1,role:'user',content:'Original action',revision:0},{id:'a',order:2,role:'assistant',content:'Original reply'}];
 await local.openStoryStore('improvement',{session:{id:'improvement',historyRevision:0,nextOrder:2,storySettingsRevision:1},messages,turns:{}},()=>{});
 await openImprovementChat(h,{},messages);await new Promise(resolve=>setImmediate(resolve));
 h.calls.editMessage=()=>new Promise(()=>{});
 const list=h.el('message-list'),bubble=list.children.find(n=>n.dataset.messageId==='u');
 await bubble.querySelectorAll('button').find(b=>b.textContent==='Edit').click();
 bubble.querySelector('.msg-editor').value='Corrected visible action';
 await bubble.querySelector('.msg-actions').children.find(b=>b.textContent==='Save').click();
 assert.ok(list.querySelectorAll('.msg-content').some(n=>n.textContent==='Corrected visible action'),'Save must replace the visible text');
 h.calls.response='New visible narration';h.el('chat-input').value='Continue visibly';
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 for(const text of ['Continue visibly','New visible narration'])assert.ok(list.querySelectorAll('.msg-content').some(n=>n.textContent===text),text);
 assert.ok(h.calls.requests[0].messages.some(m=>m.content.includes('Corrected visible action')));
});
test('Reattaching a detached queue preserves a newer confirmed save over the displayed snapshot',async()=>{
 const h=await harness();await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Stale displayed action',revision:0}]);
 await new Promise(resolve=>setImmediate(resolve));
 const local=await h.use('local-story-store.js'),store=local.storyStore('improvement');local.closeStoryStores();
 h.calls.editMessage=async()=>({});
 store.enqueue('edit',{id:'u',order:1,content:'Newer confirmed action',expectedRevision:0});await store.flush();
 assert.equal(store.status.pending,0);assert.equal(store.view.session.historyRevision,1);
 const bubble=h.el('message-list').children.find(n=>n.dataset.messageId==='u');
 await bubble.querySelectorAll('button').find(b=>b.textContent==='Edit').click();
 assert.equal(bubble.querySelector('.msg-editor').value,'Newer confirmed action');
 await bubble.querySelector('.msg-actions').children.find(b=>b.textContent==='Cancel').click();
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Newer confirmed action'));
 assert.equal(store.view.session.historyRevision,1);
});
test('Returning to a story displays pending edits without leaking them into another story',async()=>{
 const h=await harness(),messages=[{id:'shared',order:1,role:'user',content:'Original story action',revision:0}];
 const chat=await openImprovementChat(h,{},messages);await new Promise(resolve=>setImmediate(resolve));
 h.calls.editMessage=()=>new Promise(()=>{});
 const local=await h.use('local-story-store.js'),store=local.storyStore('improvement');
 chat.setSession('other');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'other',data:()=>({title:'Other story'})});
 await h.calls.latestCallbacks.at(-1)({messages:[{id:'shared',order:1,role:'user',content:'Other story action'}],hasEarlier:false});
 store.enqueue('edit',{id:'shared',order:1,content:'Pending original story correction',expectedRevision:0});
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Other story action'));
 assert.ok(!h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Pending original story correction'));
 chat.setSession('improvement');await new Promise(resolve=>setTimeout(resolve,0));
 h.calls.sessionCallbacks.at(-1)({id:'improvement',data:()=>({title:'Story',historyRevision:0})});
 await h.calls.latestCallbacks.at(-1)({messages,hasEarlier:false});await new Promise(resolve=>setImmediate(resolve));
 assert.ok(h.el('message-list').querySelectorAll('.msg-content').some(n=>n.textContent==='Pending original story correction'));
 assert.equal(local.storyStore('improvement'),store);assert.equal(store.status.pending,1);
});
test('Cached deletion is immediate even while its Firebase transaction never settles',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Remove this'},{id:'a',order:2,role:'assistant',content:'Keep this'}]);
 h.calls.deleteMessage=()=>new Promise(()=>{});
 const before=h.calls.historyReads;const bubble=h.el('message-list').children.find(n=>n.dataset.messageId==='u');await bubble.querySelectorAll('button').find(b=>b.textContent==='Delete').click();
 assert.ok(!chat.memorySnapshot().messages.some(m=>m.id==='u'));assert.equal(h.state.busy,false);assert.equal(h.calls.historyReads,before);
});
test('Explicit refresh refuses to replace local work when flushing fails',async()=>{
 const h=await harness(),chat=await openImprovementChat(h);
 h.calls.addMessage=async()=>{throw Object.assign(Error('Denied'),{code:'permission-denied'});};h.el('chat-input').value='Keep my work';h.calls.response='Keep my prose';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 const before=chat.memorySnapshot().messages.map(m=>m.content);await (h.calls.settingsDoc ??= h.settings.storedSettings(h.state.settings),chat.syncChatData());assert.deepEqual(chat.memorySnapshot().messages.map(m=>m.content),before);assert.equal(h.state.busy,false);
});
test('Ordinary local turns reuse loaded history and lore without collection reloads',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{memory:{scene:true,lorebooks:true}},[{id:'u',order:1,role:'user',content:'Opening'},{id:'a',order:2,role:'assistant',content:'Scene'}]);
 await chat.prepareMemorySnapshot();const history=h.calls.historyReads,lore=h.calls.loreReads,sessionReads=h.calls.sessionReads;
 for(let i=0;i<3;i++){h.el('chat-input').value='Action '+i;h.calls.response='Reply '+i;await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await (await h.use('local-story-store.js')).storyStore('improvement').flush();}
 assert.equal(h.calls.historyReads,history);assert.equal(h.calls.loreReads,lore);assert.equal(h.calls.sessionReads,sessionReads);assert.deepEqual(h.calls.subscriptions,[]);
});

test('committed cached lore reaches the UI and next request without a header or collection reload',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{memory:{lorebooks:true}},[{id:'a',role:'assistant',order:1,content:'Opening'}]);await settle();
 const reads={lore:h.calls.loreReads,session:h.calls.sessionReads},entries=[{id:'fact',book:'facts',kind:'card',name:'Inn',alwaysLoad:true,aliases:[],sections:{text:{text:'The inn has a purple door.',origin:'user',kind:'canon',lines:[]}}}];
 await h.document.dispatchEvent({type:'local-lore-saved',detail:{uid:'another',sessionId:'improvement',revision:99,snapshot:{entries:[{id:'wrong-account'}]}}});assert.equal(chat.memorySnapshot().entries.length,0);
 await h.document.dispatchEvent({type:'local-lore-saved',detail:{uid:'test-user',sessionId:'improvement',revision:2,snapshot:{entries,loadedRevision:0,lastCommittedRevision:2},sessionPatch:{'memoryState.needsRebuild':true}}});
 assert.equal(chat.memorySnapshot().entries[0].id,'fact');assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,true);assert.deepEqual({lore:h.calls.loreReads,session:h.calls.sessionReads},reads);
 h.el('chat-input').value='Look at the inn';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.calls.requests.length,1);assert.match(JSON.stringify(h.calls.requests[0]),/purple door/);assert.equal(h.calls.loreReads,reads.lore);
});
test('a failed initial lore load keeps the composer draft and offers manual Sync',async()=>{
 const h=await harness();h.calls.onLoreRead=()=>{throw Error('Limit reached');};const chat=await openImprovementChat(h,{memory:{lorebooks:true}});await settle();
 await h.document.dispatchEvent({type:'local-lore-saved',detail:{uid:'test-user',sessionId:'improvement',revision:1,snapshot:{initialized:false,entries:[],loadedRevision:null}}});
 h.el('chat-input').value='Keep my unsent action';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.el('chat-input').value,'Keep my unsent action');assert.equal(h.calls.requests.length,0);assert.equal(chat.memorySnapshot().messages.length,0);assert.equal(h.state.busy,false);
 assert.match(h.el('btn-memory').title,/Sync data/);
});
for(const mode of ['retry','regenerate','continue'])test('Cancel '+mode+' discards partial output, unlocks immediately and ignores a late stream',async()=>{
 const h=await harness(),messages=[{id:'u',order:1,role:'user',content:'Opening'},...(mode==='retry'?[]:[{id:'a',order:2,role:'assistant',content:'Original reply'}])];
 const chat=await openImprovementChat(h,{},messages);h.state.settings.streaming=true;
 let late;h.calls.streamReader={read:()=>new Promise(resolve=>{late=resolve;}),cancel:()=>new Promise(()=>{})};
 let first;if(mode==='retry')first=h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 else if(mode==='regenerate')first=h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Regenerate').click();
 else first=h.fire('btn-rewrite');
 for(let i=0;i<20 && !late;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(h.state.busy,true);
 await h.stopAfterGuard();assert.equal(h.state.busy,false);assert.equal(h.el('message-list').querySelector('.unsaved'),null);assert.ok(!h.calls.confirmations?.some(s=>/partial reply/.test(s)));
 if(mode!=='retry')assert.equal(chat.memorySnapshot().messages.find(m=>m.id==='a').content,'Original reply');
 h.state.settings.streaming=false;h.calls.streamReader=null;h.calls.response='Next successful reply';h.el('chat-input').value='A new action';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 late({done:false,value:new TextEncoder().encode('data: {"choices":[{"delta":{"content":"STALE"}}]}\n\n')});await first;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.calls.requests.length,2);assert.equal(h.state.busy,false);assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='Next successful reply'));assert.ok(!chat.memorySnapshot().messages.some(m=>m.content?.includes('STALE')));
});
test('Automatic maintenance waits until pending cloud saves finish',async()=>{
 const h=await harness();await openImprovementChat(h,{memory:{autoUpdate:true},memoryState:{extractedThroughOrder:0}});
 h.calls.memoryDue=true;let release;h.calls.addMessage=(_sid,m,opts)=>new Promise(resolve=>{release=()=>resolve({...m,id:opts.id,order:1,historyRevision:1});});
 h.el('chat-input').value='Action';h.calls.response='Reply';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.equal(h.calls.memoryStarts ?? 0,0);assert.equal(h.calls.requests.length,1);h.calls.addMessage=null;release();
});

for(const stage of ['director','narrator'])test('Cancel during '+stage+' releases the turn; an unchanged retry reuses any completed Director contract',async()=>{
 const seed={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
 let h,pending,finishDirector,late;
 h=await harness({extraStubs:{'director-store.js':{getDirectorTurn:async()=>pending,savePendingDirectorTurn:async(_sid,turn,source)=>{pending={...turn,source,status:'pending'};return pending;},discardPendingDirector:async()=>{pending=null;}}}});
 Object.assign(h.state.settings,{modelId:'narrator',apiKey:'key',streaming:true,narrationMode:'director',directorProfileId:'small',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,profiles:[{id:'large',endpoint:'https://narrator.test',apiKey:'key',modelId:'narrator'},{id:'small',endpoint:'https://director.test',apiKey:'key',modelId:'director'}]});
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('story');await new Promise(r=>setTimeout(r,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',directorState:seed,memory:{scene:true,protagonist:'Nera'}})});
 await h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Look around'}],hasEarlier:false});
 h.calls.onMessageSaved=result=>{if(result.role==='assistant' && result.directorTurnId)Object.assign(result.session,{directorState:{...seed,scene:{...seed.scene,time:'21:00'}},directorRevision:1,directorCheckpoint:result.directorTurnId,directorPending:null,directorNeedsReview:false,directorStateHistoryOrder:result.order});};
 const contract={version:1,action:'narrate',transition:'completed',objective:'Describe the room',stopCondition:'Stop before the next voluntary action',memoryIds:[],requiredMemoryIds:[],updates:{scene:{time:'21:00'}}};
 h.calls.onRequest=async body=>{if(body.model==='director'){if(stage==='director')await new Promise(resolve=>finishDirector=resolve);h.calls.response=JSON.stringify(contract);}};
 h.calls.streamReader={read:()=>new Promise(resolve=>late=resolve),cancel:()=>new Promise(()=>{})};
 const retry=()=>h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();const first=retry();
 for(let i=0;i<30 && !(stage==='director'?finishDirector:late);i++)await new Promise(r=>setImmediate(r));
 assert.equal(h.state.busy,true);await h.stopAfterGuard();assert.equal(h.state.busy,false);assert.equal(chat.memorySnapshot().session.directorState.scene.time,'20:00');
 if(stage==='narrator')assert.ok(chat.memorySnapshot().session.directorPending);
 h.calls.streamReader=null;h.state.settings.streaming=false;h.calls.onRequest=body=>{h.calls.response=body.model==='director'?JSON.stringify(contract):'The room settles.';};
 await retry();if(finishDirector)finishDirector();if(late)late({done:true});await first;
 assert.equal(h.calls.requests.filter(r=>r.model==='director').length,stage==='director'?2:1);assert.equal(chat.memorySnapshot().session.directorState.scene.time,'21:00');assert.equal(h.state.busy,false);
});

test('A page reload keeps cached history until explicit Sync',async()=>{
 const h=await harness({globals:{performance:{getEntriesByType:()=>[{type:'reload'}]}}}),chat=await h.use('ui/chat-view.js');h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);chat.initChatView();chat.setSession('story');await new Promise(r=>setTimeout(r,0));
 h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story'})});h.calls.serverHistory=[{id:'u',order:1,role:'user',content:'Fresh server history'}];
 await h.calls.latestCallbacks.at(-1)({messages:[{id:'u',order:1,role:'user',content:'Cached history'}],hasEarlier:false});await settle();
 assert.equal(chat.memorySnapshot().messages[0].content,'Cached history');assert.equal(h.calls.historyReads ?? 0,0);assert.equal(h.state.busy,false);
 assert.equal(await chat.syncChatData(),true);assert.equal(chat.memorySnapshot().messages[0].content,'Fresh server history');assert.equal(h.calls.historyReads,1);assert.equal(h.calls.requests.length,0);
});
test('Own story-settings metadata patches preserve Director review requirements without a listener',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Opening'}]);h.state.storySettings.revision=2;
 await h.document.dispatchEvent({type:'story-settings-changed',detail:{sessionPatch:{directorNeedsReview:true}}});
 assert.equal(chat.memorySnapshot().session.directorNeedsReview,true);assert.equal((await h.use('local-story-store.js')).storyStore('improvement').view.session.directorNeedsReview,true);
});

test('Settings stays dismissible during a delayed save and keeps edits typed after submission',async()=>{
 const h=await harness(),view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();
 h.el('set-model').value='submitted-model';let finish;
 h.calls.onSettingsSave=()=>new Promise(resolve=>finish=resolve);
 const save=h.fire('btn-save-settings');for(let i=0;i<20&&!finish;i++)await new Promise(r=>setImmediate(r));
 assert.match(h.el('settings-saved-msg').textContent,/Saving/);
 assert.equal(h.el('btn-save-settings').disabled,true);assert.equal(h.el('btn-save-session').disabled,true);
 h.el('set-model').value='next-draft';await h.fire('btn-close-settings');
 assert.equal(h.el('settings-tab').classList.contains('hidden'),true);
 view.openSettingsPopup();assert.equal(h.el('set-model').value,'next-draft');
 finish();await save;
 assert.equal(h.state.settings.modelId,'submitted-model');assert.equal(h.el('set-model').value,'next-draft');
 assert.equal(h.el('settings-saved-msg').textContent,'Saved. New edits are unsaved.');
 h.calls.onSettingsSave=null;await h.fire('btn-save-settings');assert.equal(h.state.settings.modelId,'next-draft');
});

test('A dismissed failed settings save preserves the draft for reopening',async()=>{
 const h=await harness(),view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();
 h.el('set-model').value='keep-on-error';let fail;h.calls.onSettingsSave=()=>new Promise((_r,reject)=>fail=reject);
 const save=h.fire('btn-save-settings');for(let i=0;i<20&&!fail;i++)await new Promise(r=>setImmediate(r));
 await h.fire('btn-close-settings');fail(Error('Offline'));await save;view.openSettingsPopup();
 assert.equal(h.el('set-model').value,'keep-on-error');assert.match(h.el('settings-saved-msg').textContent,/Offline/);
 assert.equal(h.el('btn-save-settings').disabled,false);
});

test('Shared dialog buttons acknowledge delayed actions and keep Close usable',async()=>{
 const h=await harness(),ui=await h.use('ui/memory-ui.js');let finish,calls=0;
 const dialog=ui.subSheet('Save example'),save=ui.button('Save',()=>{calls++;return new Promise(resolve=>finish=resolve);});dialog.dialog.append(save);
 const pending=save.click();assert.equal(save.textContent,'Saving…');assert.equal(save.disabled,true);
 await save.click();assert.equal(calls,1);assert.equal(dialog.hide(),true);finish();await pending;
 assert.equal(save.textContent,'Save');assert.equal(save.disabled,false);
});

test('A late card save cannot replace a different editor after navigation',async()=>{
 const {h,lore,other,root}=await cardUI();let finish;h.calls.onCardSave=()=>new Promise(resolve=>finish=resolve);
 const text=root.querySelectorAll('textarea').find(t=>t.value==='Before');text.value='Submitted';await text.dispatchEvent({type:'input'});
 const save=namedButton(root,'Save').click();assert.ok(finish);lore.openLorebooks({entryId:other.id});
 finish();await save;
 assert.ok(root.querySelectorAll('h2').some(i=>i.textContent==='Other'));assert.ok(!root.querySelectorAll('textarea').some(t=>t.value==='Submitted'));
});

test('A card save preserves newer typing and merges notes returned by the save',async()=>{
 const {h,card,root}=await cardUI();let finish;h.calls.onCardSave=()=>new Promise(resolve=>finish=resolve);
 const text=root.querySelectorAll('textarea').find(t=>t.value==='Before');text.value='Submitted';await text.dispatchEvent({type:'input'});
 const save=namedButton(root,'Save').click();text.value='New draft';await text.dispatchEvent({type:'input'});
 const result=structuredClone(h.calls.cardWrites[0][1]);result.sections.notes.lines.push({id:'fresh',text:'Concurrent note',by:'auto',turn:1,src:1,at:1});finish(result);await save;
 assert.ok(root.querySelectorAll('textarea').some(t=>t.value==='New draft'));
 h.calls.onCardSave=null;await namedButton(root,'Save').click();const next=h.calls.cardWrites[1];
 assert.equal(next[1].sections.notes.text,'New draft');assert.ok(next[1].sections.notes.lines.some(l=>l.id==='fresh'));assert.equal(next[2].sections.notes.text,'Submitted');
 assert.equal(next[1].id,card.id);
});

test('Send waiting on a lore operation acknowledges immediately and can be cancelled before it resumes',async()=>{
 const h=await harness(),chat=await openImprovementChat(h);let finish;
 h.calls.lorePending=true;h.calls.onLoreWait=()=>new Promise(resolve=>finish=resolve);h.el('chat-input').value='First draft';
 const first=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});assert.ok(finish);
 assert.equal(h.el('btn-stop').classList.contains('hidden'),false);assert.equal(h.state.busy,true);
 await h.stopAfterGuard();assert.equal(h.state.busy,false);assert.equal(h.el('chat-input').value,'First draft');
 h.calls.lorePending=false;h.el('chat-input').value='New action';h.calls.response='New reply';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 finish();await first;
 assert.equal(h.calls.requests.length,1);assert.ok(!chat.memorySnapshot().messages.some(m=>m.content==='First draft'));assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='New reply'));
});

test('Deleting a card preserves a newly selected editor and Undo targets the original story',async()=>{
 const {h,lore,other,root}=await cardUI();let finish;h.calls.onCardDelete=()=>new Promise(resolve=>finish=resolve);
 const pending=namedButton(root,'Delete card').click();assert.ok(finish);lore.openLorebooks({entryId:other.id});finish();await pending;
 assert.ok(root.querySelectorAll('h2').some(n=>n.textContent==='Other'));
 h.state.sessionId='another-story';await namedButton(h.document.body.querySelector('.toast'),'Undo').click();
 assert.equal(h.calls.cardRestores[0][0].id,'improvement');
});

test('A late dialog completion cannot close a replacement dialog or steal its focus',async()=>{
 const h=await harness(),ui=await h.use('ui/memory-ui.js'),root=h.el('example-sheet');
 const old=ui.sheet(root,'First');assert.equal(old.hide(),true);const next=ui.sheet(root,'Second');
 assert.equal(h.document.activeElement,next.dialog);old.hide();assert.equal(root.classList.contains('hidden'),false);assert.equal(h.document.activeElement,next.dialog);
});

test('Finishing story creation does not interrupt navigation made while it was pending',async()=>{
 const h=await harness();(await h.use('ui/chat-view.js')).initChatView();(await h.use('ui/sidebar.js')).initSidebar();
 h.calls.prompt='New story';let finish;h.calls.onCreate=()=>new Promise(resolve=>finish=resolve);
 const pending=h.fire('btn-new-session');assert.equal(h.el('btn-new-session').textContent,'Creating…');
 h.state.sessionId='another-story';finish('created-story');await pending;
 assert.equal(h.state.sessionId,'another-story');assert.equal(h.el('btn-new-session').disabled,false);
});

for(const type of ['director','catch-up'])test(type+' preparation opens a dismissible dialog before a delayed snapshot',async()=>{
 let finish;const h=await harness({extraStubs:{'ui/chat-view.js':{prepareMemorySnapshot:()=>new Promise(resolve=>finish=resolve),memorySnapshot:()=>null,syncChatData:async()=>{},dismissMemoryRebuild:async()=>{}}}});
 h.state.sessionId='story';let pending;
 if(type==='director')pending=(await h.use('ui/director-view.js')).openDirectorState();
 else {const memory=await h.use('ui/memory-settings-view.js');memory.initMemorySettings(()=>{});pending=h.fire('mem-catch-up');}
 const root=h.document.body.querySelector('.memory-sub-sheet');assert.ok(root);assert.equal(root.classList.contains('hidden'),false);await new Promise(r=>setImmediate(r));assert.ok(finish);
 await root.querySelectorAll('button').find(b=>b.dataset.iconLabel==='Close').click();assert.equal(root.classList.contains('hidden'),true);
 finish({session:{id:'story'},messages:[],entries:[]});await pending;await new Promise(r=>setImmediate(r));assert.equal(root.querySelectorAll('input').length,0);assert.equal(h.calls.catchUps,undefined);
});

for(const outcome of ['success','failure','cancel'])test('Send after dismissing a settings save handles '+outcome+' without stale settings or a frozen composer',async()=>{
 const h=await harness(),chat=await openImprovementChat(h),view=await h.use('ui/settings-view.js');h.settings.mirrorToActiveProfile(h.state.settings);view.initSettingsView();view.openSettingsPopup();
 h.el('set-model').value='saved-new-model';let finish,fail;h.calls.onSettingsSave=()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
 const save=h.fire('btn-save-settings');for(let i=0;i<20&&!finish;i++)await new Promise(r=>setImmediate(r));await h.fire('btn-close-settings');
 h.el('chat-input').value='Use saved settings';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await new Promise(r=>setImmediate(r));
 assert.equal(h.calls.requests.length,0);assert.equal(h.el('btn-stop').classList.contains('hidden'),false);
 if(outcome==='cancel'){await h.stopAfterGuard();assert.equal(h.state.busy,false);}
 if(outcome==='failure')fail(Error('Save failed'));else finish();await save;await send;
 if(outcome==='success'){assert.equal(h.calls.requests.length,1);assert.equal(h.calls.requests[0].model,'saved-new-model');}
 else {assert.equal(h.calls.requests.length,0);assert.equal(h.el('chat-input').value,'Use saved settings');assert.ok(!chat.memorySnapshot().messages.some(m=>m.content==='Use saved settings'));}
 assert.equal(h.state.busy,false);
});

test('Stop rewriting releases immediately and late cleanup cannot replace a newly typed draft',async()=>{
 const h=await rewriteChatHarness();let late;h.calls.streamReader={read:()=>new Promise(resolve=>late=resolve),cancel:()=>new Promise(()=>{})};
 const rewrite=h.fire('btn-rewrite');for(let i=0;i<30&&!late;i++)await new Promise(r=>setImmediate(r));assert.ok(late);
 const stop=h.stopAfterGuard();assert.equal(h.state.busy,false);assert.equal(h.el('chat-input').readOnly,false);
 h.el('chat-input').value='New draft after Stop';await stop;late({done:true});await rewrite;
 assert.equal(h.el('chat-input').value,'New draft after Stop');assert.equal(h.state.busy,false);
});

test('A failed dismissed Director save restores its draft when reopened',async()=>{
 const seed={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};let fail;
 const h=await harness({extraStubs:{'ui/chat-view.js':{prepareMemorySnapshot:async()=>({session:{id:'story',directorState:seed},messages:[],entries:[]}),saveDirectorLiveState:()=>new Promise((_r,reject)=>fail=reject),syncChatData:async()=>{}},'director-store.js':{discardPendingDirector:async()=>{}}}});
 h.state.sessionId='story';const view=await h.use('ui/director-view.js');await view.openDirectorState();
 let root=h.document.body.querySelector('.memory-sub-sheet');root.querySelectorAll('input')[1].value='21:15';const save=namedButton(root,'Save live state').click();assert.ok(fail);
 await root.querySelectorAll('button').find(b=>b.dataset.iconLabel==='Close').click();fail(Error('Offline'));await save;await view.openDirectorState();
 root=h.document.body.children.filter(n=>(n.className ?? '').includes('memory-sub-sheet')).at(-1);assert.equal(root.querySelectorAll('input')[1].value,'21:15');
});

test('A submitted live-state refresh can complete while Send is waiting on its settings dependency',async()=>{
 const h=await harness(),chat=await openImprovementChat(h),pending=await h.use('ui/pending-settings.js');
 const finish=pending.beginSettingsSave('test-user','improvement');h.el('chat-input').value='Continue after save';
 const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await new Promise(r=>setImmediate(r));assert.equal(h.calls.requests.length,0);
 const sync=await (h.calls.settingsDoc ??= h.settings.storedSettings(h.state.settings),chat.syncChatData({pendingStateSave:true}));assert.equal(sync,true);assert.equal(h.state.busy,true);
 finish(true);await send;assert.equal(h.calls.requests.length,1);assert.equal(h.state.busy,false);
});

test('Legacy Hour 24 live-state review requires an explicit modern date and clock before saving',async()=>{
 const seed={version:1,scene:{date:'21/10/738',hour:24,location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};let saved;
 const h=await harness({extraStubs:{'ui/chat-view.js':{prepareMemorySnapshot:async()=>({session:{id:'story',directorState:seed},messages:[],entries:[]}),saveDirectorLiveState:async(_sid,value)=>{saved=value;},syncChatData:async()=>{}},'director-store.js':{discardPendingDirector:async()=>{}}}});
 h.state.sessionId='story';await (await h.use('ui/director-view.js')).openDirectorState();
 const root=h.document.body.querySelector('.memory-sub-sheet'),inputs=root.querySelectorAll('input'),review=inputs.find(i=>i.type==='checkbox');assert.ok(review);assert.equal(inputs[0].value,'');assert.equal(inputs[1].value,'');
 inputs[0].value='22/10/738';inputs[1].value='00:15';review.checked=true;await namedButton(root,'Save live state').click();
 assert.equal(saved.version,2);assert.equal(saved.scene.date,'22/10/738');assert.equal(saved.scene.time,'00:15');assert.equal(seed.scene.hour,24);
});

test('Editing an effectively expired thread preserves the raw saved baseline until an explicit lifecycle action',async()=>{
 const h=await harness(),chat=await h.use('ui/chat-view.js'),{makeEntry}=await h.use('lore-lines.js'),lore=await h.use('ui/lorebook-view.js');
 const card=makeEntry('events','Visit Lysia',{id:'visit',kind:'thread',status:'open'});card.threadMeta={kind:'appointment',dueDate:'24/10/738',dueTime:'08:00',participants:['Lysia'],location:'Inn',outcome:null};h.calls.loreEntries=[card];
 chat.initChatView();chat.setSession('story');await new Promise(r=>setTimeout(r,0));h.calls.sessionCallbacks.at(-1)({id:'story',exists:()=>true,data:()=>({title:'Story',memory:{scene:true,lorebooks:true}})});h.calls.latestCallbacks.at(-1)({messages:[{id:'a',order:1,role:'assistant',content:'The morning passes.',scene:'date: 28/10/738 · time: 09:00 · place: Inn · present: Nera',sceneMeta:{kind:'manual'}}],hasEarlier:false});
 lore.initLorebookView();lore.openLorebooks();await new Promise(r=>setTimeout(r,0));lore.openLorebooks({entryId:'visit'});
 const root=h.el('lorebook-overlay');assert.ok(namedButton(root,'Reopen as ongoing'));const title=root.querySelectorAll('input').find(i=>i.value==='Visit Lysia');title.value='Meeting with Lysia';await title.dispatchEvent({type:'input'});await namedButton(root,'Save').click();
 const [,staged,base]=h.calls.cardWrites.at(-1);assert.equal(base.status,'open');assert.equal(staged.status,'open');assert.equal(staged.threadMeta.outcome,null);assert.equal(staged.name,'Meeting with Lysia');
});

test('character importance editor defaults old cards to Minor and saves manual selection',async()=>{
 const {h,lore,card,root}=await cardUI();delete card.importance;
 for(const cb of h.calls.loreCallbacks ?? [])cb(h.calls.loreEntries);
 lore.openLorebooks({entryId:card.id});
 const select=root.querySelectorAll('select').find(s=>s.attributes?.['aria-label']==='Importance');
 assert.ok(select);assert.equal(select.value,'3');assert.equal(select.children.length,4);
 assert.ok(root.querySelectorAll('.badge').some(b=>b.textContent==='Minor'));
 select.value='1';await select.dispatchEvent({type:'change'});
 assert.ok(root.querySelectorAll('p').some(p=>p.textContent==='Major influence, relationships, and long-term development.'));
 await namedButton(root,'Save').click();assert.equal(h.calls.cardWrites.at(-1)[1].importance,1);
});

function controlledTimers(){
 let now=0,serial=0;const jobs=new Map();
 return {jobs,setTimeout(fn,ms){const id=++serial;jobs.set(id,{fn,ms,due:now+ms});return id;},clearTimeout:id=>jobs.delete(id),advance(ms){now+=ms;for(const [id,job]of [...jobs])if(job.due<=now){jobs.delete(id);job.fn();}}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('accepted Send immediately protects Stop for 500 ms, rejects duplicate submits, and preserves its draft during preparation',async()=>{
 const timers=controlledTimers(),h=await harness({timers}),chat=await openImprovementChat(h);
 const waiting=deferred();h.calls.lorePending=true;h.calls.onLoreWait=()=>waiting.promise;
 h.el('chat-input').value='Keep this draft';const bubble=h.el('message-list').children.find(n=>n.dataset.messageId);
 const first=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.el('btn-send').hidden,true);assert.equal(h.el('btn-stop').disabled,true);
 assert.equal(h.el('message-list').children.find(n=>n.dataset.messageId),bubble,'busy alone preserves message DOM');
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 await h.fire('btn-stop');assert.equal(h.state.busy,true,'handler also rejects a synthetic click');
 timers.advance(499);await h.fire('btn-stop');assert.equal(h.state.busy,true);
 timers.advance(1);assert.equal(h.el('btn-stop').disabled,false);await h.fire('btn-stop');
 assert.equal(h.state.busy,false);assert.equal(h.el('chat-input').value,'Keep this draft');
 waiting.resolve();await first;assert.equal(h.calls.requests.length,0);assert.equal(h.calls.messages.length,0);
});

test('an expired old Stop timer cannot enable cancellation for a new accepted Send',async()=>{
 const timers=controlledTimers(),h=await harness({timers});await openImprovementChat(h);
 const waiting=deferred();h.calls.lorePending=true;h.calls.onLoreWait=()=>waiting.promise;
 h.el('chat-input').value='First';const first=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 const old=[...timers.jobs.values()].find(j=>j.ms===500).fn;
 timers.advance(500);await h.fire('btn-stop');
 h.el('chat-input').value='Second';const second=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 old();assert.equal(h.el('btn-stop').disabled,true);await h.fire('btn-stop');assert.equal(h.state.busy,true);
 timers.advance(500);await h.fire('btn-stop');waiting.resolve();await Promise.all([first,second]);assert.equal(h.calls.requests.length,0);
});

test('Stop after enqueue keeps the saved user turn and stops generation after the guard',async()=>{
 const timers=controlledTimers(),h=await harness({timers}),chat=await openImprovementChat(h);
 const provider=deferred();h.calls.onRequest=()=>provider.promise;
 h.el('chat-input').value='Queued action';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 for(let i=0;i<30 && !h.calls.requests.length;i++){timers.advance(0);await settle();}
 assert.equal(h.calls.requests.length,1,'the request starts before advancing the guard timer');
 assert.equal(h.el('btn-stop').disabled,true);timers.advance(500);await h.fire('btn-stop');
 assert.ok(chat.memorySnapshot().messages.some(m=>m.role==='user' && m.content==='Queued action'));assert.equal(h.el('chat-input').value,'');
 provider.resolve();await send;assert.ok(!chat.memorySnapshot().messages.some(m=>m.role==='assistant' && m.content==='summary'));
});

async function realLoreChat(){
 let h;const commit=deferred(),entered=deferred();let block=false;
 const ref=(_db,...parts)=>({path:parts.join('/')});
 const fs={doc:ref,collection:ref,Timestamp:class{},getDocsFromServer:async()=>({docs:[]}),writeBatch:()=>({}),
  getDocFromServer:async target=>{const data=target.path.includes('/sessions/')?h.calls.sessionDocs.improvement:h.calls.settingsDoc;return {exists:()=>!!data,data:()=>structuredClone(data)};},
  runTransaction:async(_db,action)=>{if(block){block=false;entered.resolve();await commit.promise;}
   const writes=[];const result=await action({get:async()=>({exists:()=>true,data:()=>structuredClone(h.calls.sessionDocs.improvement)}),update:(target,patch)=>writes.push(patch)});
   for(const patch of writes)for(const [key,value]of Object.entries(patch)){const parts=key.split('.');let obj=h.calls.sessionDocs.improvement;for(const part of parts.slice(0,-1))obj=obj[part]??={};obj[parts.at(-1)]=value;}
   return result;
  }};
 h=await harness({extraStubs:{'lore-store.js':null},firestoreOverrides:fs});const chat=await openImprovementChat(h),lore=await h.use('lore-store.js');
 const extract=()=>lore.commitExtraction('improvement',{appends:[],aliases:[],statusChanges:[],creates:[]},{expectedSource:(()=>{const s=chat.memorySnapshot().session;return {historyRevision:s.historyRevision ?? 0,loreRevision:s.loreRevision ?? 0,storySettingsRevision:s.storySettingsRevision ?? 0,directorRevision:s.directorRevision ?? 0};})(),endOrder:2,fromTurn:1,toTurn:1});
 return {h,chat,lore,extract,commit,entered,block(){block=true;}};
}

test('real lore gate drains an earlier extraction commit before Send and defers a later commit without a circular wait',{timeout:3000},async()=>{
 const x=await realLoreChat(),{h,lore}=x;x.block();const earlier=x.extract();await x.entered.promise;
 const provider=deferred();h.calls.onRequest=()=>provider.promise;h.el('chat-input').value='Continue';
 const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});let laterDone=false;const later=x.extract().then(()=>laterDone=true,()=>laterDone=true);
 await settle();assert.equal(h.calls.requests.length,0);assert.equal(laterDone,false);
 x.commit.resolve();await earlier;
 for(let i=0;i<30 && !h.calls.requests.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal(h.calls.requests.length,1);assert.equal(laterDone,false);
 provider.resolve();await send;
 // This extraction was queued against an older source and may safely reject.
 await later.catch(()=>{});assert.equal(lore.loreWritesPending(),false);assert.equal(h.state.busy,false);
});

test('Sync using the real lore gate waits for an underway extraction commit before fetching canonical progress',{timeout:3000},async()=>{
 const x=await realLoreChat(),{h,chat}=x;x.block();const write=x.extract();await x.entered.promise;
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);const before=h.calls.historyReads ?? 0;
 const sync=chat.syncChatData();await settle();assert.equal(h.calls.historyReads ?? 0,before);
 x.commit.resolve();await write;assert.equal(await sync,true);
 assert.equal(chat.memorySnapshot().session.memoryState.extractedThroughOrder,2);assert.equal(h.state.busy,false);
});

for(const failure of ['account','prompts','messages','lore','cache'])test('failed Sync '+failure+' retains the complete displayed story and cached local state',async()=>{
 const cached=[],h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},replaceStoryCache:async(...args)=>{if(failure==='cache')throw Error('Cache failed');cached.push(args);}}}),chat=await openImprovementChat(h);
 const before=JSON.stringify(chat.memorySnapshot().session),messages=JSON.stringify(chat.memorySnapshot().messages),settings=h.state.settings,prompts=h.state.storySettings;
 h.calls.settingsDoc=failure==='account'?null:h.settings.storedSettings(h.state.settings);
 if(failure==='prompts')h.calls.onPromptsRefresh=()=>{throw Error('Prompts failed');};
 if(failure==='messages')h.calls.onMessagesRefresh=()=>{throw Error('Messages failed');};
 if(failure==='lore')h.calls.onLoreRead=()=>{throw Error('Lore failed');};
 assert.equal(await chat.syncChatData(),false);assert.equal(JSON.stringify(chat.memorySnapshot().session),before);assert.equal(JSON.stringify(chat.memorySnapshot().messages),messages);
 assert.equal(h.state.settings,settings);assert.equal(h.state.storySettings,prompts);assert.equal(cached.length,0);assert.equal(h.state.busy,false);
});

test('Sync replaces settings, prompts, history, memory flags, lore and Director checkpoint together while retaining other stories',async()=>{
 const saved=[],h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},replaceStoryCache:async(...args)=>saved.push(structuredClone(args))},extraStubs:{'director-store.js':{getDirectorTurn:async(_sid,id)=>({id,version:1,status:'completed',after:{scene:{time:'21:00'}}}),savePendingDirectorTurn:async()=>{},discardPendingDirector:async()=>{}}}}),chat=await openImprovementChat(h);
 h.calls.settingsDoc={...h.settings.storedSettings(h.state.settings),maxContextTokens:64000};
 const canonical={...h.calls.sessionDocs.improvement,historyRevision:9,loreRevision:7,storySettingsRevision:3,directorRevision:2,directorCheckpoint:'d2',directorState:{scene:{time:'21:00'}},memoryState:{extractedThroughOrder:6,needsRebuild:true,rebuildFromOrder:2,failureStreak:3,paused:true,lastError:'Retain this failure'}};
 h.calls.sessionDocs.improvement=canonical;h.calls.serverPrompts={revision:3,values:{narratorSystemPrompt:'New story prompt'}};
 h.calls.serverHistory=[{id:'u-new',role:'user',order:9,content:'Server history'}];h.calls.loreEntries=[{id:'fresh',book:'facts',name:'Fresh',sections:{text:{text:'Canonical lore',lines:[]}}}];
 assert.equal(await chat.syncChatData(),true);const live=chat.memorySnapshot();
 assert.equal(h.state.settings.maxContextTokens,64000);assert.equal(h.state.storySettings.values.narratorSystemPrompt,'New story prompt');assert.equal(live.messages[0].content,'Server history');assert.equal(live.entries[0].id,'fresh');
 assert.deepEqual(live.session.memoryState,canonical.memoryState);assert.equal(live.session.directorCheckpoint,'d2');
 assert.equal(saved.length,1);assert.equal(saved[0][1],'improvement');assert.equal(saved[0][3].turns.d2.id,'d2');
 assert.deepEqual((await h.use('local-story-store.js')).storyStore('improvement').view.turns.d2.after,{scene:{time:'21:00'}});
});

for(const switched of ['account','story'])test('late Sync result cannot replace a newly selected '+switched,async()=>{
 const h=await harness(),chat=await openImprovementChat(h),wait=deferred();h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);h.calls.onMessagesRefresh=()=>wait.promise;
 const sync=chat.syncChatData();await settle();if(switched==='account')h.calls.uid='other';else h.state.sessionId='other';wait.resolve();
 assert.equal(await sync,false);assert.equal(h.state.sessionId,switched==='story'?'other':'improvement');assert.equal(h.state.busy,false);assert.equal(h.state.storySettings.revision,1);
});

test('an unscoped lore notification performs no reload; explicit Sync replaces cached lore',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{memory:{lorebooks:true}});await settle();
 const reads=h.calls.loreReads ?? 0;h.calls.loreEntries=[{id:'remote'}];
 await h.document.dispatchEvent({type:'local-lore-saved',detail:{sessionId:'improvement'}});await settle();
 assert.equal(h.calls.loreReads ?? 0,reads);
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);assert.equal(await chat.syncChatData(),true);
 assert.equal(h.calls.loreReads,reads+1);assert.equal(chat.memorySnapshot().entries[0].id,'remote');
});

test('Manual Sync reads a changing remote snapshot once and preserves local data until the next explicit Sync',async()=>{
 const published=[],h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},replaceStoryCache:async(...args)=>published.push(args)}}),chat=await openImprovementChat(h,{},[{id:'local',role:'assistant',order:1,content:'Keep local'}]);
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);let reads=0;
 h.calls.onMessagesRefresh=()=>{if(++reads===1){h.calls.sessionDocs.improvement={...h.calls.sessionDocs.improvement,historyRevision:5};h.calls.serverHistory=[{id:'new',order:5,role:'user',content:'New revision'}];}};
 assert.equal(await chat.syncChatData(),false);assert.equal(reads,1);assert.equal(published.length,0);assert.equal(chat.memorySnapshot().messages[0].content,'Keep local');assert.equal(h.state.busy,false);
 assert.equal(await chat.syncChatData(),true);assert.equal(reads,2);assert.equal(published.length,1);assert.equal(chat.memorySnapshot().session.historyRevision,5);assert.equal(chat.memorySnapshot().messages[0].content,'New revision');
});
test('repeated remote changes during Sync leave local work visible and release Send',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Keep local history'}]);h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);
 h.calls.onMessagesRefresh=()=>{h.calls.sessionDocs.improvement={...h.calls.sessionDocs.improvement,historyRevision:(h.calls.sessionDocs.improvement.historyRevision ?? 0)+1};};
 assert.equal(await chat.syncChatData(),false);assert.equal(chat.memorySnapshot().messages[0].content,'Keep local history');assert.equal(h.state.busy,false);
});

for(const blockedRole of ['user','assistant'])test('turn-end checkpoint keeps generation and composer responsive during a slow '+blockedRole+' upload',async()=>{
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{}}}),chat=await openImprovementChat(h,{},[{id:'opening',role:'assistant',order:1,content:'Opening'}]);await settle();
 let finish;
 h.calls.addMessage=async(sid,message,options)=>{
   const commit=()=>{const session={...options.session,historyRevision:(options.session.historyRevision ?? 0)+1,nextOrder:(options.session.nextOrder ?? 0)+1};
     if(message.role==='assistant')session.nextNarratorTurn=(session.nextNarratorTurn ?? 1)+1;
     h.calls.sessionDocs[sid]=session;h.calls.historyRevision=session.historyRevision;
     return {message:{...message,id:options.id,order:session.nextOrder,historyRevision:session.historyRevision},session,historyRevision:session.historyRevision};};
   if(message.role===blockedRole)return new Promise(resolve=>finish=()=>resolve(commit()));return commit();
 };
 h.calls.response='Completed reply';h.el('chat-input').value='My action';
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 const store=(await h.use('local-story-store.js')).storyStore('improvement');
 assert.equal(h.calls.requests.length,1);assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='Completed reply'));
 assert.equal(h.state.busy,false);assert.ok(store.status.pending>0);assert.equal(h.el('chat-sync-status').textContent,'Saving…');
 finish();await store.flush();await settle();
 assert.equal(store.status.pending,0);assert.equal(h.el('chat-sync-status').textContent,'Synced');assert.equal(h.calls.requests.length,1);
});

test('Sync resolves a persisted stale-save conflict after reload and removes dependent local messages only for that story',async()=>{
 const fixture=indexedDBFixture({sessions:[]}),uid='test-user',sid='s';
 const old={id:sid,storageVersion:2,continuityVersion:2,lookupVersion:1,storySettingsRevision:1,historyRevision:2,loreRevision:1};
 const messages=[{id:'u',role:'user',order:1,revision:0,content:'Old history'}],remote={...old,historyRevision:4,loreRevision:2};
 const serverMessages=[...messages,{id:'phone',role:'assistant',order:2,content:'Phone reply'}];
 const unsaved=new Map();
 async function open(type){
   const h=await harness({globals:{indexedDB:fixture.indexedDB,performance:{getEntriesByType:()=>[{type}]}},extraStubs:{'unsaved-replies.js':{
     loadUnsavedReply:async(owner,story)=>unsaved.get(owner+':'+story) ?? null,
     storeUnsavedReply:async(owner,story,value)=>{if(value)unsaved.set(owner+':'+story,value);else unsaved.delete(owner+':'+story);},
   }}});
   const cache=await h.use('chat-cache.js');
   if(type==='navigate'){
     await cache.saveChatCache(uid,sid,{session:old,recent:messages,history:messages,hasEarlier:false});
     await cache.saveStoryData(uid,sid,{confirmed:{session:old,messages,turns:{}}});
     await cache.storyQueueStorage.put(uid,'other',{id:'other-op',kind:'edit',payload:{id:'u',order:1,content:'Other work'}},{session:{...old,id:'other'},messages,turns:{}});
   }
   const guard=await h.use('continuity.js');h.calls.onMessageSave=async(_sid,_message,options)=>guard.assertSource(remote,options.expectedSource);
   const chat=await h.use('ui/chat-view.js');h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);chat.initChatView();chat.setSession(sid);await new Promise(r=>setTimeout(r,0));
   const cached=await cache.loadChatCache(uid,sid);
   h.calls.sessionCallbacks.at(-1)({id:sid,data:()=>cached.session});h.calls.sessionDocs[sid]=remote;h.calls.serverHistory=serverMessages;
   await h.calls.latestCallbacks.at(-1)({messages:cached.history,hasEarlier:false});await settle();
   return {h,chat,cache,store:(await h.use('local-story-store.js')).storyStore(sid)};
 }
 const first=await open('navigate');
 first.store.enqueue('add',{id:'local-user',message:{role:'user',content:'Conflicting local action'}});
 first.store.enqueue('add',{id:'local-reply',message:{role:'assistant',content:'Dependent local reply'}});
 await assert.rejects(first.store.flush(),error=>error.code==='story-conflict');await first.store.settled();
 unsaved.set(uid+':'+sid,{owner:uid,sid,id:'unsaved',message:{role:'assistant',content:'Old unsaved reply'},sourceRevision:2});
 const second=await open('reload');assert.equal(second.store.status.pending,2);assert.equal(second.h.calls.historyReads ?? 0,0);
 assert.equal(await second.chat.syncChatData(),true);assert.equal(second.store.status.pending,0);
 assert.deepEqual(second.chat.memorySnapshot().messages.map(m=>m.content),['Old history','Phone reply']);
 assert.equal(await second.cache.storyQueueStorage.load(uid,sid),null);assert.ok(await second.cache.storyQueueStorage.load(uid,'other'));assert.equal(unsaved.has(uid+':'+sid),false);
 assert.equal(second.h.calls.requests.length,0);
 const recovery=(await second.cache.loadStoryData(uid,sid)).deviceRecoveryBackups;
 assert.ok(recovery.some(b=>b.snapshot.messages.some(m=>m.content==='Dependent local reply')),'Sync must keep the discarded local branch recoverable');
 const third=await open('back_forward');assert.equal(third.store.status.pending,0);assert.equal(third.store.view.messages.at(-1).content,'Phone reply');
});

for(const failure of ['messages','cache','permission','offline'])test('Sync conflict recovery preserves local work when '+failure+' fails',async()=>{
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},replaceStoryCache:async()=>{if(failure==='cache')throw Error('Cache failed');}}}),chat=await openImprovementChat(h);await settle();
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);
 const code=failure==='permission'?'permission-denied':failure==='offline'?'unavailable':'story-conflict';
 h.calls.addMessage=async()=>{throw Object.assign(Error('Save failed'),{code});};
 const store=(await h.use('local-story-store.js')).storyStore('improvement');store.enqueue('add',{id:'local',message:{role:'user',content:'Keep my local work'}});
 if(failure==='offline')await settle();else await assert.rejects(store.flush());
 if(failure==='messages')h.calls.onMessagesRefresh=()=>{throw Error('Message read failed');};
 assert.equal(await chat.syncChatData(),false);assert.equal(store.status.pending,1);assert.equal(store.status.paused,false);
 assert.ok(chat.memorySnapshot().messages.some(m=>m.content==='Keep my local work'));
 if(failure==='permission' || failure==='offline')assert.equal(h.calls.historyReads ?? 0,0);
 store.close();
});

for(const event of ['visibilitychange','online','pageshow','focus'])test('foreground '+event+' keeps local chat usable without automatic Firebase refresh',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'old',role:'assistant',order:1,content:'Old message'}]);await settle();
 h.document.hidden=false;
 h.calls.sessionDocs.improvement={...h.calls.sessionDocs.improvement,historyRevision:4};h.calls.serverHistory=[{id:'phone',role:'assistant',order:2,content:'New phone reply'}];
 const reads={session:h.calls.sessionReads,history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads};
 if(event==='visibilitychange')await h.document.dispatchEvent({type:event});
 else for(const callback of h.calls.windowListeners[event] ?? [])callback();
 await settle();assert.equal(chat.memorySnapshot().messages.at(-1).content,'Old message');assert.equal(h.state.busy,false);assert.equal(h.el('btn-send').disabled,false);
 assert.deepEqual({session:h.calls.sessionReads,history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads},reads);
});

test('finishing a settings save does not start automatic full Sync',async()=>{
 const h=await harness(),chat=await openImprovementChat(h);await settle();h.document.hidden=false;
 const pending=await h.use('ui/pending-settings.js'),finish=pending.beginSettingsSave('test-user','improvement');
 h.calls.sessionDocs.improvement={...h.calls.sessionDocs.improvement,historyRevision:5};h.calls.serverHistory=[{id:'phone',role:'assistant',order:1,content:'Phone'}];
 const reads=h.calls.sessionReads;await h.document.dispatchEvent({type:'visibilitychange'});finish(true);await settle();
 assert.equal(h.calls.sessionReads,reads);assert.equal(h.calls.historyReads ?? 0,0);assert.equal(h.state.busy,false);
});

test('opening a visible cached story keeps local data until explicit Sync',async()=>{
 const h=await harness({chatCache:{loadChatCache:async()=>({session:{id:'s',storageVersion:2,continuityVersion:2,lookupVersion:1,storySettingsRevision:1,historyRevision:1},recent:[{id:'old',role:'assistant',order:1,content:'Cached'}],history:[{id:'old',role:'assistant',order:1,content:'Cached'}],hasEarlier:false}),saveChatCache:async()=>{},deleteChatCache:async()=>{}}});
 h.document.hidden=false;h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);
 const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('s');await new Promise(r=>setTimeout(r,0));
 h.calls.sessionCallbacks.at(-1)({id:'s',data:()=>({historyRevision:1})});
 h.calls.sessionDocs.s={...h.calls.sessionDocs.s,historyRevision:3};h.calls.serverHistory=[{id:'phone',role:'assistant',order:2,content:'Phone version'}];
 await h.calls.latestCallbacks.at(-1)({messages:[{id:'old',role:'assistant',order:1,content:'Cached'}],hasEarlier:false});
 await settle();assert.equal(chat.memorySnapshot().messages.at(-1).content,'Cached');assert.equal(h.calls.historyReads ?? 0,0);assert.equal(h.state.busy,false);
 assert.equal(await chat.syncChatData(),true);assert.equal(chat.memorySnapshot().messages.at(-1).content,'Phone version');assert.equal(h.calls.historyReads,1);assert.equal(h.calls.requests.length,0);
 const reads=h.calls.historyReads;await h.document.dispatchEvent({type:'visibilitychange'});await settle();assert.equal(h.calls.historyReads,reads);
});

for(const switched of ['story','account'])test('a conflict replacement committed during a '+switched+' switch cannot revive the discarded queue',async()=>{
 const replacement=deferred();let replacing=false;
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},replaceStoryCache:async()=>{replacing=true;await replacement.promise;}}}),chat=await openImprovementChat(h);await settle();
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);h.calls.addMessage=async()=>{throw Object.assign(Error('Changed'),{code:'story-conflict'});};
 const store=(await h.use('local-story-store.js')).storyStore('improvement');store.enqueue('add',{id:'local',message:{role:'user',content:'Conflicting'}});await assert.rejects(store.flush());
 h.calls.serverHistory=[{id:'phone',role:'assistant',order:1,content:'Phone'}];const sync=chat.syncChatData();
 for(let i=0;i<30 && !replacing;i++)await settle();assert.equal(replacing,true);
 if(switched==='story')h.state.sessionId='other';else h.calls.uid='other';
 replacement.resolve();assert.equal(await sync,false);assert.equal(store.status.pending,0);assert.equal(store.view.messages.at(-1).content,'Phone');
 assert.equal(store.status.paused,false);assert.equal(h.state.storySettings.revision,1);
});

test('Sync waits for discarded unsaved reply cleanup before reporting completion',async()=>{
 const cleanup=deferred();let clearing=false,finished=false;
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{}},extraStubs:{'unsaved-replies.js':{
   loadUnsavedReply:async()=>null,storeUnsavedReply:async()=>{clearing=true;await cleanup.promise;},
 }}}),chat=await openImprovementChat(h);await settle();h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);
 h.calls.addMessage=async()=>{throw Object.assign(Error('Changed'),{code:'story-conflict'});};
 const store=(await h.use('local-story-store.js')).storyStore('improvement');store.enqueue('add',{id:'local',message:{role:'user',content:'Conflicting'}});await assert.rejects(store.flush());
 const sync=chat.syncChatData().then(result=>{finished=true;return result;});
 for(let i=0;i<30 && !clearing;i++)await settle();assert.equal(clearing,true);assert.equal(finished,false);
 cleanup.resolve();assert.equal(await sync,true);assert.equal(store.status.pending,0);
});

const saveSeed={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
const editedScene='date: Day 1 · time: night · place: Saved Hall · present: Nera';
async function sceneSaveHarness(options={}) {
 const h=await harness(options),messages=[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Reply',scene:'date: Day 1 · time: morning · place: Inn · present: Nera',revision:0}];
 const chat=await openImprovementChat(h,{memory:{scene:true,lorebooks:true}},messages);await chat.prepareMemorySnapshot();
 h.calls.updateScene=async(sid,id,_order,scene,_prior,options)=>{
   h.calls.sceneSaves=(h.calls.sceneSaves ?? 0)+1;h.calls.sceneOptions=options;await h.calls.onSceneSave?.();
   const baseHistoryRevision=options.session.historyRevision ?? 0,historyRevision=baseHistoryRevision+1;
   const replacement={...messages[1],scene,sceneMeta:{kind:'manual',stale:false},revision:1};
   const session={...options.session,historyRevision,...h.calls.sceneSessionPatch};
   h.calls.historyRevision=historyRevision;h.calls.sessionDocs[sid]=session;
   h.calls.history=h.calls.history.map(m=>m.id===id?replacement:m);
   const result={replacement,session,baseHistoryRevision,historyRevision,retiredSummaryIds:h.calls.retiredSummaries ?? []};
   await h.calls.beforeSceneReturn?.(result);return structuredClone(result);
 };
 const edit=async()=>{await h.el('message-list').querySelector('.scene-chip').click();const input=h.el('message-list').querySelector('input');input.value=editedScene;return namedButton(h.el('message-list'),'Save');};
 return {h,chat,edit,store:(await h.use('local-story-store.js')).storyStore('improvement')};
}
async function directorSaveHarness(options={}) {
 let h;const turns=new Map();
 h=await harness({...options,extraStubs:{...options.extraStubs,'director-store.js':{
   getDirectorTurn:async(_sid,id)=>{h.calls.directorReads=(h.calls.directorReads ?? 0)+1;return turns.get(id);},
   savePendingDirectorTurn:async(_sid,turn,source)=>{const saved={...turn,source,status:'pending'};turns.set(turn.id,saved);return saved;},discardPendingDirector:async()=>{},
   resetDirectorState:async(sid,value,expected)=>{
     h.calls.directorSaves=(h.calls.directorSaves ?? 0)+1;await h.calls.onDirectorSave?.();
     const api=await h.use('continuity.js'),session=h.calls.sessionDocs[sid];api.assertSource(session,expected);
     const source=api.requestSource(session),id='manual_saved',patch={directorState:structuredClone(value),directorRevision:source.directorRevision+1,directorCheckpoint:id,directorStateHistoryOrder:session.nextOrder ?? 0,directorNeedsReview:false};
     const checkpoint={version:1,id,manual:true,status:'completed',previousCheckpoint:session.directorCheckpoint ?? null,before:session.directorState,after:patch.directorState,order:patch.directorStateHistoryOrder};
     turns.set(id,checkpoint);h.calls.sessionDocs[sid]={...session,...patch};
     const result={state:value,source,patch,checkpoint};await h.calls.beforeDirectorReturn?.(result);return structuredClone(result);
   },
 }}});
 const chat=await openImprovementChat(h,{directorState:saveSeed,memory:{scene:true,lorebooks:true}},[{id:'u',order:1,role:'user',content:'Start'},{id:'a',order:2,role:'assistant',content:'Reply'}]);
 await chat.prepareMemorySnapshot();const store=(await h.use('local-story-store.js')).storyStore('improvement');
 const open=async()=>{await (await h.use('ui/director-view.js')).openDirectorState();const root=h.document.body.children.filter(n=>(n.className ?? '').includes('memory-sub-sheet')).at(-1);root.querySelectorAll('input')[1].value='21:15';return root;};
 return {h,chat,store,open,turns};
}

test('Warm scene save waits for Firebase, rejects duplicates, bridges local history and sends the edited scene without downloads',async()=>{
 const {h,chat,store,edit}=await sceneSaveHarness(),wait=deferred(),save=await edit();h.calls.onSceneSave=()=>wait.promise;
 const before={history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads,session:h.calls.sessionReads};
 const pending=save.click();await settle();assert.equal(save.disabled,true);assert.equal(h.state.busy,true);assert.equal(store.status.paused,true);
 await save.click();assert.equal(h.calls.sceneSaves,1);assert.match(chat.memorySnapshot().messages[1].scene,/Inn/);
 wait.resolve();await pending;assert.equal(save.disabled,false);assert.equal(h.state.busy,false);assert.equal(store.status.paused,false);
 assert.equal(chat.memorySnapshot().historyComplete,true);assert.equal(store.confirmed.messages[1].scene,editedScene);assert.equal(h.calls.sceneOptions.session.historyRevision,0);
 assert.deepEqual({history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads,session:h.calls.sessionReads},before);
 h.el('chat-input').value='Continue from the saved room';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.ok(h.calls.requests[0].messages.some(m=>m.content.includes('Saved Hall')));assert.equal(h.calls.historyReads,before.history);
 chat.setSession(null);chat.setSession('improvement');assert.equal(chat.memorySnapshot().messages.find(m=>m.id==='a').scene,editedScene);
});

test('Scene save applies summary retirements and fallback/memory metadata to history and the idle store',async()=>{
 const {h,chat,store,edit}=await sceneSaveHarness();
 const summaries=[{id:'early',role:'summary',order:3,content:'Earlier',coveredRange:{toOrder:1}},{id:'late',role:'summary',order:4,content:'Obsolete',coveredRange:{toOrder:2}}];
 await h.calls.latestCallbacks.at(-1)({messages:[...h.calls.history,...summaries],hasEarlier:false});
 h.calls.retiredSummaries=['late'];h.calls.sceneSessionPatch={activeSummaryMessageId:'early',breakpointOrder:1,memoryState:{extractedThroughOrder:2,needsRebuild:true,rebuildFromOrder:2},memoryInvalidations:[{fromOrder:2,toOrder:2,revision:1}]};
 const before=h.calls.historyReads;await (await edit()).click();
 assert.equal(h.calls.historyReads,before);assert.equal(chat.memorySnapshot().messages.find(m=>m.id==='late').retired,true);
 assert.equal(store.confirmed.messages.find(m=>m.id==='late').retired,true);assert.equal(store.confirmed.session.activeSummaryMessageId,'early');assert.equal(store.confirmed.session.memoryState.needsRebuild,true);
});

for(const kind of ['scene','director'])test(kind+' save flushes pending uploads before its direct write and blocks new admissions',async()=>{
 const ctx=kind==='scene'?await sceneSaveHarness():await directorSaveHarness(),{h,store,chat}=ctx;
 const wait=deferred();let uploading=false;h.calls.editMessage=async(_sid,id,content)=>{uploading=true;await wait.promise;const replacement={...h.calls.history.find(m=>m.id===id),content,revision:1};h.calls.history=h.calls.history.map(m=>m.id===id?replacement:m);const session={...store.view.session,historyRevision:1};h.calls.sessionDocs.improvement=session;h.calls.historyRevision=1;return {session,replacement,historyRevision:1};};
 store.enqueue('edit',{id:'u',order:1,content:'Uploaded correction',expectedRevision:0});await settle();assert.equal(uploading,true);
 let saving;if(kind==='scene')saving=(await ctx.edit()).click();else{const api=await h.use('continuity.js');saving=chat.saveDirectorLiveState('improvement',saveSeed,api.requestSource(store.view.session));}
 await settle();assert.equal(h.calls.sceneSaves ?? h.calls.directorSaves ?? 0,0);assert.throws(()=>store.enqueue('delete',{id:'a',order:2}),/Sync/);
 wait.resolve();await saving;assert.equal(store.confirmed.messages[0].content,'Uploaded correction');assert.equal(store.requiresReconciliation,false);assert.equal(store.status.paused,false);
});

for(const kind of ['scene','director'])test(kind+' failed write preserves its draft and releases all save locks',async()=>{
 const ctx=kind==='scene'?await sceneSaveHarness():await directorSaveHarness(),{h,chat,store}=ctx;let root,save;
 if(kind==='scene'){save=await ctx.edit();h.calls.onSceneSave=async()=>{throw Error('Offline');};}else{root=await ctx.open();save=namedButton(root,'Save live state');h.calls.onDirectorSave=async()=>{throw Error('Offline');};}
 await save.click();assert.equal(save.disabled,false);assert.equal(h.state.busy,false);assert.equal(store.status.paused,false);assert.equal(store.requiresReconciliation,false);
 if(kind==='scene'){assert.equal(h.el('message-list').querySelector('input').value,editedScene);assert.match(chat.memorySnapshot().messages[1].scene,/Inn/);}
 else {assert.equal(root.querySelectorAll('input')[1].value,'21:15');assert.equal(chat.memorySnapshot().session.directorState.scene.time,'20:00');}
});

test('Warm Director save waits for Firebase and applies state/checkpoint before dismissed-dialog Send resumes without refreshes',async()=>{
 const {h,chat,store,open}=await directorSaveHarness(),wait=deferred(),root=await open(),save=namedButton(root,'Save live state');h.calls.onDirectorSave=()=>wait.promise;
 const before={history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads,session:h.calls.sessionReads};
 const saving=save.click();await settle();assert.equal(save.disabled,true);await save.click();assert.equal(h.calls.directorSaves,1);
 await root.querySelector('.settings-close').click();h.el('chat-input').value='Continue after save';
 const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await settle();assert.equal(h.calls.requests.length,0);assert.equal(h.state.busy,true);
 Object.assign(h.state.settings,{narrationMode:'director',directorProfileId:'director-profile',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5,profiles:[...h.state.settings.profiles,{id:'director-profile',endpoint:'https://director.test',apiKey:'key',modelId:'director'}]});
 h.calls.onRequest=body=>{if(body.model==='director'){assert.ok(body.messages.some(m=>m.content.includes('21:15')));assert.equal(store.view.turns.manual_saved.after.scene.time,'21:15');assert.equal(store.view.session.directorCheckpoint,'manual_saved');h.calls.response=JSON.stringify({version:1,action:'narrate',transition:'unchanged',objective:'Describe the room',stopCondition:'Stop before the next action',memoryIds:[],requiredMemoryIds:[],updates:{}});}else h.calls.response='The room waits.';};
 wait.resolve();await saving;await send;
 assert.equal(save.disabled,false);assert.equal(h.state.busy,false);assert.equal(store.status.paused,false);assert.equal(chat.memorySnapshot().session.directorState.scene.time,'21:15');assert.equal(h.calls.requests.length,2,JSON.stringify({toasts:h.document.body.querySelectorAll('.toast').map(t=>t.textContent),ui:h.el('message-list').children.map(t=>t.textContent)}));
 assert.deepEqual({history:h.calls.historyReads,lore:h.calls.loreReads,settings:h.calls.reads,session:h.calls.sessionReads},before);assert.equal(h.calls.directorReads ?? 0,0);
});

for(const outcome of ['failure','reconcile-failure'])test('Dismissed Director '+outcome+' keeps failed drafts and lets confirmed saves continue without full Sync',async()=>{
 const {h,chat,store,open}=await directorSaveHarness(),wait=deferred(),root=await open(),loreBefore=h.calls.loreReads ?? 0;h.calls.onDirectorSave=()=>wait.promise;
 if(outcome==='reconcile-failure'){h.calls.beforeDirectorReturn=()=>{h.calls.sessionCallbacks.at(-1)({data:()=>({...h.calls.sessionDocs.improvement,loreRevision:4})});};h.calls.onLoreRead=async()=>{throw Error('Refresh offline');};h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);}
 const saving=namedButton(root,'Save live state').click();await settle();await root.querySelector('.settings-close').click();h.el('chat-input').value='Keep waiting draft';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await settle();
 if(outcome==='failure')wait.reject(Error('Offline'));else wait.resolve();await saving;await send;
 assert.equal(h.calls.requests.length,outcome==='failure'?0:1);assert.equal(h.el('chat-input').value,outcome==='failure'?'Keep waiting draft':'');assert.equal(h.state.busy,false);assert.equal(store.status.paused,false);assert.equal(store.requiresReconciliation,false);
 if(outcome==='failure')assert.ok(h.document.body.querySelectorAll('.toast').some(t=>/failed/.test(t.textContent)));
 else {assert.equal(chat.memorySnapshot().session.directorState.scene.time,'21:15');assert.equal(h.calls.loreReads ?? 0,loreBefore);assert.equal(h.calls.historyReads,1);}
 if(outcome==='failure'){await open();const latest=h.document.body.children.filter(n=>(n.className ?? '').includes('memory-sub-sheet')).at(-1);assert.equal(latest.querySelectorAll('input')[1].value,'21:15');assert.equal(chat.memorySnapshot().session.directorState.scene.time,'20:00');}
});

test('A newer scene-save snapshot stays authoritative and requires coherent reconciliation before queued mutations',async()=>{
 const {h,chat,store,edit}=await sceneSaveHarness();h.calls.beforeSceneReturn=result=>{h.calls.historyRevision=4;h.calls.sessionCallbacks.at(-1)({data:()=>({...result.session,historyRevision:4,loreRevision:3,directorRevision:2})});};
 const before=h.calls.historyReads ?? 0;await (await edit()).click();assert.equal(h.calls.historyReads ?? 0,before);assert.equal(chat.memorySnapshot().session.historyRevision,4);assert.equal(chat.memorySnapshot().session.loreRevision,3);
 assert.equal(chat.memorySnapshot().historyComplete,false);assert.equal(store.requiresReconciliation,true);assert.match(chat.memorySnapshot().messages[1].scene,/Saved Hall/);
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);h.calls.serverHistory=h.calls.history.map(m=>m.id==='u'?{...m,content:'Remote current action'}:m);
 h.el('chat-input').value='Continue after reconciliation';await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(store.requiresReconciliation,false);assert.ok(h.calls.historyReads>before);assert.ok(h.calls.requests[0].messages.some(m=>m.content.includes('Remote current action')));
});

for(const switched of ['story','account','away-back'])test('Director result after '+switched+' change cannot update the active story and always releases its queue',async()=>{
 const {h,chat,store,open}=await directorSaveHarness(),wait=deferred(),root=await open();h.calls.onDirectorSave=()=>wait.promise;
 const saving=namedButton(root,'Save live state').click();await settle();
 if(switched==='account')h.calls.uid='other';else{chat.setSession(null);if(switched==='away-back')chat.setSession('improvement');}
 wait.resolve();await saving;assert.equal(store.status.paused,false);assert.equal(store.requiresReconciliation,true);assert.equal(chat.memorySnapshot()?.session.directorState?.scene.time ?? '20:00','20:00');
});

test('Director local application leaves cache persistence outside the save completion wait and survives reopening',async()=>{
 const caches=[],{h,chat,store,open}=await directorSaveHarness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},saveStoryData:(_u,_s,value)=>{caches.push(structuredClone(value));return new Promise(()=>{});}}});
 const root=await open();await namedButton(root,'Save live state').click();assert.equal(store.confirmed.session.directorState.scene.time,'21:15');assert.ok(caches.some(v=>v.confirmed?.turns.manual_saved));
 chat.setSession(null);chat.setSession('improvement');assert.equal(chat.memorySnapshot().session.directorState.scene.time,'21:15');
});

test('A same-revision author metadata change during a scene save is retained for coherent reconciliation',async()=>{
 const {h,chat,store,edit}=await sceneSaveHarness();h.calls.beforeSceneReturn=result=>h.calls.sessionCallbacks.at(-1)({data:()=>({...result.session,longTermPlan:'Newer author plan'})});
 await (await edit()).click();assert.equal(chat.memorySnapshot().session.longTermPlan,'Newer author plan');assert.equal(store.requiresReconciliation,true);assert.equal(chat.memorySnapshot().historyComplete,false);assert.equal(h.state.busy,false);
});

test('Director save reconciles a remote dependency revision before settling its dismissed dialog and Send',async()=>{
 const {h,chat,store,open}=await directorSaveHarness(),wait=deferred(),root=await open();h.calls.onDirectorSave=()=>wait.promise;h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);
 h.calls.beforeDirectorReturn=()=>h.calls.sessionCallbacks.at(-1)({data:()=>({...h.calls.sessionDocs.improvement,loreRevision:3})});
 const saving=namedButton(root,'Save live state').click();await settle();await root.querySelector('.settings-close').click();h.el('chat-input').value='Use reconciled state';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});await settle();
 const before=h.calls.historyReads ?? 0;wait.resolve();await saving;await send;
 assert.equal(store.requiresReconciliation,false);assert.equal(store.status.paused,false);assert.equal(chat.memorySnapshot().session.directorState.scene.time,'21:15');assert.equal(chat.memorySnapshot().session.loreRevision,3);assert.ok(h.calls.historyReads>before);assert.equal(h.calls.requests.length,1);assert.equal(h.state.busy,false);
});

test('Concurrent Director coordinators produce one write and release the queue after the committed result',async()=>{
 const {h,chat,store}=await directorSaveHarness(),wait=deferred(),api=await h.use('continuity.js'),source=api.requestSource(chat.memorySnapshot().session);h.calls.onDirectorSave=()=>wait.promise;
 const saving=chat.saveDirectorLiveState('improvement',saveSeed,source);await settle();await assert.rejects(chat.saveDirectorLiveState('improvement',saveSeed,source),/already saving/);assert.equal(h.calls.directorSaves,1);
 wait.resolve();await saving;assert.equal(store.status.paused,false);assert.equal(store.confirmed.session.directorCheckpoint,'manual_saved');
});

test('Provider cooldown resets only after saved manual reselection, survives a failed save, and never resets other providers',async()=>{
  const h=await harness(),routing=await h.use('provider-routing.js');
  const profile=h.state.settings.profiles.find(p=>p.id===h.state.settings.activeProfileId);
  profile.endpoint='https://openrouter.ai/api/v1/chat/completions';profile.modelId='author/model';profile.providerOrder=['first','second'];
  h.settings.mirrorFromActiveProfile(h.state.settings);h.state.settings.providerCooldownAccount='test-user';
  routing.coolDownProvider(h.state.settings,'first');routing.coolDownProvider(h.state.settings,'second');
  h.calls.modelFetch=async()=>({ok:true,json:async()=>({data:{endpoints:[{tag:'first',provider_name:'First'},{tag:'second',provider_name:'Second'}]}})});
  const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();await h.fire('btn-fetch-providers');
  await h.el('provider-selected').children[0].children[3].click();
  assert.ok(routing.providerRetryAt(h.state.settings,'first'));
  await h.el('provider-list').children[0].children[1].click();
  assert.ok(routing.providerRetryAt(h.state.settings,'first'));
  h.calls.fail=true;await h.fire('btn-save-settings');assert.ok(routing.providerRetryAt(h.state.settings,'first'));assert.match(h.el('settings-saved-msg').textContent,/Save failed/);
  h.calls.fail=false;await h.fire('btn-save-settings');assert.equal(routing.providerRetryAt(h.state.settings,'first'),0);assert.ok(routing.providerRetryAt(h.state.settings,'second'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.writes.at(-1).profiles[0].providerOrder)),['second','first']);assert.equal(h.calls.writes.at(-1).providerCooldownAccount,undefined);
});

test('Changing model discards draft provider selection and resolving another profile never inherits its provider order',async()=>{
  const h=await harness(),profile=h.state.settings.profiles.find(p=>p.id===h.state.settings.activeProfileId);
  profile.providerOrder=['first'];h.settings.mirrorFromActiveProfile(h.state.settings);
  const view=await h.use('ui/settings-view.js');view.initSettingsView();view.openSettingsPopup();
  h.el('set-model').value='other/model';await h.fire('set-model','input');await h.fire('btn-save-settings');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.settings.providerOrder)),[]);
  const models=await h.use('model-profiles.js');h.state.settings.providerOrder=['first'];h.state.settings.profiles.push({id:'other',endpoint:profile.endpoint,modelId:'other/model',providerOrder:['third']});
  const resolved=models.resolveModelProfile(h.state.settings,'other');assert.deepEqual(JSON.parse(JSON.stringify(resolved.providerOrder)),['third']);resolved.providerOrder.push('fourth');assert.equal(h.state.settings.profiles.at(-1).providerOrder.length,1);
});

test('Send paints feedback and the queued message before request preparation, without stealing scroll position',async()=>{
 const {createWorkBudget}=await import('../js/ui-work.js');const paints=[];
 const h=await harness({extraStubs:{'ui-work.js':{createWorkBudget,afterUiPaint:()=>new Promise(resolve=>paints.push(resolve))}}});
 await openImprovementChat(h);h.state.settings.streaming=true;h.calls.streamLines=['data: {"choices":[{"delta":{"content":"The traveler waits."},"finish_reason":"stop"}]}\n','data: [DONE]\n'];const list=h.el('message-list');list.scrollHeight=3000;list.scrollTop=2500;
 await list.dispatchEvent({type:'scroll'});
 h.el('chat-input').value='A new action';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(h.el('composer-preparing').hidden,false);assert.equal(h.el('btn-send').hidden,true);
 assert.equal(h.calls.messages.length,0);assert.equal(h.calls.requests.length,0);
 paints.shift()();for(let i=0;i<30&&!paints.length;i++)await settle();
 assert.equal(h.el('chat-input').value,'');assert.ok(list.children.some(n=>n.dataset.messageId));assert.equal(h.calls.requests.length,0);
 list.scrollTop=800;await list.dispatchEvent({type:'scroll'});
 paints.shift()();await send;
 assert.equal(list.scrollTop,800);assert.equal(h.el('composer-preparing').hidden,true);assert.equal(h.calls.requests.length,1);
});

test('Stop before the first paint retains the draft and prevents a late request',async()=>{
 const {createWorkBudget}=await import('../js/ui-work.js');const paints=[];
 const h=await harness({extraStubs:{'ui-work.js':{createWorkBudget,afterUiPaint:()=>new Promise(resolve=>paints.push(resolve))}}});
 await openImprovementChat(h);h.el('chat-input').value='Do not submit';
 const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 await h.stopAfterGuard();assert.equal(h.state.busy,false);assert.equal(h.el('composer-preparing').hidden,true);
 paints.shift()();await send;
 assert.equal(h.el('chat-input').value,'Do not submit');assert.equal(h.calls.requests.length,0);assert.equal(h.calls.messages.length,0);
});

test('stream text appends preserve the text node and unchanged frames do no writes',async()=>{
 const source=(await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8'))+'\nexport {updateStreamText};';
 const h=await harness({sources:{'ui/chat-view.js':source}}),chat=await h.use('ui/chat-view.js');
 let value='Hello',replacements=0,appends=0;
 const text={nodeType:3,appendData:s=>{value+=s;appends++;}};
 const node={firstChild:text,lastChild:text,get textContent(){return value;},set textContent(v){value=v;replacements++;}};
 chat.updateStreamText(node,'Hello there');assert.equal(appends,1);assert.equal(replacements,0);
 chat.updateStreamText(node,'Hello there');assert.equal(appends,1);assert.equal(replacements,0);
 chat.updateStreamText(node,'Hello');assert.equal(replacements,1);assert.equal(value,'Hello');
});


test('cached token window and indicator never start the accurate tokenizer automatically',async()=>{
 const h=await harness();const chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Opening.'}]);
 h.state.settings.tokenCountingMode='accurate';let exactCalls=0;h.calls.onTokenCount=()=>{exactCalls++;return new Promise(()=>{});};
 h.el('chat-input').value='Unsent action never counted';await chat.updateIndicator();await new Promise(resolve=>setTimeout(resolve,25));
 const viewer=await h.use('ui/context-viewer.js');viewer.initContextViewer();const estimates=h.calls.estimateCalls,requests=h.calls.requests.length,reads=h.calls.historyReads ?? 0;
 for(let i=0;i<5;i++){
  viewer.openContextViewer();const root=h.el('context-viewer');assert.ok(root.querySelector('.context-total'));
  assert.match(root.querySelector('.context-count-status').textContent,/Cached context estimate/);
  await root.querySelector('.settings-close').click();
 }
 assert.equal(exactCalls,0);assert.equal(h.calls.estimateCalls,estimates);assert.equal(h.calls.requests.length,requests);assert.equal(h.calls.historyReads ?? 0,reads);
 assert.match(h.el('context-label').textContent,/input.*tokens.*estimate/);
});

test('accurate current preview runs only on request and is cached after completion',async()=>{
 const h=await harness();const chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start refining.'},{id:'a',order:2,role:'assistant',content:'Opening refining.'}]);
 h.state.settings.tokenCountingMode='accurate';let release,calls=0;const ready=new Promise(resolve=>release=resolve);
 h.calls.onTokenCount=async text=>{calls++;await ready;return text.length;};await chat.updateIndicator();await new Promise(resolve=>setTimeout(resolve,25));
 const viewer=await h.use('ui/context-viewer.js');viewer.initContextViewer();viewer.openContextViewer();const root=h.el('context-viewer');
 assert.equal(calls,0);assert.match(root.querySelector('.context-count-status').textContent,/Cached context estimate/);
 const calculating=root.querySelectorAll('button').find(b=>b.textContent==='Calculate current preview').click();await settle();assert.ok(calls>0);
 assert.ok(root.querySelector('.context-total'),'Cached overview stays visible during calculation');
 release();await calculating;assert.match(root.querySelector('.context-count-status').textContent,/Tokenizer count/);
 const before=calls;await root.querySelector('.settings-close').click();viewer.openContextViewer();
 await root.querySelectorAll('button').find(b=>b.textContent==='View cached current preview').click();assert.equal(calls,before);
 assert.equal(h.calls.requests.length,0);await root.querySelector('.settings-close').click();
});

test('saving an edit replaces the row without first removing it from the scrolling list',async()=>{
 const {h,bubble,pending}=await oldMessageEditor();await pending;
 let removed=false;const remove=bubble.remove.bind(bubble);bubble.remove=()=>{removed=true;remove();};
 bubble.querySelector('.msg-editor').value='Corrected text';
 await bubble.querySelector('.msg-actions').children.find(b=>b.textContent==='Save').click();
 assert.equal(removed,false,'Keep the row in layout until its replacement is ready');
 assert.equal(h.el('message-list').querySelector('.msg-editor'),null);
});

test('finishing a stream atomically replaces its row instead of temporarily duplicating the reply',async()=>{
 const source=(await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8'))+`\nexport {startStreamUI};\nexport function completeStreamFixture(message){streamState.savedId=message.id;streamState.saveCompleted=true;renderMessages([...lastMessages,message]);}\n`;
 const h=await harness({sources:{'ui/chat-view.js':source}}),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Begin.'}]);
 chat.startStreamUI();const list=h.el('message-list'),stream=list.children.at(-1);let duplicated=false;
 const insert=list.insertBefore.bind(list);list.insertBefore=(node,anchor)=>{if(node.dataset.messageId==='a' && stream.parentNode===list)duplicated=true;return insert(node,anchor);};
 chat.completeStreamFixture({id:'a',order:2,role:'assistant',content:'Completed narration.'});
 assert.equal(duplicated,false,'Do not insert the completed reply beside the full streaming reply');
 assert.equal(stream.parentNode,null);assert.equal(list.children.filter(n=>n.dataset.messageId==='a').length,1);
});

test('scroll gestures do not highlight or copy a long message, while a stationary hold still copies',async()=>{
 const source=(await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8'))+'\nexport {attachHoldToCopy};';
 const jobs=new Map();let serial=0;
 const h=await harness({sources:{'ui/chat-view.js':source},timers:{setTimeout:(fn,ms)=>{jobs.set(++serial,{fn,ms});return serial;},clearTimeout:id=>jobs.delete(id)}}),chat=await h.use('ui/chat-view.js');
 const target=h.document.createElement('div');chat.attachHoldToCopy(target,()=> 'Narration to copy');
 const pointer={pointerType:'touch',clientX:50,clientY:100,target:{closest:()=>null}};
 await target.dispatchEvent({type:'pointerdown',...pointer});
 assert.equal(target.classList.contains('holding'),false,'A scroll starts with pointerdown, so delay visual hold feedback');
 await target.dispatchEvent({type:'pointermove',...pointer,clientY:125});
 for(const [id,job]of [...jobs])if(job.ms===500){jobs.delete(id);job.fn();}
 await target.dispatchEvent({type:'pointerup',...pointer});assert.equal(h.calls.clipboard,undefined);
 await target.dispatchEvent({type:'pointerdown',...pointer});
 for(const [id,job]of [...jobs])if(job.ms===500){jobs.delete(id);job.fn();}
 assert.equal(target.classList.contains('holding'),true);
 await target.dispatchEvent({type:'pointerup',...pointer});assert.equal(h.calls.clipboard,'Narration to copy');assert.equal(target.classList.contains('holding'),false);
});

test('replacing content above the viewport preserves the visible message anchor',async()=>{
 const source=(await readFile(new URL('../js/ui/chat-view.js',import.meta.url),'utf8'))+'\nexport {renderMessages};';
 const h=await harness({sources:{'ui/chat-view.js':source}}),chat=await openImprovementChat(h,{},[
  {id:'u',order:1,role:'user',content:'x'.repeat(300)},
  {id:'a',order:2,role:'assistant',content:'y'.repeat(600)},
  {id:'u2',order:3,role:'user',content:'z'.repeat(300)},
 ]);
 const list=h.el('message-list');list.clientHeight=500;list.scrollTop=800;
 const height=node=>40+(node.querySelector?.('.msg-content')?.textContent?.length ?? 0)*2;
 const rect=node=>{let top=-list.scrollTop;for(const sibling of list.children){if(sibling===node)break;top+=height(sibling);}return {top,bottom:top+height(node),height:height(node),width:320};};
 list.getBoundingClientRect=()=>({top:0,bottom:500,height:500,width:320});
 Object.defineProperty(list,'scrollHeight',{get:()=>list.children.reduce((n,node)=>n+height(node),0)});
 for(const node of list.children)node.getBoundingClientRect=()=>rect(node);
 const create=h.document.createElement;h.document.createElement=tag=>{const node=create(tag);node.getBoundingClientRect=()=>rect(node);return node;};
 const visible=()=>list.children.find(node=>node.dataset.messageId==='a');const before=visible().getBoundingClientRect().top;
 chat.renderMessages(chat.memorySnapshot().messages.map(m=>m.id==='u'?{...m,content:'Shortened above viewport'}:m));
 assert.equal(visible().getBoundingClientRect().top,before);assert.ok(list.scrollTop>=0);assert.ok(list.scrollTop<=list.scrollHeight-list.clientHeight);
});


test('provider input usage is shared by indicator and cached window; context changes never recount it',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.responseData={choices:[{finish_reason:'stop',message:{content:'A short reply.'}}],usage:{prompt_tokens:75000,completion_tokens:1200,total_tokens:76200}};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const before=chat.tokenUsageSnapshot();assert.equal(before.record.kind,'provider');assert.equal(before.record.tokens,75000);
 assert.equal(before.contextChanged,false);assert.match(h.el('context-label').textContent,/75,000.*last sent.*provider/);
 const localInput=chat.memorySnapshot().sentContext.report.totals.input;assert.equal(before.record.report.totals.input,localInput);assert.notEqual(localInput,75000);
 const estimates=h.calls.estimateCalls,reads=h.calls.historyReads ?? 0,requests=h.calls.requests.length;
 h.calls.onTokenCount=()=>{throw Error('Cached usage must never invoke tokenizer');};
 const viewer=await h.use('ui/context-viewer.js');viewer.initContextViewer();
 for(let i=0;i<3;i++){viewer.openContextViewer();assert.match(h.el('context-viewer').querySelector('.context-total').textContent,/75,000/);await h.el('context-viewer').querySelector('.settings-close').click();}
 h.state.settings.maxContextTokens=100000;await chat.updateIndicator();await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(chat.tokenUsageSnapshot().contextChanged,true);assert.equal(chat.tokenUsageSnapshot().record.tokens,75000);
 assert.equal(h.calls.estimateCalls,estimates);assert.equal(h.calls.historyReads ?? 0,reads);assert.equal(h.calls.requests.length,requests);
 assert.ok(h.calls.messages.every(([,message])=>!Object.hasOwn(message,'tokenUsage') && !Object.hasOwn(message,'prompt_tokens')));
});

test('missing provider usage reuses sent-context estimate; a failed following request preserves that count',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.response='Completed reply.';await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 const expected=chat.memorySnapshot().sentContext.report.totals.input;
 assert.equal(chat.tokenUsageSnapshot().record.kind,'sent-estimate');assert.equal(chat.tokenUsageSnapshot().record.tokens,expected);
 const before=JSON.stringify(chat.tokenUsageSnapshot().record);
 h.calls.responseData={error:{message:'Provider unavailable'}};h.el('chat-input').value='Another action';
 await h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
 assert.equal(JSON.stringify(chat.tokenUsageSnapshot().record),before);
});

test('provider count survives reload through device cache without being added to story messages',async()=>{
 const idb=indexedDBFixture(),h=await harness({globals:{indexedDB:idb.indexedDB}}),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.responseData={choices:[{finish_reason:'stop',message:{content:'Cached reply.'}}],usage:{prompt_tokens:75000}};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();await settle();
 const cache=await h.use('chat-cache.js'),saved=await cache.loadChatCache('test-user','improvement');assert.equal(saved.tokenUsage.tokens,75000);
 const fresh=await harness({globals:{indexedDB:idb.indexedDB}});const restored=await openImprovementChat(fresh,{},chat.memorySnapshot().messages);await settle();
 assert.equal(restored.tokenUsageSnapshot().record.tokens,75000);assert.equal(restored.tokenUsageSnapshot().record.kind,'provider');
 assert.equal(fresh.calls.requests.length,0);assert.equal(fresh.calls.estimateCalls ?? 0,0);
});


test('regeneration replaces the cached provider count with the new completed request usage',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.responseData={choices:[{finish_reason:'stop',message:{content:'First reply.'}}],usage:{prompt_tokens:75000}};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 assert.equal(chat.tokenUsageSnapshot().record.tokens,75000);
 h.calls.responseData={choices:[{finish_reason:'stop',message:{content:'Replacement reply.'}}],usage:{prompt_tokens:76000,completion_tokens:1800,total_tokens:77800}};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Regenerate').click();
 assert.equal(chat.tokenUsageSnapshot().record.tokens,76000);assert.equal(chat.tokenUsageSnapshot().record.kind,'provider');
 assert.match(h.el('context-label').textContent,/76,000.*last sent/);
});

test('a manual preview is invalidated by context changes and cannot publish a stale result',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'},{id:'a',order:2,role:'assistant',content:'Reply.'}]);
 await chat.updateIndicator();await new Promise(resolve=>setTimeout(resolve,15));
 h.state.settings.tokenCountingMode='accurate';let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 h.calls.onTokenCount=async text=>{started();await gate;return text.length;};
 const computing=chat.calculateCurrentTokenPreview();await ready;h.state.settings.maxContextTokens=110000;release();
 await assert.rejects(computing,/changed/);assert.equal(chat.tokenUsageSnapshot().previewCached,false);
});


test('provider input_tokens usage is accepted without adding output or reasoning usage',async()=>{
 const h=await harness(),chat=await openImprovementChat(h,{},[{id:'u',order:1,role:'user',content:'Start.'}]);
 h.calls.responseData={choices:[{finish_reason:'stop',message:{content:'Reply.'}}],usage:{input_tokens:75000,output_tokens:21000}};
 await h.el('message-list').querySelectorAll('button').find(b=>b.textContent==='Retry reply').click();
 assert.equal(chat.tokenUsageSnapshot().record.tokens,75000);assert.equal(chat.tokenUsageSnapshot().record.kind,'provider');
});

async function rebuildDismissHarness() {
 const cachedChats=new Map(),cachedStories=new Map(),cacheKey=(uid,sid)=>uid+':'+sid;
 const chatCache={
  loadChatCache:async(uid,sid)=>structuredClone(cachedChats.get(cacheKey(uid,sid)) ?? null),
  saveChatCache:async(uid,sid,value)=>{cachedChats.set(cacheKey(uid,sid),structuredClone(value));},deleteChatCache:async()=>{},
  loadStoryData:async(uid,sid)=>structuredClone(cachedStories.get(cacheKey(uid,sid)) ?? null),
  saveStoryData:async(uid,sid,value)=>{const key=cacheKey(uid,sid);cachedStories.set(key,{...cachedStories.get(key),...structuredClone(value)});return true;},
 };
 const server={id:'improvement',title:'Story',storageVersion:2,continuityVersion:2,lookupVersion:1,storySettingsRevision:1,historyRevision:5,
  memory:{lorebooks:true,autoUpdate:true,batchTurns:10,lagTurns:0},memoryInvalidations:[{revision:4,fromOrder:1,toOrder:122}],
  memoryState:{extractedThroughOrder:122,paused:true,failureStreak:2,needsRebuild:true,rebuildFromOrder:1}};
 let h;
 h=await harness({chatCache,firestoreOverrides:{runTransaction:async(_db,work)=>{
  h.calls.dismissAttempts=(h.calls.dismissAttempts ?? 0)+1;await h.calls.onDismissSave?.();
  const writes=[],result=await work({get:async()=>({exists:()=>true,data:()=>structuredClone(server)}),update:(_ref,patch)=>writes.push(patch)});
  if(h.calls.failDismiss)throw Error('Offline');
  for(const patch of writes){h.calls.dismissWrites=(h.calls.dismissWrites ?? 0)+1;for(const [key,value]of Object.entries(patch)){const path=key.split('.');let target=server;for(const part of path.slice(0,-1))target=target[part]??={};target[path.at(-1)]=value;}}
  h.calls.sessionDocs.improvement=structuredClone(server);await h.calls.beforeDismissReturn?.();return result;
 }}});
 const {makeEntry}=await h.use('lore-lines.js'),card=makeEntry('characters','Mira');card.sections.appearance.text='Author-maintained appearance.';h.calls.loreEntries=[card];
 const messages=Array.from({length:22},(_,i)=>({id:'m'+i,order:101+i,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+20,content:'Story '+i,revision:0}));
 const chat=await openImprovementChat(h,structuredClone(server),messages);await chat.prepareMemorySnapshot();await settle();
 const lore=await h.use('ui/lorebook-view.js');lore.initLorebookView();lore.openLorebooks({screen:'list',book:'characters'});await settle();
 const settings=await h.use('ui/memory-settings-view.js');settings.initMemorySettings(()=>{});settings.fillMemory(server.memory);
 const store=(await h.use('local-story-store.js')).storyStore('improvement'),root=h.el('lorebook-overlay');
 const banner=()=>root.querySelectorAll('button').find(b=>b.textContent.startsWith('History edited'));
 return {h,chat,lore,settings,store,server,root,banner,card,chatCache};
}

for(const surface of ['lorebooks','settings'])test('Dismiss rebuild from '+surface+' immediately clears the screenshot notice and persists without AI calls',async()=>{
 const {h,chat,store,server,root,banner,chatCache}=await rebuildDismissHarness();
 assert.equal(banner().textContent,'History edited at T? — re-extract 11 turns (~2 extraction calls)');
 assert.equal(h.el('mem-dismiss-rebuild').classList.contains('hidden'),false);
 const before=structuredClone(chat.memorySnapshot()),reads={history:h.calls.historyReads,lore:h.calls.loreReads,session:h.calls.sessionReads};
 await (surface==='lorebooks'?namedButton(root,'Dismiss'):h.el('mem-dismiss-rebuild')).click();await settle();
 assert.equal(banner(),undefined);assert.equal(h.el('mem-dismiss-rebuild').classList.contains('hidden'),true);
 assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,false);assert.equal(store.confirmed.session.memoryState.needsRebuild,false);assert.equal(server.memoryState.needsRebuild,false);
 for(const key of ['extractedThroughOrder','paused','failureStreak'])assert.equal(chat.memorySnapshot().session.memoryState[key],before.session.memoryState[key]);
 assert.deepEqual(chat.memorySnapshot().session.memory,before.session.memory);assert.deepEqual(chat.memorySnapshot().entries,before.entries);
 assert.equal(h.calls.dismissWrites,1);assert.equal(h.calls.requests.length,0);assert.equal(h.calls.memoryStarts ?? 0,0);assert.equal(h.calls.catchUps ?? 0,0);
 assert.deepEqual({history:h.calls.historyReads,lore:h.calls.loreReads,session:h.calls.sessionReads},reads);
 const cache=await h.use('chat-cache.js'),saved=await cache.loadStoryData('test-user','improvement');
 assert.equal(saved.confirmed.session.memoryState.needsRebuild,false);assert.equal((await cache.loadChatCache('test-user','improvement')).session.memoryState.needsRebuild,false);
 chat.setSession(null);chat.setSession('improvement');assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,false);
 const fresh=await harness({chatCache}),restored=await fresh.use('ui/chat-view.js');restored.initChatView();restored.setSession('improvement');await settle();
 assert.equal(restored.memorySnapshot().session.memoryState.needsRebuild,false);
});

test('Dismiss rebuild refreshes the list while retaining the open unsaved card draft',async()=>{
 const {h,lore,root,card,banner}=await rebuildDismissHarness();lore.openLorebooks({entryId:card.id});await settle();
 const editor=root.querySelector('.lore-editor'),appearance=editor.querySelectorAll('.lore-section')[1].querySelector('textarea');
 appearance.value='Unsaved author correction';await appearance.dispatchEvent({type:'input'});
 await namedButton(root,'Dismiss').click();
 assert.equal(banner(),undefined);assert.equal(root.querySelector('.lore-editor'),editor);assert.equal(appearance.value,'Unsaved author correction');assert.equal(h.calls.cardWrites,undefined);
});

for(const surface of ['lorebooks','settings'])test('Dismiss rebuild from '+surface+' keeps edits made after the displayed notice',async()=>{
 const {h,chat,store,server,root,banner}=await rebuildDismissHarness();
 server.historyRevision=6;server.memoryInvalidations.push({revision:6,fromOrder:110,toOrder:122});
 h.calls.historyRevision=6;h.calls.sessionCallbacks.at(-1)({data:()=>structuredClone(server)});
 await (surface==='lorebooks'?namedButton(root,'Dismiss'):h.el('mem-dismiss-rebuild')).click();
 const remaining=JSON.parse(JSON.stringify(chat.memorySnapshot().session.memoryInvalidations));
 assert.deepEqual(remaining,[{revision:6,fromOrder:110,toOrder:122}]);assert.equal(store.confirmed.session.memoryState.needsRebuild,true);
 assert.equal(server.memoryState.rebuildFromOrder,110);assert.ok(banner());assert.equal(h.el('mem-dismiss-rebuild').classList.contains('hidden'),false);
});

test('Dismiss rebuild retains a newer snapshot delivered after its transaction',async()=>{
 const {h,chat,store,server,root}=await rebuildDismissHarness();
 h.calls.beforeDismissReturn=()=>{server.historyRevision=6;server.memoryInvalidations=[{revision:6,fromOrder:110,toOrder:122}];server.memoryState.needsRebuild=true;server.memoryState.rebuildFromOrder=110;h.calls.historyRevision=6;h.calls.sessionCallbacks.at(-1)({data:()=>structuredClone(server)});};
 await namedButton(root,'Dismiss').click();
 assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,true);assert.equal(chat.memorySnapshot().session.memoryState.rebuildFromOrder,110);
 assert.equal(chat.memorySnapshot().session.memoryInvalidations.length,1);
 assert.equal(chat.memorySnapshot().historyComplete,false);assert.equal(store.requiresReconciliation,true);
});

for(const surface of ['lorebooks','settings'])test('Dismiss rebuild from '+surface+' keeps the notice on failure and allows retry',async()=>{
 const {h,chat,store,root,banner}=await rebuildDismissHarness();h.calls.failDismiss=true;
 const button=surface==='lorebooks'?namedButton(root,'Dismiss'):h.el('mem-dismiss-rebuild');await button.click();
 assert.ok(banner());assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,true);assert.equal(store.status.paused,false);assert.equal(!!button.disabled,false);
 assert.ok(h.document.body.querySelectorAll('.toast').some(t=>/Offline/.test(t.textContent)));assert.equal(h.calls.requests.length,0);
 h.calls.failDismiss=false;await button.click();assert.equal(banner(),undefined);assert.equal(h.calls.dismissWrites,1);
});

test('Dismiss rebuild flushes pending edits, blocks duplicate writes and preserves their new invalidation',async()=>{
 const {h,chat,store,server,root}=await rebuildDismissHarness(),upload=deferred();
 h.calls.editMessage=async(_sid,id,content)=>{await upload.promise;const replacement={...h.calls.history.find(m=>m.id===id),content,revision:1};Object.assign(server,structuredClone(store.view.session));h.calls.historyRevision=server.historyRevision;h.calls.sessionDocs.improvement=structuredClone(server);h.calls.history=h.calls.history.map(m=>m.id===id?replacement:m);return {session:structuredClone(server),replacement,historyRevision:server.historyRevision};};
 store.enqueue('edit',{id:'m0',order:101,content:'Newer correction',expectedRevision:0});await settle();
 const saving=namedButton(root,'Dismiss').click();await settle();assert.equal(h.calls.dismissAttempts ?? 0,0);
 await assert.rejects(chat.dismissMemoryRebuild('improvement',5),/already saving/);assert.throws(()=>store.enqueue('delete',{id:'m1',order:102}),/Sync/);
 upload.resolve();await saving;assert.equal(h.calls.dismissWrites,1);assert.equal(store.status.paused,false);assert.equal(store.confirmed.messages[0].content,'Newer correction');
 assert.equal(chat.memorySnapshot().session.memoryState.needsRebuild,true);assert.equal(chat.memorySnapshot().session.memoryInvalidations[0].revision,6);
});

for(const change of ['story','account','away-back'])test('Dismiss rebuild after '+change+' switch cannot patch the active story and releases its save lock',async()=>{
 const {h,chat,store,root}=await rebuildDismissHarness(),wait=deferred();h.calls.onDismissSave=()=>wait.promise;
 let refreshes=0;h.document.addEventListener('memory-refresh',()=>{refreshes++;});
 const saving=namedButton(root,'Dismiss').click();await settle();assert.equal(store.status.paused,true);
 if(change==='account')h.calls.uid='other';else{chat.setSession(null);if(change==='away-back')chat.setSession('improvement');}
 wait.resolve();await saving;
 assert.equal(store.status.paused,false);assert.equal(refreshes,0);assert.equal(store.confirmed.session.memoryState.needsRebuild,true);
 assert.notEqual(chat.memorySnapshot()?.session.memoryState?.needsRebuild,false);
});

async function deviceUploadChat() {
 const {appHarness}=await import('./app-harness.mjs'),pure=await appHarness({stubs:{'db.js':{db:{}},'auth.js':{currentUid:()=> 'test-user'},'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{}}})('device-story-upload.js');
 const saved=new Map();let h;
 const chatCache={loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},
  loadStoryData:async(uid,sid)=>structuredClone(saved.get(uid+':'+sid) ?? null),
  saveStoryData:async(uid,sid,data)=>{const key=uid+':'+sid;saved.set(key,{...saved.get(key),...structuredClone(data)});return true;},
  saveDeviceRecoveryBackup:async(...args)=>{(h.calls.deviceBackups ??= []).push(structuredClone(args));return !h.calls.failDeviceBackup;},
  replaceStoryCache:async(...args)=>{await h.calls.onDeviceCache?.();if(h.calls.failDeviceCache)throw Error('Cache failed');(h.calls.deviceReplacements ??= []).push(structuredClone(args));},
 };
 h=await harness({chatCache,extraStubs:{'device-story-upload.js':{deviceStoryCopies:pure.deviceStoryCopies,validateDeviceStory:pure.validateDeviceStory,
  uploadDeviceStory:async(copy,options)=>{
   (h.calls.deviceUploads ??= []).push(structuredClone(copy));await h.calls.onDeviceUpload?.();
   const session={...copy.session,historyRevision:20,loreRevision:10,storySettingsRevision:10},loreSnapshot={...copy.loreSnapshot,entries:copy.lore,initialized:true,loadedRevision:10,lastCommittedRevision:10};
   const ranges=[{id:'device-chunk',firstOrder:copy.messages[0].order,lastOrder:copy.messages.at(-1).order}];
   return {session,messages:copy.messages,storySettings:{...copy.storySettings,revision:10},loreSnapshot,turns:{},messageSnapshot:{messages:copy.messages,records:[],chunkRanges:ranges},backupId:'cloud-backup',cloudBackup:{...copy,session:{...copy.session,title:'Previous cloud copy'}}};
  }}}});
 const {makeEntry}=await h.use('lore-lines.js'),card=makeEntry('facts','Phone canon');card.sections.text.text='Preserve this author canon.';h.calls.loreEntries=[card];
 const chat=await openImprovementChat(h,{memory:{lorebooks:true,autoUpdate:true},memoryState:{extractedThroughOrder:2}},[{id:'u',order:1,revision:0,role:'user',content:'Phone action'},{id:'a',order:2,revision:0,role:'assistant',content:'Phone reply',thinking:'Private thinking'}]);
 h.state.storySettings.values.narratorSystemPrompt='Phone custom prompt';await chat.prepareMemorySnapshot();await settle();
 const store=(await h.use('local-story-store.js')).storyStore('improvement');
 const open=async()=>{await chat.openDeviceStoryUpload();return h.document.body.querySelectorAll('.memory-sub-sheet').at(-1);};
 return {h,chat,store,open,card};
}

test('Device upload preview reads only local copies and cancellation makes no cloud or model calls',async()=>{
 const {h,open}=await deviceUploadChat(),before={history:h.calls.historyReads,session:h.calls.sessionReads,lore:h.calls.loreReads},root=await open();
 assert.ok(root.querySelector('select'));assert.ok(namedButton(root,'Download device backup'));
 h.calls.confirm=false;await namedButton(root,'Replace Firebase with this copy').click();
 assert.equal(h.calls.deviceUploads,undefined);assert.equal(h.calls.deviceBackups,undefined);assert.equal(h.calls.requests.length,0);
 assert.deepEqual({history:h.calls.historyReads,session:h.calls.sessionReads,lore:h.calls.loreReads},before);
});

test('Force device upload bypasses a stale queue conflict, preserves the whole local branch and clears it only after the cloud save',async()=>{
 const {h,chat,store,open,card}=await deviceUploadChat();let attempts=0;
 h.calls.addMessage=async()=>{attempts++;throw Object.assign(Error('Stale save'),{code:'story-conflict'});};
 store.enqueue('add',{id:'lost-u',message:{role:'user',content:'My lost action'}});store.enqueue('add',{id:'lost-a',message:{role:'assistant',content:'My lost reply'}});await assert.rejects(store.flush());await store.settled();
 const root=await open(),wait=deferred();h.calls.onDeviceUpload=()=>wait.promise;const saving=namedButton(root,'Replace Firebase with this copy').click();await settle();
 assert.equal(h.calls.deviceUploads.length,1);assert.equal(store.status.pending,2);assert.equal(store.status.paused,true);const tried=attempts;
 const upload=h.calls.deviceUploads[0];assert.equal(upload.messages.length,4);assert.equal(upload.messages.at(-1).content,'My lost reply');assert.equal(upload.messages[1].thinking,'Private thinking');
 assert.equal(upload.storySettings.values.narratorSystemPrompt,'Phone custom prompt');assert.equal(upload.lore[0].sections.text.text,card.sections.text.text);
 wait.resolve();await saving;
 assert.equal(attempts,tried,'force upload must not retry the stale queue first');assert.equal(store.status.pending,0);assert.equal(store.status.paused,false);
 assert.equal(chat.memorySnapshot().messages.at(-1).content,'My lost reply');assert.equal(chat.memorySnapshot().session.historyRevision,20);assert.equal(h.state.storySettings.revision,10);
 assert.equal(h.calls.deviceReplacements[0][4].discardPending,true);assert.equal(h.calls.requests.length,0);
 assert.match(root.querySelectorAll('p')[0].textContent,/Uploaded to Firebase/);assert.equal(namedButton(root,'Download previous cloud backup').hidden,false);
});

test('Force device upload keeps pending local turns and releases the queue when the cloud upload fails',async()=>{
 const {h,chat,store,open}=await deviceUploadChat();h.calls.onDeviceUpload=()=>{throw Error('Offline');};const before=structuredClone(chat.memorySnapshot());
 const root=await open();await namedButton(root,'Replace Firebase with this copy').click();
 assert.deepEqual(chat.memorySnapshot().messages,before.messages);assert.equal(store.status.paused,false);assert.equal(h.calls.deviceReplacements,undefined);assert.equal(h.calls.requests.length,0);
 assert.match(root.querySelectorAll('p')[0].textContent,/Offline/);assert.equal(h.calls.deviceBackups.length,1);
});

test('Force device upload detects changes after preview and never uploads a stale phone snapshot',async()=>{
 const {h,chat,store,open}=await deviceUploadChat(),root=await open();
 store.enqueue('add',{id:'new-action',message:{role:'user',content:'Newer phone action'}});await store.flush();
 await namedButton(root,'Replace Firebase with this copy').click();assert.equal(h.calls.deviceUploads,undefined);
 assert.equal(chat.memorySnapshot().messages.at(-1).content,'Newer phone action');assert.match(root.querySelectorAll('p')[0].textContent,/changed after the preview/);
});

test('Force device upload requires a device backup before any cloud call when local storage is unavailable',async()=>{
 const {h,store,open}=await deviceUploadChat();h.calls.failDeviceBackup=true;const root=await open();await namedButton(root,'Replace Firebase with this copy').click();
 assert.equal(h.calls.deviceUploads,undefined);assert.equal(store.status.paused,false);assert.match(root.querySelectorAll('p')[0].textContent,/Download the device backup/);
 await namedButton(root,'Download device backup').click();await namedButton(root,'Replace Firebase with this copy').click();assert.equal(h.calls.deviceUploads.length,1);
});

test('Force device upload reports committed cloud data and retains the queue if local cache replacement fails',async()=>{
 const {h,chat,store,open}=await deviceUploadChat();h.calls.failDeviceCache=true;const before=structuredClone(chat.memorySnapshot()),root=await open();
 await namedButton(root,'Replace Firebase with this copy').click();assert.equal(h.calls.deviceUploads.length,1);assert.equal(store.status.paused,true);assert.equal(store.requiresReconciliation,true);
 assert.deepEqual(chat.memorySnapshot().messages,before.messages);assert.match(root.querySelectorAll('p')[0].textContent,/upload reached Firebase/);
});

test('Force device upload cannot apply an old account result to a new account',async()=>{
 const {h,chat,store,open}=await deviceUploadChat(),root=await open(),wait=deferred();h.calls.onDeviceUpload=()=>wait.promise;
 const saving=namedButton(root,'Replace Firebase with this copy').click();await settle();h.calls.uid='new-account';wait.resolve();await saving;
 assert.equal(h.calls.deviceReplacements,undefined);assert.notEqual(chat.memorySnapshot()?.session.historyRevision,20);assert.equal(store.requiresReconciliation,true);
});

test('Force device upload preserves the local queue when the cloud outcome cannot be confirmed',async()=>{
 const {h,chat,store,open}=await deviceUploadChat(),root=await open(),before=structuredClone(chat.memorySnapshot());
 h.calls.onDeviceUpload=()=>{throw Object.assign(Error('Cloud result could not be confirmed'),{uploadUncertain:true});};
 await namedButton(root,'Replace Firebase with this copy').click();assert.equal(store.status.paused,true);assert.equal(store.requiresReconciliation,true);assert.equal(h.calls.deviceReplacements,undefined);
 assert.deepEqual(chat.memorySnapshot().messages,before.messages);assert.match(root.querySelectorAll('p')[0].textContent,/could not be confirmed/);
});

test('Sync refuses to discard conflicted local work if its recovery backup cannot be saved',async()=>{
 const h=await harness({chatCache:{loadChatCache:async()=>null,saveChatCache:async()=>{},deleteChatCache:async()=>{},saveDeviceRecoveryBackup:async()=>false}}),chat=await openImprovementChat(h,{},[{id:'a',role:'assistant',order:1,content:'Opening'}]);await settle();
 h.calls.settingsDoc=h.settings.storedSettings(h.state.settings);h.calls.addMessage=async()=>{throw Object.assign(Error('Stale save'),{code:'story-conflict'});};
 const store=(await h.use('local-story-store.js')).storyStore('improvement');store.enqueue('add',{id:'lost',message:{role:'user',content:'Do not lose this local action'}});await assert.rejects(store.flush());
 assert.equal(await chat.syncChatData(),false);assert.equal(store.status.pending,1);assert.equal(chat.memorySnapshot().messages.at(-1).content,'Do not lose this local action');assert.equal(h.calls.requests.length,0);
});
