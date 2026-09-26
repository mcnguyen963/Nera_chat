// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// all live inside maxContextTokens; maxResponseTokens is reserved on top.
//
// Firestore optimization: both functions accept a pre-fetched `messages` array (the
// chat view already holds one from its snapshot listener), so normal chat turns and
// the context indicator perform ZERO extra Firestore reads.

import { getMessages } from "./messages.js";
import { countTokens } from "./tokenizer.js";
import { planInjectionBlock } from "./plan-parser.js";

// The narrator prompt + plan block rarely change between turns; cache its token count
// to avoid re-running the tokenizer on every send/indicator refresh.
const systemTokenCache = new Map();

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
  const all = opts.messages ?? (await getMessages(session.id));
  const upToOrder = opts.upToOrder ?? Infinity; // regenerate: only messages before this order

  const systemText =
    (settings.narratorSystemPrompt || "") + "\n\n" + planInjectionBlock(session.longTermPlan);
  const systemTokens = await countSystemTokensCached(systemText);

  const parts = [{ role: "system", content: systemText }];
  let used = systemTokens;

  const summaryMsg = session.activeSummaryMessageId
    ? all.find((m) => m.id === session.activeSummaryMessageId)
    : null;
  if (summaryMsg) {
    parts.push({ role: "system", content: "Story so far:\n" + summaryMsg.content });
    used += summaryMsg.tokenCount ?? 0;
  }

  let budget = settings.maxContextTokens - settings.maxResponseTokens - used;
  if (budget < 0) budget = 0;

  const candidates = all
    .filter(
      (m) =>
        m.role !== "summary" &&
        m.order > (session.breakpointOrder ?? 0) &&
        m.order < upToOrder
    )
    .sort((a, b) => b.order - a.order); // newest first

  const windowed = [];
  for (const m of candidates) {
    const cost = m.tokenCount ?? 0;
    if (budget - cost < 0) break; // stop BEFORE exceeding — whole-message boundary only
    budget -= cost;
    used += cost;
    windowed.unshift(m); // restore chronological order
  }

  for (const m of windowed) {
    parts.push({ role: m.role, content: m.content });
  }

  return {
    apiMessages: parts,
    usedTokens: used,
    windowedCount: windowed.length,
    droppedCount: candidates.length - windowed.length,
  };
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeContextUsage(session, settings, messages = null) {
  const { usedTokens, droppedCount } = await buildContextForRequest(session, settings, { messages });
  const max = settings.maxContextTokens;
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { usedTokens, max, threshold, overThreshold: usedTokens >= threshold, droppedCount };
}
