// Loaded only when short memory is enabled. A short, per-story working note is
// updated after a completed assistant turn, using only visible chat content.
import { chatCompletion } from "./llm-client.js";
import { countTokens } from "./tokenizer.js";
import { updateSession } from "./sessions.js";

const MEMORY_LIMIT = 1200;
const MEMORY_PROMPT =
  "Maintain a short memory for an ongoing roleplay story. Record only the current " +
  "scene, immediate goals, character relationships or emotional state that matter now, " +
  "and unresolved near-term beats. Keep established facts accurate. Do not retell the " +
  "whole story, invent facts, include hidden reasoning, or include a preamble. " +
  "Keep the result under 1200 tokens.";

async function fitMemory(text) {
  let value = text.trim();
  if (await countTokens(value) <= MEMORY_LIMIT) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (await countTokens(value.slice(0, mid)) <= MEMORY_LIMIT) low = mid;
    else high = mid - 1;
  }
  value = value.slice(0, low);
  const boundary = Math.max(value.lastIndexOf("\n"), value.lastIndexOf(". "));
  return (boundary > value.length * 0.7 ? value.slice(0, boundary + 1) : value).trim();
}

export async function refreshShortMemory(session, settings, messages, opts = {}) {
  if (settings.shortMemoryEnabled !== true) return null;
  const raw = messages.filter((m) => m.role === "user" || m.role === "assistant")
    .sort((a, b) => a.order - b.order);
  const latest = raw.at(-1);
  if (!latest || latest.role !== "assistant") return null;
  // Regenerating an older reply must not replace memory of later turns.
  if (opts.overwriteOrder && opts.overwriteOrder !== latest.order) return null;
  const reset = !!opts.overwriteOrder;
  const delta = reset || !session.shortMemory
    ? raw.slice(-8)
    : raw.filter((m) => m.order > (session.shortMemoryThroughOrder ?? 0)).slice(-8);
  if (!delta.length) return null;
  const input = [
    reset ? "Rebuild the memory from the recent transcript." : "Update the memory with these new turns.",
    !reset && session.shortMemory ? `Previous short memory:\n${session.shortMemory}` : "",
    reset && session.longTermPlan ? `Current story plan:\n${session.longTermPlan}` : "",
    "Recent transcript:\n" + delta.map((m) => `${m.role}: ${m.content.slice(-12000)}`).join("\n\n"),
  ].filter(Boolean).join("\n\n");
  const result = await chatCompletion({
    settings: { ...settings, streaming: false, maxResponseTokens: MEMORY_LIMIT,
      reasoning: { ...settings.reasoning, enabled: false } },
    messages: [{ role: "system", content: MEMORY_PROMPT }, { role: "user", content: input }],
  });
  if (!result.content?.trim()) throw new Error("Short memory update returned no text.");
  const shortMemory = await fitMemory(result.content);
  await updateSession(session.id, { shortMemory, shortMemoryThroughOrder: latest.order });
  return { shortMemory, shortMemoryThroughOrder: latest.order };
}
