import { prompts, renderPrompt } from './system-prompts.js';
import { CONTINUITY_RULE, requestSource, evidenceFor } from './continuity.js';
import { computeTurns, formatTurnsTranscript } from './turns.js';
import { isAcceptedTurn, lastUserOrderOf } from './turn-review.js';
// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.
//
// Firestore optimization: opts.messages lets the caller pass its cached
// checkpoint-to-present message list; the summary message + session pointer update
// are committed in ONE transaction (1 read + 2 writes instead of 2 reads + 3 writes).

import { getMessages, getCheckpointMessages, addMessage, newMessageId } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { buildContextForRequest, computeContextUsage, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } from "./context-builder.js";
import { countTokens } from "./tokenizer.js";

const CHUNK_TOKEN_BUDGET_DEFAULT = 250000;

// The summarizer has its own output budget (summarizerMaxTokens), independent
// of the chat's maxResponseTokens, so long histories can be captured fully.
function summarizerSettings(settings, outputCapacity) {
  const contextLimit = Number(settings.maxContextTokens);
  if (!Number.isFinite(contextLimit) || contextLimit < 1024) {
    throw new Error("Summarization needs a context limit of at least 1024 tokens.");
  }
  const maxResponseTokens = Math.min(
    settings.summarizerMaxTokens ?? 20000, Math.floor(contextLimit / 3), outputCapacity
  );
  // Summaries need their output budget for facts, not the chat profile's thinking.
  return { ...settings, maxResponseTokens, reasoning: { ...settings.reasoning, enabled: false } };
}

export function formatAsTranscript(msgs) { return formatTurnsTranscript(msgs); }

export async function runSummarization(session, settings, opts = {}) {
  const expectedSource = requestSource(session);
  const all = structuredClone(opts.messages ?? (opts.full
    ? await getMessages(session.id)
    : await getCheckpointMessages(session)));
  const N = Math.max(0,settings.keepRecentMessagesAfterSummary ?? 10);

  const raw = all
    .filter((m) => m.role !== "summary")
    .sort((a, b) => a.order - b.order);

  if (raw.length <= N) {
    return { skipped: true, reason: `Need more than ${N} raw messages to summarize.` };
  }

  const turns = computeTurns(raw);
  let recentStart = raw.length-N;
  const firstRecentTurn = turns.turnById.get(raw[recentStart]?.id);
  while (recentStart > 0 && turns.turnById.get(raw[recentStart-1].id) === firstRecentTurn) recentStart--;
  if (recentStart === 0) return { skipped:true,reason:'No complete older turns to summarize.' };
  const newBreakpointOrder = raw[recentStart-1].order;
  // opts.full: ignore the existing checkpoint — fold in the ENTIRE history
  // from the very start and drop the old summary (fresh full-history summary).
  const hasSummary = all.some((m) => m.id === session.activeSummaryMessageId);
  const fromOrder = opts.full || !hasSummary ? 0 : (session.breakpointOrder ?? 0);
  const toFold = raw.filter(
    (m) => m.order > fromOrder && m.order <= newBreakpointOrder
  );
  if (toFold.length === 0) {
    return { skipped: true, reason: "Nothing new to fold in since the last breakpoint." };
  }
  if (toFold.some(m => m.role === 'assistant' && !isAcceptedTurn(m,{lastUserOrder:lastUserOrderOf(raw),sceneOn:session.memory?.scene === true}))) {
    return { skipped:true,reason:'Review or regenerate flagged replies before summarizing their turns.' };
  }

  // Prior summary is already in `all` — no extra getMessage() read.
  const priorSummary = opts.full
    ? null
    : session.activeSummaryMessageId
      ? all.find((m) => m.id === session.activeSummaryMessageId)?.content ?? null
      : null;

  const probe = await buildContextForRequest({ ...session,activeSummaryMessageId:null,breakpointOrder:0 },settings,{ ...opts,messages:all,loreEntries:[],onlyRequiredWindow:true,requireLatestUser:true });
  const summaryHeaderCost = await countTokens(renderPrompt(prompts.historicalSummary, { CUTOFF: 'message order '+newBreakpointOrder, SUMMARY: '' }))+MESSAGE_FRAME_TOKENS+32;
  const capacity = Math.floor(settings.maxContextTokens-settings.maxResponseTokens-probe.usedTokens-summaryHeaderCost);
  if (capacity < 64 || probe.report.warnings.some(w => w.startsWith('Recent window reduced'))) throw new Error('No room for a summary and the required recent conversation; checkpoint was not changed.');
  const requestSettings = summarizerSettings(settings,capacity);
  const inputLimit = settings.maxContextTokens - requestSettings.maxResponseTokens;
  const frameTokens = MESSAGE_FRAME_TOKENS * 2 + REQUEST_FRAME_TOKENS;
  const chunkLimit = settings.summarizerChunkTokens ?? CHUNK_TOKEN_BUDGET_DEFAULT;
  let running = priorSummary ? "Previous summary:\n" + priorSummary + "\n\n" : "";

  const summaryPrompt = (settings.summarizerSystemPrompt || '')+'\n\n'+CONTINUITY_RULE;
  const detailDirective = '\n\n'+renderPrompt(prompts.summaryOutput, { MAX_OUTPUT_TOKENS: requestSettings.maxResponseTokens });

  let content = null;
  let offset = 0;
  let part = 0;
  while (offset < toFold.length) {
    const chunk = [];
    const prefix = running + "New events to fold in:\n";
    const fixedTokens = await countTokens(summaryPrompt + "\n" + prefix + detailDirective) + frameTokens;
    let transcriptTokens = 0;
    for (let i = offset; i < toFold.length; i++) {
      const message = toFold[i];
      const itemTokens = await countTokens(
        `${message.role === "user" ? "User" : "Assistant"}: ${message.content}\n\n`
      );
      if (fixedTokens + transcriptTokens + itemTokens > inputLimit ||
          transcriptTokens + itemTokens > chunkLimit) break;
      transcriptTokens += itemTokens;
      chunk.push(toFold[i]);
    }
    let summarizerInput = prefix + formatAsTranscript(chunk) + detailDirective;
    while (chunk.length && await countTokens(summaryPrompt + "\n" + summarizerInput) + frameTokens > inputLimit) {
      chunk.pop();
      summarizerInput = prefix + formatAsTranscript(chunk) + detailDirective;
    }
    if (!chunk.length) {
      throw new Error("A story message or previous summary is too large for the summarizer context budget. Increase the context limit or shorten it.");
    }
    part++;
    opts.onProgress?.(offset + chunk.length < toFold.length || part > 1, part, null);

    const r = await chatCompletion({
      settings: requestSettings,
      messages: [
        { role: "system", content: summaryPrompt },
        { role: "user", content: summarizerInput },
      ],
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
      signal:opts.signal,
      allowTruncated: true,
    });
    if (r.finishReason === 'length') throw new Error('The summary hit the output limit; the checkpoint was not changed. Raise Summarizer max tokens or use smaller summary chunks.');
    await opts.validateSource?.(expectedSource);
    content = r.content;
    if (!content?.trim()) throw new Error("The summarizer returned an empty summary; checkpoint was not changed.");
    // Each chunk's summary becomes the "previous summary" for the next chunk.
    running = "Previous summary:\n" + content.trim() + "\n\n";
    offset += chunk.length;
  }

  const summaryId = newMessageId();
  const summaryMessage = { id:summaryId,order:(all.at(-1)?.order ?? 0)+1,role:'summary',content,coveredRange:{ fromOrder:opts.full ? 1 : (all.find(m => m.id === session.activeSummaryMessageId)?.coveredRange?.fromOrder ?? 1),toOrder:newBreakpointOrder },sourceRevision:expectedSource.historyRevision,evidence:[...new Map([...(opts.full ? [] : all.find(m => m.id === session.activeSummaryMessageId)?.evidence ?? []),...evidenceFor(toFold)].map(e => [e.id,e])).values()],cutoffTurn:turns.turnById.get(raw[recentStart-1].id) };
  const candidate = await buildContextForRequest({ ...session,activeSummaryMessageId:summaryId,breakpointOrder:newBreakpointOrder },settings,{ ...opts,messages:[...all,summaryMessage],requireLatestUser:true });
  if (candidate.report.warnings.some(w => w.startsWith('Recent window reduced'))) throw new Error('Candidate summary displaced required recent conversation; checkpoint was not changed.');
  const newMsg = await addMessage(session.id,summaryMessage,{ id:summaryId,expectedSource,sessionUpdate:{ activeSummaryMessageId:summaryId,breakpointOrder:newBreakpointOrder } });

  return {
    skipped: false,
    summaryId: newMsg.id,
    newBreakpointOrder,
    foldedCount: toFold.length,
    summaryMessage:{ ...summaryMessage,...newMsg },
    historyRevision:newMsg.historyRevision,
  };
}

// Auto-trigger check (spec §8.1): fires after each assistant reply is saved.
export async function shouldAutoSummarize(session, settings, messages = null) {
  if (settings.autoSummarizationEnabled !== true) return false;
  const { overThreshold, droppedCount } = await computeContextUsage(session, settings, messages);
  return overThreshold || droppedCount > 0;
}
