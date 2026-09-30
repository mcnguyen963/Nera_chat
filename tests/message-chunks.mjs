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

test('continuity migration reads either source storage format without modifying the source', async () => {
  const h = await setup(3);
  const before = structuredClone(h.documents.get(h.sessionPath));
  assert.deepEqual((await h.api.getMessagesReadOnly('s')).map((item) => item.content),
    ['event 1', 'event 2', 'event 3']);
  assert.deepEqual(h.documents.get(h.sessionPath), before);
  assert.equal([...h.documents.keys()].some((path) => path.includes('/messageChunks/')), false);
  await h.api.ensureChunked('s');
  const afterUpgrade = structuredClone(h.documents.get(h.sessionPath));
  assert.deepEqual((await h.api.getMessagesReadOnly('s')).map((item) => item.content),
    ['event 1', 'event 2', 'event 3']);
  assert.deepEqual(h.documents.get(h.sessionPath), afterUpgrade);
});

test('assistant plan thread is stored separately from visible content', async () => {
  const h = await setup();
  const saved = await h.api.addMessage('s', {
    role: 'assistant', content: 'The door opens.', planThread: 'steering toward the reunion',
  });
  let message = (await h.api.getMessages('s'))[0];
  assert.equal(message.content, 'The door opens.');
  assert.equal(message.planThread, 'steering toward the reunion');
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

test('optional recall reads one chunk at a time and fetches only selected text', async () => {
  const h = await setup(250);
  await h.api.ensureChunked('s');
  const before = h.reads.documents;
  const page = await h.api.getRecallPage('s', 251);
  assert.equal(page.messages.length, 50);
  assert.equal(h.reads.documents - before, 1);
  const matches = await h.api.getRecallMatches('s', [
    { id: 'm225', order: 225, chunkId: page.chunkId },
    { id: 'm249', order: 249, chunkId: page.chunkId },
  ]);
  assert.deepEqual(Array.from(matches, (message) => message.content), ['event 225', 'event 249']);
  assert.equal(h.reads.documents - before, 2);
  const previous = await h.api.getRecallPage('s', page.messages[0].order);
  assert.equal(previous.messages.at(-1).order, 200);
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

test('duplicating and deleting continuity stories includes state chunks and retained legacy records', async () => {
  const h = await setup();
  const branch = h.sessionPath + '/continuityBranches/main';
  h.documents.set(branch, { status: 'ready', revision: 1, recordStorageVersion: 2, recordChunkCount: 1 });
  h.documents.set(branch + '/recordChunks/chunk_000000', { id: 'chunk_000000', records: [{ id: 'char_A', data: { name: 'A' } }] });
  h.documents.set(branch + '/records/char_A', { id: 'char_A', data: { name: 'Obsolete A' } });
  const copyId = await h.sessions.duplicateSession('s');
  const copy = `users/u/sessions/${copyId}/continuityBranches/main`;
  assert.equal(h.documents.get(copy + '/recordChunks/chunk_000000').records[0].data.name, 'A');
  assert.equal(h.documents.has(copy + '/records/char_A'), false);
  await h.sessions.deleteSession('s');
  assert.equal([...h.documents.keys()].some((path) => path.startsWith(h.sessionPath + '/')), false);
  assert.equal(h.documents.has(copy + '/recordChunks/chunk_000000'), true);
});
