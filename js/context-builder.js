import {continuationTarget} from './continuation.js';
import {createTokenCounter} from './token-cache.js';
import {normalizeMemory,memoryActive} from './memory-settings.js';
import {buildLegacyContext} from './legacy-context.js';
import {requestInputLimit} from './request-budget.js';
import { prompts } from './system-prompts.js';
import { buildMemoryContext } from './memory-context.js';
// Context window assembly (spec §6). Whole-message granularity, never cut mid-text.
// Budget accounting: narrator prompt + plan block + summary + sliding-window messages
// maxContextTokens limits input. Output is reserved only against optional modelContextTokens.
//
// Firestore optimization: both functions accept messages cached by the chat
// view, so repeated turns and indicator updates need no collection read.

import { getMessages } from "./messages.js";
import * as tokenizer from "./tokenizer.js";

// Reserve framing tokens for each API message and for the request envelope.
// Exact framing depends on the model, so these are conservative estimates.
export {MESSAGE_FRAME_TOKENS,REQUEST_FRAME_TOKENS} from './request-budget.js';

// The narrator prompt + plan block rarely change between turns; cache its token count
// to avoid re-running the tokenizer on every send/indicator refresh.
const tokenizerIsReady = () => tokenizer.tokenizerReady?.() !== false;

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

const countSystemTokensCached=createTokenCounter({count:text=>tokenizer.countTokens(text),ready:tokenizerIsReady});

export async function buildContextForRequest(session, settings, opts = {}) {
  const messages = opts.messages ?? await getMessages(session.id);
  if(opts.continuationId)continuationTarget(session,messages,opts.continuationId);
  if (!memoryActive(normalizeMemory(session.memory))) {
    let all=[...messages];
    if (opts.draftText?.trim()) all.push({id:'__legacy_draft',order:(all.filter(m=>m.role!=='summary').at(-1)?.order ?? 0)+1,role:'user',content:opts.draftText});
    if (opts.onlyRequiredWindow) {
      const raw=all.filter(m=>['user','assistant'].includes(m.role) && m.order < (opts.upToOrder ?? Infinity));
      const first=raw.find(m=>m.role==='user'),second=first && raw.find(m=>m.role==='assistant' && m.order>first.order),last=raw.findLast(m=>m.role==='user');
      const ids=new Set([first?.id,second?.id,last?.id,...raw.slice(-Math.max(0,settings.keepRecentMessagesAfterSummary ?? 10)).map(m=>m.id)]);
      all=all.filter(m=>m.role==='summary' || ids.has(m.id));
    }
    const {planOverride,...options}=opts;
    const result=await buildLegacyContext({...session,allowLlmPlanUpdates:false},settings,{...options,messages:all});
    const anchors=new Set(result.entries.filter(e=>e.source==='Opening exchange').map(e=>e.id));
    const target=all.filter(m=>['user','assistant'].includes(m.role) && !anchors.has(m.id) && m.order>(session.activeSummaryMessageId ? session.breakpointOrder ?? 0 : 0)).slice(-Math.max(0,settings.keepRecentMessagesAfterSummary ?? 10));
    const retained=target.filter(m=>result.entries.some(e=>e.id===m.id)).length;
    const warnings=[];
    if(retained<target.length) warnings.push(`Recent window reduced from ${target.length} to ${retained} messages to fit the request budget.`);
    if(result.exceedsInputLimit) warnings.push('The request exceeds the input limit.');
    return {...result,report:{mode:'legacy',totals:{input:result.usedTokens,reserved:settings.maxResponseTokens,max:requestInputLimit(settings)},blocks:result.contributions.map(c=>({key:c.source.toLowerCase().replace(/[^a-z]+/g,'-'),label:c.source,tokens:c.tokens})),loaded:[],skipped:[],scene:null,gap:null,gaps:[],warnings}};
  }
  return buildMemoryContext(session, settings, { ...opts, messages }, {
    count: countSystemTokensCached, adRule: AD_DIRECTIVE_RULE, normalizeAd: normalizeAdDirective,
  });
}

// Indicator metric: tokens that would be sent for the next turn (no new user turn yet).
export async function computeContextUsage(session, settings, messages = null, opts = {}) {
  messages ??= await getMessages(session.id);
  const { usedTokens, droppedCount, report } = await buildContextForRequest(session, settings, { ...opts, messages,placeholderLatest:memoryActive(normalizeMemory(session.memory)) && !opts.draftText?.trim() && [...messages].filter(m=>m.role!=='summary').at(-1)?.role==='assistant' });
  const max = requestInputLimit(settings);
  const threshold = (max * settings.autoSummaryThresholdPercent) / 100;
  return { usedTokens, max, threshold,
    overThreshold: usedTokens >= threshold, droppedCount, report };
}
