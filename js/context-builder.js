// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// all live inside maxContextTokens; maxResponseTokens is reserved on top.
//
// Firestore optimization: both functions accept messages cached by the chat
// view, so repeated turns and indicator updates need no collection read.

import { getCheckpointMessages, getMessages } from "./messages.js";
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
  const upToOrder = opts.upToOrder ?? Infinity; // regenerate: only messages before this order
  const all = opts.messages ?? (upToOrder <= (session.breakpointOrder ?? 0)
    ? await getMessages(session.id)
    : await getCheckpointMessages(session));

  const systemText =
    (settings.narratorSystemPrompt || "") + "\n\n" + planInjectionBlock(session.longTermPlan);
  const systemTokens = await countSystemTokensCached(systemText);

  const parts = [{ role: "system", content: systemText }];
  let used = systemTokens;

  if (settings.shortMemoryEnabled === true && session.shortMemory?.trim() &&
      (session.shortMemoryThroughOrder ?? 0) < upToOrder) {
    const memoryText = "Current short memory (recent story state):\n" + session.shortMemory.trim();
    const memoryCost = await countSystemTokensCached(memoryText);
    if (memoryCost <= 1300 && used + memoryCost <= settings.maxContextTokens - settings.maxResponseTokens) {
      parts.push({ role: "system", content: memoryText });
      used += memoryCost;
    }
  }

  const summaryMsg = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upToOrder
    ? all.find((m) => m.id === session.activeSummaryMessageId)
    : null;
  if (summaryMsg) {
    parts.push({ role: "system", content: "Story so far:\n" + summaryMsg.content });
    used += await countSystemTokensCached("Story so far:\n" + summaryMsg.content);
  }

  const available = Math.max(0, settings.maxContextTokens - settings.maxResponseTokens - used);
  const eligibleCandidates = all
    .filter((m) => m.role !== "summary" &&
      m.order > (summaryMsg ? (session.breakpointOrder ?? 0) : 0) && m.order < upToOrder)
    .sort((a, b) => b.order - a.order);
  const latestCandidate = eligibleCandidates[0];
  const recallLimit = settings.chatRecallEnabled === true
    ? Math.min(settings.chatRecallBudgetTokens ?? 4000,
      opts.recallBudgetTokens ?? Infinity,
      Math.max(0, available - (latestCandidate?.tokenCount ?? 0))) : 0;
  const recalled = [];
  const recalledIds = new Set();
  let recallUsed = 0;
  if (settings.chatRecallEnabled === true && Array.isArray(opts.recalledMessages)) {
    for (const m of opts.recalledMessages) {
      if (m.order >= upToOrder || m.role === "summary" ||
          m.id === latestCandidate?.id || recalledIds.has(m.id)) continue;
      const content = `Earlier ${m.role} message (order ${m.order}):\n${m.content}`;
      const cost = await countTokens(content);
      if (recallUsed + cost > recallLimit) continue;
      recallUsed += cost;
      recalledIds.add(m.id);
      recalled.push({ role: "system", content, order: m.order });
    }
    recalled.sort((a, b) => a.order - b.order);
    parts.push(...recalled.map(({ role, content }) => ({ role, content })));
    used += recallUsed;
  }
  const reserved = recalled.length ? 0 : Math.min(opts.recallReserveTokens ?? 0, recallLimit);
  let budget = Math.max(0, available - recallUsed - reserved);

  const candidates = eligibleCandidates.filter((m) => !recalledIds.has(m.id));

  const windowed = [];
  for (const m of candidates) {
    const cost = m.tokenCount ?? 0;
    if (budget - cost < 0) break; // stop BEFORE exceeding — whole-message boundary only
    budget -= cost;
    used += cost;
    windowed.push(m);
  }

  for (let i = windowed.length - 1; i >= 0; i--) {
    const m = windowed[i];
    const content = m.role === "assistant" && m.planThread
      ? `${m.content}\n<plan_thread>${m.planThread}</plan_thread>`
      : m.content;
    parts.push({ role: m.role, content });
  }

  const includedMessageIds = new Set(windowed.map((m) => m.id));

  return {
    apiMessages: parts,
    usedTokens: used,
    windowedCount: windowed.length,
    droppedCount: candidates.length - windowed.length,
    includedMessageIds,
    availableRecallTokens: reserved || Math.min(recallLimit, budget),
  };
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeContextUsage(session, settings, messages = null) {
  const { usedTokens, droppedCount } = await buildContextForRequest(session, settings, { messages });
  const max = settings.maxContextTokens;
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { usedTokens, max, threshold, overThreshold: usedTokens >= threshold, droppedCount };
}
