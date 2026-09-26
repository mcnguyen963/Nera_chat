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
    effort: "medium", // "minimal" | "low" | "medium" | "high" | "xhigh" | "none"
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
    "if it has not changed, omit the tag. The plan tag is never shown to the user.",
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

// Per-account settings: each signed-in user has their own doc at
// users/{uid}/settings/current — covered by the per-user Firestore rules,
// so no account can read another account's API key or config.
function userSettingsRef() {
  return doc(db, "users", currentUid(), "settings", "current");
}

export async function loadSettings() {
  const ref = userSettingsRef();
  const snap = await getDoc(ref);
  if (snap.exists()) return mergeDefaults(snap.data());

  // One-time migration: seed this account's settings from the legacy shared
  // /settings/global doc (falling back to defaults). Everything is then
  // written to (and only ever read from) the per-user doc.
  let seed = structuredClone(DEFAULT_SETTINGS);
  try {
    const legacy = await getDoc(doc(db, "settings", "global"));
    if (legacy.exists()) seed = mergeDefaults(legacy.data());
  } catch (e) {
    console.warn("Could not read legacy /settings/global (using defaults):", e);
  }
  await setDoc(ref, seed);
  return seed;
}

export async function saveSettings(settings) {
  await setDoc(userSettingsRef(), settings);
}
