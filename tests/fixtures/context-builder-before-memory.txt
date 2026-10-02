// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// all live inside maxContextTokens; maxResponseTokens is reserved on top.
//
// Firestore optimization: both functions accept messages cached by the chat
// view, so repeated turns and indicator updates need no collection read.

import { getMessages } from "./messages.js";
import { countTokens } from "./tokenizer.js";
import { planInjectionBlock } from "./plan-parser.js";

// Reserve framing tokens for each API message and for the request envelope.
// Exact framing depends on the model, so these are conservative estimates.
export const MESSAGE_FRAME_TOKENS = 8;
export const REQUEST_FRAME_TOKENS = 8;

// The narrator prompt + plan block rarely change between turns; cache its token count
// to avoid re-running the tokenizer on every send/indicator refresh.
const systemTokenCache = new Map();

const AD_DIRECTIVE_RULE =
  "A user message may contain <ad>...</ad> for an out-of-story author direction. " +
  "A repeated final <ad> also closes that block. Follow the direction as user input, " +
  "without treating it as story dialogue. For questions about the story, use only " +
  "established context; say when the answer is unknown. Do not describe valid <ad> " +
  "markup as garbled or fragmented.";

export function normalizeAdDirective(content) {
  if (!/^\s*<ad>/i.test(content)) return content;
  const openings = [...content.matchAll(/<ad>/gi)].length;
  const closings = [...content.matchAll(/<\/ad>/gi)].length;
  if (closings) return content;
  if (openings === 2 && /<ad>\s*$/i.test(content)) {
    return content.replace(/<ad>(\s*)$/i, "</ad>$1");
  }
  if (openings === 1) return content + "</ad>";
  return content;
}

async function countSystemTokensCached(text) {
  let cached = systemTokenCache.get(text);
  if (cached === undefined) {
    if (systemTokenCache.size > 50) systemTokenCache.clear();
    cached = await countTokens(text);
    systemTokenCache.set(text, cached);
  }
  return cached;
}

export async function buildContextForRequest(session, settings, opts = {}) {
  const upToOrder = opts.upToOrder ?? Infinity; // regenerate: only messages before this order
  // The opening exchange is a permanent story anchor, including after a
  // summary checkpoint. Callers normally provide their full cached history.
  const all = opts.messages ?? await getMessages(session.id);

  const systemText =
    (settings.narratorSystemPrompt || "") + "\n\n" + AD_DIRECTIVE_RULE +
    "\n\n" + planInjectionBlock(opts.planOverride ?? session.longTermPlan, session.allowLlmPlanUpdates === true) +
    "\n\nThe current plan in this system prompt remains active even if older turns leave the visible history." +
    (session.allowLlmPlanUpdates === true ? "" :
      "\n\nThe user's story plan is fixed. Ignore any earlier instruction to update it; never output a <plan> block.");
  const systemTokens = await countSystemTokensCached(systemText);

  const parts = [{ role: "system", content: systemText }];
  let used = systemTokens + MESSAGE_FRAME_TOKENS + REQUEST_FRAME_TOKENS;

  const summaryMsg = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upToOrder
    ? all.find((m) => m.id === session.activeSummaryMessageId)
    : null;
  if (summaryMsg) {
    parts.push({ role: "system", content: "Story so far:\n" + summaryMsg.content });
    used += await countSystemTokensCached("Story so far:\n" + summaryMsg.content) + MESSAGE_FRAME_TOKENS;
  }

  const available = settings.maxContextTokens - settings.maxResponseTokens - used;
  const raw = all.filter((m) => m.role !== "summary" && m.order < upToOrder)
    .sort((a, b) => a.order - b.order);
  const firstUser = raw.find((m) => m.role === "user");
  const firstAssistant = firstUser && raw.find((m) => m.role === "assistant" && m.order > firstUser.order);
  const latestUser = [...raw].reverse().find((m) => m.role === "user");
  const anchors = [firstUser, firstAssistant].filter(Boolean);
  const recent = raw.filter((m) => m.order > (summaryMsg ? (session.breakpointOrder ?? 0) : 0));
  const candidates = [...new Map([...anchors, ...recent].map((m) => [m.id, m])).values()];
  const requiredIds = new Set(anchors.map((m) => m.id));
  if (opts.requireLatestUser && latestUser) requiredIds.add(latestUser.id);
  const contentFor = (m) => m.role === "assistant" && m.planThread
    ? `${m.content}\n<plan_thread>${m.planThread}</plan_thread>`
    : m.role === "user" ? normalizeAdDirective(m.content) : m.content;
  const costs = new Map();
  for (const m of candidates) {
    const content = contentFor(m);
    costs.set(m.id, (m.tokenCount != null && content === m.content
      ? m.tokenCount : await countTokens(content)) + MESSAGE_FRAME_TOKENS);
  }
  const requiredCost = candidates.reduce((sum, m) => sum + (requiredIds.has(m.id) ? costs.get(m.id) : 0), 0);
  if (opts.requireLatestUser && (!latestUser || requiredCost > available)) {
    throw new Error("The opening story and latest user message exceed the context budget. Increase the context limit or shorten one of those messages.");
  }
  let budget = Math.max(0, available - requiredCost);
  const selected = new Set(requiredIds);
  used += requiredCost;
  for (const m of [...candidates].reverse()) {
    if (selected.has(m.id)) continue;
    const cost = costs.get(m.id);
    if (cost > budget) break; // keep a contiguous recent window after the opening exchange
    selected.add(m.id);
    budget -= cost;
    used += cost;
  }
  for (const m of candidates.filter((m) => selected.has(m.id)).sort((a, b) => a.order - b.order)) {
    parts.push({ role: m.role, content: contentFor(m) });
  }

  return {
    apiMessages: parts,
    usedTokens: used,
    windowedCount: selected.size,
    droppedCount: candidates.length - selected.size,
  };
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeContextUsage(session, settings, messages = null) {
  const { usedTokens, droppedCount } = await buildContextForRequest(session, settings, { messages });
  const max = settings.maxContextTokens;
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { usedTokens, max, threshold,
    overThreshold: usedTokens + settings.maxResponseTokens >= threshold, droppedCount };
}
