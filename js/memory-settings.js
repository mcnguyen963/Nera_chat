import { inspectSceneOutput } from './scene.js';
export const memoryValidationRanges = {
  batchTurns: [2, 100], lagTurns: [0, 50], updateMaxTokens: [256, 32000],
  reorganizeMaxTokens: [256, 32000], blockDepth: [1, 20], budget: [0, 100000], maxCards: [1, 50],
};
export const DEFAULT_MEMORY = {
  v: 1, protagonist: '', scene: false, sceneMode:'tag', sceneExtractionModel:'', startingScene:null, sceneFallback:false, sceneFallbackModel:'', replyContract:'off', lorebooks: false, autoUpdate: false, memoryBlock: false, blockWindow: false,
  books: { characters: { on: true, budget: 4000, maxCards: 6 }, locations: { on: true, budget: 4000, maxCards: 2 }, facts: { on: true, budget: 1000 }, events: { on: true, budget: 3000 } },
  batchTurns: 10, lagTurns: 4, updateMaxTokens: 2000, reorganizeMaxTokens: 4000, blockDepth: 3, blockRole: 'system',
};
export const DEFAULT_MEMORY_STATE = { extractedThroughOrder: null, lastUpdateAt: null, lastUpdateTurns: null, failureStreak: 0, paused: false, lastError: null };
export function normalizeMemory(raw) {
  const out = structuredClone(DEFAULT_MEMORY);
  if (!raw || typeof raw !== 'object') return out;
  out.protagonist = String(raw.protagonist ?? '').trim().slice(0, 60);
  for (const k of ['scene', 'sceneFallback', 'lorebooks', 'autoUpdate', 'memoryBlock', 'blockWindow']) out[k] = raw[k] === true;
  out.startingScene = typeof raw.startingScene === 'string' ? inspectSceneOutput('<scene>'+raw.startingScene+'</scene>').scene : null;
  out.sceneFallbackModel = String(raw.sceneFallbackModel ?? '').trim().slice(0,200);
  out.sceneMode = raw.sceneMode === 'extract' ? 'extract' : 'tag';
  out.sceneExtractionModel = String(raw.sceneExtractionModel ?? '').trim().slice(0,200);
  out.replyContract = ['system','user'].includes(raw.replyContract) ? raw.replyContract : 'off';
  const clamp = (k, value, fallback) => {
    const [min, max] = memoryValidationRanges[k];
    return Number.isFinite(Number(value)) && value != null && value !== '' ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
  };
  for (const k of ['batchTurns', 'lagTurns', 'updateMaxTokens', 'reorganizeMaxTokens', 'blockDepth']) out[k] = clamp(k, raw[k], out[k]);
  out.blockRole = raw.blockRole === 'user' ? 'user' : 'system';
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
