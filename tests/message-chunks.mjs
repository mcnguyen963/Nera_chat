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
    const patch = {};
    for (const [key, field] of Object.entries(value)) {
      patch[key] = field?.kind === 'arrayUnion'
        ? [...(current[key] ?? []), field.value]
        : field?.kind === 'serverTimestamp' ? new Date() : field;
    }
    documents.set(target.path, structuredClone({ ...current, ...patch }));
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
    arrayUnion: (value) => ({ kind: 'arrayUnion', value }),
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
    runTransaction: async (_db, callback) => {
      const changes = [];
      const tx = {
        get: async (target) => { reads.documents++; return snapshot(target.path); },
        set: (target, value) => changes.push(['set', target, value]),
        update: (target, value) => changes.push(['update', target, value]),
      };
      const result = await callback(tx);
      for (const change of changes) apply(...change);
      return result;
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
  return { api: messages.namespace, sessions: sessions.namespace, documents, reads, sessionPath };
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
  assert.equal(message.tokenCount, message.content.length);
  await h.api.overwriteMessage('s', saved.id, {
    content: 'The room is empty.', thinking: null, planThread: 'steering toward the reveal',
  }, saved.order);
  message = (await h.api.getMessages('s'))[0];
  assert.equal(message.planThread, 'steering toward the reveal');
  await h.api.editMessage('s', saved.id, 'A quiet room.', saved.order);
  message = (await h.api.getMessages('s'))[0];
  assert.equal(message.planThread, null);
});

test('private-note edits preserve the reply and save story settings atomically', async () => {
  const h = await setup();
  const saved = await h.api.addMessage('s', {
    role: 'assistant', content: 'The door opens.', thinking: 'Saved reasoning',
    planThread: 'Old private note', planBefore: 'Find the door',
  });
  const original = (await h.api.getMessages('s'))[0];
  const result = await h.api.editPlanThread('s', saved.id, 'The edited private note', saved.order, {
    title: 'Edited story', longTermPlan: 'Meet the queen',
  });
  const edited = (await h.api.getMessages('s'))[0];
  assert.equal(edited.planThread, 'The edited private note');
  assert.equal(edited.content, original.content);
  assert.equal(edited.thinking, original.thinking);
  assert.equal(edited.planBefore, original.planBefore);
  assert.equal(edited.tokenCount, edited.content.length);
  assert.equal(result.message.planThread, edited.planThread);
  assert.equal(h.documents.get(h.sessionPath).title, 'Edited story');
  assert.equal(h.documents.get(h.sessionPath).longTermPlan, 'Meet the queen');
  await h.api.editPlanThread('s', saved.id, '', saved.order);
  const cleared = (await h.api.getMessages('s'))[0];
  assert.equal(cleared.planThread, null);
  assert.equal(cleared.tokenCount, original.content.length);
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

test('Editing folded story history preserves its checkpoint; deleting the active summary resets it', async () => {
  const h = await setup();
  const first = await h.api.addMessage('s', { role: 'user', content: 'Old fact' });
  await h.api.addMessage('s', { role: 'assistant', content: 'Reply' });
  const summary = await h.api.addMessage('s', { role: 'summary', content: 'Old fact remains' }, {
    sessionUpdate: { activeSummaryMessageId: 'summary', breakpointOrder: 2 }, id: 'summary',
  });
  assert.equal(summary.order, 3);
  const edited = await h.api.editMessage('s', first.id, 'Corrected fact', first.order);
  assert.equal(edited.summaryReset, false);
  assert.equal(h.documents.get(h.sessionPath).activeSummaryMessageId, 'summary');
  assert.equal(h.documents.get(h.sessionPath).breakpointOrder, 2);
  assert.equal((await h.api.getMessages('s'))[0].content, 'Corrected fact');
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

test('partial copies restore generated plans at the selected message cutoff', async () => {
  const h = await setup();
  await h.api.addMessage('s', { role: 'user', content: 'Start' }, { id: 'u1' });
  await h.api.addMessage('s', { role: 'assistant', content: 'First scene', planBefore: 'Initial plan' }, {
    id: 'a1', sessionUpdate: { longTermPlan: 'Plan after first scene', allowLlmPlanUpdates: true },
  });
  await h.api.addMessage('s', { role: 'user', content: 'Continue' }, { id: 'u2' });
  await h.api.addMessage('s', { role: 'assistant', content: 'Later reveal', planBefore: 'Plan after first scene' }, {
    id: 'a2', sessionUpdate: { longTermPlan: 'Future reveal in latest plan' },
  });
  const partial = await h.sessions.duplicateSession('s', null, 'a1');
  assert.equal(h.documents.get(`users/u/sessions/${partial}`).longTermPlan, 'Plan after first scene');
  const empty = await h.sessions.duplicateSession('s', 0);
  assert.equal(h.documents.get(`users/u/sessions/${empty}`).longTermPlan, 'Initial plan');
  const full = await h.sessions.duplicateSession('s');
  assert.equal(h.documents.get(`users/u/sessions/${full}`).longTermPlan, 'Future reveal in latest plan');
  h.documents.get(h.sessionPath).allowLlmPlanUpdates = false;
  const fixed = await h.sessions.duplicateSession('s', null, 'a1');
  assert.equal(h.documents.get(`users/u/sessions/${fixed}`).longTermPlan, 'Future reveal in latest plan');
});

test('partial copies reject unknown historical generated plans', async () => {
  const h = await setup();
  await h.api.addMessage('s', { role: 'assistant', content: 'Legacy reply' }, {
    sessionUpdate: { longTermPlan: 'Later plan', allowLlmPlanUpdates: true },
  });
  await assert.rejects(h.sessions.duplicateSession('s', 0), /plan.*cutoff is unknown/);
});
