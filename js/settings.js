import { prompts } from './system-prompts.js';
import { DEFAULT_MEMORY_EXTRACTION_PROMPT, DEFAULT_MEMORY_REORGANIZE_PROMPT } from './memory-prompts.js';
import {
  doc,
  getDocFromServer,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { state } from "./state.js";

export const PROMPT_KEYS = ['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt'];
const legacyHashes = new Map(PROMPT_KEYS.map(k => [k,new Set()]));
for (const line of prompts.legacyPromptHashes.split('\n')) { const [key,hash]=line.trim().split(/\s+/);legacyHashes.get(key)?.add(hash); }
export function storedSettings(settings) {
  const out=structuredClone(settings);
  for (const key of PROMPT_KEYS) if (out[key]===DEFAULT_SETTINGS[key]) delete out[key];
  return out;
}
const localKey=() => 'nera.settings.local.'+currentUid();
export function withLocal(settings) {
  const out=structuredClone(settings);let local;
  try {local=JSON.parse(localStorage.getItem(localKey()) ?? '{}');} catch {local={};}
  if (out.profiles?.some(p => p.id===local.profileId)) {out.activeProfileId=local.profileId;mirrorFromActiveProfile(out);}
  if (local.reasoning) {out.reasoning={...out.reasoning,...local.reasoning};mirrorToActiveProfile(out);}
  return out;
}

export const DEFAULT_SETTINGS = {
  memoryExtractionPrompt: DEFAULT_MEMORY_EXTRACTION_PROMPT,
  memoryReorganizePrompt: DEFAULT_MEMORY_REORGANIZE_PROMPT,
  petCharacterIds: [],
  petMovement: "roam",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  modelId: "",
  streaming: true,
  rewriteRecentMessages: 10, rewriteSystemPrompt: null, streamVibrationMode: "spaces",
  maxResponseTokens: 8192,
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
  maxContextTokens: 120000,
  modelContextTokens: null,
  autoSummarizationEnabled: false,
  autoSummaryThresholdPercent: 70,
  keepRecentMessagesAfterSummary: 10,
  summarizerMaxTokens: 20000,
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
  for (const key of PROMPT_KEYS) {
    const saved=data?.[key];
    if (typeof saved!=='string' || saved===DEFAULT_SETTINGS[key]) {merged[key]=DEFAULT_SETTINGS[key];continue;}
    const variants=new Set([saved,saved.replace(/\r\n/g,'\n').replace(/\n$/,'').trimEnd()]);
    for(const value of variants){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
      const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(legacyHashes.get(key)?.has(hash)){merged[key]=DEFAULT_SETTINGS[key];break;}
    }
  }
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
  "streaming",
  "maxResponseTokens",
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
  for (const k of PROFILE_CONNECTION_KEYS) p[k] = settings[k];
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
function userSettingsRef() {
  return doc(db, "users", currentUid(), "settings", "current");
}

const cacheKey = () => `roleplay-settings:${currentUid()}`;

function readCachedSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey()));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheSettings(settings) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(settings));
  } catch {
    // Private browsing or a full storage quota must not prevent using settings.
  }
}

export async function loadSettings({ requireServer = false } = {}) {
  const cached = readCachedSettings();
  const ref = userSettingsRef();
  let snap;
  try {
    snap = await getDocFromServer(ref);
  } catch (error) {
    state.settingsSource=cached ? 'cache' : 'defaults';
    if (cached && !requireServer) return withLocal(hydrateProfiles(await mergeDefaults(cached)));
    throw error;
  }
  if (requireServer && !snap.exists()) throw new Error('Settings did not load from the server; reload before saving.');
  state.settingsSource='server';
  if (snap.exists()) {
    const settings = hydrateProfiles(await mergeDefaults(snap.data()));
    cacheSettings(settings);
    return withLocal(settings);
  }

  // New accounts start with their own clean settings. Shared legacy settings
  // may contain credentials and must never be copied into a new account.
  const seed = structuredClone(DEFAULT_SETTINGS);
  hydrateProfiles(seed);
  await setDoc(ref, storedSettings(seed));
  cacheSettings(seed);
  return withLocal(seed);
}

// Keep an open device current when settings are saved on another device.
// Ignore local Firestore snapshots so stale/offline data cannot replace a
// newer server value loaded at startup.
export function watchSettings() {
  let update = 0;
  return onSnapshot(userSettingsRef(), async (snap) => {
    if (!snap.exists() || snap.metadata.fromCache || snap.metadata.hasPendingWrites || state.settingsSaving) return;
    const sequence = ++update;
    try {
      const settings = withLocal(hydrateProfiles(await mergeDefaults(snap.data())));
      state.settingsSource='server';
      if (sequence !== update || state.settingsSaving || JSON.stringify(settings) === JSON.stringify(state.settings)) return;
      state.settings = settings;
      cacheSettings(settings);
      document.dispatchEvent(new CustomEvent("settings-changed"));
    } catch (error) {
      console.error("Failed to sync settings:", error);
    }
  }, (error) => console.error("Failed to sync settings:", error));
}

// Quick controls are device-local. Only an explicit Settings save writes Firestore.
export function useLocalSettings(settings) {
  const snapshot = structuredClone(settings);
  normalizeProfiles(snapshot);
  mirrorToActiveProfile(snapshot);
  try {localStorage.setItem(localKey(),JSON.stringify({profileId:snapshot.activeProfileId,reasoning:snapshot.reasoning}));} catch {}
  state.settings = snapshot;
  cacheSettings(snapshot);
  document.dispatchEvent(new CustomEvent("settings-changed"));
}

export async function saveSettings(settings) {
  if (state.settingsSaving) throw new Error("A settings save is already in progress. Please try again.");
  state.settingsSaving = true;
  try {
    if (state.settingsSource!=='server') {
      let recovered;
      try { recovered=await loadSettings({requireServer:true}); }
      catch { throw new Error('Settings did not load from the server; reload before saving.'); }
      state.settings=recovered;
      document.dispatchEvent(new CustomEvent('settings-changed'));
      throw Object.assign(new Error('Your saved settings were loaded from the server. Review them and save again.'),{code:'settings-reloaded'});
    }
    const snapshot = structuredClone(settings);
    normalizeProfiles(snapshot);
    mirrorToActiveProfile(snapshot);
    await setDoc(userSettingsRef(), storedSettings(snapshot));
    try {localStorage.removeItem(localKey());} catch {}
    state.settings = snapshot;
    cacheSettings(snapshot);
    document.dispatchEvent(new CustomEvent("settings-changed"));
  } finally {
    state.settingsSaving = false;
  }
}
