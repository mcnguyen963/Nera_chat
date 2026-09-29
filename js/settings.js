import {
  doc,
  getDocFromServer,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { state } from "./state.js";
import { DEFAULT_NARRATOR_PROMPT, DEFAULT_SUMMARIZER_PROMPT } from "./default-prompts.js";

const LEGACY_DEFAULT_NARRATOR_PROMPT =
  "You are the narrator of an interactive, ongoing story. Drive the plot forward, " +
  "stay consistent with everything established so far, and write in vivid prose. " +
  "You maintain a long-term plan for the story that appears in your system prompt. " +
  "If the plan changes, include a new <plan>...</plan> block anywhere in your reply; " +
  "if it has not changed, omit the tag. The plan tag is never shown to the user. " +
  "PLAN THREAD — cheap, every turn: While a plan is active, include one short line in " +
  "your hidden output each turn, in the form <plan_thread>brief one-clause reminder of " +
  "the current target, e.g. \"steering toward: reconciliation scene between A and her " +
  "father\"</plan_thread>. This is not the full plan restated — a handful of tokens, not " +
  "a paragraph. Its only job is to make sure the plan is never more than one turn away " +
  "from appearing somewhere in your own hidden output, so it doesn't quietly vanish from " +
  "view over a long conversation. Writing this line is mandatory whenever a plan is " +
  "active, with no exceptions — it's cheap enough that \"it hasn't changed\" is never a " +
  "reason to skip it. The plan_thread tag is never shown to the user. If, at the start " +
  "of a turn, neither a <plan> block nor a <plan_thread> line appears anywhere in the " +
  "visible conversation history, even though a plan seems to have been set earlier, " +
  "treat that plan as lost from context. Its exact contents cannot be reconstructed; " +
  "proceed with no active plan until the user sets a new one.";
const LEGACY_DEFAULT_SUMMARIZER_PROMPT =
  "You maintain a running summary of a long roleplay story. You are given the previous " +
  "summary (if any) and a transcript of new events. Produce an updated summary that " +
  "preserves all characters, relationships, open plot threads, key decisions, and " +
  "established facts. Be concise but complete. Output only the summary text, no preamble.";

export const DEFAULT_SETTINGS = {
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
  chatRecallEnabled: false,
  chatRecallBudgetTokens: 4000,
  semanticSearchEnabled: false,
  embeddingEndpoint: "",
  embeddingApiKey: "",
  embeddingModelId: "",
  shortMemoryEnabled: false,
  petCharacterIds: [],
  autoSummaryThresholdPercent: 70,
  keepRecentMessagesAfterSummary: 10,
  summarizerMaxTokens: 100000,
  summarizerChunkTokens: 250000,
  narratorSystemPrompt: DEFAULT_NARRATOR_PROMPT,
  summarizerSystemPrompt: DEFAULT_SUMMARIZER_PROMPT,
};

function mergeDefaults(data) {
  const merged = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...data,
    reasoning: {
      ...structuredClone(DEFAULT_SETTINGS.reasoning),
      ...(data?.reasoning ?? {}),
    },
  };
  // Replace the former app defaults, while preserving prompts the user edited.
  if (data?.narratorSystemPrompt === LEGACY_DEFAULT_NARRATOR_PROMPT) {
    merged.narratorSystemPrompt = DEFAULT_SETTINGS.narratorSystemPrompt;
  }
  if (data?.summarizerSystemPrompt === LEGACY_DEFAULT_SUMMARIZER_PROMPT) {
    merged.summarizerSystemPrompt = DEFAULT_SETTINGS.summarizerSystemPrompt;
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
    if (cached) return hydrateProfiles(mergeDefaults(cached));
    throw error;
  }
  if (snap.exists()) {
    const settings = hydrateProfiles(mergeDefaults(snap.data()));
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
  return onSnapshot(userSettingsRef(), (snap) => {
    if (!snap.exists() || snap.metadata.fromCache || snap.metadata.hasPendingWrites || state.settingsSaving) return;
    const settings = hydrateProfiles(mergeDefaults(snap.data()));
    if (JSON.stringify(settings) === JSON.stringify(state.settings)) return;
    state.settings = settings;
    cacheSettings(settings);
    document.dispatchEvent(new CustomEvent("settings-changed"));
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
