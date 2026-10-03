// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.
//
// Firestore optimization: opts.messages lets the caller pass its cached
// checkpoint-to-present message list; the summary message + session pointer update
// are committed in ONE transaction (1 read + 2 writes instead of 2 reads + 3 writes).

import { getMessages, getCheckpointMessages, addMessage, newMessageId } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { computeContextUsage, MESSAGE_FRAME_TOKENS, REQUEST_FRAME_TOKENS } from "./context-builder.js";
import { countTokens } from "./tokenizer.js";
import { storyText } from "./story-text.js";

const CHUNK_TOKEN_BUDGET_DEFAULT = 250000;

// The summarizer has its own output budget (summarizerMaxTokens), independent
// of the chat's maxResponseTokens, so long histories can be captured fully.
function summarizerSettings(settings) {
  const contextLimit = Number(settings.maxContextTokens);
  if (!Number.isFinite(contextLimit) || contextLimit < 1024) {
    throw new Error("Summarization needs a context limit of at least 1024 tokens.");
  }
  const maxResponseTokens = Math.min(
    settings.summarizerMaxTokens ?? 20000, Math.floor(contextLimit / 3)
  );
  // Summaries need their output budget for facts, not the chat profile's thinking.
  return { ...settings, maxResponseTokens, reasoning: { ...settings.reasoning, enabled: false } };
}

export function formatAsTranscript(msgs) {
  return msgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.role === "user" ? m.content : storyText(m.content)}`)
    .join("\n\n");
}

export async function runSummarization(session, settings, opts = {}) {
  const all = opts.messages ?? (opts.full
    ? await getMessages(session.id)
    : await getCheckpointMessages(session));
  const N = settings.keepRecentMessagesAfterSummary;

  const raw = all
    .filter((m) => ["user", "assistant"].includes(m.role))
    .map((m) => ({ ...m, content: m.role === "user" ? m.content : storyText(m.content) }))
    .sort((a, b) => a.order - b.order);

  if (raw.length <= N) {
    return { skipped: true, reason: `Need more than ${N} raw messages to summarize.` };
  }

  const newBreakpointOrder = raw[raw.length - N - 1].order;
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

  // Prior summary is already in `all` — no extra getMessage() read.
  const priorSummary = opts.full
    ? null
    : session.activeSummaryMessageId
      ? all.find((m) => m.id === session.activeSummaryMessageId)?.content ?? null
      : null;

  const requestSettings = summarizerSettings(settings);
  const inputLimit = settings.maxContextTokens;
  const frameTokens = MESSAGE_FRAME_TOKENS * 2 + REQUEST_FRAME_TOKENS;
  const chunkLimit = settings.summarizerChunkTokens ?? CHUNK_TOKEN_BUDGET_DEFAULT;
  const cleanPriorSummary = storyText(priorSummary);
  let running = cleanPriorSummary ? "Previous summary:\n" + cleanPriorSummary + "\n\n" : "";

  // Detail directive appended to every summarizer call — the stored system
  // prompt says "be concise", which makes models crush long transcripts into
  // a few hundred tokens. This overrides that at call time.
  const detailDirective =
    "\n\nWrite a thorough, DETAILED summary. Preserve every named character, " +
    "relationship, open plot thread, key decision, promise, reveal, and outcome — " +
    "losing any of them breaks the story going forward. Scale length to the material: " +
    "for a large transcript write a long summary of at least 1000-2000 words. " +
    "Output only the summary text.";

  let content = null;
  let offset = 0;
  let part = 0;
  while (offset < toFold.length) {
    const chunk = [];
    const prefix = running + "New events to fold in:\n";
    const fixedTokens = await countTokens(settings.summarizerSystemPrompt + "\n" + prefix + detailDirective) + frameTokens;
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
    while (chunk.length && await countTokens(settings.summarizerSystemPrompt + "\n" + summarizerInput) + frameTokens > inputLimit) {
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
        { role: "system", content: settings.summarizerSystemPrompt },
        { role: "user", content: summarizerInput },
      ],
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
    });
    content = storyText(r.content);
    if (!content?.trim()) throw new Error("The summarizer returned an empty summary; checkpoint was not changed.");
    // Each chunk's summary becomes the "previous summary" for the next chunk.
    running = "Previous summary:\n" + content.trim() + "\n\n";
    offset += chunk.length;
  }

  // One transaction: summary doc + updated summary pointer/breakpoint together.
  const summaryId = newMessageId();
  const newMsg = await addMessage(
    session.id,
    { role: "summary", content },
    { id: summaryId, sessionUpdate: { activeSummaryMessageId: summaryId, breakpointOrder: newBreakpointOrder } }
  );

  return {
    skipped: false,
    summaryId: newMsg.id,
    newBreakpointOrder,
    foldedCount: toFold.length,
    summaryMessage: { id: newMsg.id, order: newMsg.order, role: "summary", content, tokenCount: newMsg.tokenCount },
  };
}

// Auto-trigger check (spec §8.1): fires after each assistant reply is saved.
export async function shouldAutoSummarize(session, settings, messages = null) {
  if (settings.autoSummarizationEnabled !== true) return false;
  const { overThreshold, droppedCount } = await computeContextUsage(session, settings, messages);
  return overThreshold || droppedCount > 0;
}
