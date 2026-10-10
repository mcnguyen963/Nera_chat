import { promptFetch, promptImportMeta } from './prompt-files.mjs';
// Run: node --experimental-vm-modules --test tests/message-chunks.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup(legacyCount = 0) {
  const documents = new Map();
  const reads = { documents: 0, legacy: 0 };
  const transactions = [], fault = { failAt:null, failBatchAt:null, batchCount:0, beforeCommit:null };
  const sessionPath = 'users/u/sessions/s';
  documents.set('users/u/settings/storyMigration',{version:1,values:{narratorSystemPrompt:'Legacy narrator',summarizerSystemPrompt:'Legacy summary'}});
  documents.set(sessionPath, { nextOrder: legacyCount, breakpointOrder: 0 });
  for (let order = 1; order <= legacyCount; order++) {
    documents.set(`${sessionPath}/messages/m${order}`, {
      order, role: 'user', content: `event ${order}`, tokenCount: 8,
      createdAt: new Date(), editedAt: null, thinking: null,
    });
  }
  const ref = (...parts) => ({ path: parts.slice(1).join('/') });
  const snapshot = (path) => ({
    id: path.split('/').at(-1), ref: { path }, exists: () => documents.has(path),
    data: () => structuredClone(documents.get(path)),
  });
  const apply = (type, target, value) => {
    if (type === 'delete') return documents.delete(target.path);
    const current = type === 'set' ? {} : documents.get(target.path);
    if (!current) throw new Error(`Missing document: ${target.path}`);
    const result = structuredClone(current);
    for (const [key, field] of Object.entries(value)) {
      const keys = key.split('.'); let holder = result;
      for (const k of keys.slice(0,-1)) holder = holder[k] ??= {};
      const last = keys.at(-1);
      holder[last] = field?.kind === 'arrayUnion'
        ? [...(holder[last] ?? []), ...field.values.filter(v => !(holder[last] ?? []).some(x => JSON.stringify(x) === JSON.stringify(v)))]
        : field?.kind === 'serverTimestamp' ? new Date() : field?.kind === 'increment' ? (holder[last] ?? 0)+field.amount : field;
    }
    documents.set(target.path, structuredClone(result));
  };
  const query = (target, ...constraints) => ({ target, constraints });
  const firestore = {
    doc: ref, collection: ref, query,
    orderBy: (field, direction = 'asc') => ({ kind: 'orderBy', field, direction }),
    where: (field, op, value) => ({ kind: 'where', field, op, value }),
    startAfter: (value) => ({ kind: 'startAfter', value }),
    limit: (value) => ({ kind: 'limit', value }),
    limitToLast: (value) => ({ kind: 'limitToLast', value }),
    Timestamp: { now: () => new Date() },
    arrayUnion: (...values) => ({ kind: 'arrayUnion', values }),
    serverTimestamp: () => ({ kind: 'serverTimestamp' }),
    increment: amount => ({kind:'increment',amount}),
    getDocFromServer: async (target) => {
      reads.documents++;
      await fault.onServerRead?.(target.path);
      return snapshot(target.path);
    },
    getDoc: async (target) => firestore.getDocFromServer(target),
    getDocsFromServer: async (source) => {
      const target = source.target ?? source;
      await fault.onServerRead?.(target.path);
      const constraints = source.constraints ?? [];
      const prefix = target.path + '/';
      let paths = [...documents.keys()].filter((path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
      );
      for (const c of constraints.filter((item) => item.kind === 'where')) {
        paths = paths.filter((path) => {
          const value = documents.get(path)[c.field];
          return c.op === '<' ? value < c.value : c.op === '<=' ? value <= c.value : c.op === '>=' ? value >= c.value : value > c.value;
        });
      }
      const sort = constraints.find((item) => item.kind === 'orderBy');
      if (sort) paths.sort((a, b) => {
        const delta = documents.get(a)[sort.field] - documents.get(b)[sort.field];
        return sort.direction === 'desc' ? -delta : delta;
      });
      const cursor = constraints.find((item) => item.kind === 'startAfter');
      if (cursor) {
        const cursorValue = typeof cursor.value === 'number'
          ? cursor.value : documents.get(cursor.value.ref.path)[sort.field];
        paths = paths.filter((path) => sort.direction === 'desc'
          ? documents.get(path)[sort.field] < cursorValue
          : documents.get(path)[sort.field] > cursorValue);
      }
      const cap = constraints.find((item) => item.kind === 'limit');
      if (cap) paths = paths.slice(0, cap.value);
      const tail = constraints.find((item) => item.kind === 'limitToLast');
      if (tail) paths = paths.slice(-tail.value);
      reads.documents += paths.length;
      if (target.path.endsWith('/messages')) reads.legacy += paths.length;
      const docs = paths.map(snapshot);
      return { docs, empty: docs.length === 0 };
    },
    updateDoc: async (target, value) => apply('update', target, value),
    setDoc: async (target, value) => apply('set', target, value),
    deleteDoc: async (target) => apply('delete', target),
    getDocs: async (source) => firestore.getDocsFromServer(source),
    writeBatch: () => {
      const changes = [];
      return {
        set: (target, value) => changes.push(['set', target, value]),
        update: (target, value) => changes.push(['update', target, value]),
        delete: (target) => changes.push(['delete', target]),
        commit: async () => { if(++fault.batchCount===fault.failBatchAt){fault.failBatchAt=null;throw new Error('Injected sweep failure');}for (const change of changes) apply(...change); },
      };
    },
    runTransaction:async (_db,callback) => {
      for (let attempt=0;attempt<10;attempt++) {
        const changes = [], versions = new Map(); let wrote = false;
        const tx = {
          get:async target => { assert.equal(wrote,false,'Firestore requires reads before writes'); reads.documents++; const version = JSON.stringify(documents.get(target.path)); versions.set(target.path,version); return snapshot(target.path); },
          set:(target,value) => { wrote = true; changes.push(['set',target,value]); },
          update:(target,value) => { wrote = true; changes.push(['update',target,value]); },
          delete:target => { wrote = true; changes.push(['delete',target]); },
        };
        const result = await callback(tx);
        await fault.beforeCommit?.(changes);
        if ([...versions].some(([path,version]) => JSON.stringify(documents.get(path)) !== version)) continue;
        transactions.push(changes.map(([type,target])=>({type,path:target.path})));
        if (fault.failAt === transactions.length) { fault.failAt=null; throw new Error('Injected transaction failure'); }
        for (const change of changes) apply(...change);
        return result;
      }
      throw new Error('Transaction retry limit');
    },
    onSnapshot: (source, callback) => {
      let active = true;
      queueMicrotask(async () => {
        const result = await firestore.getDocsFromServer(source);
        if (active) callback(result);
      });
      return () => { active = false; };
    },
  };
  const context = vm.createContext({ URL, fetch:promptFetch, TextEncoder, Date, structuredClone, console });
  const modules = new Map();
  async function load(path) {
    if (modules.has(path)) return modules.get(path);
    const stub = path.startsWith('https:') ? firestore : {
      'db.js': { db: {} },
      'auth.js': { currentUid: () => 'u' },
      'tokenizer.js': { countTokens: async (content) => content.length },
    }[path];
    const module = stub
      ? new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context, identifier: path })
      : new vm.SourceTextModule(await readFile(new URL('../js/' + path, import.meta.url), 'utf8'),
        { context, identifier: path, initializeImportMeta:promptImportMeta });
    modules.set(path, module);
    return module;
  }
  const link=async module => { if (module.status==='unlinked') await module.link((specifier,parent) => load(specifier.startsWith('https:') ? specifier : new URL(specifier,'https://local/'+parent.identifier).pathname.slice(1))); };
  const messages = await load('messages.js'); await link(messages);
  await messages.evaluate();
  const sessions = await load('sessions.js'); await link(sessions);
  await sessions.evaluate();
  const lore = await load('lore-store.js'); await link(lore); await lore.evaluate();
  const storySettings=await load('story-settings-store.js');await link(storySettings);await storySettings.evaluate();
  const transfer=await load('import-export.js');await link(transfer);await transfer.evaluate();
  return {transfer:transfer.namespace,storySettings:storySettings.namespace,lore: lore.namespace, api: messages.namespace, sessions: sessions.namespace, documents, reads, sessionPath, transactions, fault, turns:modules.get('turns.js').namespace };
}

test('migration packs existing messages once and checkpoint reads use chunks', async () => {
  const h = await setup(1000);
  h.documents.get(h.sessionPath).activeSummaryMessageId = 'm901';
  h.documents.get(h.sessionPath).breakpointOrder = 900;
  h.documents.get(`${h.sessionPath}/messages/m901`).role = 'summary';
  await h.api.ensureChunked('s');
  assert.equal(h.reads.legacy, 1000);
  const chunks = [...h.documents.entries()].filter(([path]) => path.includes('/messageChunks/'));
  assert.ok(chunks.length <= 10);
  assert.equal(chunks.flatMap(([, chunk]) => chunk.messages).length, 1000);
  assert.ok(chunks.every(([, chunk]) => chunk.count <= 100 && chunk.byteSize < 1024 * 1024));
  const before = h.reads.documents;
  const recent = await h.api.getCheckpointMessages({
    id: 's', activeSummaryMessageId: 'm901', breakpointOrder: 900,
  });
  assert.equal(recent.length, 100);
  assert.ok(h.reads.documents - before < 5);
  assert.equal(h.reads.legacy, 1000);
  assert.equal(h.documents.get(h.sessionPath).storageVersion, 2);
  const seen = await new Promise((resolve, reject) =>
    h.api.subscribeLatestMessages('s', resolve, reject)
  );
  assert.equal(seen.messages.length, 300);
  assert.equal(seen.hasEarlier, true);
});

test('assistant plan thread is stored separately from visible content', async () => {
  const h = await setup();
  const saved = await h.api.addMessage('s', {
    role: 'assistant', content: 'The door opens.', planThread: 'steering toward the reunion', planBefore: 'Find the door',
  });
  let message = (await h.api.getMessages('s'))[0];
  assert.equal(message.content, 'The door opens.');
  assert.equal(message.planThread, 'steering toward the reunion');
  assert.equal(message.planBefore, 'Find the door');
  assert.ok(message.tokenCount > message.content.length);
  await h.api.overwriteMessage('s', saved.id, {
    content: 'The room is empty.', thinking: null, planThread: 'steering toward the reveal',
  }, saved.order);
  message = (await h.api.getMessages('s'))[0];
  assert.equal(message.planThread, 'steering toward the reveal');
  await h.api.editMessage('s', saved.id, 'A quiet room.', saved.order);
  message = (await h.api.getMessages('s'))[0];
  assert.equal(message.planThread, 'steering toward the reveal');
});

test('assistant plan updates are committed with the message', async () => {
  const h = await setup();
  const saved = await h.api.addMessage('s', { role: 'assistant', content: 'The first event' }, {
    sessionUpdate: { longTermPlan: 'Meet the queen on day 20' },
  });
  assert.equal(h.documents.get(h.sessionPath).longTermPlan, 'Meet the queen on day 20');
  assert.equal((await h.api.getMessages('s'))[0].content, 'The first event');
  await h.api.overwriteMessage('s', saved.id, { content: 'A revised event' }, saved.order, {
    longTermPlan: 'Meet the queen on day 30',
  });
  assert.equal(h.documents.get(h.sessionPath).longTermPlan, 'Meet the queen on day 30');
  assert.equal((await h.api.getMessages('s'))[0].content, 'A revised event');
});

test('Editing folded story history retires its summary checkpoint; deletion preserves cleared state', async () => {
  const h = await setup();
  const first = await h.api.addMessage('s', { role: 'user', content: 'Old fact' });
  await h.api.addMessage('s', { role: 'assistant', content: 'Reply' });
  const summary = await h.api.addMessage('s', { role: 'summary', content: 'Old fact remains' }, {
    sessionUpdate: { activeSummaryMessageId: 'summary', breakpointOrder: 2 }, id: 'summary',
  });
  assert.equal(summary.order, 3);
  const edited = await h.api.editMessage('s', first.id, 'Corrected fact', first.order);
  assert.equal(edited.summaryReset, true);
  assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId, null);
  assert.equal(h.documents.get(h.sessionPath).breakpointOrder, 0);
  const secondSummary = await h.api.addMessage('s', { role: 'summary', content: 'Rebuilt' }, {
    sessionUpdate: { activeSummaryMessageId: 'summary2', breakpointOrder: 2 }, id: 'summary2',
  });
  const deleted = await h.api.deleteMessage('s', secondSummary.id, secondSummary.order);
  assert.equal(deleted.summaryReset, true);
  assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId, null);
});

test('append, edit, split, and delete preserve message order and content', async () => {
  const h = await setup(100);
  await h.api.ensureChunked('s');
  const added = await h.api.addMessage('s', { role: 'assistant', content: 'reply' });
  assert.equal(added.order, 101);
  await h.api.editMessage('s', 'm50', 'x'.repeat(260 * 1024), 50);
  const chunks = [...h.documents.keys()].filter((path) => path.includes('/messageChunks/'));
  assert.ok(chunks.length >= 3);
  let all = await h.api.getMessages('s');
  assert.equal(all.length, 101);
  assert.equal(all.find((message) => message.id === 'm50').content.length, 260 * 1024);
  await h.api.deleteMessage('s', 'm50', 50);
  all = await h.api.getMessages('s');
  assert.equal(all.length, 100);
  assert.equal(all.at(-1).order, 101);
  await h.api.editMessage('s', added.id, 'y'.repeat(260 * 1024), 101);
  const next = await h.api.addMessage('s', { role: 'user', content: 'next turn' });
  assert.equal(next.order, 102);
  assert.equal((await h.api.getMessages('s')).at(-1).content, 'next turn');
  const earlier = await h.api.getEarlierMessages('s', 101, 20);
  assert.deepEqual(Array.from(earlier, (message) => message.order), Array.from({ length: 20 }, (_, i) => i + 81));
});

test('duplicating and deleting a migrated session handles chunks and legacy docs', async () => {
  const h = await setup(250);
  const copyId = await h.sessions.duplicateSession('s');
  assert.equal((await h.api.getMessages(copyId)).length, 250);
  await h.sessions.deleteSession('s');
  assert.equal([...h.documents.keys()].some((path) => path.startsWith(h.sessionPath + '/')), false);
  assert.equal((await h.api.getMessages(copyId)).length, 250);
});

test('partial copy counts existing messages across chunks and appends independently', async () => {
  const h = await setup(250);
  await h.api.ensureChunked('s');
  await h.api.deleteMessage('s', 'm2', 2);
  Object.assign(h.documents.get(h.sessionPath), {
    longTermPlan: 'Find the queen', allowLlmPlanUpdates: true, customSetting: { enabled: true },
  });
  const source = await h.api.getMessages('s');
  const copyId = await h.sessions.duplicateSession('s', 105);
  const copied = await h.api.getMessages(copyId);
  assert.deepEqual(copied, source.slice(0, 105));
  const metadata = h.documents.get(`users/u/sessions/${copyId}`);
  assert.equal(metadata.nextOrder, 106);
  assert.equal(metadata.activeChunkCount, 5);
  assert.equal(metadata.longTermPlan, 'Find the queen');
  assert.equal(metadata.allowLlmPlanUpdates, true);
  assert.deepEqual(metadata.customSetting, { enabled: true });
  const added = await h.api.addMessage(copyId, { role: 'user', content: 'New direction' });
  assert.equal(added.order, 107);
  assert.deepEqual(await h.api.getMessages('s'), source);
});

test('partial copy retains only summary checkpoints present in the copied prefix', async () => {
  const h = await setup(2);
  await h.api.addMessage('s', {
    role: 'summary', content: 'Events so far', thinking: 'Hidden text', planThread: 'Next target',
  }, { id: 'summary', sessionUpdate: { activeSummaryMessageId: 'summary', breakpointOrder: 2 } });
  await h.api.addMessage('s', { role: 'user', content: 'Later event' });
  const beforeId = await h.sessions.duplicateSession('s', 2);
  const before = h.documents.get(`users/u/sessions/${beforeId}`);
  assert.equal(before.activeSummaryMessageId, null);
  assert.equal(before.breakpointOrder, 0);
  const afterId = await h.sessions.duplicateSession('s', 3);
  const after = h.documents.get(`users/u/sessions/${afterId}`);
  assert.equal(after.activeSummaryMessageId, 'summary');
  assert.equal(after.breakpointOrder, 2);
  assert.deepEqual(await h.api.getMessages(afterId), (await h.api.getMessages('s')).slice(0, 3));
});

test('zero-message copy inherits story settings with clean storage and context', async () => {
  const h = await setup(10);
  await h.api.ensureChunked('s');
  Object.assign(h.documents.get(h.sessionPath), {
    longTermPlan: 'Keep this plan', allowLlmPlanUpdates: true,
    activeSummaryMessageId: 'old-summary', breakpointOrder: 8,
  });
  const copyId = await h.sessions.duplicateSession('s', 0);
  const metadata = h.documents.get(`users/u/sessions/${copyId}`);
  assert.equal(metadata.longTermPlan, 'Keep this plan');
  assert.equal(metadata.allowLlmPlanUpdates, true);
  assert.equal(metadata.nextOrder, 0);
  assert.equal(metadata.activeChunkId, null);
  assert.equal(metadata.activeChunkCount, 0);
  assert.equal(metadata.activeChunkBytes, 0);
  assert.equal(metadata.activeSummaryMessageId, null);
  assert.equal(metadata.breakpointOrder, 0);
  assert.equal((await h.api.getMessages(copyId)).length, 0);
  assert.equal((await h.api.addMessage(copyId, { role: 'user', content: 'Fresh start' })).order, 1);
  assert.equal((await h.api.getMessages('s')).length, 10);
});

test('invalid copy counts cannot create a new session', async () => {
  const h = await setup(2);
  await h.api.ensureChunked('s');
  const originalPaths = [...h.documents.keys()];
  for (const count of [-1, 1.5, NaN, Infinity, '1', 3]) {
    await assert.rejects(h.sessions.duplicateSession('s', count), /Message count|only 2 messages/);
    assert.deepEqual([...h.documents.keys()], originalPaths);
  }
});

test('copy through a clicked message includes that message despite gaps in order', async () => {
  const h = await setup(105);
  await h.api.ensureChunked('s');
  await h.api.deleteMessage('s', 'm2', 2);
  const source = await h.api.getMessages('s');
  const copyId = await h.sessions.duplicateSession('s', null, 'm102');
  assert.deepEqual(await h.api.getMessages(copyId), source.filter((m) => m.order <= 102));
  assert.equal(h.documents.get(`users/u/sessions/${copyId}`).nextOrder, 102);
  const paths = [...h.documents.keys()];
  await assert.rejects(h.sessions.duplicateSession('s', null, 'missing'), /no longer exists/);
  assert.deepEqual([...h.documents.keys()], paths);
});

test('scene changes preserve timestamps; prose edits keep scene metadata', async () => {
  const h = await setup(); const saved = await h.api.addMessage('s',{ role:'assistant',content:'Story',scene:'Day 1 · Inn' });
  await h.api.updateMessageScene('s',saved.id,saved.order,'Day 2 · night · Inn'); let m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,'date: Day 2 · time: night · place: Inn · present: unknown'); assert.equal(m.editedAt,null);
  await h.api.editMessage('s',saved.id,'Edited story',saved.order); m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,'date: Day 2 · time: night · place: Inn · present: unknown');
  await h.api.overwriteMessage('s',saved.id,{ content:'New reply',scene:'Day 3 · Market' },saved.order); m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,'Day 3 · Market');
});
test('long scene attendance survives storage, edits and reload; oversized edits cannot write partial state',async () => {
  const h = await setup();
  const raw = 'date: Day 2 · time: night · place: Inn · present: '+Array.from({ length:25 },(_,i) => `Established Character ${i}`).join(', ');
  const saved = await h.api.addMessage('s',{ role:'assistant',content:'Story',scene:raw });
  assert.equal((await h.api.getMessages('s'))[0].scene,raw);
  const edited = raw.replace('Day 2','Day 3');
  await h.api.updateMessageScene('s',saved.id,saved.order,edited);
  assert.equal((await h.api.getMessages('s'))[0].scene,edited);
  const before = JSON.stringify([...h.documents]);
  await assert.rejects(h.api.updateMessageScene('s',saved.id,saved.order,'x'.repeat(2001)),/exceeds 2000/);
  assert.equal(JSON.stringify([...h.documents]),before);
});
function loreEntry(id='mira') { return { id,book:'characters',kind:'card',name:'Mira',aliases:[],alwaysLoad:false,draft:false,status:null,createdFrom:'user',sections:{ appearance:{ text:'canon',lines:[{ id:'old',text:'old',turn:1,src:2,by:'auto',at:1 }] },notes:{ text:'',lines:[] } } }; }
test('card save merges concurrent appends while field and line edits win',async () => {
  const h = await setup(), base = loreEntry(); await h.lore.createEntry('s',base);
  const current = h.documents.get(h.sessionPath+'/lore/mira'); current.sections.appearance.lines.push({ id:'concurrent',text:'new',turn:2,src:4,by:'auto',at:2 });
  const staged = structuredClone(base); staged.sections.appearance.text='my edit'; staged.sections.appearance.lines[0].text='edited old';
  await h.lore.saveEntry('s',staged,base); const result = h.documents.get(h.sessionPath+'/lore/mira'); assert.equal(result.sections.appearance.text,'my edit'); assert.deepEqual(result.sections.appearance.lines.map(l => l.text),['edited old','new']);
});
test('extraction commits dotted append fields and pointer together, preserving user text',async () => {
  const h = await setup(); await h.lore.createEntry('s',loreEntry());
  const ln = { id:'new',text:'scar',turn:2,src:4,by:'auto',at:2 };
  await h.lore.commitExtraction('s',{ creates:[],appends:[{ entryId:'mira',section:'appearance',line:ln }],aliases:[],statusChanges:[] },{ fromTurn:1,toTurn:2,endOrder:4 });
  assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.text,'canon'); assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.length,2); assert.equal(h.documents.get(h.sessionPath).memoryState.extractedThroughOrder,4);
});
test('B3 extraction commits other cards and its checkpoint when a current card is full',async()=>{
  const h=await setup();await h.lore.createEntry('s',loreEntry('first'));await h.lore.createEntry('s',loreEntry('full'));
  // Simulate a card enlarged by another client after the extraction planner ran.
  h.documents.get(h.sessionPath+'/lore/full').sections.appearance.text='x'.repeat(900000);
  const before=JSON.stringify([...h.documents]);
  const appends=['first','full'].map(entryId=>({entryId,section:'appearance',line:{id:'new-'+entryId,text:'scar',turn:2,src:4,by:'auto',at:2}}));
  const fullBefore=JSON.stringify(h.documents.get(h.sessionPath+'/lore/full'));
  const result=await h.lore.commitExtraction('s',{creates:[],appends,aliases:[],statusChanges:[]},{fromTurn:1,toTurn:2,endOrder:4});
  assert.equal(result.skipped[0].reason,'card full');assert.equal(JSON.stringify(h.documents.get(h.sessionPath+'/lore/full')),fullBefore);assert.equal(h.documents.get(h.sessionPath+'/lore/first').sections.appearance.lines.length,2);assert.equal(h.documents.get(h.sessionPath).memoryState.extractedThroughOrder,4);
});
test('B3 oversized new cards are skipped while valid cards and checkpoint commit',async()=>{
  const h=await setup();await h.lore.createEntry('s',loreEntry('first'));
  const full=loreEntry('new-full');full.sections.appearance.text='x'.repeat(900000);
  const before=JSON.stringify([...h.documents]);
  const result=await h.lore.commitExtraction('s',{creates:[full],appends:[{entryId:'first',section:'appearance',line:{id:'new',text:'scar',turn:2,src:4,by:'auto',at:2}}],aliases:[],statusChanges:[]},{fromTurn:1,toTurn:2,endOrder:4});
  assert.equal(result.skipped[0].reason,'card full');assert.equal(h.documents.has(h.sessionPath+'/lore/new-full'),false);assert.equal(h.documents.get(h.sessionPath+'/lore/first').sections.appearance.lines.length,2);assert.equal(h.documents.get(h.sessionPath).memoryState.extractedThroughOrder,4);
});
test('delete and restore preserve cards, remove createdIds and backup pruning keeps twenty groups',async () => {
  const h = await setup(), e = loreEntry(); await h.lore.createEntry('s',e);
  const backup = await h.lore.deleteEntry('s',e); assert.equal(h.documents.has(h.sessionPath+'/lore/mira'),false); await h.lore.restoreBackup('s',backup,[]); assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.text,'canon');
  const created = loreEntry('new'), importBackup = await h.lore.writeBackup('s','import','Import',[],['new']); await h.lore.createEntry('s',created); await h.lore.restoreBackup('s',importBackup,[created]); assert.equal(h.documents.has(h.sessionPath+'/lore/new'),false);
  for (let i=0;i<22;i++) await h.lore.writeBackup('s','delete','Backup '+i,[e]); assert.equal((await h.lore.listBackups('s')).length,20);
});
test('merge keeps canon, aliases and lines; reorganize preserves concurrent and user-authored lines',async () => {
  const h = await setup(), a = loreEntry('a'), b = loreEntry('b'); a.name='Old Tom'; a.aliases=['Old man']; b.name='Tom'; b.sections.appearance.text='target canon'; b.sections.appearance.lines=[];
  await h.lore.createEntry('s',a); await h.lore.createEntry('s',b); const backup = await h.lore.mergeEntries('s',a,b); const merged = h.documents.get(h.sessionPath+'/lore/b'); assert.equal(merged.sections.appearance.text,'target canon'); assert.ok(merged.aliases.includes('Old Tom')); assert.ok(merged.sections.appearance.lines.some(l => l.text==='From Old Tom: canon')); assert.equal(h.documents.has(h.sessionPath+'/lore/a'),false);
  await h.lore.restoreBackup('s',backup,[{ id:'b',...merged }]); assert.equal(h.documents.has(h.sessionPath+'/lore/a'),true);
  const current = h.documents.get(h.sessionPath+'/lore/a'); current.sections.appearance.lines.push({ id:'late',text:'late',by:'auto',at:100 },{ id:'user',text:'my note',by:'user',at:2 });
  await h.lore.replaceLines('s',[{ entry:a,snapshot:{appearance:['old']},sections:{ appearance:[{ id:'tidied',text:'tidied',by:'reorganize',at:101 }] } }],50);
  const after = h.documents.get(h.sessionPath+'/lore/a'); assert.equal(after.sections.appearance.text,'canon'); assert.deepEqual(after.sections.appearance.lines.map(l => l.id),['user','tidied','late']);
});
test('copy filters future lore, clamps pointer and delete removes lore and backups',async () => {
  const h = await setup(); const a = await h.api.addMessage('s',{ role:'assistant',content:'one' }); const b = await h.api.addMessage('s',{ role:'assistant',content:'two' });
  const entry = loreEntry(); entry.sections.appearance.lines = [{ id:'first',text:'first',src:a.order,turn:1,at:1 },{ id:'future',text:'future',src:b.order,turn:2,at:2 }]; await h.lore.createEntry('s',entry); h.documents.get(h.sessionPath).memoryState={ extractedThroughOrder:b.order,failureStreak:3,paused:true,lastError:'failed' };
  const id = await h.sessions.duplicateSession('s',null,a.id), path = 'users/u/sessions/'+id;
  assert.equal(h.documents.get(path+'/lore/mira').sections.appearance.lines.length,1); assert.equal(h.documents.get(path).memoryState.extractedThroughOrder,a.order); assert.equal(h.documents.get(path).memoryState.paused,false);
  await h.lore.writeBackup(id,'delete','Deleted',[entry]); await h.sessions.deleteSession(id); assert.ok(![...h.documents.keys()].some(p => p.startsWith(path)));
});

test('lore writes wait for the narrator and expose a barrier before another turn starts',async () => {
  const h=await setup(); let release; h.lore.configureLoreWrites(() => new Promise(resolve => release=resolve));
  const pending=h.lore.createEntry('s',loreEntry()); assert.equal(h.lore.loreWritesPending(),true); await Promise.resolve(); assert.equal(h.documents.has(h.sessionPath+'/lore/mira'),false);
  let complete=false; const barrier=h.lore.waitForLoreWrites().then(() => complete=true); assert.equal(complete,false); release(); await pending; await barrier; assert.equal(complete,true); assert.equal(h.lore.loreWritesPending(),false);
});

test('bulk deleted-turn removal is backed up and Undo restores all source-linked notes',async () => {
  const h=await setup(), e=loreEntry(); for(let i=0;i<6;i++) await h.api.addMessage('s',{role:i%2 ? 'assistant' : 'user',content:'story '+i}); const deleted=(await h.api.getMessages('s')).find(m=>m.order===4); await h.api.deleteMessage('s',deleted.id,deleted.order); e.sections.appearance.lines.push({ id:'later',text:'later',turn:2,src:4,by:'auto',at:2 }); await h.lore.createEntry('s',e);
  const backup=await h.lore.removeDeletedLines('s',[e],new Set([2])); const after=h.documents.get(h.sessionPath+'/lore/mira'); assert.deepEqual(after.sections.appearance.lines.map(l => l.id),['old']); await h.lore.restoreBackup('s',backup,[{ id:'mira',...after }]); assert.deepEqual(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.map(l => l.id),['old','later']);
});

test('stable narrator turns survive deletion, regeneration and copies through a trailing user',async () => {
  const h = await setup();
  const u1 = await h.api.addMessage('s',{ role:'user',content:'Start' }), a1 = await h.api.addMessage('s',{ role:'assistant',content:'First' });
  const u2 = await h.api.addMessage('s',{ role:'user',content:'Next' }), a2 = await h.api.addMessage('s',{ role:'assistant',content:'Second' });
  assert.equal(a1.narratorTurn,1); assert.equal(a2.narratorTurn,2);
  await h.api.deleteMessage('s',a1.id,a1.order);
  await h.api.overwriteMessage('s',a2.id,{ content:'New second' },a2.order);
  const a3 = await h.api.addMessage('s',{ role:'assistant',content:'Third' }); assert.equal(a3.narratorTurn,3);
  assert.equal((await h.api.getMessages('s')).find(m => m.id === a2.id).narratorTurn,2);
  const id = await h.sessions.duplicateSession('s',null,u2.id);
  const reply = await h.api.addMessage(id,{ role:'assistant',content:'Copy reply' }); assert.equal(reply.narratorTurn,u2.narratorTurn);
});
test('concurrent chunk edits retain both devices changes and increment history revisions',async () => {
  const h = await setup();
  const a = await h.api.addMessage('s',{ role:'user',content:'A' }), b = await h.api.addMessage('s',{ role:'assistant',content:'B' });
  const before = h.documents.get(h.sessionPath).historyRevision;
  await Promise.all([h.api.editMessage('s',a.id,'Device one',a.order),h.api.editMessage('s',b.id,'Device two',b.order)]);
  const messages = await h.api.getMessages('s'); assert.deepEqual(messages.map(m => m.content),['Device one','Device two']); assert.ok(messages.every(m => m.revision === 1)); assert.equal(h.documents.get(h.sessionPath).historyRevision,before+2);
  await assert.rejects(h.api.editMessage('s',a.id,'Stale local edit',a.order,{ expectedRevision:0 }),/edited elsewhere/);
});
test('atomic reply, summary and extraction commits reject source changes without partial writes',async () => {
  const h = await setup(); const user = await h.api.addMessage('s',{ role:'user',content:'Start' });
  const session = h.documents.get(h.sessionPath), expectedSource = { historyRevision:session.historyRevision,longTermPlan:session.longTermPlan ?? '',memory:JSON.stringify(session.memory ?? null),loreRevision:session.loreRevision ?? 0,activeSummaryMessageId:null,breakpointOrder:0 };
  await h.api.editMessage('s',user.id,'Changed',user.order);
  const before = JSON.stringify([...h.documents]);
  await assert.rejects(h.api.addMessage('s',{ role:'assistant',content:'Stale reply' },{ expectedSource }),e=>e.name==='HistoryConflict');
  await assert.rejects(h.api.addMessage('s',{ role:'summary',content:'Stale summary' },{ expectedSource,sessionUpdate:{ activeSummaryMessageId:'new',breakpointOrder:1 } }),/discarded/);
  await assert.rejects(h.lore.commitExtraction('s',{ creates:[loreEntry()],appends:[],aliases:[],statusChanges:[] },{ expectedSource,endOrder:1,fromTurn:1,toTurn:1 }),/discarded/);
  assert.equal(JSON.stringify([...h.documents]),before);
});
test('prose edits and scene corrections invalidate summary and memory without deleting notes',async () => {
  const h = await setup(); const a = await h.api.addMessage('s',{ role:'assistant',content:'Story',planThread:'Reminder',scene:'Day 1 · Inn' });
  const e = loreEntry(); e.sections.appearance.lines[0].src = a.order; await h.lore.createEntry('s',e);
  Object.assign(h.documents.get(h.sessionPath),{ activeSummaryMessageId:'summary',breakpointOrder:a.order,memoryState:{ extractedThroughOrder:a.order } });
  const result = await h.api.editMessage('s',a.id,'Edited',a.order);
  assert.equal(result.summaryReset,true); assert.equal(result.replacement.scene,'Day 1 · Inn'); assert.equal(result.replacement.planThread,'Reminder');
  const session = h.documents.get(h.sessionPath); assert.equal(session.activeSummaryMessageId,null); assert.equal(session.memoryState.needsRebuild,true); assert.notEqual(session.memoryState.paused,true);
  assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.length,1);
  await h.api.updateMessageScene('s',a.id,a.order,'unknown · unknown · Inn'); assert.equal(h.documents.get(h.sessionPath).memoryInvalidations.length,2);
});
test('earlier session copies exclude future evidence and make later snapshots unavailable while preserving fixed plan',async () => {
  const h = await setup(); const a = await h.api.addMessage('s',{ role:'assistant',content:'One' }), b = await h.api.addMessage('s',{ role:'assistant',content:'Two' });
  h.documents.get(h.sessionPath).longTermPlan = 'Fixed author plan';
  const e = loreEntry(); Object.assign(e.sections.appearance,{ kind:'snapshot',cutoff:{ turn:2,order:b.order } }); e.sections.appearance.lines = [{ id:'future',src:a.order,by:'auto',evidence:[{ id:b.id,revision:0,order:b.order }] }]; await h.lore.createEntry('s',e);
  const copied = await h.sessions.duplicateSession('s',null,a.id), path = 'users/u/sessions/'+copied;
  assert.equal(h.documents.get(path).longTermPlan,'Fixed author plan'); assert.equal(h.documents.get(path+'/lore/mira').sections.appearance.unavailable,true); assert.equal(h.documents.get(path+'/lore/mira').sections.appearance.lines.length,0);
});

test('version 2 bulk import retains orders, turn numbers, message revisions and evidence IDs across deletion gaps',async () => {
  const h = await setup();
  await h.api.addMessagesBulk('s',[{ id:'user',order:3,role:'user',content:'Question',revision:2,narratorTurn:8 },{ id:'assistant',order:7,role:'assistant',content:'Reply',revision:4,narratorTurn:8 },{ id:'summary',order:9,role:'summary',content:'Summary',coveredRange:{ fromOrder:3,toOrder:7 },sourceRevision:12,evidence:[{ id:'assistant',order:7,revision:4 }] }]);
  const imported = await h.api.getMessages('s'); assert.deepEqual(imported.map(m => m.order),[3,7,9]); assert.equal(imported[1].narratorTurn,8); assert.equal(imported[1].revision,4); assert.equal(imported[2].evidence[0].id,'assistant'); assert.equal(h.documents.get(h.sessionPath).nextOrder,9);
});

test('accepting a flagged reply is revision checked, persists its candidate scene and invalidates downstream notes',async () => {
  const h = await setup();
  const candidate = { scene:'date: Day 2 · time: unknown · place: Inn · present: Nera, Mira',sceneMeta:{ kind:'declared',provenance:{ time:'unknown' } } };
  const reply = await h.api.addMessage('s',{ role:'assistant',content:'You say hello.',scene:'Inn',acceptance:'pending',sceneCandidate:candidate,reviewWarnings:['Player speech.'] });
  await assert.rejects(h.api.acceptMessage('s',reply.id,reply.order,1),/changed/);
  assert.equal((await h.api.getMessages('s'))[0].acceptance,'pending');
  const accepted = await h.api.acceptMessage('s',reply.id,reply.order,0);
  assert.equal(accepted.replacement.acceptance,'accepted');assert.equal(accepted.replacement.scene,candidate.scene);
  assert.equal(accepted.replacement.sceneCandidate,null);assert.equal(accepted.replacement.revision,1);
  assert.notEqual(h.documents.get(h.sessionPath).memoryState?.paused,true);
  assert.equal((await h.api.getMessages('s'))[0].sceneMeta.provenance.time,'unknown');
  const replacement = await h.api.overwriteMessage('s',reply.id,{ content:'Mira waits.',scene:'Inn',sceneMeta:{ kind:'inferred' },acceptance:'accepted' },reply.order);
  assert.equal(replacement.replacement.sceneMeta.kind,'inferred');assert.equal(replacement.replacement.sceneCandidate,null);
});

test('S10 manual scenes reject unreadable input, blank clears, and editing pending replies keeps the candidate',async () => {
 const h=await setup();const scene='date: Day 2 · time: night · place: Inn · present: Mira';
 const a=await h.api.addMessage('s',{role:'assistant',content:'Reply',acceptance:'pending',sceneCandidate:{scene,sceneMeta:{kind:'declared'}}});
 const edited=await h.api.editMessage('s',a.id,'Reply edited',a.order);
 assert.equal(edited.replacement.scene,scene);assert.equal(edited.replacement.acceptance,'accepted');assert.equal(edited.replacement.sceneCandidate,null);
 await assert.rejects(h.api.updateMessageScene('s',a.id,a.order,'Tavern, night'),/Could not read/);
 const cleared=await h.api.updateMessageScene('s',a.id,a.order,'',{fromId:'previous',fromOrder:1});
 assert.equal(cleared.replacement.scene,null);assert.equal(cleared.replacement.sceneMeta.kind,'carried');assert.equal(cleared.replacement.sceneMeta.fromId,'previous');
});

test('P0 and U4 regeneration clears edited and cut-off fields and omits review metadata with Scene off',async () => {
 const h=await setup();const a=await h.api.addMessage('s',{role:'assistant',content:'Partial',truncated:true,acceptance:'pending',reviewWarnings:['warning'],sceneCandidate:{scene:'candidate'}});
 await h.api.editMessage('s',a.id,'Edited',a.order);
 const result=await h.api.overwriteMessage('s',a.id,{content:'Complete'},a.order);
 assert.equal(Boolean(result.replacement.truncated),false);assert.equal('truncated' in result.replacement,false);assert.equal('editedAt' in result.replacement,false);assert.equal('acceptance' in result.replacement,false);assert.equal('reviewWarnings' in result.replacement,false);assert.equal('sceneCandidate' in result.replacement,false);
});

test('U3 backup parts and index write atomically and listing scans for orphan parts',async()=>{
 const h=await setup(),e=loreEntry();await h.lore.writeBackup('s','test','First',[e]);const before=h.reads.documents;await h.lore.writeBackup('s','test','Second',[e]);assert.equal(h.reads.documents-before,2);const start=h.reads.documents,groups=await h.lore.listBackups('s');assert.equal(h.reads.documents-start,3);assert.equal(groups.length,2);assert.equal(groups[0].count,1);assert.equal('entries' in groups[0],false);const fetched=await h.lore.loadBackupGroup('s',groups[0].id);assert.equal(fetched[0].entries[0].id,e.id);
});
test('U3 pre-index backups remain restorable and build a metadata index once',async()=>{
 const h=await setup(),e=loreEntry();h.documents.set(h.sessionPath+'/loreBackups/old',{partOf:'old',part:1,label:'Old',reason:'delete',createdMs:1,entries:[{id:e.id,data:e}],createdIds:[]});const groups=await h.lore.listBackups('s');assert.equal(groups[0].id,'old');assert.ok(h.documents.has(h.sessionPath+'/loreMeta/backups'));await h.lore.restoreBackup('s','old',[]);assert.equal(h.documents.get(h.sessionPath+'/lore/mira').name,'Mira');
});
test('L2 extraction rebases notes and aliases onto current canon, refreshes stale twins, and returns its lore revision',async()=>{
 const h=await setup(),e=loreEntry();e.sections.appearance.lines=[{id:'stale',text:'A scar.',by:'auto',needsReview:true,src:2,at:1}];await h.lore.createEntry('s',e);h.documents.get(h.sessionPath).memoryState={extractedThroughOrder:0};h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.text='New manual canon';
 const line={id:'candidate',text:'a scar',by:'auto',src:4,turn:2,at:2,evidence:[],sourceRevision:0};const r=await h.lore.commitExtraction('s',{creates:[],appends:[{entryId:'mira',section:'appearance',line}],aliases:[{entryId:'mira',alias:'Witch'}],statusChanges:[]},{fromTurn:1,toTurn:2,endOrder:4,guard:{startPointer:0,startRevision:0,fromOrder:1,endOrder:4}});const card=h.documents.get(h.sessionPath+'/lore/mira');assert.equal(card.sections.appearance.text,'New manual canon');assert.equal(card.sections.appearance.lines.length,1);assert.equal(card.sections.appearance.lines[0].id,'stale');assert.equal(card.sections.appearance.lines[0].needsReview,false);assert.ok(card.aliases.includes('Witch'));assert.equal(r.loreRevision,h.documents.get(h.sessionPath).loreRevision);assert.equal(r.entries[0].sections.appearance.text,'New manual canon');
});
test('L6 changed sent text refuses replacement and missing snapshot notes are replaced while fresh and user notes survive',async()=>{
 const h=await setup(),e=loreEntry();await h.lore.createEntry('s',e);const sent=e.sections.appearance.lines.map(l=>({id:l.id,text:l.text})),snapshot={appearance:sent.map(l=>l.id)},preview={entry:e,sent:{appearance:sent},snapshot,sections:{appearance:[{id:'new',text:'tidied',by:'reorganize',at:5}]}};
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines[0].text='Edited elsewhere';await assert.rejects(h.lore.replaceLines('s',[preview],3),/changed since the preview/);assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines[0].text,'Edited elsewhere');
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines[0].text=sent[0].text;h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.push({id:'fresh',text:'fresh',by:'auto',at:6},{id:'user',text:'mine',by:'user',at:1});await h.lore.replaceLines('s',[preview],3);assert.deepEqual(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.map(l=>l.id),['user','new','fresh']);
});
test('L1 content edits cap the edit log without pausing and scene corrections create revisioned invalidations',async()=>{
 const h=await setup(),a=await h.api.addMessage('s',{role:'assistant',content:'Story'});h.documents.get(h.sessionPath).memoryState={extractedThroughOrder:a.order};for(let i=0;i<25;i++)await h.api.editMessage('s',a.id,'Story '+i,a.order);const session=h.documents.get(h.sessionPath);assert.equal(session.contentEdits.length,20);assert.ok(session.contentEditsFloor>0);assert.notEqual(session.memoryState.paused,true);const n=session.memoryInvalidations.length,revision=(await h.api.getMessages('s'))[0].revision;await h.api.updateMessageScene('s',a.id,a.order,'date: Day 1 · time: night · place: Inn · present: Mira');assert.equal(h.documents.get(h.sessionPath).memoryInvalidations.length,n+1);assert.equal((await h.api.getMessages('s'))[0].revision,revision+1);
});
test('L2 rebuild cleanup backs up unreproduced notes and preserves refreshed, imported, user and out-of-range notes',async()=>{
 const h=await setup(),e=loreEntry();e.sections.appearance.lines=[{id:'remove',by:'auto',text:'old',needsReview:true,src:4,at:1},{id:'updated',by:'auto',text:'reproduced',needsReview:false,src:4,at:2},{id:'later',by:'auto',text:'outside',needsReview:true,src:8,at:1},{id:'mine',by:'user',text:'mine',needsReview:true,src:4,at:1},{id:'import',by:'import',text:'canon',needsReview:true,src:4,at:1}];await h.lore.createEntry('s',e);const backup=await h.lore.removeReviewedLines('s',[e],3,6);assert.deepEqual(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.map(l=>l.id),['updated','later','mine','import']);await h.lore.restoreBackup('s',backup,[]);assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.length,5);
});


test('D2 reply saves reject a concurrent history revision without writes',async()=>{
 const h=await setup(),u=await h.api.addMessage('s',{role:'user',content:'Action'});
 await h.api.addMessage('s',{role:'user',content:'Another device action'});
 const before=JSON.stringify([...h.documents]);
 await assert.rejects(h.api.addMessage('s',{role:'assistant',content:'Paid reply'},{expectedSource:{historyRevision:u.historyRevision}}),e=>e.name==='HistoryConflict');
 assert.equal(JSON.stringify([...h.documents]),before);
});
test('D2 normal narrator save adds no transaction reads for its history guard',async()=>{
 const h=await setup(),u=await h.api.addMessage('s',{role:'user',content:'Action'}),before=h.reads.documents;
 const reply=await h.api.addMessage('s',{role:'assistant',content:'Reply'},{expectedSource:{historyRevision:u.historyRevision}});
 assert.equal(h.reads.documents-before,1);assert.equal(reply.historyRevision,u.historyRevision+1);
});
test('D2 overwrite rejects newer story messages across chunks but permits trailing summaries',async()=>{
 const h=await setup(),a=await h.api.addMessage('s',{role:'assistant',content:'Old reply'});
 await h.api.addMessage('s',{role:'summary',content:'Summary'});
 let revision=h.documents.get(h.sessionPath).historyRevision;
 await h.api.overwriteMessage('s',a.id,{content:'Regenerated'},a.order,{}, {historyRevision:revision});
 // Force a new chunk so the newer user action is outside the target chunk.
 h.documents.get(h.sessionPath).activeChunkCount=100;
 await h.api.addMessage('s',{role:'user',content:'Newer action'});
 revision=h.documents.get(h.sessionPath).historyRevision;const before=JSON.stringify([...h.documents]);
 await assert.rejects(h.api.overwriteMessage('s',a.id,{content:'Stale replacement'},a.order,{}, {historyRevision:revision}),e=>e.name==='HistoryConflict');
 assert.equal(JSON.stringify([...h.documents]),before);
});
test('D2 overwrite of a deleted reply reports a typed conflict',async()=>{
 const h=await setup(),a=await h.api.addMessage('s',{role:'assistant',content:'Old reply'});
 await h.api.deleteMessage('s',a.id,a.order);
 await assert.rejects(h.api.overwriteMessage('s',a.id,{content:'Paid replacement'},a.order,{}, {historyRevision:h.documents.get(h.sessionPath).historyRevision}),e=>e.name==='HistoryConflict');
});


function legacyContinuityChunks(h,count=60) {
 const base=h.documents.get(h.sessionPath);Object.assign(base,{storageVersion:2,nextOrder:count,historyRevision:7,activeChunkId:'legacy'+count,activeChunkCount:1});
 for(let i=1;i<=count;i++)h.documents.set(h.sessionPath+'/messageChunks/legacy'+i,{firstOrder:i,lastOrder:i,count:1,byteSize:100,messages:[{id:'old'+i,order:i,role:i%2 ? 'user':'assistant',content:'old '+i}]});
}
test('D6 large continuity migration writes at most one chunk per transaction',async()=>{
 const h=await setup();legacyContinuityChunks(h);await h.api.ensureContinuityMetadata('s');
 assert.ok(h.transactions.every(tx=>tx.filter(w=>w.path.includes('/messageChunks/')).length<=1));
 assert.ok(h.transactions.length>=61);
 assert.equal(h.documents.get(h.sessionPath).continuityVersion,2);assert.equal(h.documents.get(h.sessionPath).nextNarratorTurn,31);
 for(let i=1;i<=60;i++){const c=h.documents.get(h.sessionPath+'/messageChunks/legacy'+i);assert.equal(c.continuityVersion,2);assert.equal(c.messages[0].revision,0);assert.equal(c.messages[0].narratorTurn,Math.ceil(i/2));}
});
test('D6 interrupted continuity migration resumes without rewriting completed chunks',async()=>{
 const h=await setup();legacyContinuityChunks(h);h.fault.failAt=4;
 await assert.rejects(h.api.ensureContinuityMetadata('s'),/Injected transaction failure/);
 assert.notEqual(h.documents.get(h.sessionPath).continuityVersion,2);
 assert.equal(h.documents.get(h.sessionPath+'/messageChunks/legacy1').continuityVersion,2);
 const completed=JSON.stringify(h.documents.get(h.sessionPath+'/messageChunks/legacy1')),start=h.transactions.length;
 await h.api.ensureContinuityMetadata('s');
 assert.equal(JSON.stringify(h.documents.get(h.sessionPath+'/messageChunks/legacy1')),completed);
 assert.ok(h.transactions.slice(start).every(tx=>!tx.some(w=>w.path.endsWith('/legacy1'))));
 assert.equal(h.documents.get(h.sessionPath).continuityVersion,2);
});


test('D9 delete newest reply then Retry keeps the user action in the same extraction turn',async()=>{
 const h=await setup(),u=await h.api.addMessage('s',{role:'user',content:'I act.'}),a=await h.api.addMessage('s',{role:'assistant',content:'First reply'});
 await h.api.addMessage('s',{role:'summary',content:'Summary after reply'});
 await h.api.deleteMessage('s',a.id,a.order);
 const retried=await h.api.addMessage('s',{role:'assistant',content:'Retried reply'});
 assert.equal(retried.narratorTurn,u.narratorTurn);
 const history=await h.api.getMessages('s'),turns=h.turns.computeTurns(history);
 assert.equal(turns.turnById.get(u.id),turns.turnById.get(retried.id));
 const range=h.turns.dueRange(history,{extractedThroughOrder:0},{lagTurns:0,batchTurns:1},{manual:true});
 assert.ok(range.messages.some(m=>m.id===u.id));assert.ok(range.messages.some(m=>m.id===retried.id));
});
test('D9 deleting an older assistant does not rewind the narrator turn counter',async()=>{
 const h=await setup(),a=await h.api.addMessage('s',{role:'assistant',content:'Old reply'});
 h.documents.get(h.sessionPath).activeChunkCount=100;
 const b=await h.api.addMessage('s',{role:'assistant',content:'New reply'}),counter=h.documents.get(h.sessionPath).nextNarratorTurn;
 await h.api.deleteMessage('s',a.id,a.order);
 assert.equal(h.documents.get(h.sessionPath).nextNarratorTurn,counter);assert.equal(b.narratorTurn,2);
});


test('D4 a tombstone blocks replies, extraction and card creation before the sweep',async()=>{
 const h=await setup();await h.api.addMessage('s',{role:'user',content:'Start'});
 Object.assign(h.documents.get(h.sessionPath),{deleting:true});const before=JSON.stringify([...h.documents]);
 await assert.rejects(h.api.addMessage('s',{role:'assistant',content:'Paid reply'}),e=>e.name==='StoryDeleted');
 await assert.rejects(h.lore.commitExtraction('s',{creates:[loreEntry()],appends:[],aliases:[],statusChanges:[]},{endOrder:1,fromTurn:1,toTurn:1}),e=>e.name==='StoryDeleted');
 await assert.rejects(h.lore.createEntry('s',loreEntry()),e=>e.name==='StoryDeleted');
 await assert.rejects(h.lore.writeBackup('s','test','Late backup',[loreEntry()]),e=>e.name==='StoryDeleted');
 assert.equal(JSON.stringify([...h.documents]),before);
});
test('D4 interrupted deletion stays hidden and a resumed sweep removes every subtree',async()=>{
 const h=await setup();await h.api.addMessage('s',{role:'assistant',content:'Reply'});await h.lore.createEntry('s',loreEntry());
 h.documents.set(h.sessionPath+'/messages/legacy',{order:1,content:'Legacy'});
 h.documents.set(h.sessionPath+'/loreBackups/old',{entries:[]});
 const revision=h.documents.get(h.sessionPath).historyRevision;
 h.fault.failBatchAt=h.fault.batchCount+2;
 await assert.rejects(h.sessions.deleteSession('s'),/Injected sweep failure/);
 assert.equal(h.documents.get(h.sessionPath).deleting,true);assert.equal(h.documents.get(h.sessionPath).historyRevision,revision+1);
 assert.ok(![...h.documents.keys()].some(p=>p.startsWith(h.sessionPath+'/messageChunks/')));
 const visible=await new Promise(resolve=>h.sessions.subscribeSessions(resolve));assert.equal(visible.length,0);
 await h.sessions.resumeSessionDeletion('s');
 assert.ok(![...h.documents.keys()].some(p=>p===h.sessionPath || p.startsWith(h.sessionPath+'/')));
 await h.sessions.resumeSessionDeletion('s');
});
test('D4 a missing story cannot recreate orphan memory or message documents',async()=>{
 const h=await setup();await h.api.addMessage('s',{role:'assistant',content:'Reply'});h.documents.delete(h.sessionPath);
 await assert.rejects(h.api.addMessage('s',{role:'assistant',content:'Late reply'}),e=>e.name==='StoryDeleted');
 await assert.rejects(h.lore.createEntry('s',loreEntry()),e=>e.name==='StoryDeleted');
 assert.equal(h.documents.has(h.sessionPath+'/lore/mira'),false);
});

test('D4 sidebar omits unpublished importing stories without sweeping them',async()=>{
 const h=await setup(),id=await h.sessions.createSession('Pending import',{importing:true});
 const visible=await new Promise(resolve=>h.sessions.subscribeSessions(resolve));
 assert.ok(!visible.some(s=>s.id===id));assert.equal(h.documents.get('users/u/sessions/'+id).importing,true);
});

test('D5 appending never replaces an existing next chunk after an interrupted import',async()=>{
 const h=await setup();await h.api.ensureContinuityMetadata('s');const path=h.sessionPath+'/messageChunks/chunk_000000000001',existing={firstOrder:1,lastOrder:100,messages:[{id:'imported',order:1,role:'user',content:'Imported story'}]};h.documents.set(path,existing);
 await assert.rejects(h.api.addMessage('s',{role:'user',content:'New send'}),/chunk already exists/);assert.deepEqual(h.documents.get(path),existing);assert.equal(h.documents.get(h.sessionPath).nextOrder,0);
});
test('B19 prefix copies keep only invalidations and edits they contain',async()=>{
 const h=await setup(),u=await h.api.addMessage('s',{role:'user',content:'First'});await h.api.addMessage('s',{role:'assistant',content:'Reply'});
 Object.assign(h.documents.get(h.sessionPath),{memoryInvalidations:[{fromOrder:9,revision:10}],contentEdits:[{order:9,revision:10}],memoryState:{needsRebuild:true,rebuildFromOrder:9}});
 const id=await h.sessions.duplicateSession('s',null,u.id),copy=h.documents.get('users/u/sessions/'+id);assert.deepEqual(copy.memoryInvalidations,[]);assert.deepEqual(copy.contentEdits,[]);assert.equal(copy.memoryState.needsRebuild,false);assert.equal(copy.memoryState.rebuildFromOrder,null);
});

test('B20 deleting the active summary falls back to the newest remaining known coverage',async()=>{
  const h=await setup();
  await h.api.addMessage('s',{role:'user',content:'Start'});await h.api.addMessage('s',{role:'assistant',content:'First'});
  const earlier=await h.api.addMessage('s',{role:'summary',content:'Earlier events',coveredRange:{fromOrder:1,toOrder:2}},{id:'earlier',sessionUpdate:{activeSummaryMessageId:'earlier',breakpointOrder:2}});
  await h.api.addMessage('s',{role:'user',content:'Continue'});await h.api.addMessage('s',{role:'assistant',content:'Later'});
  const active=await h.api.addMessage('s',{role:'summary',content:'All earlier events',coveredRange:{fromOrder:1,toOrder:5}},{id:'active',sessionUpdate:{activeSummaryMessageId:'active',breakpointOrder:5}});
  const result=await h.api.deleteMessage('s',active.id,active.order);
  assert.equal(result.summaryReset,true);
  assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId,earlier.id);
  assert.equal(h.documents.get(h.sessionPath).breakpointOrder,2);
  assert.equal(result.session.activeSummaryMessageId,earlier.id);
});

test('B20 deleting a folded turn can fall back only to a summary before that source',async()=>{
  for(const earlierCutoff of [2,4]) {
    const h=await setup();
    await h.api.addMessage('s',{role:'user',content:'Start'});await h.api.addMessage('s',{role:'assistant',content:'First'});
    await h.api.addMessage('s',{role:'summary',content:'Earlier events',coveredRange:{fromOrder:1,toOrder:earlierCutoff}},{id:'earlier'});
    const user=await h.api.addMessage('s',{role:'user',content:'Remove this folded turn'});await h.api.addMessage('s',{role:'assistant',content:'Later'});
    await h.api.addMessage('s',{role:'summary',content:'All earlier events',coveredRange:{fromOrder:1,toOrder:5}},{id:'active',sessionUpdate:{activeSummaryMessageId:'active',breakpointOrder:5}});
    await h.api.deleteMessage('s',user.id,user.order);
    assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId,earlierCutoff===2 ? 'earlier' : null);
    assert.equal(h.documents.get(h.sessionPath).breakpointOrder,earlierCutoff===2 ? 2 : 0);
  }
});

test('B20 an older summary with unknown coverage is not a safe fallback',async()=>{
  const h=await setup();await h.api.addMessage('s',{role:'user',content:'Start'});
  await h.api.addMessage('s',{role:'summary',content:'Old legacy summary'},{id:'legacy'});
  const active=await h.api.addMessage('s',{role:'summary',content:'Known coverage',coveredRange:{fromOrder:1,toOrder:1}},{id:'active',sessionUpdate:{activeSummaryMessageId:'active',breakpointOrder:1}});
  await h.api.deleteMessage('s',active.id,active.order);
  assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId,null);assert.equal(h.documents.get(h.sessionPath).breakpointOrder,0);
});

test('B20 failed fallback deletion leaves the active checkpoint and messages unchanged',async()=>{
  const h=await setup();await h.api.addMessage('s',{role:'user',content:'Start'});
  await h.api.addMessage('s',{role:'summary',content:'Earlier events',coveredRange:{fromOrder:1,toOrder:1}},{id:'earlier'});
  const active=await h.api.addMessage('s',{role:'summary',content:'Latest summary',coveredRange:{fromOrder:1,toOrder:1}},{id:'active',sessionUpdate:{activeSummaryMessageId:'active',breakpointOrder:1}});
  const before=JSON.stringify([...h.documents]);h.fault.failAt=h.transactions.length+1;
  await assert.rejects(h.api.deleteMessage('s',active.id,active.order),/Injected transaction failure/);
  assert.equal(JSON.stringify([...h.documents]),before);
});


test('D7 stale UI delete backs up the server-only note and restore recovers it',async()=>{
 const h=await setup(),e=loreEntry();await h.lore.createEntry('s',e);
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.push({id:'server-only',text:'New note from another device',src:4,by:'auto',at:2});
 const backup=await h.lore.deleteEntry('s',e);await h.lore.restoreBackup('s',backup,[]);
 assert.ok(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.some(l=>l.id==='server-only'));
});
test('D7 import backs up current cards and identifies new cards from the server',async()=>{
 const h=await setup(),e=loreEntry();await h.lore.createEntry('s',e);
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.push({id:'server-only',text:'Concurrent',src:4,by:'auto',at:2});
 const replacement=loreEntry();replacement.sections.appearance.text='Imported canon';
 const backup=await h.lore.importLore('s',{writes:[{id:'mira',data:replacement},{id:'new',data:loreEntry('new')}]},[]);
 await h.lore.restoreBackup('s',backup,[]);
 assert.ok(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.some(l=>l.id==='server-only'));
 assert.equal(h.documents.has(h.sessionPath+'/lore/new'),false);
});
test('D7 restore backs up current server data and flags the newer lost extraction source',async()=>{
 const h=await setup(),old=loreEntry();old.updatedAt=new Date(1000);await h.lore.createEntry('s',old);
 const backup=await h.lore.writeBackup('s','test','Old snapshot',[old]);
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.push({id:'newer',text:'Fresh extraction',src:50,by:'auto',at:2});
 h.documents.get(h.sessionPath).memoryState={lastUpdateAt:new Date(3000),extractedThroughOrder:50};
 await h.lore.restoreBackup('s',backup,[]);
 const session=h.documents.get(h.sessionPath);assert.equal(session.memoryState.needsRebuild,true);assert.equal(session.memoryState.rebuildFromOrder,50);
 const undo=(await h.lore.listBackups('s')).find(g=>g.reason==='restore');const parts=await h.lore.loadBackupGroup('s',undo.id);
 assert.ok(parts.flatMap(p=>p.entries).some(e=>e.data.sections.appearance.lines.some(l=>l.id==='newer')));
 await h.lore.restoreBackup('s',undo.id,[]);
 assert.ok(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.some(l=>l.id==='newer'));
});
test('D7 backup parts and index share one transaction and failure publishes neither',async()=>{
 const h=await setup();await h.lore.listBackups('s');const start=h.transactions.length;
 const id=await h.lore.writeBackup('s','test','Atomic',[loreEntry()]);
 assert.ok(h.transactions.slice(start).some(tx=>tx.some(w=>w.path.endsWith('/loreBackups/'+id)) && tx.some(w=>w.path.endsWith('/loreMeta/backups'))));
 const before=JSON.stringify([...h.documents]);h.fault.failAt=h.transactions.length+1;
 await assert.rejects(h.lore.writeBackup('s','test','Failure',[loreEntry()]),/Injected transaction failure/);
 assert.equal(JSON.stringify([...h.documents]),before);
});
test('D7 backup listing sweeps orphan parts but preserves indexed and active staged parts',async()=>{
 const h=await setup(),id=await h.lore.writeBackup('s','test','Kept',[loreEntry()]);
 h.documents.set(h.sessionPath+'/loreBackups/orphan',{partOf:'absent',entries:[]});
 h.documents.set(h.sessionPath+'/loreBackups/staged',{partOf:'pending',entries:[]});
 h.documents.get(h.sessionPath+'/loreMeta/backups').pending=[{id:'pending',createdMs:Date.now(),parts:['staged']}];
 await h.lore.listBackups('s');
 assert.equal(h.documents.has(h.sessionPath+'/loreBackups/orphan'),false);
 assert.equal(h.documents.has(h.sessionPath+'/loreBackups/'+id),true);assert.equal(h.documents.has(h.sessionPath+'/loreBackups/staged'),true);
 h.documents.get(h.sessionPath+'/loreMeta/backups').pending[0].createdMs=0;await h.lore.listBackups('s');
 assert.equal(h.documents.has(h.sessionPath+'/loreBackups/staged'),false);
});
test('D7 failed per-card restore retains a backup for each card it already changed',async()=>{
 const h=await setup(),a=loreEntry('a'),b=loreEntry('b');await h.lore.createEntry('s',a);await h.lore.createEntry('s',b);
 const backup=await h.lore.writeBackup('s','test','Old pair',[a,b]);
 h.documents.get(h.sessionPath+'/lore/a').sections.appearance.text='New A';h.documents.get(h.sessionPath+'/lore/b').sections.appearance.text='New B';
 h.fault.failAt=h.transactions.length+2;
 await assert.rejects(h.lore.restoreBackup('s',backup,[]),/Injected transaction failure/);
 assert.equal(h.documents.get(h.sessionPath+'/lore/a').sections.appearance.text,'canon');assert.equal(h.documents.get(h.sessionPath+'/lore/b').sections.appearance.text,'New B');
 const undo=(await h.lore.listBackups('s')).find(g=>g.reason==='restore'),parts=await h.lore.loadBackupGroup('s',undo.id);
 assert.equal(parts.flatMap(p=>p.entries).find(e=>e.id==='a').data.sections.appearance.text,'New A');
});

test('D7 merge backup preserves notes absent from both UI cards',async()=>{
 const h=await setup(),a=loreEntry('a'),b=loreEntry('b');await h.lore.createEntry('s',a);await h.lore.createEntry('s',b);
 h.documents.get(h.sessionPath+'/lore/b').sections.appearance.lines.push({id:'fresh',text:'Fresh on target',src:4,by:'auto',at:2});
 const backup=await h.lore.mergeEntries('s',a,b);await h.lore.restoreBackup('s',backup,[]);
 assert.ok(h.documents.get(h.sessionPath+'/lore/b').sections.appearance.lines.some(l=>l.id==='fresh'));
});
test('D7 deleted-note removal retries its atomic backup when a server note races the write',async()=>{
 const h=await setup(),e=loreEntry();await h.api.addMessagesBulk('s',[{id:'u',order:1,role:'user',content:'Start'},{id:'a',order:4,role:'assistant',content:'Reply'}]);await h.lore.createEntry('s',e);
 let raced=false;h.fault.beforeCommit=changes=>{
  if(!raced && changes.some(([type,target])=>type==='update' && target.path===h.sessionPath+'/lore/mira')){
   raced=true;h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.push({id:'racing',text:'New concurrent note',src:4,by:'auto',at:2});
  }
 };
 const backup=await h.lore.removeDeletedLines('s',[e],new Set(),1);h.fault.beforeCommit=null;
 await h.lore.restoreBackup('s',backup,[]);
 assert.ok(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.some(l=>l.id==='racing'));
});

test('D7 oversized backup failure keeps staged parts unpublished until the orphan lease expires',async()=>{
 const h=await setup();await h.lore.listBackups('s');
 const entries=Array.from({length:12},(_,i)=>{const e=loreEntry('big'+i);e.sections.appearance.text='x'.repeat(740000);return e;});
 h.fault.failAt=h.transactions.length+3;
 await assert.rejects(h.lore.writeBackup('s','test','Oversized',entries),/Injected transaction failure/);
 const index=h.documents.get(h.sessionPath+'/loreMeta/backups');assert.equal(index.groups.length,0);assert.equal(index.pending.length,1);
 assert.equal([...h.documents.keys()].filter(p=>p.includes('/loreBackups/')).length,1);
 assert.equal((await h.lore.listBackups('s')).length,0);
 index.pending[0].createdMs=0;await h.lore.listBackups('s');
 assert.equal([...h.documents.keys()].filter(p=>p.includes('/loreBackups/')).length,0);
});

test('B13 reorganize never resurrects an unsent line deleted after preview',async()=>{
 const h=await setup(),e=loreEntry();e.sections.appearance.lines.push({id:'unsent',text:'Needs review',by:'auto',needsReview:true,src:2,at:1});await h.lore.createEntry('s',e);
 h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines=h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.filter(l=>l.id!=='unsent');
 await h.lore.replaceLines('s',[{entry:e,sections:{appearance:[e.sections.appearance.lines[1],{id:'clean',text:'Clean',by:'reorganize',src:2,at:2}]},sent:{appearance:[e.sections.appearance.lines[0]]},snapshot:{appearance:e.sections.appearance.lines.map(l=>l.id)}}],2);
 assert.ok(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.every(l=>l.id!=='unsent'));
});

test('D5 cleanup whose tombstone initially fails is queued and resumes on reconnect',async()=>{
 const h=await setup();await h.api.addMessage('s',{role:'user',content:'Imported partial'});h.fault.failAt=h.transactions.length+1;
 await assert.rejects(h.sessions.deleteSession('s'),e=>e.deletionPending===true);assert.ok(h.documents.has(h.sessionPath));await h.sessions.resumeQueuedDeletions();assert.ok(![...h.documents.keys()].some(k=>k===h.sessionPath || k.startsWith(h.sessionPath+'/')));
});

test('D9 deleting a reply before a later pending user preserves that user turn for Retry',async()=>{
 const h=await setup();await h.api.addMessage('s',{role:'user',content:'First'});const old=await h.api.addMessage('s',{role:'assistant',content:'Old reply'}),user=await h.api.addMessage('s',{role:'user',content:'Pending next action'});await h.api.deleteMessage('s',old.id,old.order);const reply=await h.api.addMessage('s',{role:'assistant',content:'Pending reply'});assert.equal(reply.narratorTurn,user.narratorTurn);
});

function discoveryChunk(h,id,firstOrder,lastOrder,messages) {
  h.documents.set(h.sessionPath+'/messageChunks/'+id,{firstOrder,lastOrder,messages,count:messages.length});
}

test('F8 server discovery finds a committed reply in an older chunk after active rollover',async()=>{
  const h=await setup();
  discoveryChunk(h,'older',1,100,[{id:'paid',order:100,role:'assistant',content:'Paid reply'}]);
  discoveryChunk(h,'active',101,200,[{id:'other-device',order:200,role:'assistant',content:'Later reply'}]);
  Object.assign(h.documents.get(h.sessionPath),{activeChunkId:'active',nextOrder:200});
  const before=h.reads.documents;
  const found=await h.api.findSavedMessage('s','paid',100);
  assert.equal(found.content,'Paid reply');assert.equal(found.order,100);
  assert.equal(h.reads.documents-before,2,'range starts inclusively at the original minimum order');
  assert.equal(h.transactions.length,0,'discovery performs no writes');
});

test('F8 old pending replies without a minimum order search only the last three chunks',async()=>{
  const h=await setup();
  for(let i=0;i<5;i++)discoveryChunk(h,'chunk'+i,i*100+1,i*100+100,[{id:'reply'+i,order:i*100+1,role:'assistant',content:'Reply '+i}]);
  const before=h.reads.documents;
  assert.equal((await h.api.findSavedMessage('s','reply2')).content,'Reply 2');
  assert.equal(h.reads.documents-before,3);
  assert.equal(await h.api.findSavedMessage('s','reply0'),null);
  assert.equal(h.transactions.length,0);
});

test('F8 overwrite discovery reads the chunk containing the known original order',async()=>{
  const h=await setup();
  discoveryChunk(h,'original',1,100,[{id:'regenerated',order:100,role:'assistant',content:'Already overwritten'}]);
  discoveryChunk(h,'newer',101,200,[{id:'later',order:101,role:'assistant',content:'Later'}]);
  const before=h.reads.documents;
  const found=await h.api.findSavedMessage('s','regenerated',100,{overwrite:true});
  assert.equal(found.content,'Already overwritten');assert.equal(found.order,100);
  assert.equal(h.reads.documents-before,1);
  assert.equal(await h.api.findSavedMessage('s','unsaved',100,{overwrite:true}),null);
  assert.equal(h.transactions.length,0);
});

test('Continuity repair selects a valid earlier summary and retains retired history',async()=>{
 const h=await setup();const story=[];for(let i=0;i<6;i++)story.push(await h.api.addMessage('s',{role:i%2?'assistant':'user',content:'Fact '+i}));
 const early=await h.api.addMessage('s',{role:'summary',content:'Earlier facts',coveredRange:{fromOrder:1,toOrder:2}},{id:'early'});
 const late=await h.api.addMessage('s',{role:'summary',content:'Obsolete fact',coveredRange:{fromOrder:1,toOrder:6}},{id:'late',sessionUpdate:{activeSummaryMessageId:'late',breakpointOrder:6}});
 const edited=await h.api.editMessage('s',story[3].id,'Corrected fact',story[3].order);
 assert.equal(edited.session.activeSummaryMessageId,early.id);assert.equal(edited.session.breakpointOrder,2);
 const messages=await h.api.getMessages('s');assert.equal(messages.find(m=>m.id===late.id).retired,true);assert.equal(messages.find(m=>m.id===early.id).retired,undefined);
 const second=await h.api.editMessage('s',story[0].id,'Corrected opening',story[0].order);assert.equal(second.session.activeSummaryMessageId,null);assert.ok((await h.api.getMessages('s')).filter(m=>m.role==='summary').every(m=>m.retired));
});
test('Scene edit rejects extraction at commit and preserves its checkpoint and lore',async()=>{
 const h=await setup(),reply=await h.api.addMessage('s',{role:'assistant',content:'Story',scene:'date: Day 1 · time: morning · place: Inn · present: Mira'});
 h.documents.get(h.sessionPath).memoryState={extractedThroughOrder:0};
 const guard={startPointer:0,startRevision:h.documents.get(h.sessionPath).historyRevision,fromOrder:1,endOrder:1};
 await h.api.updateMessageScene('s',reply.id,reply.order,'date: Day 1 · time: night · place: Inn · present: Mira');
 await assert.rejects(h.lore.commitExtraction('s',{creates:[loreEntry()],appends:[],aliases:[],statusChanges:[]},{guard,endOrder:1}),/edited/);
 assert.equal(h.documents.get(h.sessionPath).memoryState.extractedThroughOrder,0);assert.equal(h.documents.has(h.sessionPath+'/lore/mira'),false);
});
test('Existing story migration is idempotent and the migration seed is immutable',async()=>{
 const h=await setup(),api=h.storySettings;
 const [a,b]=await Promise.all([api.ensureStorySettings('s'),api.ensureStorySettings('s')]);assert.deepEqual(a,b);assert.equal(a.values.narratorSystemPrompt,'Legacy narrator');
 const saved=await api.preserveLegacyStorySeed({narratorSystemPrompt:'Later account prompt'});assert.equal(saved.narratorSystemPrompt,'Legacy narrator');
 assert.equal(h.documents.get(h.sessionPath).storySettingsRevision,1);
});
test('Story prompt saves preserve unrelated remote fields and reject overlapping changes',async()=>{
 const h=await setup(),api=h.storySettings,base=(await api.ensureStorySettings('s')).values;
 await api.saveStorySettings('s',base,{summarizerSystemPrompt:'Remote summary'});
 const merged=await api.saveStorySettings('s',base,{narratorSystemPrompt:'Local narrator',apiKey:'Never import credentials'});
 assert.equal(merged.values.summarizerSystemPrompt,'Remote summary');assert.equal(merged.values.narratorSystemPrompt,'Local narrator');assert.equal('apiKey' in merged.values,false);
 const before=JSON.stringify([...h.documents]);await assert.rejects(api.saveStorySettings('s',base,{narratorSystemPrompt:'Conflict'}),/Reload and review/);assert.equal(JSON.stringify([...h.documents]),before);
});
test('New and zero-message copied stories receive independent explicit settings and deletion removes them',async()=>{
 const h=await setup(),api=h.storySettings,source=await api.ensureStorySettings('s');
 await api.saveStorySettings('s',source.values,{narratorSystemPrompt:'Custom source',rewriteSystemPrompt:'Custom rewrite'});
 const copied=await h.sessions.duplicateSession('s',0),path='users/u/sessions/'+copied;
 const copiedSettings=await api.ensureStorySettings(copied);assert.equal(copiedSettings.values.narratorSystemPrompt,'Custom source');
 await api.saveStorySettings(copied,copiedSettings.values,{narratorSystemPrompt:'Independent copy'});assert.equal((await api.ensureStorySettings('s')).values.narratorSystemPrompt,'Custom source');
 const fresh=await h.sessions.createSession('New');assert.notEqual((await api.ensureStorySettings(fresh)).values.narratorSystemPrompt,'Custom source');assert.ok((await api.ensureStorySettings(fresh)).values.rewriteSystemPrompt);
 await h.sessions.deleteSession(copied);assert.equal(h.documents.has(path+'/storySettings/current'),false);
});
test('Concurrent source settings and lore changes abort unpublished copies',async()=>{
 for(const field of ['historyRevision','loreRevision','storySettingsRevision']){
  const h=await setup();await h.api.addMessage('s',{role:'assistant',content:'Story'});await h.storySettings.ensureStorySettings('s');
  let changed=false;h.fault.beforeCommit=changes=>{if(!changed && changes.some(c=>c[1].path.includes('/storySettings/current') && !c[1].path.startsWith(h.sessionPath+'/'))){changed=true;h.documents.get(h.sessionPath)[field]=(h.documents.get(h.sessionPath)[field] ?? 0)+1;}};
  await assert.rejects(h.sessions.duplicateSession('s'),/story changed while copying/);assert.equal([...h.documents].filter(([p,d])=>p.startsWith('users/u/sessions/') && p.split('/').length===4 && !d.importing).length,1);
 }
});
test('Background reconciliation and Undo retain concurrent evidence and atomic backups',async()=>{
 const h=await setup(),entry=loreEntry();await h.lore.createEntry('s',entry);const path=h.sessionPath+'/lore/mira';
 h.documents.get(path).sections.appearance.lines.push({id:'concurrent',by:'auto',text:'Later fact',src:4,at:2});
 const backup=await h.lore.reconcileBackground('s',entry,'appearance','Updated background','canon');
 assert.equal(h.documents.get(path).sections.appearance.text,'Updated background');assert.equal(h.documents.get(path).sections.appearance.lines.length,2);
 await h.lore.restoreBackup('s',backup,[]);assert.equal(h.documents.get(path).sections.appearance.text,'canon');assert.equal(h.documents.get(path).sections.appearance.lines.length,2);
 const before=JSON.stringify([...h.documents]);await assert.rejects(h.lore.reconcileBackground('s',entry,'appearance','Conflict','outdated text'),/changed on another device/);assert.equal(JSON.stringify([...h.documents]),before);
});
test('Failed lore writes leave their revision and content unchanged',async()=>{
 const h=await setup(),entry=loreEntry();await h.lore.createEntry('s',entry);const revision=h.documents.get(h.sessionPath).loreRevision;
 h.fault.failAt=h.transactions.length+1;await assert.rejects(h.lore.saveEntry('s',{...entry,name:'Changed'},entry),/Injected/);
 assert.equal(h.documents.get(h.sessionPath).loreRevision,revision);assert.equal(h.documents.get(h.sessionPath+'/lore/mira').name,entry.name);
});

test('Story JSONL and full backups round trip only allowed settings and old files use the preserved seed',async()=>{
 const h=await setup(),api=h.storySettings;
 await h.api.addMessage('s',{role:'assistant',content:'Preserved story',scene:'Inn'});const base=(await api.ensureStorySettings('s')).values;
 await api.saveStorySettings('s',base,{narratorSystemPrompt:'Export narrator',rewriteRecentMessages:3});
 const exported=await h.transfer.serializeStory('s'),records=exported.text.trim().split('\n').map(JSON.parse);assert.equal(records[0].nera.storySettings.values.narratorSystemPrompt,'Export narrator');
 Object.assign(records[0].nera.storySettings.values,{apiKey:'Blocked key',maxContextTokens:1,petCharacterIds:['blocked'],streamVibrationMode:'speed'});
 const file={size:1000,name:'story.jsonl',text:async()=>records.map(JSON.stringify).join('\n')},id=await h.transfer.importSillyTavern(file),values=(await api.ensureStorySettings(id)).values;
 assert.equal(values.narratorSystemPrompt,'Export narrator');assert.equal(values.rewriteRecentMessages,3);for(const key of ['apiKey','maxContextTokens','petCharacterIds','streamVibrationMode'])assert.equal(key in values,false);
 const backup=await h.transfer.buildFullBackup('s'),full=await h.transfer.importSillyTavern({size:1000,name:'full.json',text:async()=>JSON.stringify(backup)});assert.equal((await api.ensureStorySettings(full)).values.narratorSystemPrompt,'Export narrator');
 delete records[0].nera.storySettings;const old=await h.transfer.importSillyTavern({...file,text:async()=>records.map(JSON.stringify).join('\n')});assert.equal((await api.ensureStorySettings(old)).values.narratorSystemPrompt,'Legacy narrator');
 assert.equal(h.documents.get('users/u/sessions/'+id).memory.autoUpdate,false);assert.equal(h.documents.get('users/u/sessions/'+id).memory.sceneFallback,false);
});
test('Export rejects history, lore, or settings changes during snapshot reads',async()=>{
 for(const field of ['historyRevision','loreRevision','storySettingsRevision']){
  const h=await setup();await h.api.addMessage('s',{role:'assistant',content:'Story'});await h.storySettings.ensureStorySettings('s');
  h.fault.onServerRead=path=>{if(path===h.sessionPath+'/lore'){h.documents.get(h.sessionPath)[field]=(h.documents.get(h.sessionPath)[field] ?? 0)+1;}};
  await assert.rejects(h.transfer.serializeStory('s'),/story changed while copying or exporting/);
 }
});
test('Summary Stop before its save transaction leaves history and checkpoint untouched',async()=>{
 const h=await setup(),controller=new AbortController();controller.abort('user');const before=JSON.stringify([...h.documents]);
 await assert.rejects(h.api.addMessage('s',{role:'summary',content:'Discard'},{signal:controller.signal,sessionUpdate:{activeSummaryMessageId:'sum',breakpointOrder:2}}),/Summary stopped/);
 // Lazy metadata initialization is permitted, but no summary/checkpoint write is.
 assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId,undefined);assert.equal((await h.api.getMessages('s')).length,0);
});

test('Duplicate thread merge records an explicit surviving status independent of generated status evidence',async()=>{
 const h=await setup();const entry=id=>({id,book:'events',kind:'thread',name:id==='a'?"Katarina's invitation":'Katarina’s invitation',aliases:[],status:'open',statusSource:{needsReview:true,by:'auto'},sections:{text:{text:'Invitation',lines:[]}}});const a=entry('a'),b=entry('b');await h.lore.createEntry('s',a);await h.lore.createEntry('s',b);
 await assert.rejects(h.lore.mergeEntries('s',a,b),/Choose the surviving thread status/);
 const backup=await h.lore.mergeEntries('s',a,b,'closed'),merged=h.documents.get(h.sessionPath+'/lore/b');assert.equal(merged.status,'closed');assert.equal(merged.statusSource,null);
 await h.lore.restoreBackup('s',backup,[]);assert.equal(h.documents.has(h.sessionPath+'/lore/a'),true);assert.equal(h.documents.get(h.sessionPath+'/lore/b').status,'open');
});

test('Editing with a cleared checkpoint retires inactive summaries so they cannot become a stale fallback',async()=>{
 const h=await setup(),a=await h.api.addMessage('s',{role:'assistant',content:'Old fact'});
 await h.api.addMessage('s',{role:'summary',content:'Obsolete inactive summary',coveredRange:{fromOrder:1,toOrder:1}},{id:'old'});
 await h.api.editMessage('s',a.id,'Corrected fact',a.order);assert.equal((await h.api.getMessages('s')).find(m=>m.id==='old').retired,true);
 const active=await h.api.addMessage('s',{role:'summary',content:'Correct facts',coveredRange:{fromOrder:1,toOrder:1}},{id:'new',sessionUpdate:{activeSummaryMessageId:'new',breakpointOrder:1}});
 const deleted=await h.api.deleteMessage('s',active.id,active.order);assert.equal(deleted.session.activeSummaryMessageId,null);
});

test('Copies and exports reject prompt changes between settings and parent reads',async()=>{
 for(const mode of ['copy','jsonl','full']){
  const h=await setup();await h.api.addMessage('s',{role:'assistant',content:'Story'});await h.storySettings.ensureStorySettings('s');let changed=false;
  h.fault.onServerRead=path=>{if(!changed && path===(mode==='copy' ? h.sessionPath+'/messageChunks' : h.sessionPath)){changed=true;h.documents.get(h.sessionPath).storySettingsRevision++;const settings=h.documents.get(h.sessionPath+'/storySettings/current');settings.revision++;settings.values.narratorSystemPrompt='Concurrent prompt';}};
  await assert.rejects(mode==='copy' ? h.sessions.duplicateSession('s') : mode==='jsonl' ? h.transfer.serializeStory('s') : h.transfer.buildFullBackup('s'),/story changed while copying or exporting/);
 }
});

test('Continuation overwrite preserves turn and checkpoint through read, copy and native exports; edits clear it',async()=>{
 const h=await setup();const original=await h.api.addMessage('s',{role:'assistant',content:'Prefix',thinking:'old'});
 const checkpoint={contentOffset:6,thinkingOffset:3,before:{scene:null,sceneMeta:null,planThread:null,ooc:false,truncated:false,acceptance:null,reviewWarnings:[],sceneCandidate:null,responseDiagnostics:null}};
 const parent=h.documents.get(h.sessionPath);const next=parent.nextNarratorTurn,order=parent.nextOrder;
 parent.memoryState={extractedThroughOrder:original.order};
 await h.api.overwriteMessage('s',original.id,{content:'Prefix\n\nPassage',thinking:'old\n\nnew',lastContinuation:checkpoint},original.order,{}, {historyRevision:parent.historyRevision});
 const read=(await h.api.getMessages('s')).at(-1);assert.deepEqual(read.lastContinuation,checkpoint);assert.equal(read.narratorTurn,original.narratorTurn);assert.equal(h.documents.get(h.sessionPath).nextNarratorTurn,next);assert.equal(h.documents.get(h.sessionPath).nextOrder,order);assert.ok(h.documents.get(h.sessionPath).memoryState.needsRebuild);
 const copy=await h.sessions.duplicateSession('s');assert.deepEqual((await h.api.getMessages(copy)).at(-1).lastContinuation,checkpoint);
 const jsonl=await h.transfer.serializeStory('s');const imported=await h.transfer.importSillyTavern({size:1000,name:'story.jsonl',text:async()=>jsonl.text});assert.deepEqual((await h.api.getMessages(imported)).at(-1).lastContinuation,checkpoint);
 const backup=await h.transfer.buildFullBackup('s');const restored=await h.transfer.importSillyTavern({size:1000,name:'story.json',text:async()=>JSON.stringify(backup)});assert.deepEqual((await h.api.getMessages(restored)).at(-1).lastContinuation,checkpoint);
 await h.api.editMessage('s',original.id,'Edited',original.order);assert.equal((await h.api.getMessages('s')).at(-1).lastContinuation,null);
 await h.api.overwriteMessage('s',original.id,{content:'Prefix\n\nPassage',lastContinuation:checkpoint},original.order);
 await h.api.updateMessageScene('s',original.id,original.order,'date: Day 1 · time: night · place: Inn · present: Mira');assert.equal((await h.api.getMessages('s')).at(-1).lastContinuation,null);
});
