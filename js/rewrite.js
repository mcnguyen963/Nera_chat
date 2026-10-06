import { storyText } from "./story-text.js";
import { countTokens } from "./tokenizer.js";
import { requestInputLimit } from "./request-budget.js";

let defaultPromptPromise;
export function loadRewriteDefaultPrompt() {
  if (!defaultPromptPromise) {
    defaultPromptPromise = (async () => {
      const response = await fetch("./rewrite_default_prompt.md", { cache: "no-cache" });
      if (!response.ok) throw new Error("Could not load the default rewrite prompt. Try again.");
      const prompt = (await response.text()).trim();
      if (!prompt) throw new Error("The default rewrite prompt is empty.");
      return prompt;
    })().catch((error) => { defaultPromptPromise = null; throw error; });
  }
  return defaultPromptPromise;
}

export async function buildRewriteMessages(settings, history, draft) {
  const n = settings.rewriteRecentMessages ?? 10;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Rewrite recent messages must be a nonnegative whole number.");
  const prompt = settings.rewriteSystemPrompt ?? await loadRewriteDefaultPrompt();
  if (!prompt.trim()) throw new Error("Set a rewrite system prompt in Settings first.");
  const recent = history.filter((m) => m.role === "user" || m.role === "assistant")
    .slice().sort((a, b) => a.order - b.order);
  const messages = [
    { role: "system", content: prompt },
    ...(n ? recent.slice(-n) : []).map(({ role, content }) => ({ role,
      content: role === "assistant" ? storyText(content) : content,
    })).filter((m) => m.role !== "assistant" || m.content.trim()),
    { role: "user", content: draft },
  ];
  const counts = await Promise.all(messages.map((m) => countTokens(m.content)));
  const tokens = 8 + counts.reduce((sum, count) => sum + count + 8, 0);
  if (tokens > requestInputLimit(settings)) {
    throw new Error("Rewrite input exceeds the context limit. Reduce recent messages in Settings or shorten your draft.");
  }
  return messages;
}
