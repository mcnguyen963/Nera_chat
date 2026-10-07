import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appHarness } from './app-harness.mjs';

async function settingsHarness() {
  const viewSource = await readFile(new URL('../js/ui/settings-view.js', import.meta.url), 'utf8');
  const settingsSource = await readFile(new URL('../js/settings.js', import.meta.url), 'utf8');
  const use = appHarness({
    sources: {
      'settings.js': settingsSource + '\nexport { mergeDefaults };',
      'ui/settings-view.js': viewSource + '\nexport function validateForTest(value) { draft = value; return validatedDraft(); }',
    },
    stubs: {
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js': { doc() {}, getDocFromServer() {}, onSnapshot() {}, setDoc() {} },
      'db.js': { db: {} }, 'auth.js': { currentUid: () => 'user' }, 'state.js': { state: {} },
      'ui/memory-settings-view.js': { fillMemory() {}, readMemory() {}, memoryDirty() {}, initMemorySettings() {}, chooseMemoryStart() {} },
      'sessions.js': { getSession() {}, updateSession() {} },
      'import-export.js': { importSillyTavern() {}, exportSillyTavern() {} },
      'ui/chat-view.js': { refreshContextIndicator() {} }, 'ui/pet-view.js': { loadPetCatalog() {} },
    },
    globals: { document: { getElementById: () => ({ dataset: { min: '0' }, closest: () => ({ firstChild: { textContent: 'Tokens' } }) }) } },
  });
  return { settings: await use('settings.js'), view: await use('ui/settings-view.js') };
}

test('Reasoning budget must leave response room without changing the context validation', async () => {
  const { settings, view } = await settingsHarness();
  assert.equal(settings.DEFAULT_SETTINGS.reasoning.maxTokens, 4096);
  const draft = structuredClone(settings.DEFAULT_SETTINGS);
  draft.profiles = [{ id: 'default', endpoint: draft.endpoint, maxResponseTokens: 8192,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 9000 } }];
  draft.activeProfileId = 'default';
  assert.throws(() => view.validateForTest(draft), /Reasoning max tokens must be lower than Max response tokens/);
  draft.profiles[0].reasoning.maxTokens = 8192;
  assert.throws(() => view.validateForTest(draft), /Reasoning max tokens must be lower/);
  draft.profiles[0].reasoning.maxTokens = 4096;
  assert.equal(view.validateForTest(draft).reasoning.maxTokens, 4096);
  draft.profiles[0].reasoning.mode = 'effort';
  draft.profiles[0].reasoning.maxTokens = 20000;
  assert.equal(view.validateForTest(draft).reasoning.maxTokens, 20000);
  draft.maxContextTokens = 8192;
  assert.throws(() => view.validateForTest(draft), /Max context tokens must exceed max response tokens/);
  const legacy = await settings.mergeDefaults({ reasoning: { maxTokens: 20000 } });
  assert.equal(legacy.reasoning.maxTokens, 20000);
});
