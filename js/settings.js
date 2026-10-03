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

const legacyNarratorHashes = new Set(prompts.legacyNarratorHashes.split(/\s+/));

export const DEFAULT_SETTINGS = {
  memoryExtractionPrompt: DEFAULT_MEMORY_EXTRACTION_PROMPT,
  memoryReorganizePrompt: DEFAULT_MEMORY_REORGANIZE_PROMPT,
  petCharacterIds: [],
  petMovement: "roam",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  modelId: "",
  streaming: true,
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
    maxTokens: 20000,
  },
  maxContextTokens: 120000,
  autoSummarizationEnabled: false,
  autoSummaryThresholdPercent: 70,
  keepRecentMessagesAfterSummary: 10,
  summarizerMaxTokens: 100000,
  summarizerChunkTokens: 250000,
  narratorSystemPrompt: prompts.narrator,
  summarizerSystemPrompt: prompts.summarizer,
};

async function mergeDefaults(data) {
  const merged = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...data,
    reasoning: {
      ...structuredClone(DEFAULT_SETTINGS.reasoning),
      ...(data?.reasoning ?? {}),
    },
  };
  // Identify exact obsolete app defaults without keeping their conflicting text.
  // Custom prompts remain exactly as saved.
  if (typeof data?.narratorSystemPrompt === 'string' && data.narratorSystemPrompt !== DEFAULT_SETTINGS.narratorSystemPrompt) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.narratorSystemPrompt));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (legacyNarratorHashes.has(hash)) merged.narratorSystemPrompt = DEFAULT_SETTINGS.narratorSystemPrompt;
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

export async function loadSettings() {
  const cached = readCachedSettings();
  const ref = userSettingsRef();
  let snap;
  try {
    snap = await getDocFromServer(ref);
  } catch (error) {
    if (cached) return hydrateProfiles(await mergeDefaults(cached));
    throw error;
  }
  if (snap.exists()) {
    const settings = hydrateProfiles(await mergeDefaults(snap.data()));
    cacheSettings(settings);
    return settings;
  }

  // New accounts start with their own clean settings. Shared legacy settings
  // may contain credentials and must never be copied into a new account.
  const seed = structuredClone(DEFAULT_SETTINGS);
  hydrateProfiles(seed);
  await setDoc(ref, seed);
  cacheSettings(seed);
  return seed;
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
      const settings = hydrateProfiles(await mergeDefaults(snap.data()));
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
  state.settings = snapshot;
  cacheSettings(snapshot);
  document.dispatchEvent(new CustomEvent("settings-changed"));
}

export async function saveSettings(settings) {
  if (state.settingsSaving) throw new Error("A settings save is already in progress. Please try again.");
  const snapshot = structuredClone(settings);
  normalizeProfiles(snapshot);
  mirrorToActiveProfile(snapshot);
  state.settingsSaving = true;
  try {
    await setDoc(userSettingsRef(), snapshot);
    state.settings = snapshot;
    cacheSettings(snapshot);
    document.dispatchEvent(new CustomEvent("settings-changed"));
  } finally {
    state.settingsSaving = false;
  }
}
