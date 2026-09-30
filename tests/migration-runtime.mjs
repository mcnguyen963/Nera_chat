import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness({ failInitialize = false, failUpdate = false, updateSucceeded = false } = {}) {
  const session = { migrationStatus: 'staging', continuityEnabled: false };
  const calls = [];
  const stubs = {
    '../sessions.js': {
      createSession: async (title, options) => {
        calls.push(['create', title, options]); return 'copy-id';
      },
      getSession: async () => ({ ...session }),
      updateSession: async (_id, patch) => {
        calls.push(['publish', patch]);
        if (failUpdate && !updateSucceeded) throw new Error('publish failed');
        Object.assign(session, patch);
        if (failUpdate) throw new Error('acknowledgment lost');
      },
      deleteSession: async (id) => { calls.push(['delete', id]); },
    },
    './runtime.js': {
      storyStore: () => ({ initialize: async (snapshot) => {
        calls.push(['initialize', snapshot]);
        if (failInitialize) throw new Error('initialization failed');
      } }),
    },
  };
  const context = vm.createContext({ Error });
  const modules = new Map(Object.entries(stubs).map(([path, exports]) => [path,
    new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context })]));
  const module = new vm.SourceTextModule(await readFile(new URL('../js/continuity/migration-runtime.js', import.meta.url), 'utf8'),
    { context });
  await module.link((path) => modules.get(path));
  await module.evaluate();
  return { publish: module.namespace.publishContinuityMigration, calls, session };
}

const request = { title: 'Old story (continuity)', sourceSessionId: 'old-id',
  prepared: { state: { branchId: 'main', revision: 1 }, messages: [] } };

test('migration publishes a staged copy only after branch initialization', async () => {
  const h = await harness();
  assert.equal(await h.publish(request), 'copy-id');
  assert.deepEqual(h.calls.map(([action]) => action), ['create', 'initialize', 'publish']);
  assert.equal(h.session.continuityEnabled, true);
  assert.equal(h.session.migrationStatus, 'ready');
  assert.equal(h.session.continuityMode, 'reviewed');
});

test('migration can create a Saver story and rejects an unsupported mode before writing', async () => {
  const h = await harness();
  assert.equal(await h.publish({ ...request, continuityMode: 'saver' }), 'copy-id');
  assert.equal(h.session.continuityMode, 'saver');
  assert.equal(h.session.continuitySaverReviewEveryTurn, false);
  const invalid = await harness();
  await assert.rejects(invalid.publish({ ...request, continuityMode: 'unknown' }), /Choose Reviewed or Saver/);
  assert.equal(invalid.calls.length, 0);
});

test('migration removes a staging copy when initialization fails', async () => {
  const h = await harness({ failInitialize: true });
  await assert.rejects(h.publish(request), /initialization failed/);
  assert.deepEqual(h.calls.map(([action]) => action), ['create', 'initialize', 'delete']);
});

test('migration recognizes a successful publish after its acknowledgment is lost', async () => {
  const h = await harness({ failUpdate: true, updateSucceeded: true });
  assert.equal(await h.publish(request), 'copy-id');
  assert.deepEqual(h.calls.map(([action]) => action), ['create', 'initialize', 'publish']);
});
