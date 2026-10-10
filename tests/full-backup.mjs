import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup(changed = false) {
  const session = { id: 's', title: 'Story', longTermPlan: 'Plan', allowLlmPlanUpdates: true,
    activeSummaryMessageId: 'sum', breakpointOrder: 1, nextOrder: 3, updatedAt: { seconds: 10, nanoseconds: 20 } };
  const messages = [
    { id: 'u', order: 1, role: 'user', content: 'Opening', createdAt: { seconds: 1, nanoseconds: 2 } },
    { id: 'sum', order: 2, role: 'summary', content: 'Facts' },
    { id: 'a', order: 3, role: 'assistant', content: 'Reply', thinking: 'Thinking', planThread: 'Note', planBefore: 'Prior plan', truncated: true },
  ];
  let reads = 0;
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/import-export.js', import.meta.url), 'utf8'), { context });
  await module.link(async specifier => {
    if(specifier==='./math-utils.js')return new vm.SourceTextModule(await readFile(new URL('../js/math-utils.js',import.meta.url),'utf8'),{context});
    const exports = specifier.includes('story-settings-store') ? {ensureStorySettings:async()=>({version:1,revision:1,values:{narratorSystemPrompt:'Story prompt'}}),writeInitialStorySettings(){},preserveLegacyStorySeed(){}} : specifier.includes('story-settings') ? {assertSnapshotRevisions(){},explicitStorySettings:x=>x} : specifier.includes('state') ? {state:{}} : specifier.includes('sessions') ? {
      createSession() {}, getSession() {}, updateSession(){}, deleteSession(){},listSessions:async()=>[], getSessionFromServer: async () => {
        reads++;
        return { ...session, nextOrder: changed && reads > 1 ? 4 : 3 };
      },
    } : specifier.includes('messages') ? { getMessages: async () => messages, addMessagesBulk() {}, ensureChunked: async () => {} }
      : specifier.includes('lore-format') ? {normalizeLoreEntry:x=>x}
      : specifier.includes('lore-store') ? {getLore:async()=>[],importLore(){}}
      : specifier.includes('memory-settings') ? {normalizeMemory:()=>({})}
      : specifier.includes('memory-ui') ? {download(){}}
      : { currentUid: () => 'owner' };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { api: module.namespace, session, messages };
}

test('Full JSON backup retains session pointers, all messages, private data, and timestamps', async () => {
  const h = await setup();
  const backup = JSON.parse(JSON.stringify(await h.api.buildFullBackup('s')));
  assert.equal(backup.version, 1);
  assert.equal(backup.format, 'nera-chat-backup');
  assert.deepEqual(backup.session, h.session);
  assert.deepEqual(backup.messages, h.messages);
});

test('Export refuses inconsistent session and message snapshots', async () => {
  const h = await setup(true);
  await assert.rejects(h.api.buildFullBackup('s'), /story changed while exporting/);
});
