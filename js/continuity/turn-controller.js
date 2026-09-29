import { chatCompletion } from "../llm-client.js";
import { countTokens } from "../tokenizer.js";
import { sourceMessage } from "./state.js";
import { buildContinuityContext, requestTokenCount, inputBudget } from "./context.js";
import { NARRATOR_TOOLS, createStoryTools, runNarratorTools, requireCompletedResponse } from "./tools.js";
import { REVIEWER_CONTRACT } from "./prompts.js";
import { REVIEW_SCHEMA, validate } from "./schema.js";
import { acceptedReceipt, validateReview } from "./store.js";

// Separate entry point: no legacy summary, short-memory or plan-tag writes.
// A future UI adapter supplies the repository and an explicit story branch.
export async function runContinuityTurn({ store, branchId, turnId, input, settings, mode = "player",
  stylePrompt = "", characterIds = [], signal, complete = chatCompletion, count = countTokens,
  structuredOutputs = false, onStatus = () => {}, draftOverride = null,
  expectedActiveBranchId = branchId }) {
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
    expectedActiveBranchId, user };
  const started = await store.beginTurn(request);
  if (started.status === "accepted") return started;
  try {
    signal?.throwIfAborted();
    onStatus("building_context");
    const built = await buildContinuityContext({ state: snapshot.state, messages: snapshot.messages,
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
      snapshot.messages.slice(-4).forEach((m) => sourceIds.add(m.id));
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
      const reviewMessages = [{ role: "system", content: REVIEWER_CONTRACT + "\nSCHEMA:\n" + JSON.stringify(REVIEW_SCHEMA) },
        { role: "user", content: JSON.stringify(reviewInput) }];
      const reviewSettings = { ...settings, streaming: false,
        maxResponseTokens: settings.continuityReviewMaxTokens ?? 4096,
        reasoning: { ...settings.reasoning, enabled: false } };
      const responseFormat = structuredOutputs ? { type: "json_schema", json_schema: { name: "continuity_review", strict: true, schema: REVIEW_SCHEMA } } : undefined;
      const reviewCost = await requestTokenCount(reviewMessages, [], count) + (responseFormat ? await count(JSON.stringify(responseFormat)) : 0);
      if (reviewCost > inputBudget(reviewSettings)) throw new Error("Continuity review exceeds its context budget.");
      const reviewed = await complete({ settings: reviewSettings, messages: reviewMessages, responseFormat, signal });
      requireCompletedResponse(reviewed);
      let review;
      try { review = JSON.parse(reviewed.content); } catch { throw new Error("Continuity reviewer returned invalid JSON."); }
      validate(REVIEW_SCHEMA, review);
      if (review.patch.branchId !== branchId || review.patch.baseRevision !== request.baseRevision || review.patch.turnId !== turnId)
        throw new Error("Review does not match the pending turn.");
      for (const operation of review.patch.operations) {
        if (snapshot.state.records.some((record) => record.id === operation.record.id) &&
            !recordIds.has(operation.record.id))
          throw new Error(`Reviewer changed unseen existing record: ${operation.record.id}`);
      }
      const proposals = new Map(executor.proposals.map((proposal) => [proposal.agendaId, proposal]));
      for (const operation of review.patch.operations.filter((op) => op.record.kind === "agenda")) {
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
          promptVersion: 1, narratorFinishReason: draft.finishReason, reviewerFinishReason: reviewed.finishReason,
          narratorUsage: draft.usage ?? null, reviewerUsage: reviewed.usage ?? null } });
      onStatus("accepted");
      return result;
    }
    throw new Error("Continuity review rejected both drafts: " + violations.join("; "));
  } catch (error) {
    await store.failTurn(branchId, turnId, error.message).catch(() => {});
    onStatus("failed");
    throw error;
  }
}
