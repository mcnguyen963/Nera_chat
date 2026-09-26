// Rolling summarization (spec §8). The new summary always folds in the old summary
// plus everything since the last breakpoint; only the newest summary is referenced by
// the session going forward — older summary docs remain in the log as history.

import { getMessages, getMessage, addMessage } from "./messages.js";
import { chatCompletion } from "./llm-client.js";
import { computeContextUsage } from "./context-builder.js";
import { updateSession } from "./sessions.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";

export function formatAsTranscript(msgs) {
  return msgs
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function runSummarization(session, settings) {
  const N = settings.keepRecentMessagesAfterSummary;
  const raw = (await getMessages(session.id))
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

  const priorSummary = session.activeSummaryMessageId
    ? (await getMessage(session.id, session.activeSummaryMessageId))?.content
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

  const newMsg = await addMessage(session.id, { role: "summary", content });
  await updateDoc(doc(db, "sessions", session.id), {
    activeSummaryMessageId: newMsg.id,
    breakpointOrder: newBreakpointOrder,
  });

  return { skipped: false, summaryId: newMsg.id, newBreakpointOrder, foldedCount: toFold.length };
}

// Auto-trigger check (spec §8.1): fires after each assistant reply is saved.
export async function shouldAutoSummarize(session, settings) {
  const { overThreshold } = await computeContextUsage(session, settings);
  return overThreshold;
}
