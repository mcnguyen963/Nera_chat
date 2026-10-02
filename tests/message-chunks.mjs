// Run: node --experimental-vm-modules --test tests/message-chunks.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup(legacyCount = 0) {
  const documents = new Map();
  const reads = { documents: 0, legacy: 0 };
  const sessionPath = 'users/u/sessions/s';
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
        : field?.kind === 'serverTimestamp' ? new Date() : field;
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
    getDocFromServer: async (target) => {
      reads.documents++;
      return snapshot(target.path);
    },
    getDoc: async (target) => firestore.getDocFromServer(target),
    getDocsFromServer: async (source) => {
      const target = source.target ?? source;
      const constraints = source.constraints ?? [];
      const prefix = target.path + '/';
      let paths = [...documents.keys()].filter((path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
      );
      for (const c of constraints.filter((item) => item.kind === 'where')) {
        paths = paths.filter((path) => {
          const value = documents.get(path)[c.field];
          return c.op === '<' ? value < c.value : c.op === '<=' ? value <= c.value : value > c.value;
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
        commit: async () => { for (const change of changes) apply(...change); },
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
        if ([...versions].some(([path,version]) => JSON.stringify(documents.get(path)) !== version)) continue;
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
  const context = vm.createContext({ TextEncoder, Date, structuredClone, console });
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
        { context, identifier: path });
    modules.set(path, module);
    await module.link((specifier, parent) => load(specifier.startsWith('https:')
      ? specifier : new URL(specifier, 'https://local/' + parent.identifier).pathname.slice(1)));
    return module;
  }
  const messages = await load('messages.js');
  await messages.evaluate();
  const sessions = await load('sessions.js');
  await sessions.evaluate();
  const lore = await load('lore-store.js'); await lore.evaluate();
  return { lore: lore.namespace, api: messages.namespace, sessions: sessions.namespace, documents, reads, sessionPath };
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
  assert.equal(message.planThread, null);
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

test('Editing folded story history atomically invalidates its summary checkpoint', async () => {
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

test('scene changes preserve timestamps; prose edits clear old metadata', async () => {
  const h = await setup(); const saved = await h.api.addMessage('s',{ role:'assistant',content:'Story',scene:'Day 1 · Inn' });
  await h.api.updateMessageScene('s',saved.id,saved.order,'Day 2 · Inn'); let m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,'Day 2 · Inn'); assert.equal(m.editedAt,null);
  await h.api.editMessage('s',saved.id,'Edited story',saved.order); m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,null);
  await h.api.overwriteMessage('s',saved.id,{ content:'New reply',scene:'Day 3 · Market' },saved.order); m = (await h.api.getMessages('s'))[0]; assert.equal(m.scene,'Day 3 · Market');
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
  await h.lore.replaceLines('s',[{ entry:a,sections:{ appearance:[{ id:'tidied',text:'tidied',by:'reorganize',at:101 }] } }],50);
  const after = h.documents.get(h.sessionPath+'/lore/a'); assert.equal(after.sections.appearance.text,'canon'); assert.deepEqual(after.sections.appearance.lines.map(l => l.id),['old','late','user','tidied']);
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
  const h=await setup(), e=loreEntry(); e.sections.appearance.lines.push({ id:'later',text:'later',turn:2,src:4,by:'auto',at:2 }); await h.lore.createEntry('s',e);
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
  await assert.rejects(h.api.addMessage('s',{ role:'assistant',content:'Stale reply' },{ expectedSource }),/discarded/);
  await assert.rejects(h.api.addMessage('s',{ role:'summary',content:'Stale summary' },{ expectedSource,sessionUpdate:{ activeSummaryMessageId:'new',breakpointOrder:1 } }),/discarded/);
  await assert.rejects(h.lore.commitExtraction('s',{ creates:[loreEntry()],appends:[],aliases:[],statusChanges:[] },{ expectedSource,endOrder:1,fromTurn:1,toTurn:1 }),/discarded/);
  assert.equal(JSON.stringify([...h.documents]),before);
});
test('prose edits and scene corrections invalidate summary and memory without deleting notes',async () => {
  const h = await setup(); const a = await h.api.addMessage('s',{ role:'assistant',content:'Story',planThread:'Reminder',scene:'Day 1 · Inn' });
  const e = loreEntry(); e.sections.appearance.lines[0].src = a.order; await h.lore.createEntry('s',e);
  Object.assign(h.documents.get(h.sessionPath),{ activeSummaryMessageId:'summary',breakpointOrder:a.order,memoryState:{ extractedThroughOrder:a.order } });
  const result = await h.api.editMessage('s',a.id,'Edited',a.order);
  assert.equal(result.summaryReset,true); assert.equal(result.replacement.scene,null); assert.equal(result.replacement.planThread,null);
  const session = h.documents.get(h.sessionPath); assert.equal(session.activeSummaryMessageId,null); assert.equal(session.memoryState.needsRebuild,true); assert.equal(session.memoryState.paused,true);
  assert.equal(h.documents.get(h.sessionPath+'/lore/mira').sections.appearance.lines.length,1);
  await h.api.updateMessageScene('s',a.id,a.order,'unknown · Inn'); assert.equal(h.documents.get(h.sessionPath).memoryInvalidations.length,2);
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
