import {setTokenCountingMode} from './tokenizer.js';
import {getPref,setPref} from './local-pref.js';
import { preserveLegacyStorySeed } from './story-settings-store.js';
import { prompts } from './system-prompts.js';
import { DEFAULT_MEMORY_EXTRACTION_PROMPT, DEFAULT_MEMORY_REORGANIZE_PROMPT } from './memory-prompts.js';
import {
  doc,
  getDocFromServer,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import * as auth from "./auth.js";
const currentUid=auth.currentUid;
import { state } from "./state.js";

export const PROMPT_KEYS = ['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt'];
const legacyHashes = new Map(PROMPT_KEYS.map(k => [k,new Set()]));
for (const line of prompts.legacyPromptHashes.split('\n')) { const [key,hash]=line.trim().split(/\s+/);legacyHashes.get(key)?.add(hash); }
export function storedSettings(settings) {
  const out=structuredClone(settings);
  for (const key of PROMPT_KEYS) if (out[key]===DEFAULT_SETTINGS[key]) delete out[key];
  delete out.streamVibrationMode;
  delete out.providerCooldownAccount;
  return out;
}
const localKey=owner => 'nera.settings.local.'+owner;
export function withLocal(settings,owner=currentUid()) {
  const out=structuredClone(settings);out.providerCooldownAccount=owner;out.streamVibrationMode=getPref('nera.streamVibrationMode','spaces');
  return out;
}

export const DEFAULT_SETTINGS = {
  memoryExtractionPrompt: DEFAULT_MEMORY_EXTRACTION_PROMPT,
  memoryReorganizePrompt: DEFAULT_MEMORY_REORGANIZE_PROMPT,
  petCharacterIds: ["luna-spritesheet.png"],
  petMovement: "roam",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  modelId: "",
  providerOrder: [],
  streaming: true,
  rewriteRecentMessages: 10, rewriteSystemPrompt: null, streamVibrationMode: "spaces",
  maxResponseTokens: 8192,
  maxOutputPrice: null,
  advancedParametersEnabled: false,
  temperature: null,
  topP: null,
  frequencyPenalty: null,
  presencePenalty: null,
  reasoning: {
    enabled: false,
    mode: "effort", // "effort" | "max_tokens" — mutually exclusive OpenRouter controls
    effort: "medium", // "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none"
    maxTokens: 4096,
  },
  tokenCountingMode: "estimate",
  maxContextTokens: 120000,
  modelContextTokens: null,
  autoSummarizationEnabled: false,
  autoSummaryThresholdPercent: 70,
  keepRecentMessagesAfterSummary: 10,
  summarizerMaxTokens: 50000,
  summarizerThinkingTokens: 20000,
  summarizerChunkTokens: 250000,
  narratorSystemPrompt: prompts.narrator,
  summarizerSystemPrompt: prompts.summarizer,
};

export async function mergeDefaults(data) {
  const merged = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...data,
    reasoning: {
      ...structuredClone(DEFAULT_SETTINGS.reasoning),
      ...(data?.reasoning ?? {}),
    },
  };
  // Older saved total limits stay intact; leave room for visible text when
  // introducing the separate thinking budget to those settings.
  if (data?.summarizerThinkingTokens == null) merged.summarizerThinkingTokens = Math.min(20000, Math.floor(merged.summarizerMaxTokens * 0.4));
  for (const key of PROMPT_KEYS) {
    const saved=data?.[key];
    if (typeof saved!=='string' || saved===DEFAULT_SETTINGS[key]) {merged[key]=DEFAULT_SETTINGS[key];continue;}
    // Management defaults are adopted explicitly through reset/edit controls.
    if (key==='memoryExtractionPrompt' || key==='memoryReorganizePrompt') continue;
    const variants=new Set([saved,saved.replace(/\r\n/g,'\n').replace(/\n$/,'').trimEnd()]);
    for(const value of variants){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
      const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(legacyHashes.get(key)?.has(hash)){merged[key]=DEFAULT_SETTINGS[key];break;}
    }
  }
  merged.tokenCountingMode=merged.tokenCountingMode==='accurate' ? 'accurate' : 'estimate';
  return merged;
}

// ---------- connection profiles ----------
// A profile is a named, swappable LLM connection (endpoint, key, model, response
// caps, reasoning). The flat top-level connection fields on settings always
// mirror the ACTIVE profile, so chat code can keep reading settings.endpoint etc.
// Context/summarization settings and prompts stay global (not per-profile).

const PROFILE_CONNECTION_KEYS = [
  "endpoint",
  "apiKey",
  "modelId",
  "providerOrder",
  "streaming",
  "maxResponseTokens",
  "maxOutputPrice",
  "advancedParametersEnabled",
  "temperature",
  "topP",
  "frequencyPenalty",
  "presencePenalty",
];

export function activeProfile(settings) {
  return settings.profiles?.find((p) => p.id === settings.activeProfileId) ?? null;
}

// Copy the flat connection fields into the active profile.
export function mirrorToActiveProfile(settings) {
  const p = activeProfile(settings);
  if (!p) return;
  for (const k of PROFILE_CONNECTION_KEYS) p[k] = k === "providerOrder" ? structuredClone(settings.providerOrder ?? []) : settings[k];
  p.reasoning = structuredClone(settings.reasoning ?? DEFAULT_SETTINGS.reasoning);
}

// Copy the active profile's connection fields into the flat fields.
export function mirrorFromActiveProfile(settings) {
  const p = activeProfile(settings);
  if (!p) return;
  for (const k of PROFILE_CONNECTION_KEYS) {
    settings[k] = k === "advancedParametersEnabled" && p[k] === undefined
      ? ["temperature", "topP", "frequencyPenalty", "presencePenalty"].some((name) => p[name] !== null && p[name] !== undefined && p[name] !== "")
      : p[k] ?? DEFAULT_SETTINGS[k];
  }
  settings.providerOrder = structuredClone(p.providerOrder ?? []);
  settings.reasoning = {
    ...structuredClone(DEFAULT_SETTINGS.reasoning),
    ...(p.reasoning ?? {}),
  };
}

// Structural validation only: guarantee a profiles array exists and
// activeProfileId points at a real profile. Never mirrors field values —
// callers do that explicitly (mirrorToActiveProfile / mirrorFromActiveProfile),
// otherwise UI edits get silently overwritten by stale profile data.
export function normalizeProfiles(settings) {
  if (!Array.isArray(settings.profiles) || settings.profiles.length === 0) {
    settings.profiles = [{ id: "default", name: "Default" }];
  }
  if (!settings.profiles.some((p) => p.id === settings.activeProfileId)) {
    settings.activeProfileId = settings.profiles[0].id;
  }
  return settings;
}

// Load-time hydration: if the active profile has stored connection data, it
// wins (loaded into the flat fields); otherwise (legacy settings) the flat
// fields seed the profile.
export function hydrateProfiles(settings) {
  normalizeProfiles(settings);
  const p = activeProfile(settings);
  const stored = p.endpoint !== undefined || p.modelId !== undefined || p.apiKey !== undefined;
  if (stored) {
    mirrorFromActiveProfile(settings);
  } else {
    mirrorToActiveProfile(settings);
  }
  for(const profile of settings.profiles)if(!['minimal','low','medium','high','xhigh','max','none'].includes(profile.reasoning?.effort)){profile.reasoning={...DEFAULT_SETTINGS.reasoning,...profile.reasoning,effort:'medium'};}
  if(!['minimal','low','medium','high','xhigh','max','none'].includes(settings.reasoning?.effort))settings.reasoning={...DEFAULT_SETTINGS.reasoning,...settings.reasoning,effort:'medium'};
  return settings;
}

// Per-account settings: each signed-in user has their own doc at
// users/{uid}/settings/current — covered by the per-user Firestore rules,
// so no account can read another account's API key or config.
function userSettingsRef(owner=currentUid()) {
  return doc(db, "users", owner, "settings", "current");
}

const cacheKey = owner => `roleplay-settings:${owner}`;

function readCachedSettings(owner) {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey(owner)));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheSettings(settings,owner) {
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(settings));
  } catch {
    // Private browsing or a full storage quota must not prevent using settings.
  }
}

let settingsEpoch=0;
const accountEpoch=()=>auth.accountEpoch?.() ?? 0;
function settingsScope() {
  const owner=currentUid(),epoch=accountEpoch(),run=++settingsEpoch;
  const current=()=>{try{return owner===currentUid() && epoch===accountEpoch();}catch{return false;}};
  return {owner,current,check(){if(!current() || run!==settingsEpoch)throw new Error('Settings changed while loading or saving. Try again.');}};
}
export async function readSettingsRefresh() {
  const scope=settingsScope(),{owner}=scope;
  const snap=await getDocFromServer(userSettingsRef(owner));scope.check();
  if(!snap.exists())throw new Error('Settings did not load from the server.');
  const settings=withLocal(hydrateProfiles(await mergeDefaults(snap.data())),owner);scope.check();
  return {settings,check:scope.check,apply(){this.check();++settingsEpoch;state.settings=settings;setTokenCountingMode(settings.tokenCountingMode);state.settingsSource='server';cacheSettings(settings,owner);}};
}
function activateTokenCounting(settings) {setTokenCountingMode(settings.tokenCountingMode);return settings;}
export async function loadSettings({ requireServer = false } = {}) {
  return loadScopedSettings(settingsScope(),{requireServer});
}
async function loadScopedSettings(scope,{requireServer=false}={}) {
  const {owner}=scope,cached = readCachedSettings(owner);
  const ref = userSettingsRef(owner);
  let snap;
  try {
    snap = await getDocFromServer(ref);
  } catch (error) {
    scope.check();
    if (cached && !requireServer) {
      const settings=withLocal(hydrateProfiles(await mergeDefaults(cached)),owner);scope.check();
      state.settingsSource='cache';return activateTokenCounting(settings);
    }
    state.settingsSource=cached ? 'cache' : 'defaults';
    throw error;
  }
  scope.check();
  if (requireServer && !snap.exists()) throw new Error('Settings did not load from the server; reload before saving.');
  if (snap.exists()) {
    const settings = hydrateProfiles(await mergeDefaults(snap.data()));scope.check();
    await preserveLegacyStorySeed(settings,{owner,check:scope.check});scope.check();
    cacheSettings(settings,owner);state.settingsSource='server';
    return activateTokenCounting(withLocal(settings,owner));
  }

  // New accounts start with their own clean settings. Shared legacy settings
  // may contain credentials and must never be copied into a new account.
  const seed = structuredClone(DEFAULT_SETTINGS);
  hydrateProfiles(seed);
  await setDoc(ref, storedSettings(seed));scope.check();
  await preserveLegacyStorySeed(seed,{owner,check:scope.check});scope.check();
  cacheSettings(seed,owner);state.settingsSource='server';
  return activateTokenCounting(withLocal(seed,owner));
}

// Keep an open device current when settings are saved on another device.
// Ignore local Firestore snapshots so stale/offline data cannot replace a
// newer server value loaded at startup.
export function watchSettings() {
  const owner=currentUid(),epoch=accountEpoch();let update = 0;
  const current=()=>{try{return owner===currentUid() && epoch===accountEpoch();}catch{return false;}};
  return onSnapshot(userSettingsRef(owner), async (snap) => {
    if (!current() || !snap.exists() || snap.metadata.fromCache || snap.metadata.hasPendingWrites || state.settingsSaving) return;
    const sequence = ++update,run=settingsEpoch;
    try {
      const settings = withLocal(hydrateProfiles(await mergeDefaults(snap.data())),owner);
      if (!current() || run!==settingsEpoch || sequence !== update || state.settingsSaving || JSON.stringify(settings) === JSON.stringify(state.settings)) return;
      state.settingsSource='server';state.settings = settings;setTokenCountingMode(settings.tokenCountingMode);
      cacheSettings(settings,owner);
      document.dispatchEvent(new CustomEvent("settings-changed"));
    } catch (error) {
      console.error("Failed to sync settings:", error);
    }
  }, (error) => console.error("Failed to sync settings:", error));
}

let activeSave=null;
export async function saveSettings(settings) {
  if (state.settingsSaving && (!activeSave || activeSave.current())) throw new Error("A settings save is already in progress. Please try again.");
  const scope=settingsScope(),{owner}=scope;activeSave=scope;
  state.settingsSaving = true;
  try {
    if (state.settingsSource!=='server') {
      let recovered;
      try { recovered=await loadScopedSettings(scope,{requireServer:true}); }
      catch { scope.check();throw new Error('Settings did not load from the server; reload before saving.'); }
      scope.check();
      state.settings=recovered;
      document.dispatchEvent(new CustomEvent('settings-changed'));
      throw Object.assign(new Error('Your saved settings were loaded from the server. Review them and save again.'),{code:'settings-reloaded'});
    }
    const snapshot = structuredClone(settings);
    snapshot.providerCooldownAccount=owner;
    normalizeProfiles(snapshot);
    mirrorToActiveProfile(snapshot);
    await setDoc(userSettingsRef(owner), storedSettings(snapshot));scope.check();
    setPref('nera.streamVibrationMode',snapshot.streamVibrationMode);
    try {localStorage.removeItem(localKey(owner));} catch {}
    setTokenCountingMode(snapshot.tokenCountingMode);
    ++settingsEpoch;state.settings = snapshot;
    cacheSettings(snapshot,owner);
    document.dispatchEvent(new CustomEvent("settings-changed"));
  } finally {
    if(activeSave===scope){activeSave=null;state.settingsSaving = false;}
  }
}
