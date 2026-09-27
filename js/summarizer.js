// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.
//
// Firestore optimization: opts.messages lets the caller pass its cached
// checkpoint-to-present message list; the summary message + session pointer update
// are committed in ONE transaction (1 read + 2 writes instead of 2 reads + 3 writes).

import { getMessages, getCheckpointMessages, addMessage, newMessageId } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { computeContextUsage } from "./context-builder.js";
import { countTokens } from "./tokenizer.js";

// Max input tokens per summarizer call. Configurable via settings.summarizerChunkTokens.
const CHUNK_TOKEN_BUDGET_DEFAULT = 250000;

async function chunkByTokens(msgs, budget) {
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const m of msgs) {
    const t = m.tokenCount ?? await countTokens(m.content);
    if (cur.length > 0 && curTokens + t > budget) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(m);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// The summarizer has its own output budget (summarizerMaxTokens), independent
// of the chat's maxResponseTokens, so long histories can be captured fully.
function summarizerSettings(settings) {
  return { ...settings, maxResponseTokens: settings.summarizerMaxTokens ?? 20000 };
}

export function formatAsTranscript(msgs) {
  return msgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function runSummarization(session, settings, opts = {}) {
  const all = opts.messages ?? (opts.full
    ? await getMessages(session.id)
    : await getCheckpointMessages(session));
  const N = settings.keepRecentMessagesAfterSummary;

  const raw = all
    .filter((m) => m.role !== "summary")
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

  const chunks = await chunkByTokens(toFold, settings.summarizerChunkTokens ?? CHUNK_TOKEN_BUDGET_DEFAULT);
  let running = priorSummary ? "Previous summary:\n" + priorSummary + "\n\n" : "";

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
  for (let i = 0; i < chunks.length; i++) {
    opts.onProgress?.(chunks.length > 1, i + 1, chunks.length);
    const summarizerInput =
      running +
      (chunks.length > 1 ? "New events to fold in (part " + (i + 1) + " of " + chunks.length + "):\n" : "New events to fold in:\n") +
      formatAsTranscript(chunks[i]) +
      detailDirective;

    const r = await chatCompletion({
      settings: summarizerSettings(settings),
      messages: [
        { role: "system", content: settings.summarizerSystemPrompt },
        { role: "user", content: summarizerInput },
      ],
      onDelta: opts.onDelta,
      onReasoning: opts.onReasoning,
    });
    content = r.content;
    if (!content?.trim()) throw new Error("The summarizer returned an empty summary; checkpoint was not changed.");
    // Each chunk's summary becomes the "previous summary" for the next chunk.
    running = content && content.trim() ? "Previous summary:\n" + content + "\n\n" : running;
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
  const { overThreshold, droppedCount } = await computeContextUsage(session, settings, messages);
  return overThreshold || droppedCount > 0;
}
