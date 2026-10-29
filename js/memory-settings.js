import { normalizeCalendar } from './story-calendar.js';
import { resolveModelProfile } from './model-profiles.js';
import { canonicalScene } from './scene.js';
export const memoryValidationRanges = {
  loreNotesPerSection: [0, Number.MAX_SAFE_INTEGER], loreLookbackMessages: [0, Number.MAX_SAFE_INTEGER], batchTurns: [2, 100], lagTurns: [0, 50], updateMaxTokens: [256, 32000],
  reorganizeMaxTokens: [256, 32000], blockDepth: [1, 20], budget: [0, 100000], maxCards: [1, 50],
};
export const DEFAULT_MEMORY = {
  v: 1, calendar: {mode:'legacy',anchor:null}, characterSelection: false, protagonist: '', scene: false, startingScene:null, sceneFallback:false, sceneFallbackModel:'', replyContract:'off', lorebooks: false, autoUpdate: false, memoryBlock: false, blockWindow: false, semanticLore:false, semanticEndpoint:'http://127.0.0.1:11434/v1/embeddings', semanticModel:'qwen3-embedding:0.6b',
  books: { characters: { on: true, budget: 4000, maxCards: 6 }, locations: { on: true, budget: 4000, maxCards: 2 }, facts: { on: true, budget: 1000 }, events: { on: true, budget: 3000 }, plan: { on: true, budget: 1500 } },
  loreNotesPerSection: 3, loreLookbackMessages: 4, batchTurns: 10, lagTurns: 4, updateProfileId:'', updateMaxTokens: 2000, reorganizeMaxTokens: 4000, blockDepth: 3, blockRole: 'user',
};
export const DEFAULT_MEMORY_STATE = { extractedThroughOrder: null, lastUpdateAt: null, lastUpdateTurns: null, failureStreak: 0, paused: false, lastError: null };
export function normalizeMemory(raw) {
  const out = structuredClone(DEFAULT_MEMORY);
  if (!raw || typeof raw !== 'object') return out;
  out.calendar = normalizeCalendar(raw.calendar);
  out.protagonist = String(raw.protagonist ?? '').trim().slice(0, 60);
  for (const k of ['characterSelection', 'scene', 'sceneFallback', 'lorebooks', 'autoUpdate', 'memoryBlock', 'blockWindow','semanticLore']) out[k] = raw[k] === true;
  for (const k of ['semanticEndpoint','semanticModel']) if(typeof raw[k]==='string')out[k]=raw[k].trim().slice(0,500);
  out.startingScene = typeof raw.startingScene === 'string' ? canonicalScene(raw.startingScene) : null;
  if (!out.startingScene && (raw.startingScene || raw.startingSceneRaw)) out.startingSceneRaw=String(raw.startingScene || raw.startingSceneRaw);
  out.sceneFallbackModel = String(raw.sceneFallbackModel ?? '').trim().slice(0,200);
  out.updateProfileId = String(raw.updateProfileId ?? '').trim().slice(0,200);
  out.replyContract = ['system','user'].includes(raw.replyContract) ? raw.replyContract : 'off';
  const clamp = (k, value, fallback) => {
    const [min, max] = memoryValidationRanges[k];
    return Number.isFinite(Number(value)) && value != null && value !== '' ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
  };
  for (const k of ['loreNotesPerSection', 'loreLookbackMessages', 'batchTurns', 'lagTurns', 'updateMaxTokens', 'reorganizeMaxTokens', 'blockDepth']) out[k] = clamp(k, raw[k], out[k]);
  out.blockRole = raw.blockRole === 'system' ? 'system' : 'user';
  for (const [book, defaults] of Object.entries(out.books)) {
    const b = raw.books?.[book];
    if (!b) continue;
    defaults.on = b.on === undefined ? true : b.on === true;
    defaults.budget = clamp('budget', b.budget, defaults.budget);
    if ('maxCards' in defaults) defaults.maxCards = clamp('maxCards', b.maxCards, defaults.maxCards);
  }
  return out;
}
export function memoryActive(mem) { return !!(mem?.scene || mem?.lorebooks || mem?.memoryBlock || mem?.blockWindow); }
export function anyMemory(mem) { return memoryActive(mem) || mem?.autoUpdate === true; }

// Resolve a task-local connection without switching the narrator's active profile.
export function memoryTaskSettings(settings, mem, outputTokens = mem.updateMaxTokens) {
  const task=resolveModelProfile(settings,mem.updateProfileId,{role:'memory'});
  return { ...task,maxResponseTokens:outputTokens,reasoning:structuredClone(task.reasoning ?? {}) };
}
