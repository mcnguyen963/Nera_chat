import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appHarness } from './app-harness.mjs';

async function settingsHarness() {
  const viewSource = await readFile(new URL('../js/ui/settings-view.js', import.meta.url), 'utf8');
  const settingsSource = await readFile(new URL('../js/settings.js', import.meta.url), 'utf8');
  const use = appHarness({
    sources: {
      'settings.js': settingsSource,
      'ui/settings-view.js': viewSource + '\nexport function validateForTest(value) { draft = value; return validatedDraft(); }',
    },
    stubs: {
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js': { doc() {}, getDocFromServer() {}, onSnapshot() {}, setDoc() {}, increment() {}, runTransaction() {}, serverTimestamp() {} },
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

test('Reasoning budget leaves response room while the input limit stays independent', async () => {
  const { settings, view } = await settingsHarness();
  assert.equal(settings.DEFAULT_SETTINGS.reasoning.maxTokens, 4096);
  const draft = structuredClone(settings.DEFAULT_SETTINGS);
  draft.profiles = [{ id: 'default', endpoint: draft.endpoint, maxResponseTokens: 8192,
    reasoning: { enabled: true, mode: 'max_tokens', maxTokens: 9000 } }];
  draft.activeProfileId = 'default';
  assert.equal(view.validateForTest(draft).reasoning.maxTokens,8191);
  draft.profiles[0].reasoning.maxTokens = 8192;
  assert.equal(view.validateForTest(draft).reasoning.maxTokens,8191);
  draft.profiles[0].reasoning.maxTokens = 4096;
  assert.equal(view.validateForTest(draft).reasoning.maxTokens, 4096);
  draft.profiles[0].reasoning.mode = 'effort';
  draft.profiles[0].reasoning.maxTokens = 20000;
  assert.equal(view.validateForTest(draft).reasoning.maxTokens,8191);
  draft.maxContextTokens = 8192;
  assert.equal(view.validateForTest(draft).maxContextTokens,8192);
  const legacy = await settings.mergeDefaults({ reasoning: { maxTokens: 20000 } });
  assert.equal(legacy.reasoning.maxTokens, 20000);
});


test('B17 validates inactive profile input capacity before saving',async()=>{
  const {settings,view}=await settingsHarness(),draft=structuredClone(settings.DEFAULT_SETTINGS);
  draft.modelContextTokens=10000;
  draft.profiles=[{id:'active',name:'Active',endpoint:draft.endpoint,maxResponseTokens:1000,reasoning:{enabled:false,mode:'effort',maxTokens:4096}},{id:'inactive',name:'Inactive',endpoint:draft.endpoint,maxResponseTokens:10000,reasoning:{enabled:false,mode:'effort',maxTokens:4096}}];
  draft.activeProfileId='active';
  assert.throws(()=>view.validateForTest(draft),/Profile "Inactive".*no room for input/);
});

test('B17 blank reasoning budgets are numeric defaults in disabled and effort profiles',async()=>{
  const {settings,view}=await settingsHarness(),draft=structuredClone(settings.DEFAULT_SETTINGS);
  draft.profiles=[{id:'active',endpoint:draft.endpoint,maxResponseTokens:8192,reasoning:{enabled:false,mode:'effort',maxTokens:''}},{id:'other',endpoint:draft.endpoint,maxResponseTokens:2000,reasoning:{enabled:true,mode:'effort',maxTokens:''}}];draft.activeProfileId='active';
  const saved=view.validateForTest(draft);
  assert.equal(saved.profiles[0].reasoning.maxTokens,4096);
  assert.equal(saved.profiles[1].reasoning.maxTokens,1999);
  assert.equal(saved.reasoning.maxTokens,4096);
});
