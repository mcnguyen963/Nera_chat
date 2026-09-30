import { createStoryState, sourceMessage } from "./state.js";
import { createMemoryStoryStore } from "./store.js";
import { runContinuityTurn } from "./turn-controller.js";
import { MAX_DOCUMENT_BYTES, validateInitialStoryStorage } from "./firestore-store.js";

// A migration note is an explicit author assertion reviewed by the user before
// publication. Earlier transcript text remains available as archival context,
// but it is not silently promoted into character knowledge or canonical state.
export async function prepareContinuityMigration({ legacyMessages, authorNote, settings,
  complete, count, onStatus = () => {}, onProgress = () => {},
  reviewOutputOverride = null, migrationTurnId = null, onReviewOutput = () => {} }) {
  if (!authorNote?.trim()) throw new Error("Write or paste a reviewed author note first.");
  if (!Array.isArray(legacyMessages)) throw new Error("Story transcript is missing.");
  if (legacyMessages.some((item) => !["user", "assistant", "summary"].includes(item.role)))
    throw new Error("The old transcript contains an unsupported message role.");
  const narrative = legacyMessages.filter((item) => ["user", "assistant"].includes(item.role))
    .sort((a, b) => a.order - b.order);
  if (!narrative.length) throw new Error("There are no story messages to migrate.");
  if (new Set(narrative.map((item) => item.order)).size !== narrative.length ||
      narrative.some((item) => !Number.isSafeInteger(item.order) || item.order < 1))
    throw new Error("The old transcript has invalid or duplicate message orders.");
  const messages = [];
  for (const item of narrative) {
    if (typeof item.content !== "string" || !item.content.trim())
      throw new Error(`Message ${item.order} is empty; clean up the transcript before migrating.`);
    messages.push({ ...await sourceMessage({ id: `legacy_${item.order}`, role: item.role,
      content: item.content, order: item.order }), archived: true, legacyId: item.id ?? null });
    if (new TextEncoder().encode(JSON.stringify(messages.at(-1))).length > MAX_DOCUMENT_BYTES)
      throw new Error(`Message ${item.order} exceeds continuity storage limits.`);
  }
  const state = createStoryState("main");
  state.throughOrder = messages.at(-1).order;
  const store = createMemoryStoryStore();
  await store.initialize({ state, messages });
  const turnId = migrationTurnId ?? `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  if (reviewOutputOverride !== null && (!migrationTurnId || typeof reviewOutputOverride !== "string"))
    throw new Error("Edited migration output requires its original turn ID and response text.");
  await runContinuityTurn({ store, branchId: "main", turnId, input: authorNote.trim(),
    mode: "author", migrationReview: true, onProgress, reviewOverride: reviewOutputOverride, onReviewOutput, settings: { ...settings,
      continuityReviewMaxTokens: settings.continuityReviewMaxTokens ?? settings.maxResponseTokens },
    draftOverride: "Migration note received. No new story event or player action occurred.",
    ...(complete ? { complete } : {}), ...(count ? { count } : {}), onStatus });
  const history = await store.history("main");
  const accepted = history.turns[0];
  const authorId = accepted.user.id;
  const grounded = (item) => item.sources.some((source) => source.messageId === authorId &&
    source.contentHash === accepted.user.contentHash);
  if (![...accepted.review.patch.events, ...accepted.review.patch.operations].every(grounded))
    throw new Error("Every migrated event and state change must cite the reviewed author note.");
  const prepared = await store.load("main");
  const result = {
    state: prepared.state,
    messages: prepared.messages.map((message) => ({ ...message, archived: true })),
    sourceMessageCount: narrative.length,
    skippedSummaryCount: legacyMessages.filter((item) => item.role === "summary").length,
  };
  validateInitialStoryStorage(result);
  return result;
}
