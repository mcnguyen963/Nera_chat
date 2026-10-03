import { prompts } from './system-prompts.js';
import { buildMemoryContext } from './memory-context.js';
// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// all live inside maxContextTokens; maxResponseTokens is reserved on top.
//
// Firestore optimization: both functions accept messages cached by the chat
// view, so repeated turns and indicator updates need no collection read.

import { getMessages } from "./messages.js";
import { countTokens } from "./tokenizer.js";

// Reserve framing tokens for each API message and for the request envelope.
// Exact framing depends on the model, so these are conservative estimates.
export const MESSAGE_FRAME_TOKENS = 8;
export const REQUEST_FRAME_TOKENS = 8;

// The narrator prompt + plan block rarely change between turns; cache its token count
// to avoid re-running the tokenizer on every send/indicator refresh.
const systemTokenCache = new Map();

const AD_DIRECTIVE_RULE = prompts.authorDirection;
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
    if (systemTokenCache.size >= 5000) systemTokenCache.clear();
    cached = await countTokens(text);
    systemTokenCache.set(text, cached);
  }
  return cached;
}

export async function buildContextForRequest(session, settings, opts = {}) {
  const messages = opts.messages ?? await getMessages(session.id);
  return buildMemoryContext(session, settings, { ...opts, messages }, {
    count: countSystemTokensCached, adRule: AD_DIRECTIVE_RULE, normalizeAd: normalizeAdDirective,
  });
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeContextUsage(session, settings, messages = null, opts = {}) {
  const { usedTokens, droppedCount, report } = await buildContextForRequest(session, settings, { ...opts, messages });
  const max = settings.maxContextTokens;
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { usedTokens, max, threshold,
    overThreshold: usedTokens + settings.maxResponseTokens >= threshold, droppedCount, report };
}
