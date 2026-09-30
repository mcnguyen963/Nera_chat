import { chatCompletion, completionProgress } from "../llm-client.js";
import { countTokens } from "../tokenizer.js";
import { sourceMessage, sourceRef } from "./state.js";
import { buildContinuityContext, requestTokenCount, inputBudget } from "./context.js";
import { NARRATOR_TOOLS, createStoryTools, runNarratorTools, requireCompletedResponse } from "./tools.js";
import { REVIEWER_CONTRACT } from "./prompts.js";
import { REVIEW_SCHEMA, MIGRATION_REVIEW_SCHEMA, MIGRATION_OUTPUT_SCHEMA, normalizeMigrationReview, validate } from "./schema.js";
import { acceptedReceipt, validateReview } from "./store.js";

// Separate entry point: no legacy summary, short-memory or plan-tag writes.
// A future UI adapter supplies the repository and an explicit story branch.
export async function runContinuityTurn({ store, branchId, turnId, input, settings, mode = "player",
  stylePrompt = "", characterIds = [], signal, complete = chatCompletion, count = countTokens,
  structuredOutputs = false, onStatus = () => {}, draftOverride = null,
  expectedActiveBranchId = branchId, migrationReview = false, onProgress = () => {},
  reviewOverride = null, onReviewOutput = () => {} }) {
  if (reviewOverride !== null && !migrationReview) throw new Error("Review output editing is available only for migration.");
  if (!["player", "author"].includes(mode) || !input?.trim()) throw new Error("Invalid turn input.");
  // Retries of an accepted operation return the stored result without another
  // paid completion. An idempotency key cannot be reused for different input.
  const existing = await store.readTurn(branchId, turnId);
  if (existing && (existing.user.content !== input || existing.user.role !== (mode === "author" ? "author" : "user")))
    throw new Error("Turn ID was already used for different input.");
  if (existing?.status === "accepted") return acceptedReceipt(existing);
  const snapshot = await store.load(branchId);
  const user = await sourceMessage({ id: `${turnId}_user`, role: mode === "author" ? "author" : "user", content: input, order: snapshot.state.throughOrder + 1 });
  const request = { branchId, turnId, baseRevision: snapshot.state.revision,
    expectedActiveBranchId, user, migrationReview };
  const started = await store.beginTurn(request);
  if (started.status === "accepted") return started;
  try {
    signal?.throwIfAborted();
    onStatus("building_context");
    const localReview = migrationReview && reviewOverride !== null;
    const built = localReview ? { apiMessages: [], trace: { branchId, revision: snapshot.state.revision,
      recordIds: [], eventIds: [], historyMessages: 0, droppedMessages: snapshot.messages.length } }
      : await buildContinuityContext({ state: snapshot.state, messages: migrationReview ? [] : snapshot.messages,
      input, mode, settings, stylePrompt, characterIds, tools: NARRATOR_TOOLS, count });
    let violations = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      onStatus(attempt ? "repairing" : "generating");
      const executor = createStoryTools(snapshot.state);
      const messages = structuredClone(built.apiMessages);
      if (violations.length) {
        const current = JSON.parse(messages.at(-1).content);
        current.draftCorrection = violations;
        messages.at(-1).content = JSON.stringify(current);
      }
      const draft = draftOverride === null
        ? await runNarratorTools({ complete, settings, messages, executor, signal, count })
        : { content: draftOverride, finishReason: "stop", usage: null, trace: [] };
      if (typeof draft.content !== "string" || !draft.content.trim()) throw new Error("Narration is empty.");
      if (/<\/?(?:plan|plan_thread)\b/i.test(draft.content)) throw new Error("Narrator returned legacy plan tags instead of tool calls.");
      const assistant = await sourceMessage({ id: `${turnId}_assistant`, role: "assistant", content: draft.content, order: user.order + 1 });
      onStatus("reviewing");
      const recordIds = new Set([...built.trace.recordIds, ...executor.retrievedRecordIds,
        ...executor.proposals.map((p) => p.agendaId)]);
      const eventIds = new Set([...built.trace.eventIds, ...executor.retrievedEventIds]);
      const records = snapshot.state.records.filter((r) => recordIds.has(r.id));
      records.flatMap((r) => r.eventIds).forEach((ref) => eventIds.add(ref));
      const events = snapshot.state.events.filter((e) => eventIds.has(e.id));
      const sourceIds = new Set([...records, ...events].flatMap((r) => r.sources.map((source) => source.messageId)));
      sourceIds.add(user.id);
      sourceIds.add(assistant.id);
      // Include neighboring accepted text for causal interpretation, plus exact
      // sources of protected facts. No slicing across an evidence boundary.
      if (!migrationReview) snapshot.messages.slice(-4).forEach((m) => sourceIds.add(m.id));
      const archivedSources = await store.readSources(branchId, [...sourceIds]);
      const sourceMessages = new Map([...snapshot.messages, ...archivedSources, user, assistant].map((message) => [message.id, message]));
      const refs = [...records, ...events].flatMap((record) => record.sources);
      const sources = [...sourceMessages.values()].filter((message) => sourceIds.has(message.id)).map((message) => ({
        id: message.id, revision: message.revision, role: message.role, order: message.order,
        contentHash: message.contentHash,
        quotes: [...new Set(refs.filter((ref) => ref.messageId === message.id && ref.revision === message.revision).map((ref) => ref.quote))],
        context: message.id === user.id || message.id === assistant.id ? message.content : message.content.slice(-4000),
      }));
      const reviewInput = { branchId, baseRevision: request.baseRevision, turnId,
        priorState: { records, events }, sources, planProposals: executor.proposals };
      const migrationPolicy = migrationReview ? "\nMIGRATION OUTPUT DISCIPLINE:\nConvert the current author note into established state. Archived transcript is not needed. Preserve consequential distinctions; brevity is a preference, not an additional output restriction. Produce each record once, use short exact evidence excerpts (never copy the whole note), and avoid repeated descriptions. Use the dedicated reasoning channel for thinking; the final content channel must contain only the JSON object. Stop after the complete JSON object. This is state extraction, not a new played scene. Do not reject merely because the note is long, detailed, or would require many records. There is no extra compact-output cap. The migration schema permits up to 500 operations and 500 events. Use that capacity when needed, keep different directional relationships, beliefs and unresolved consequences separate, and do not silently omit consequential state. Only reject for a concrete unresolved contradiction or a demonstrable schema limitation; identify the exact field and limit rather than speculating about response length. MIGRATION EVIDENCE OVERRIDE: In every event and operation, sources contains objects with only quote. Copy a short exact substring from the current author note for each quote. Do not output messageId, revision or contentHash in a source; the application supplies them. Do not cite the neutral narrator marker or archived history. Preserve punctuation, spelling and whitespace exactly inside the quote; do not summarize it." : "";
      const reviewSchema = migrationReview ? MIGRATION_REVIEW_SCHEMA : REVIEW_SCHEMA;
      const reviewMessages = [{ role: "system", content: REVIEWER_CONTRACT + migrationPolicy + "\nSCHEMA:\n" + JSON.stringify(migrationReview ? MIGRATION_OUTPUT_SCHEMA : reviewSchema) },
        { role: "user", content: JSON.stringify(reviewInput) }];
      const reviewSettings = { ...settings, streaming: migrationReview,
        maxResponseTokens: settings.continuityReviewMaxTokens ?? 4096,
        reasoning: migrationReview
          ? { ...settings.reasoning, enabled: true, mode: settings.reasoning?.mode ?? "effort", effort: settings.reasoning?.effort ?? "medium" }
          : { ...settings.reasoning, enabled: false } };
      const responseFormat = structuredOutputs ? { type: "json_schema", json_schema: { name: "continuity_review", strict: true, schema: migrationReview ? MIGRATION_OUTPUT_SCHEMA : reviewSchema } }
        : migrationReview ? { type: "json_object" } : undefined;
      const reviewCost = localReview ? 0 : await requestTokenCount(reviewMessages, [], count) + (responseFormat ? await count(JSON.stringify(responseFormat)) : 0);
      if (reviewOverride === null && reviewCost > inputBudget(reviewSettings)) throw new Error("Continuity review exceeds its context budget.");
      const reviewed = reviewOverride !== null
        ? { content: reviewOverride, thinking: null, finishReason: "stop", usage: null }
        : await complete({ settings: reviewSettings, messages: reviewMessages, responseFormat, signal, onProgress });
      if (migrationReview) onReviewOutput({ content: reviewed.content ?? "", thinking: reviewed.thinking ?? "",
        usage: reviewed.usage ?? null, finishReason: reviewed.finishReason, turnId });
      onProgress({ ...completionProgress(reviewed), maxOutputTokens: reviewSettings.maxResponseTokens });
      if (migrationReview) onStatus("validating_output");
      if (reviewed.finishReason === "length") {
        const reasoning = reviewed.usage?.completion_tokens_details?.reasoning_tokens;
        const total = reviewed.usage?.completion_tokens;
        throw new Error(`The provider ended state extraction at the ${reviewSettings.maxResponseTokens.toLocaleString()} token output limit` +
          (Number.isFinite(total) ? ` (${total.toLocaleString()} output tokens${Number.isFinite(reasoning) ? `, ${reasoning.toLocaleString()} reasoning` : ""})` : "") +
          ". No state was saved. Check the received text/reasoning counts; reduce thinking or repeated content before increasing the limit. Large author notes may need to be split.");
      }
      requireCompletedResponse(reviewed);
      let review;
      try {
        const content = migrationReview ? reviewed.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1") : reviewed.content;
        review = JSON.parse(content);
      } catch { throw new Error("Continuity reviewer returned invalid JSON. Thinking is handled separately; no state was saved."); }
      if (migrationReview) review = normalizeMigrationReview(review);
      if (migrationReview && review?.patch) {
        // Accept old full references from cached prompts only when they point at
        // this author note. Never trust model-generated revision/hash metadata.
        for (const group of ["events", "operations"]) {
          if (!Array.isArray(review.patch[group])) continue;
          for (const item of review.patch[group]) {
            if (!Array.isArray(item.sources)) continue;
            item.sources = item.sources.map((ref) => {
              if (ref?.messageId !== undefined && ref.messageId !== user.id)
                throw new Error("Every migrated event and state change must cite the reviewed author note.");
              if (typeof ref?.quote !== "string" || !ref.quote.trim() || !user.content.includes(ref.quote))
                throw new Error(`Migration evidence for ${item.id ?? item.record?.id ?? group} is not an exact quote from the author note. No state was saved.`);
              return sourceRef(user, ref.quote);
            });
          }
        }
      }
      validate(reviewSchema, review);
      if (review.patch.branchId !== branchId || review.patch.baseRevision !== request.baseRevision || review.patch.turnId !== turnId)
        throw new Error("Review does not match the pending turn.");
      for (const operation of review.patch.operations) {
        if (snapshot.state.records.some((record) => record.id === operation.record.id) &&
            !recordIds.has(operation.record.id))
          throw new Error(`Reviewer changed unseen existing record: ${operation.record.id}`);
      }
      const proposals = new Map(executor.proposals.map((proposal) => [proposal.agendaId, proposal]));
      for (const operation of review.patch.operations.filter((op) => op.record.kind === "agenda")) {
        if (mode === "author" && operation.sources.some((source) =>
          source.messageId === user.id && source.contentHash === user.contentHash)) continue;
        const proposal = proposals.get(operation.record.id);
        if (!proposal || operation.expectedVersion !== proposal.expectedVersion ||
            JSON.stringify(operation.record.data) !== JSON.stringify(proposal.agenda))
          throw new Error("Agenda changes must match a proposal from the plan tool.");
      }
      if (review.verdict === "reject") {
        if (!review.violations.length || review.patch.events.length || review.patch.operations.length)
          throw new Error("Rejected review must contain violations and no state changes.");
        violations = review.violations;
        if (draftOverride !== null) break;
        continue;
      }
      validateReview(review, request);
      if (mode === "author" && (!review.patch.events.length || !review.patch.operations.length))
        throw new Error("Author note produced no saved story state. Revise the note or retry with a reviewer-capable model.");
      signal?.throwIfAborted();
      onStatus("saving");
      const result = await store.commitTurn({ ...request, assistant, review,
        trace: { ...built.trace, tools: draft.trace, attempt, model: settings.modelId,
          reviewOrigin: localReview ? "author_edited_migration" : "model",
          promptVersion: 1, narratorFinishReason: draft.finishReason, reviewerFinishReason: reviewed.finishReason,
          narratorUsage: draft.usage ?? null, reviewerUsage: reviewed.usage ?? null } });
      onStatus("accepted");
      return result;
    }
    throw new Error((migrationReview ? "Migration state extraction rejected the note: "
      : draftOverride !== null ? "Continuity review rejected the supplied draft: "
      : "Continuity review rejected both drafts: ") + violations.join("; "));
  } catch (error) {
    await store.failTurn(branchId, turnId, error.message).catch(() => {});
    onStatus("failed");
    throw error;
  }
}
