import {
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";

export const DEFAULT_SETTINGS = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  modelId: "",
  streaming: true,
  maxResponseTokens: 1024,
  reasoning: {
    enabled: false,
    mode: "effort", // "effort" | "max_tokens" — mutually exclusive OpenRouter controls
    effort: "medium", // "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none"
    maxTokens: 20000,
  },
  maxContextTokens: 120000,
  autoSummaryThresholdPercent: 70,
  keepRecentMessagesAfterSummary: 10,
  narratorSystemPrompt:
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
    "reason to skip it. The plan_thread tag is never shown to the user.",
  summarizerSystemPrompt:
    "You maintain a running summary of a long roleplay story. You are given the previous " +
    "summary (if any) and a transcript of new events. Produce an updated summary that " +
    "preserves all characters, relationships, open plot threads, key decisions, and " +
    "established facts. Be concise but complete. Output only the summary text, no preamble.",
};

function mergeDefaults(data) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...data,
    reasoning: {
      ...structuredClone(DEFAULT_SETTINGS.reasoning),
      ...(data?.reasoning ?? {}),
    },
  };
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
    if (p[k] !== undefined) settings[k] = p[k];
  }
  if (p.reasoning) {
    settings.reasoning = {
      ...structuredClone(DEFAULT_SETTINGS.reasoning),
      ...p.reasoning,
    };
  }
}

// Guarantees: profiles array exists, activeProfileId points at a real profile,
// and legacy settings (no profiles stored yet) are seeded from their flat fields.
export function normalizeProfiles(settings) {
  if (!Array.isArray(settings.profiles) || settings.profiles.length === 0) {
    settings.profiles = [{ id: "default", name: "Default" }];
  }
  if (!settings.profiles.some((p) => p.id === settings.activeProfileId)) {
    settings.activeProfileId = settings.profiles[0].id;
  }
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

export async function loadSettings() {
  const ref = userSettingsRef();
  const snap = await getDoc(ref);
  if (snap.exists()) return normalizeProfiles(mergeDefaults(snap.data()));

  // One-time migration: seed this account's settings from the legacy shared
  // /settings/global doc (falling back to defaults). Everything is then
  // written to (and only ever read from) the per-user doc.
  let seed = structuredClone(DEFAULT_SETTINGS);
  try {
    const legacy = await getDoc(doc(db, "settings", "global"));
    if (legacy.exists()) seed = normalizeProfiles(mergeDefaults(legacy.data()));
  } catch (e) {
    console.warn("Could not read legacy /settings/global (using defaults):", e);
  }
  await setDoc(ref, seed);
  return seed;
}

export async function saveSettings(settings) {
  await setDoc(userSettingsRef(), settings);
}
