// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.
//
// Firestore optimization: opts.messages lets the caller pass its already-cached
// message list (zero collection reads); the summary message + session pointer update
// are committed in ONE transaction (1 read + 2 writes instead of 2 reads + 3 writes).

import { getMessages, addMessage, newMessageId } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { computeContextUsage } from "./context-builder.js";

export function formatAsTranscript(msgs) {
  return msgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function runSummarization(session, settings, opts = {}) {
  const all = opts.messages ?? (await getMessages(session.id));
  const N = settings.keepRecentMessagesAfterSummary;

  const raw = all
    .filter((m) => m.role !== "summary")
    .sort((a, b) => a.order - b.order);

  if (raw.length <= N) {
    return { skipped: true, reason: `Need more than ${N} raw messages to summarize.` };
  }

  const newBreakpointOrder = raw[raw.length - N].order;
  const toFold = raw.filter(
    (m) => m.order > (session.breakpointOrder ?? 0) && m.order <= newBreakpointOrder
  );
  if (toFold.length === 0) {
    return { skipped: true, reason: "Nothing new to fold in since the last breakpoint." };
  }

  // Prior summary is already in `all` — no extra getMessage() read.
  const priorSummary = session.activeSummaryMessageId
    ? all.find((m) => m.id === session.activeSummaryMessageId)?.content ?? null
    : null;

  const summarizerInput =
    (priorSummary ? "Previous summary:\n" + priorSummary + "\n\n" : "") +
    "New events to fold in:\n" +
    formatAsTranscript(toFold);

  const { content } = await chatCompletion({
    settings,
    messages: [
      { role: "system", content: settings.summarizerSystemPrompt },
      { role: "user", content: summarizerInput },
    ],
  });

  // One transaction: summary doc + updated summary pointer/breakpoint together.
  const summaryId = newMessageId();
  const newMsg = await addMessage(
    session.id,
    { role: "summary", content },
    { id: summaryId, sessionUpdate: { activeSummaryMessageId: summaryId, breakpointOrder: newBreakpointOrder } }
  );

  return { skipped: false, summaryId: newMsg.id, newBreakpointOrder, foldedCount: toFold.length };
}

// Auto-trigger check (spec §8.1): fires after each assistant reply is saved.
export async function shouldAutoSummarize(session, settings, messages = null) {
  const { overThreshold } = await computeContextUsage(session, settings, messages);
  return overThreshold;
}
