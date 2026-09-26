import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";

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
    maxTokens: 2000,
  },
  maxContextTokens: 8000,
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
    reasoning: { ...structuredClone(DEFAULT_SETTINGS.reasoning), ...(data?.reasoning ?? {}) },
  };
}

export async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "global"));
  if (!snap.exists()) {
    const initial = structuredClone(DEFAULT_SETTINGS);
    await setDoc(doc(db, "settings", "global"), initial);
    return initial;
  }
  return mergeDefaults(snap.data());
}

export async function saveSettings(settings) {
  await setDoc(doc(db, "settings", "global"), settings);
}
