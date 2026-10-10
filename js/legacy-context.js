import {createTokenCounter} from './token-cache.js';
// MAIN context builder frozen at fbcc95ad2498e24670d8daaf66f712e76f34dccf8787c5c3d00976ff13e03c64; golden fixtures verify wire parity. Prompt strings live in Markdown.
import {prompts,renderPrompt} from "./system-prompts.js";
const PLAN_THREAD_RECOVERY_RULE=" If, at the start of a turn, neither a <plan> block nor a <plan_thread> line appears anywhere in the visible conversation history, even though a plan seems to have been set earlier, treat that plan as lost from context. Its exact contents cannot be reconstructed; proceed with no active plan until the user sets a new one.";
// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// all live inside the input limit maxContextTokens. Output has its own limit.
//
// Firestore optimization: both functions accept messages cached by the chat
// view, so repeated turns and indicator updates need no collection read.

import { getMessages } from "./messages.js";
import * as tokenizer from "./tokenizer.js";
const countTokens=tokenizer.countTokens,tokenizerReady=() => tokenizer.tokenizerReady?.() !== false;


import { requestInputLimit } from "./request-budget.js";


// Reserve framing tokens for each API message and for the request envelope.
// Exact framing depends on the model, so these are conservative estimates.
export const MESSAGE_FRAME_TOKENS = 8;
export const REQUEST_FRAME_TOKENS = 8;

// The narrator prompt + plan block rarely change between turns; cache its token count
// to avoid re-running the tokenizer on every send/indicator refresh.
const countSystemTokensCached=createTokenCounter({count:countTokens,ready:tokenizerReady});

const AD_DIRECTIVE_RULE = prompts.legacyAuthorDirection;

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

// Input must be cleaned story messages in order, as used by both builders.
export function openingExchange(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  const firstAssistant = firstUser && messages.find((m) => m.role === "assistant" && m.order > firstUser.order);
  return [firstUser, firstAssistant].filter(Boolean);
}

export async function buildLegacyContext(session, settings, opts = {}) {
  const upToOrder = opts.upToOrder ?? Infinity; // regenerate: only messages before this order
  // The opening exchange is a permanent story anchor, including after a
  // summary checkpoint. Callers normally provide their full cached history.
  const all = opts.messages ?? await getMessages(session.id);

  const systemText = (settings.narratorSystemPrompt || "").replace(PLAN_THREAD_RECOVERY_RULE, "") + "\n\n" + AD_DIRECTIVE_RULE + "\n\n" + planInjectionBlock(opts.planOverride ?? session.longTermPlan) + "\n\n" + prompts.legacyPlanPresence + "\n\n" + prompts.legacyFixedPlan;
  const systemTokens = await countSystemTokensCached(systemText);

  const parts = [{ role: "system", content: systemText }];
  const entries = [{ role: "system", content: systemText, tokens: systemTokens, source: "System instructions & story plan" }];
  let used = systemTokens + MESSAGE_FRAME_TOKENS + REQUEST_FRAME_TOKENS;

  const summaryMsg = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upToOrder
    ? all.find((m) => m.id === session.activeSummaryMessageId)
    : null;
  const summaryText = summaryMsg && storyText(summaryMsg.content);
  let summaryEntry = null;
  if (summaryText) {
    const content = prompts.legacySummary+"\n"+summaryText;
    const tokens = await countSystemTokensCached(content);
    summaryEntry = { id: summaryMsg.id, role: "system", content, tokens, source: "Active story summary" };
    used += tokens + MESSAGE_FRAME_TOKENS;
  }

  const temporary=opts.continuationId ? prompts.continue : '';
  const temporaryTokens=temporary ? await countSystemTokensCached(temporary) : 0;
  if(temporary) used+=temporaryTokens+MESSAGE_FRAME_TOKENS;
  const available = requestInputLimit(settings) - used;
  const contentFor = (m) => m.role === "user" ? normalizeAdDirective(m.content) : storyText(m.content);
  const raw = all.filter((m) => ["user", "assistant"].includes(m.role) && m.order < upToOrder && contentFor(m).trim())
    .sort((a, b) => a.order - b.order);
  const latestUser = [...raw].reverse().find((m) => m.role === "user");
  const anchors = openingExchange(raw);
  const recent = raw.filter((m) => m.order > (summaryText ? (session.breakpointOrder ?? 0) : 0));
  const candidates = [...new Map([...anchors, ...recent, ...(latestUser ? [latestUser] : [])]
    .map((m) => [m.id, m])).values()];
  const candidateIds = new Set(candidates.map((m) => m.id));
  const requiredIds = new Set(anchors.map((m) => m.id));
  if (latestUser) requiredIds.add(latestUser.id);
  if(opts.continuationId) {
    const target=raw.find(m=>m.id===opts.continuationId && m.role==='assistant');
    if(!target)throw new Error('The continuation target is missing from context.');
    requiredIds.add(target.id);
  }
  const costs = new Map();
  for (const m of candidates) {
    const content = contentFor(m);
    // Stored counts may come from a CDN fallback or include removed private text.
    costs.set(m.id, await countSystemTokensCached(content) + MESSAGE_FRAME_TOKENS);
  }
  const requiredCost = candidates.reduce((sum, m) => sum + (requiredIds.has(m.id) ? costs.get(m.id) : 0), 0);
  let exceedsInputLimit = requiredCost > available;
  if ((opts.requireLatestUser || opts.continuationId) && (!latestUser || exceedsInputLimit)) {
    throw new Error("The opening story and latest user message exceed the context budget. Increase the context limit or shorten one of those messages.");
  }
  const fixedUsed = used;
  let selected;
  const selectWindow = (reserve = 0) => {
    let budget = Math.max(0, available - requiredCost - reserve);
    selected = new Set(requiredIds);
    used = fixedUsed + requiredCost + reserve;
    for (const m of [...candidates].reverse()) {
      if (selected.has(m.id)) continue;
      const cost = costs.get(m.id);
      if (cost > budget) break; // keep a contiguous recent window after the opening exchange
      selected.add(m.id);
      budget -= cost;
      used += cost;
    }
  };
  selectWindow();
  const anchorOrder = anchors.at(-1)?.order ?? 0;
  const coveredGap = Boolean(summaryText && (session.breakpointOrder ?? 0) > anchorOrder);
  let uncoveredGap = candidates.some((m) => !selected.has(m.id));
  let gapEntry = null;
  if (coveredGap || uncoveredGap) {
    // Reserving the summary marker can itself push a later turn out of the
    // window. Rebuild the marker once if that creates an uncovered gap.
    for (let pass = 0; pass < 2; pass++) {
      const content = coveredGap ? (uncoveredGap && summaryText ? prompts.omittedTurnsPartial : prompts.omittedTurnsSummary) : (uncoveredGap && summaryText ? prompts.omittedTurnsPartialUncovered : prompts.omittedTurns);
      const tokens = await countSystemTokensCached(content);
      const cost = tokens + MESSAGE_FRAME_TOKENS;
      exceedsInputLimit = requiredCost + cost > available;
      if ((opts.requireLatestUser || opts.continuationId) && exceedsInputLimit) {
        throw new Error("The opening story, latest user message, and omitted turns marker exceed the context budget. Increase the context limit or shorten the required messages.");
      }
      selectWindow(cost);
      gapEntry = { role: "system", content, tokens, source: "Omitted turns marker" };
      if (uncoveredGap || !candidates.some((m) => !selected.has(m.id))) break;
      uncoveredGap = true;
    }
  }
  const selectedMessages = candidates.filter((m) => selected.has(m.id)).sort((a, b) => a.order - b.order);
  const orderedMessages = [
    ...selectedMessages.filter((m) => anchors.some((anchor) => anchor.id === m.id)),
    ...selectedMessages.filter((m) => !anchors.some((anchor) => anchor.id === m.id)),
  ];
  for (const m of orderedMessages) {
    if (summaryEntry && !anchors.some((anchor) => anchor.id === m.id)) {
      parts.push({ role: "system", content: summaryEntry.content });
      entries.push(summaryEntry);
      summaryEntry = null;
    }
    if (gapEntry && !anchors.some((anchor) => anchor.id === m.id)) {
      parts.push({ role: "system", content: gapEntry.content });
      entries.push(gapEntry);
      gapEntry = null;
    }
    const content = contentFor(m);
    parts.push({ role: m.role, content });
    entries.push({ id: m.id, order: m.order, role: m.role, content,
      tokens: costs.get(m.id) - MESSAGE_FRAME_TOKENS,
      source: anchors.some((anchor) => anchor.id === m.id) ? "Opening exchange"
        : m.role === "user" ? "Recent user messages" : "Recent assistant story" });
  }
  if (summaryEntry) {
    parts.push({ role: "system", content: summaryEntry.content });
    entries.push(summaryEntry);
  }
  if (gapEntry) {
    parts.push({ role: "system", content: gapEntry.content });
    entries.push(gapEntry);
  }

  if(temporary) {
    parts.push({role:'user',content:temporary});
    entries.push({role:'user',content:temporary,tokens:temporaryTokens,source:'Temporary continuation instruction'});
  }
  const totals = new Map();
  for (const entry of entries) totals.set(entry.source, (totals.get(entry.source) ?? 0) + entry.tokens);
  totals.set("Framing overhead", parts.length * MESSAGE_FRAME_TOKENS + REQUEST_FRAME_TOKENS);
  const omitted = { "Summary checkpoint": 0, "Context window": candidates.length - selected.size,
    "Regeneration cutoff": 0, "Empty story text": 0, "Older summaries": 0 };
  for (const m of all) {
    if (m.order >= upToOrder) omitted["Regeneration cutoff"]++;
    else if (m.role === "summary") { if (m.id !== summaryMsg?.id || !summaryText) omitted["Older summaries"]++; }
    else if (["user", "assistant"].includes(m.role)) {
      if (!contentFor(m).trim()) omitted["Empty story text"]++;
      else if (!candidateIds.has(m.id)) omitted["Summary checkpoint"]++;
    }
  }

  return {
    apiMessages: parts,
    entries,
    contributions: [...totals].map(([source, tokens]) => ({ source, tokens })),
    omitted,
    exceedsInputLimit,
    usedTokens: used,
    windowedCount: selected.size,
    droppedCount: candidates.length - selected.size,
  };
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeLegacyUsage(session, settings, messages = null) {
  const context = await buildLegacyContext(session, settings, { messages });
  const max = requestInputLimit(settings);
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { ...context, max, threshold, overThreshold: context.usedTokens >= threshold };
}

// <plan>...</plan> tag handling (spec §11).
// The tag is emitted by the model anywhere in its reply; the app extracts it,
// saves it as the session's long-term plan only when allowed, and strips it from visible content.

function extractPlan(text) {
  if (!text) return null;
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  return m ? m[1].trim() : null;
}

function extractPlanThread(text) {
  if (!text) return null;
  const m = text.match(/<plan_thread>([\s\S]*?)<\/plan_thread>/i);
  return m ? m[1].trim() : null;
}

function stripPlanThread(text) {
  if (!text) return "";
  return text
    .replace(/<plan_thread>[\s\S]*?<\/plan_thread>\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPlan(text) {
  if (!text) return "";
  return stripPlanThread(
    text
      .replace(/<(plan|plan_thread)>[\s\S]*?<\/\1>\s*/gi, "")
      .replace(/<(plan|plan_thread)>[\s\S]*$/gi, "")
      .replace(/<(?:p|pl|pla|plan|plan_|plan_t|plan_th|plan_thr|plan_thre|plan_threa|plan_thread)?$/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}


function planInjectionBlock(plan) {return renderPrompt(prompts.legacyPlan,{PLAN:plan?.trim() ? plan : prompts.legacyNoPlan});}


// Only assistant/model output is cleaned. Author directions remain user input.
function stripThinking(text = "") {
  text = String(text ?? "");
  let depth = 0;
  let cursor = 0;
  let output = "";
  for (const match of text.matchAll(/<(\/?)(?:think|thinking)\b[^>]*>/gi)) {
    if (depth === 0) output += text.slice(cursor, match.index);
    depth = match[1] ? Math.max(0, depth - 1) : depth + 1;
    cursor = match.index + match[0].length;
  }
  if (depth === 0) output += text.slice(cursor);
  return output
    .replace(/<(?:think|thinking)\b[^>]*$/i, "")
    .replace(/<(?:t|th|thi|thin|think|thinki|thinkin|thinking)?$/i, "")
    .trim();
}

function storyText(text) {
  return stripPlan(stripThinking(text));
}
