import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareBalancedContext, BALANCED_TOOLS } from "../js/continuity/balanced.js";
import { BALANCED_PREPARE_POLICY } from "../js/continuity/prompts.js";
import { buildContinuityContext } from "../js/continuity/context.js";
import { createStoryState, sourceMessage, sourceRef, applyContinuityPatch } from "../js/continuity/state.js";
import { createMemoryStoryStore, forkAtRevision } from "../js/continuity/store.js";
import { createFirestoreStoryStore } from "../js/continuity/firestore-store.js";
import { createStoryTools, NARRATOR_TOOLS, runNarratorTools } from "../js/continuity/tools.js";
import { runContinuityTurn } from "../js/continuity/turn-controller.js";
import { prepareContinuityMigration } from "../js/continuity/migration.js";
import { runBalancedTurn, runSaverTurn, acceptSaverPending, saveManualState, repairSaverTurn } from "../js/continuity/saver.js";
import { buildRequestBody, chatCompletion } from "../js/llm-client.js";
import { MIGRATION_REVIEW_SCHEMA, REVIEW_SCHEMA, normalizeMigrationReview, validate } from "../js/continuity/schema.js";

const count = async (text) => Math.ceil(text.length / 4);

async function hostileMotherStory(branchId = "main") {
  const setup = await sourceMessage({ id: "setup", role: "author", order: 0,
    content: "A is normally cheerful and friendly. The player killed A's mother. A knows the player did it. The way A learned this is unspecified." });
  const state = createStoryState(branchId);
  const source = sourceRef(setup);
  const events = [
    { id: "mother_killed", kind: "author_setup", description: "The player killed A's mother.",
      entityIds: ["char_A", "player"], sources: [source], supersedes: [] },
    { id: "A_knows", kind: "author_setup", description: "A knows the player killed her mother; acquisition method unspecified.",
      entityIds: ["char_A"], sources: [source], supersedes: [] },
  ];
  const records = [
    { id: "char_A", kind: "character", data: { name: "A", aliases: ["A"], controller: "narrator",
      personality: "Normally cheerful and friendly.", background: "Her mother was important to her.", voice: "",
      emotion: "grieving", condition: "", goals: [], intentions: [] },
      eventIds: ["mother_killed", "A_knows"], sources: [source] },
    { id: "player", kind: "character", data: { name: "Player", aliases: ["you"], controller: "player",
      personality: "", background: "", voice: "", emotion: "", condition: "", goals: [], intentions: [] },
      eventIds: ["mother_killed"], sources: [source] },
    { id: "rel_A_player", kind: "relationship", data: { from: "char_A", to: "player",
      trust: "deep distrust", affection: "not established", hostility: "strong", boundaries: ["No reconciliation established"] },
      eventIds: ["mother_killed", "A_knows"], sources: [source] },
    { id: "belief_A_killer", kind: "belief", data: { holder: "char_A", proposition: "The player killed A's mother.",
      stance: "knows", acquisition: "Known; source of learning unspecified." },
      eventIds: ["A_knows"], sources: [source] },
    { id: "grievance_A_mother", kind: "consequence", data: { holder: "char_A", target: "player", category: "grievance",
      description: "The player killed A's mother; unresolved.", status: "open" },
      eventIds: ["mother_killed"], sources: [source] },
  ];
  const patch = { branchId, baseRevision: 0, turnId: "setup_turn", events,
    operations: records.map(({ id, kind, data }) => ({ type: "put_record", record: { id, kind, data }, expectedVersion: 0,
      reason: "Explicit authored story setup.", eventIds: records.find((record) => record.id === id).eventIds, sources: [source] })) };
  const seeded = applyContinuityPatch(state, patch, { messages: [setup], throughOrder: 0 });
  const store = createMemoryStoryStore();
  await store.initialize({ state: seeded, messages: [setup] });
  return { store, state: seeded, setup };
}

function settings(extra = {}) {
  return { modelId: "test-model", endpoint: "https://example.invalid", maxContextTokens: 50000,
    maxResponseTokens: 2048, maxTokens: 2048, continuityReviewMaxTokens: 2048, ...extra };
}

function review(branchId, baseRevision, turnId, events = [], operations = []) {
  return { verdict: "accept", violations: [], patch: { branchId, baseRevision, turnId, events, operations } };
}

test("A's unresolved grievance is selected even when the new input does not mention her mother", async () => {
  const { state } = await hostileMotherStory();
  const result = await buildContinuityContext({ state, messages: [], input: "I wave to A and ask about the weather.",
    settings: settings(), count });
  const relation = result.selection.records.find((record) => record.id === "rel_A_player");
  const grievance = result.selection.records.find((record) => record.id === "grievance_A_mother");
  const belief = result.selection.records.find((record) => record.id === "belief_A_killer");
  assert.equal(relation.data.trust, "deep distrust");
  assert.equal(grievance.data.status, "open");
  assert.equal(belief.data.stance, "knows");
  assert.equal(result.apiMessages.at(-1).role, "user");
  assert.equal(JSON.parse(result.apiMessages.at(-1).content).playerInput, "I wave to A and ask about the weather.");
});

test("current input stays last and recent exchanges retain chronological order", async () => {
  const { state } = await hostileMotherStory();
  const history = [];
  for (let order = 1; order <= 8; order++) {
    const message = await sourceMessage({ id: `m${order}`, role: order % 2 ? "user" : "assistant", order, content: `turn ${order}` });
    history.push(message);
  }
  state.throughOrder = 8;
  const built = await buildContinuityContext({ state, messages: history, input: "Continue with A.",
    settings: settings(), count, recentExchanges: 4 });
  const raw = built.apiMessages.filter((message) => message.role !== "system");
  assert.deepEqual(raw.map((message) => message.content), ["turn 1", "turn 2", "turn 3", "turn 4", "turn 5", "turn 6", "turn 7", "turn 8", raw.at(-1).content]);
  assert.equal(JSON.parse(raw.at(-1).content).playerInput, "Continue with A.");
});

test("a pronoun follow-up carries forward the character from the latest exchange", async () => {
  const { state } = await hostileMotherStory();
  const user = await sourceMessage({ id: "u1", role: "user", order: 1, content: "I approach A." });
  const assistant = await sourceMessage({ id: "a2", role: "assistant", order: 2, content: "A steps back." });
  state.throughOrder = 2;
  const built = await buildContinuityContext({ state, messages: [user, assistant],
    input: "I ask her about the weather.", settings: settings(), count });
  assert.equal(built.selection.records.find((record) => record.id === "grievance_A_mother").data.status, "open");
  assert.equal(built.selection.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
});

test("historical author notes stay marked as author instructions in narrator context", async () => {
  const { state } = await hostileMotherStory();
  const author = await sourceMessage({ id: "author1", role: "author", order: 1,
    content: "A distrusts the player." });
  const assistant = await sourceMessage({ id: "answer2", role: "assistant", order: 2,
    content: "A waits by the door." });
  state.throughOrder = 2;
  const built = await buildContinuityContext({ state, messages: [author, assistant],
    input: "I speak to her.", settings: settings(), count });
  assert.equal(built.apiMessages[0].role, "system");
  assert.equal(built.apiMessages[1].role, "system");
  assert.deepEqual(JSON.parse(built.apiMessages[2].content),
    { type: "author_note", content: "A distrusts the player." });
  assert.equal(built.selection.records.some((record) => record.id === "rel_A_player"), true);
});

test("state reducer refuses a relationship change without new supported event evidence", async () => {
  const { store, state, setup } = await hostileMotherStory();
  const existing = state.records.find((item) => item.id === "rel_A_player");
  const record = { id: existing.id, kind: existing.kind, data: structuredClone(existing.data) };
  record.data.trust = "friendly";
  const patch = { branchId: state.branchId, baseRevision: state.revision, turnId: "unsupported",
    events: [], operations: [{ type: "put_record", record, expectedVersion: existing.version,
      reason: "The narrator says A forgives the player.", eventIds: ["mother_killed"], sources: [sourceRef(setup)] }] };
  assert.throws(() => applyContinuityPatch(state, patch, { messages: [setup], throughOrder: 2 }), /new event evidence/);
  assert.equal((await store.load(state.branchId)).state.records.find((item) => item.id === record.id).data.trust, "deep distrust");
});

test("a knowledge belief requires an acquisition event naming its holder", async () => {
  const { state, setup } = await hostileMotherStory();
  const patch = { branchId: state.branchId, baseRevision: state.revision, turnId: "leak",
    events: [{ id: "new_secret", kind: "outcome", description: "A letter reveals a secret.", entityIds: ["char_A", "player"],
      sources: [sourceRef(setup)], supersedes: [] }],
    operations: [{ type: "put_record", record: { id: "belief_A_secret", kind: "belief",
      data: { holder: "char_A", proposition: "A knows the secret.", stance: "knows", acquisition: "A learned it." } },
      expectedVersion: 0, reason: "The narrator states A knows.", eventIds: ["new_secret"], sources: [sourceRef(setup)] }] };
  assert.throws(() => applyContinuityPatch(state, patch, { messages: [setup], throughOrder: 2 }), /acquisition event/);
});

test("new character state requires event evidence that names that character", async () => {
  const { state, setup } = await hostileMotherStory();
  const patch = { branchId: state.branchId, baseRevision: state.revision, turnId: "new_npc",
    events: [{ id: "npc_arrives", kind: "outcome", description: "Someone arrives.", entityIds: [],
      sources: [sourceRef(setup)], supersedes: [] }],
    operations: [{ type: "put_record", record: { id: "char_B", kind: "character", data: {
      name: "B", aliases: [], controller: "narrator", personality: "", background: "", voice: "",
      emotion: "", condition: "", goals: [], intentions: [] } }, expectedVersion: 0,
      reason: "The arrival creates a character.", eventIds: ["npc_arrives"], sources: [sourceRef(setup)] }] };
  assert.throws(() => applyContinuityPatch(state, patch, { messages: [setup], throughOrder: 2 }), /identify every character/);
});

test("an old author source cannot authorize a new correction", async () => {
  const { state, setup } = await hostileMotherStory();
  const user = await sourceMessage({ id: "u1", role: "user", order: 1, content: "Continue." });
  const assistant = await sourceMessage({ id: "a2", role: "assistant", order: 2, content: "A keeps her distance." });
  const patch = { branchId: state.branchId, baseRevision: state.revision, turnId: "false_correction",
    events: [{ id: "false_correction_event", kind: "author_correction", description: "A's mother survived.",
      entityIds: ["char_A"], sources: [sourceRef(setup)], supersedes: ["mother_killed"] }], operations: [] };
  assert.throws(() => applyContinuityPatch(state, patch, { messages: [setup, user, assistant], throughOrder: 2 }),
    /current explicit author input/);
});

test("a player attempt alone cannot establish an outcome", async () => {
  const { state, setup } = await hostileMotherStory();
  const user = await sourceMessage({ id: "u1", role: "user", order: 1, content: "I try to make A forgive me." });
  const patch = { branchId: state.branchId, baseRevision: state.revision, turnId: "forced_outcome",
    events: [{ id: "forgiven", kind: "outcome", description: "A forgives the player.",
      entityIds: ["char_A", "player"], sources: [sourceRef(user)], supersedes: [] }], operations: [] };
  assert.throws(() => applyContinuityPatch(state, patch, { messages: [setup, user], throughOrder: 2 }),
    /established narration or author evidence/);
});

test("an old player message cannot justify changing current voluntary state", async () => {
  const { state, setup } = await hostileMotherStory();
  const oldUser = await sourceMessage({ id: "old_user", role: "user", order: 1, content: "I am afraid." });
  const oldAssistant = await sourceMessage({ id: "old_assistant", role: "assistant", order: 2, content: "A watches." });
  const prior = applyContinuityPatch(state, { branchId: state.branchId, baseRevision: state.revision,
    turnId: "prior", events: [], operations: [] }, { messages: [setup, oldUser, oldAssistant], throughOrder: 2 });
  const currentUser = await sourceMessage({ id: "current_user", role: "user", order: 3, content: "Continue." });
  const currentAssistant = await sourceMessage({ id: "current_assistant", role: "assistant", order: 4, content: "A watches silently." });
  const existing = prior.records.find((record) => record.id === "player");
  const patch = { branchId: prior.branchId, baseRevision: prior.revision, turnId: "old_feeling",
    events: [{ id: "watching", kind: "outcome", description: "A watches silently.", entityIds: ["player"],
      sources: [sourceRef(currentAssistant)], supersedes: [] }],
    operations: [{ type: "put_record", record: { id: "player", kind: "character",
      data: { ...existing.data, emotion: "afraid" } }, expectedVersion: existing.version,
      reason: "Old player message mentioned fear.", eventIds: ["watching"], sources: [sourceRef(oldUser)] }] };
  assert.throws(() => applyContinuityPatch(prior, patch,
    { messages: [setup, oldUser, oldAssistant, currentUser, currentAssistant], throughOrder: 4 }),
  /Player inner state requires player evidence/);
});

test("Firestore fork history excludes messages after its initial checkpoint", async () => {
  const { state, setup } = await hostileMotherStory();
  const user = await sourceMessage({ id: "future_user", role: "user", order: 1, content: "I leave A." });
  const assistant = await sourceMessage({ id: "future_assistant", role: "assistant", order: 2, content: "A stays behind." });
  const api = {
    doc: (_db, ...path) => path.join("/"),
    collection: (_db, ...path) => path.join("/"),
    getDocFromServer: async (path) => ({ exists: () => path.endsWith("/checkpoints/initial"),
      data: () => ({ state }) }),
    getDocsFromServer: async (path) => ({ docs: (path.endsWith("/messages") ? [setup, user, assistant] : [])
      .map((message) => ({ data: () => message })) }),
  };
  const store = createFirestoreStoryStore({ api, db: {}, uid: "u", sessionId: "s" });
  const history = await store.history("main");
  assert.deepEqual(history.initial.messages.map((message) => message.id), ["setup"]);
});

test("Firestore reserves a branch before staging and rejects a competing initializer", async () => {
  const documents = new Map();
  const branchPath = "users/u/sessions/s/continuityBranches/main";
  let stagedWhileReserved = false;
  const api = {
    doc: (_db, ...path) => path.join("/"),
    runTransaction: async (_db, callback) => {
      const writes = [];
      const tx = {
        get: async (path) => ({ exists: () => documents.has(path), data: () => documents.get(path) }),
        set: (path, value) => writes.push([path, value]),
      };
      const result = await callback(tx);
      writes.forEach(([path, value]) => documents.set(path, value));
      return result;
    },
    writeBatch: () => {
      const writes = [];
      return { set: (path, value) => writes.push([path, value]),
        commit: async () => {
          stagedWhileReserved = documents.get(branchPath)?.status === "initializing";
          writes.forEach(([path, value]) => documents.set(path, value));
        } };
    },
  };
  const store = createFirestoreStoryStore({ api, db: {}, uid: "u", sessionId: "s" });
  const setup = await sourceMessage({ id: "setup", role: "author", order: 0, content: "The story begins." });
  await store.initialize({ state: createStoryState("main"), messages: [setup], initializationId: "init_one" });
  assert.equal(stagedWhileReserved, true);
  assert.equal(documents.get(branchPath).status, "ready");
  await assert.rejects(store.initialize({ state: createStoryState("main"), messages: [setup],
    initializationId: "init_two" }), /already exists/);
  assert.equal(documents.get(branchPath).status, "ready");
});

test("Firestore refuses a turn when the session points at another branch", async () => {
  const documents = new Map([
    ["users/u/sessions/s", { continuityEnabled: true, continuityBranchId: "other" }],
    ["users/u/sessions/s/continuityBranches/main", { status: "ready", revision: 0 }],
  ]);
  const api = {
    doc: (_db, ...parts) => parts.join("/"),
    runTransaction: async (_db, callback) => {
      const writes = [];
      const result = await callback({
        get: async (path) => ({ exists: () => documents.has(path), data: () => documents.get(path) }),
        set: (path, value) => writes.push([path, value]),
      });
      writes.forEach(([path, value]) => documents.set(path, value));
      return result;
    },
  };
  const store = createFirestoreStoryStore({ api, db: {}, uid: "u", sessionId: "s" });
  const user = await sourceMessage({ id: "turn_user", role: "user", order: 1, content: "Hello." });
  const request = { branchId: "main", expectedActiveBranchId: "main", turnId: "turn",
    baseRevision: 0, user };
  await assert.rejects(store.beginTurn(request), /active story branch changed/);
  assert.equal(documents.has("users/u/sessions/s/continuityBranches/main/turns/turn"), false);
  documents.get("users/u/sessions/s").continuityBranchId = "main";
  assert.deepEqual(await store.beginTurn(request), { status: "pending" });
});

test("model tool calls retrieve character state and plan changes remain proposals", async () => {
  const { state } = await hostileMotherStory();
  const tools = createStoryTools(state);
  const result = await tools.execute("get_character", { characterId: "char_A" });
  assert.equal(result.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
  assert.equal(NARRATOR_TOOLS.some((tool) => tool.function.name === "plan_thread"), false);
  const agenda = { direction: "Explore accountability if A permits the conversation.", participants: ["char_A", "player"],
    prerequisites: ["The player chooses to engage."], opportunity: "A may ask for restitution.", status: "available", origin: "narrator" };
  const proposed = await tools.execute("propose_plan_update", { agendaId: "agenda_A", expectedVersion: 0, agenda, reason: "The conversation may open an opportunity." });
  assert.equal(proposed.saved, false);
  assert.equal(state.records.some((record) => record.id === "agenda_A"), false);
});

test("narrator tools are sent as API fields", () => {
  const body = buildRequestBody(settings(), [{ role: "system", content: "rules" }], {
    tools: NARRATOR_TOOLS, toolChoice: "auto", responseFormat: { type: "json_object" },
  });
  assert.equal(body.tools, NARRATOR_TOOLS);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("tool loop sends matching tool results back and finishes before accepting narration", async () => {
  const { state } = await hostileMotherStory();
  const executor = createStoryTools(state);
  const seen = [];
  let requestNumber = 0;
  const result = await runNarratorTools({ settings: settings(), messages: [{ role: "system", content: "rules" }], executor, count,
    complete: async (request) => {
      seen.push(request.messages.at(-1));
      requestNumber++;
      if (requestNumber === 1) return { finishReason: "tool_calls", content: null,
        toolCalls: [{ id: "call1", type: "function", function: { name: "get_character", arguments: '{"characterId":"char_A"}' } }] };
      return { finishReason: "stop", content: "A keeps her distance.", toolCalls: [] };
    } });
  assert.equal(requestNumber, 2);
  assert.equal(result.content, "A keeps her distance.");
  assert.equal(seen[1].role, "tool");
  assert.equal(seen[1].tool_call_id, "call1");
});

test("turn controller retries a rejected forgiveness draft and commits only reviewed narration", async () => {
  const { store, state } = await hostileMotherStory();
  const calls = [];
  let narratorDraft = 0;
  const input = "I smile at A and ask if she will travel with me.";
  const complete = async (request) => {
    calls.push(request);
    if (request.tools) {
      narratorDraft++;
      if (narratorDraft === 1) return { finishReason: "stop", content: "A forgives you and takes your hand.", toolCalls: [] };
      return { finishReason: "stop", content: "A stays by the doorway. 'Why should I trust you?'", toolCalls: [] };
    }
    const correction = JSON.parse(request.messages[1].content);
    if (narratorDraft === 1) return { finishReason: "stop", content: JSON.stringify({ verdict: "reject",
      violations: ["A's unresolved grievance does not support forgiveness."],
      patch: { branchId: state.branchId, baseRevision: state.revision, turnId: "turn42", events: [], operations: [] } }) };
    const narrator = correction.sources.find((source) => source.id === "turn42_assistant");
    const event = { id: "guarded_reply", kind: "outcome", description: "A refuses to trust the player.",
      entityIds: ["char_A", "player"], sources: [{ messageId: narrator.id, revision: narrator.revision,
        contentHash: narrator.contentHash, quote: "A stays by the doorway." }], supersedes: [] };
    return { finishReason: "stop", content: JSON.stringify(review(state.branchId, state.revision, "turn42", [event])) };
  };
  const result = await runContinuityTurn({ store, branchId: state.branchId, turnId: "turn42", input,
    settings: settings(), complete, count });
  const after = await store.load(state.branchId);
  assert.equal(narratorDraft, 2);
  assert.match(result.assistant.content, /Why should I trust you/);
  assert.equal(after.state.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
  assert.equal(after.state.records.find((record) => record.id === "grievance_A_mother").data.status, "open");
  assert.equal(after.state.revision, state.revision + 1);
  assert.equal(after.messages.at(-1).role, "assistant");
  const editedBranch = await forkAtRevision(store, state.branchId, state.revision, "before_edit");
  assert.equal(editedBranch.messages.length, 1);
  assert.equal(editedBranch.state.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
  const retry = await runContinuityTurn({ store, branchId: state.branchId, turnId: "turn42", input,
    settings: settings(), complete, count });
  assert.equal(calls.length, 4);
  assert.equal(retry.revision, result.revision);
});

test("failed review does not append the user turn or alter relationship state", async () => {
  const { store, state } = await hostileMotherStory();
  const bad = async (request) => request.tools
    ? { finishReason: "stop", content: "A suddenly forgives the player.", toolCalls: [] }
    : { finishReason: "stop", content: JSON.stringify({ verdict: "reject", violations: ["No supported change."],
      patch: { branchId: state.branchId, baseRevision: state.revision, turnId: "turn_fail", events: [], operations: [] } }) };
  await assert.rejects(runContinuityTurn({ store, branchId: state.branchId, turnId: "turn_fail", input: "Continue.",
    settings: settings(), complete: bad, count }), /rejected both drafts/);
  const after = await store.load(state.branchId);
  assert.equal(after.state.revision, state.revision);
  assert.equal(after.messages.length, 1);
  assert.equal(after.state.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
  assert.equal((await store.readTurn(state.branchId, "turn_fail")).status, "failed");
});

test("an edited narrator draft is reviewed without a new narrator generation", async () => {
  const { store, state } = await hostileMotherStory();
  let calls = 0;
  const complete = async (request) => {
    calls++;
    assert.equal(request.tools, undefined);
    return { finishReason: "stop", content: JSON.stringify(review(state.branchId, state.revision, "edited_turn")) };
  };
  const receipt = await runContinuityTurn({ store, branchId: state.branchId, turnId: "edited_turn",
    input: "I say hello to A.", draftOverride: "A refuses to answer.",
    settings: settings(), complete, count });
  assert.equal(calls, 1);
  assert.equal(receipt.assistant.content, "A refuses to answer.");
  assert.equal((await store.load(state.branchId)).state.records.find((item) => item.id === "grievance_A_mother").data.status, "open");
});

test("an author note cannot succeed without saving any story state", async () => {
  const store = createMemoryStoryStore();
  await store.initialize({ state: createStoryState("main") });
  const complete = async (request) => request.tools
    ? { finishReason: "stop", content: "The story begins.", toolCalls: [] }
    : { finishReason: "stop", content: JSON.stringify(review("main", 0, "empty_author")) };
  await assert.rejects(runContinuityTurn({ store, branchId: "main", turnId: "empty_author",
    input: "A is cheerful but distrusts the player because they killed her mother.",
    mode: "author", settings: settings(), complete, count }), /no saved story state/);
  assert.equal((await store.load("main")).state.revision, 0);
});

test("migration keeps old dialogue as archive and saves hostile character state from a reviewed note", async () => {
  const note = "A is normally cheerful. The player killed A's mother. A knows the player killed her mother and deeply distrusts them. A may ask for accountability later.";
  const legacyMessages = [
    { id: "old1", order: 1, role: "user", content: "I enter the village." },
    { id: "old2", order: 2, role: "assistant", content: "A watches from the doorway." },
    { id: "summary", order: 3, role: "summary", content: "Story so far..." },
  ];
  const complete = async (request) => {
    assert.equal(request.tools, undefined);
    const packet = JSON.parse(request.messages[1].content);
    const author = packet.sources.find((source) => source.role === "author");
    const ref = { messageId: author.id, revision: author.revision,
      contentHash: author.contentHash, quote: "The player killed A's mother." };
    const event = { id: "death_setup", kind: "author_setup", description: "The player killed A's mother; A knows it.",
      entityIds: ["char_A", "player"], sources: [ref], supersedes: [] };
    const character = (id, name, controller) => ({ id, kind: "character", data: {
      name, aliases: [], controller, personality: id === "char_A" ? "Normally cheerful." : "",
      background: "", voice: "", emotion: "", condition: "", goals: [], intentions: [],
    } });
    const records = [character("char_A", "A", "narrator"), character("player", "Player", "player"),
      { id: "rel_A_player", kind: "relationship", data: { from: "char_A", to: "player",
        trust: "deep distrust", affection: "", hostility: "strong", boundaries: [] } },
      { id: "grievance_A", kind: "consequence", data: { holder: "char_A", target: "player",
        category: "grievance", description: "The player killed A's mother.", status: "open" } },
      { id: "belief_A", kind: "belief", data: { holder: "char_A", proposition: "The player killed A's mother.",
        stance: "knows", acquisition: "Established by author; method unspecified." } },
      { id: "agenda_A", kind: "agenda", data: { direction: "A may ask for accountability later.",
        participants: ["char_A", "player"], prerequisites: ["A chooses to raise it."],
        opportunity: "A speaks when ready.", status: "available", origin: "author" } },
    ];
    const operations = records.map((record) => ({ type: "put_record", record, expectedVersion: 0,
      reason: "Reviewed migration note.", eventIds: [event.id], sources: [ref] }));
    return { finishReason: "stop", content: JSON.stringify(review("main", 0, packet.turnId, [event], operations)) };
  };
  const prepared = await prepareContinuityMigration({ legacyMessages, authorNote: note,
    settings: settings(), complete, count });
  assert.equal(prepared.sourceMessageCount, 2);
  assert.equal(prepared.skippedSummaryCount, 1);
  assert.deepEqual(prepared.messages.slice(0, 2).map((message) => message.content),
    ["I enter the village.", "A watches from the doorway."]);
  assert.equal(prepared.messages.every((message) => message.archived), true);
  assert.equal(prepared.state.throughOrder, 4);
  assert.equal(prepared.state.records.find((record) => record.id === "rel_A_player").data.trust, "deep distrust");
  assert.equal(prepared.state.records.find((record) => record.id === "grievance_A").data.status, "open");
  assert.equal(prepared.state.records.find((record) => record.id === "agenda_A").data.origin, "author");
});

test("migration rejects a message too large for continuity storage before calling a model", async () => {
  let calls = 0;
  await assert.rejects(prepareContinuityMigration({
    legacyMessages: [{ id: "large", order: 1, role: "assistant", content: "x".repeat(260 * 1024) }],
    authorNote: "The scene is ongoing.", settings: settings(), count,
    complete: async () => { calls++; throw new Error("Model should not run."); },
  }), /exceeds continuity storage limits/);
  assert.equal(calls, 0);
});

test("migration refuses state derived only from the unreviewed old narration", async () => {
  const complete = async (request) => {
    const packet = JSON.parse(request.messages[1].content);
    assert.ok(!packet.sources.some((source) => source.id === "legacy_1"));
    const old = await sourceMessage({ id: "legacy_1", role: "assistant", order: 1, content: "A waits by the door." });
    const ref = { messageId: old.id, revision: old.revision, contentHash: old.contentHash,
      quote: "A waits by the door." };
    const event = { id: "old_scene", kind: "observation", description: "A waits by the door.",
      entityIds: ["char_A"], sources: [ref], supersedes: [] };
    const record = { id: "char_A", kind: "character", data: { name: "A", aliases: [],
      controller: "narrator", personality: "", background: "", voice: "", emotion: "",
      condition: "", goals: [], intentions: [] } };
    const operation = { type: "put_record", record, expectedVersion: 0,
      reason: "Copied from old narration.", eventIds: [event.id], sources: [ref] };
    return { finishReason: "stop", content: JSON.stringify(review("main", 0, packet.turnId,
      [event], [operation])) };
  };
  await assert.rejects(prepareContinuityMigration({
    legacyMessages: [{ id: "old", order: 1, role: "assistant", content: "A waits by the door." }],
    authorNote: "A is present.", settings: settings(), complete, count,
  }), /must cite the reviewed author note/);
});

test("Saver makes one model request and commits an ordinary turn without tools", async () => {
  const { store } = await hostileMotherStory();
  let calls = 0;
  const receipt = await runSaverTurn({ store, branchId: "main", turnId: "saver_normal",
    input: "I ask A about the weather.", settings: settings(), count,
    complete: async (request) => {
      calls++;
      assert.equal(request.tools, undefined);
      assert.equal(request.messages[0].role, "system");
      assert.equal(request.messages[1].role, "system");
      return { finishReason: "stop", content: JSON.stringify({
        narration: "A keeps her distance and answers curtly.", events: [], operations: [],
      }) };
    } });
  assert.equal(calls, 1);
  assert.equal(receipt.status, "accepted");
  assert.equal((await store.load("main")).state.records.find((r) => r.id === "rel_A_player").data.trust,
    "deep distrust");
});

test("Saver keeps suspect relationship narration pending until the author edits its state", async () => {
  const { store } = await hostileMotherStory();
  const old = (await store.load("main")).state.records.find((r) => r.id === "rel_A_player");
  const changed = { id: old.id, kind: old.kind, data: { ...old.data, trust: "friendly" } };
  const proposal = { narration: "A smiles and says she forgives the player.",
    events: [{ id: "quick_forgiveness", kind: "outcome", description: "A forgives the player.",
      entityIds: ["char_A", "player"], evidence: [{ from: "narration", quote: "A smiles and says she forgives the player." }],
      supersedes: [] }],
    operations: [{ record: changed, reason: "A said she forgave the player.",
      eventIds: ["quick_forgiveness"], evidence: [{ from: "narration", quote: "A smiles and says she forgives the player." }] }] };
  const result = await runSaverTurn({ store, branchId: "main", turnId: "saver_suspect",
    input: "I wave to A.", settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify(proposal) }) });
  assert.equal(result.status, "needs_state_review");
  await store.failTurn("main", "saver_suspect", "Late generation callback failed");
  assert.equal((await store.readPending("main")).status, "needs_state_review");
  assert.equal((await store.load("main")).state.records.find((r) => r.id === old.id).data.trust, "deep distrust");
  await assert.rejects(runSaverTurn({ store, branchId: "main", turnId: "another_turn",
    input: "I leave.", settings: settings(), count,
    complete: async () => { throw new Error("No model call expected"); } }), /pending Saver turn/);
  const current = await store.load("main");
  await saveManualState({ store, branchId: "main", pendingTurnId: "saver_suspect",
    records: current.state.records.map((r) => ({ id: r.id, kind: r.kind, data: r.data })) });
  const after = await store.load("main");
  assert.equal(after.state.throughOrder, result.assistant.order);
  assert.equal(after.state.records.find((r) => r.id === old.id).data.trust, "deep distrust");
  assert.equal((await store.readPending("main")), null);
});

test("Saver can require user approval of every valid turn", async () => {
  const { store } = await hostileMotherStory();
  const result = await runSaverTurn({ store, branchId: "main", turnId: "saver_reviewed",
    input: "I wait.", reviewEveryTurn: true, settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({
      narration: "A watches from the doorway.", events: [], operations: [],
    }) }) });
  assert.equal(result.status, "needs_state_review");
  const accepted = await acceptSaverPending({ store, branchId: "main", turnId: result.turnId });
  assert.equal(accepted.status, "accepted");
  assert.equal((await store.readPending("main")), null);
});

test("manual Saver corrections carry author provenance through branch replay", async () => {
  const { store } = await hostileMotherStory();
  const pending = await runSaverTurn({ store, branchId: "main", turnId: "manual_pending",
    input: "I wait.", reviewEveryTurn: true, settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({
      narration: "A stands silently.", events: [], operations: [],
    }) }) });
  const before = await store.load("main");
  const records = before.state.records.map((r) => ({ id: r.id, kind: r.kind,
    data: r.id === "char_A" ? { ...r.data, personality: "Cheerful with friends; guarded with strangers." } : r.data }));
  await saveManualState({ store, branchId: "main", records, expectedRevision: before.state.revision,
    pendingTurnId: pending.turnId });
  const after = await store.load("main");
  const corrected = after.state.records.find((r) => r.id === "char_A");
  assert.equal(corrected.sources[0].messageId, "manual_pending_author");
  assert.equal(after.messages.at(-1).role, "author");
  assert.equal(after.messages.at(-1).audit, true);
  const fork = await forkAtRevision(store, "main", after.state.revision, "manual_fork");
  assert.equal(fork.state.records.find((r) => r.id === "char_A").data.personality, corrected.data.personality);
  assert.equal(fork.state.throughOrder, after.state.throughOrder);
  await assert.rejects(saveManualState({ store, branchId: "main", records,
    expectedRevision: before.state.revision }), /changed on another device/);
});

test("explicit Saver repair uses one reviewer request and keeps the saved narration", async () => {
  const { store } = await hostileMotherStory();
  const pending = await runSaverTurn({ store, branchId: "main", turnId: "repair_pending",
    input: "I wait.", reviewEveryTurn: true, settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({
      narration: "A refuses to approach.", events: [], operations: [],
    }) }) });
  let calls = 0;
  const receipt = await repairSaverTurn({ store, branchId: "main", turnId: pending.turnId,
    settings: settings(), count, complete: async (request) => {
      calls++;
      assert.equal(request.tools, undefined);
      const packet = JSON.parse(request.messages[1].content);
      assert.equal(packet.narration, "A refuses to approach.");
      return { finishReason: "stop", content: JSON.stringify(review("main", 1, pending.turnId)) };
    } });
  assert.equal(calls, 1);
  assert.equal(receipt.assistant.content, pending.assistant.content);
  assert.equal((await store.readPending("main")), null);
});

test("Firestore reload preserves a pending Saver turn and clears its lock atomically on approval", async () => {
  const documents = new Map();
  const snap = (path) => ({ exists: () => documents.has(path), data: () => structuredClone(documents.get(path)) });
  const api = {
    doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"),
    query: (target) => target, orderBy: () => null, limit: () => null,
    getDocFromServer: async (path) => snap(path),
    getDocsFromServer: async (path) => ({ docs: [...documents.keys()]
      .filter((key) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"))
      .map((key) => ({ data: () => structuredClone(documents.get(key)) })) }),
    serverTimestamp: () => "now",
    runTransaction: async (_db, callback) => {
      const changes = [];
      const result = await callback({ get: async (path) => snap(path),
        set: (path, data) => changes.push([path, data]),
        update: (path, data) => changes.push([path, { ...documents.get(path), ...data }]) });
      changes.forEach(([path, data]) => documents.set(path, structuredClone(data)));
      return result;
    },
    writeBatch: () => {
      const changes = [];
      return { set: (path, data) => changes.push([path, data]),
        commit: async () => changes.forEach(([path, data]) => documents.set(path, structuredClone(data))) };
    },
  };
  const sessionPath = "users/u/sessions/s";
  documents.set(sessionPath, { continuityEnabled: true, continuityBranchId: "main" });
  const { state, setup } = await hostileMotherStory();
  const createStore = () => createFirestoreStoryStore({ api, db: {}, uid: "u", sessionId: "s" });
  const store = createStore();
  await store.initialize({ state, messages: [setup], initializationId: "init_pending" });
  const pending = await runSaverTurn({ store, branchId: "main", turnId: "persisted_pending",
    input: "I wait.", reviewEveryTurn: true, settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({
      narration: "A remains distant.", events: [], operations: [],
    }) }) });
  const reloaded = createStore();
  assert.equal((await reloaded.readPending("main")).assistant.content, "A remains distant.");
  assert.equal((await reloaded.load("main")).state.revision, 1);
  assert.equal(documents.get(sessionPath).continuityPendingTurnId, pending.turnId);
  const another = await sourceMessage({ id: "another_user", role: "user", content: "Continue.", order: 1 });
  await assert.rejects(reloaded.beginTurn({ branchId: "main", expectedActiveBranchId: "main",
    turnId: "another", baseRevision: 1, user: another }), /pending Saver turn/);
  await acceptSaverPending({ store: reloaded, branchId: "main", turnId: pending.turnId });
  assert.equal(documents.get(sessionPath).continuityPendingTurnId, null);
  assert.equal((await createStore().load("main")).state.revision, 2);
});


test("Balanced batches lookups then narrates in exactly two requests and retries for free", async () => {
  const { store } = await hostileMotherStory();
  let calls = 0;
  const options = { store, branchId: "main", turnId: "balanced_batch", input: "I wave to A.",
    settings: settings({ endpoint: "https://openrouter.ai/api/v1/chat/completions",
      reasoning: { enabled: true, mode: "effort", effort: "high" } }), count, stylePrompt: "My custom narrator style",
    complete: async (request) => {
      calls++;
      assert.equal(request.messages[0].role, "system");
      assert.equal(request.messages[1].role, "system");
      assert.ok(request.messages[0].content.includes("PLAYER AGENCY"));
      if (calls === 1) {
        assert.deepEqual(request.tools.map((t) => t.function.name), ["get_character", "search_story_events"]);
        assert.equal(request.toolChoice, "auto");
        assert.equal(request.settings.reasoning.enabled, false);
        assert.deepEqual(buildRequestBody(request.settings, request.messages).reasoning, { enabled: false });
        assert.ok(request.messages[1].content.includes("single batch"));
        return { finishReason: "tool_calls", content: "Never publish this preparation text.", toolCalls: [
          { id: "lookup_A", type: "function", function: { name: "get_character", arguments: JSON.stringify({ characterId: "char_A" }) } },
          { id: "lookup_event", type: "function", function: { name: "search_story_events", arguments: JSON.stringify({ query: "mother" }) } },
        ] };
      }
      assert.equal(request.tools, undefined);
      assert.equal(request.settings.reasoning.enabled, true);
      assert.deepEqual(buildRequestBody(request.settings, request.messages).reasoning, { effort: "high" });
      assert.equal(request.messages.filter((m) => m.role === "tool").length, 2);
      assert.ok(request.messages.some((m) => m.role === "tool" && m.content.includes("deep distrust")));
      assert.ok(!JSON.stringify(request.messages).includes("Never publish this preparation text"));
      assert.ok(request.messages[1].content.includes("JSON SCHEMA"));
      assert.ok(request.messages.some((m) => m.content?.includes("My custom narrator style")));
      return { finishReason: "stop", content: JSON.stringify({ narration: "A keeps her distance.", events: [], operations: [] }) };
    } };
  assert.equal((await runBalancedTurn(options)).status, "accepted");
  assert.equal(calls, 2);
  await runBalancedTurn(options);
  assert.equal(calls, 2);
  assert.equal(options.settings.reasoning.enabled, true);
  const snapshot = await store.load("main");
  assert.equal(snapshot.state.records.find((r) => r.id === "grievance_A_mother").data.status, "open");
  assert.ok(!snapshot.messages.some((m) => m.role === "tool"));
});

test("Balanced no-lookup turns still use two calls and honor review every turn", async () => {
  const { store } = await hostileMotherStory();
  let calls = 0;
  const result = await runBalancedTurn({ store, branchId: "main", turnId: "balanced_review", input: "I wait.",
    settings: settings(), count, reviewEveryTurn: true, complete: async () => {
      calls++;
      return { finishReason: "stop", content: calls === 1 ? "Ready" : JSON.stringify({ narration: "A waits.", events: [], operations: [] }) };
    } });
  assert.equal(calls, 2);
  assert.equal(result.status, "needs_state_review");
  assert.equal((await acceptSaverPending({ store, branchId: "main", turnId: result.turnId })).status, "accepted");
});

test("Balanced refuses write tools before narration and leaves canonical state unchanged", async () => {
  const { store } = await hostileMotherStory();
  const before = (await store.load("main")).state;
  let calls = 0;
  await assert.rejects(runBalancedTurn({ store, branchId: "main", turnId: "balanced_write", input: "I wait.",
    settings: settings(), count, complete: async () => {
      calls++;
      return { finishReason: "tool_calls", toolCalls: [{ id: "write", type: "function",
        function: { name: "propose_plan_update", arguments: "{}" } }] };
    } }), /read-only/);
  assert.equal(calls, 1);
  assert.deepEqual((await store.load("main")).state, before);
});

test("Balanced passes failed lookups as missing information without an extra model round", async () => {
  const { store } = await hostileMotherStory();
  let calls = 0;
  await runBalancedTurn({ store, branchId: "main", turnId: "balanced_error", input: "I wait.", settings: settings(), count,
    complete: async (request) => {
      if (++calls === 1) return { finishReason: "tool_calls", toolCalls: [{ id: "bad_args", type: "function",
        function: { name: "get_character", arguments: "{" } }] };
      assert.ok(JSON.parse(request.messages.find((m) => m.role === "tool").content).error);
      return { finishReason: "stop", content: JSON.stringify({ narration: "The room stays quiet.", events: [], operations: [] }) };
    } });
  assert.equal(calls, 2);
});

test("Balanced routes unsupported forgiveness into pending review", async () => {
  const { store } = await hostileMotherStory();
  const old = (await store.load("main")).state.records.find((r) => r.id === "rel_A_player");
  const narration = "A says she forgives the player.";
  let calls = 0;
  const result = await runBalancedTurn({ store, branchId: "main", turnId: "balanced_forgiveness", input: "I wave.",
    settings: settings(), count, complete: async () => ({ finishReason: "stop", content: ++calls === 1 ? "Ready" : JSON.stringify({
      narration, events: [{ id: "forgive", kind: "outcome", description: narration,
        entityIds: ["char_A", "player"], supersedes: [], evidence: [{ from: "narration", quote: narration }] }],
      operations: [{ record: { id: old.id, kind: old.kind, data: { ...old.data, trust: "friendly" } },
        reason: "She forgave them.", eventIds: ["forgive"], evidence: [{ from: "narration", quote: narration }] }],
    }) }) });
  assert.equal(result.status, "needs_state_review");
  assert.equal(calls, 2);
  assert.equal((await store.load("main")).state.records.find((r) => r.id === old.id).data.trust, "deep distrust");
});

test("Balanced budget overflow after retrieval fails without saving or narrating", async () => {
  const { store } = await hostileMotherStory();
  const before = (await store.load("main")).state;
  let calls = 0;
  const budgetCount = async (text) => text.includes('"tool_call_id"') ? 100000 : Math.ceil(text.length / 4);
  // Count the tool result itself, which contains the retrieved found flag.
  const countResults = async (text) => text.includes('"found":true') ? 100000 : budgetCount(text);
  await assert.rejects(runBalancedTurn({ store, branchId: "main", turnId: "balanced_overflow", input: "I wait.",
    settings: settings(), count: countResults, complete: async () => {
      calls++;
      return { finishReason: "tool_calls", toolCalls: [{ id: "large", type: "function",
        function: { name: "get_character", arguments: '{"characterId":"char_A"}' } }] };
    } }), /tool results exceed/);
  assert.equal(calls, 1);
  assert.deepEqual((await store.load("main")).state, before);
});


test("Balanced tracks an off-scene character retrieved outside the initial selection", async () => {
  const { state } = await hostileMotherStory();
  const built = await buildContinuityContext({ state, messages: [], input: "I wait.", settings: settings(),
    policy: BALANCED_PREPARE_POLICY, tools: BALANCED_TOOLS, count });
  assert.ok(!built.trace.recordIds.includes("char_A"));
  await prepareBalancedContext({ built, state, settings: settings(), policy: "Narration output policy", count,
    complete: async (request) => {
      const directory = JSON.parse(request.messages.find((m) => m.content?.includes('"character_directory"')).content);
      assert.ok(directory.characters.some((c) => c.id === "char_A"));
      return { finishReason: "tool_calls", toolCalls: [{ id: "offscene", type: "function",
        function: { name: "get_character", arguments: '{"characterId":"char_A"}' } }] };
    } });
  assert.ok(built.trace.recordIds.includes("char_A"));
  assert.ok(built.trace.eventIds.includes("A_knows"));
  assert.ok(built.apiMessages.some((m) => m.role === "tool" && m.content.includes("grieving")));
});

function chunkFirestoreHarness() {
  const documents = new Map(), reads = [], writes = [];
  const snap = (path) => ({ exists: () => documents.has(path), data: () => structuredClone(documents.get(path)) });
  const api = {
    doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"),
    query: (target) => target, orderBy: () => null, limit: () => null,
    getDocFromServer: async (path) => { reads.push(path); return snap(path); },
    getDocsFromServer: async (path) => {
      reads.push(path);
      return { docs: [...documents.keys()].filter((key) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"))
        .map((key) => ({ data: () => structuredClone(documents.get(key)) })) };
    },
    serverTimestamp: () => "now",
    runTransaction: async (_db, callback) => {
      const changes = [];
      const result = await callback({ get: async (path) => snap(path),
        set: (path, data) => changes.push([path, data]),
        update: (path, data) => changes.push([path, { ...documents.get(path), ...data }]) });
      changes.forEach(([path, data]) => { writes.push(path); documents.set(path, structuredClone(data)); });
      return result;
    },
    writeBatch: () => {
      const changes = [];
      return { set: (path, data) => changes.push([path, data]), commit: async () => {
        changes.forEach(([path, data]) => { writes.push(path); documents.set(path, structuredClone(data)); });
      } };
    },
  };
  const base = "users/u/sessions/s/continuityBranches/main";
  documents.set("users/u/sessions/s", { continuityEnabled: true, continuityBranchId: "main" });
  return { documents, reads, writes, base,
    store: createFirestoreStoryStore({ api, db: {}, uid: "u", sessionId: "s" }) };
}

test("Firestore groups characters and their related state into one read and writes only changed chunks", async () => {
  const h = chunkFirestoreHarness();
  const { state, setup } = await hostileMotherStory();
  await h.store.initialize({ state, messages: [setup], initializationId: "init_chunks" });
  assert.equal(h.writes.filter((path) => path.includes("/recordChunks/")).length, 1);
  assert.equal(h.writes.filter((path) => path.includes("/records/")).length, 0);
  const loaded = await h.store.load("main");
  assert.deepEqual({ ...loaded.state, events: [...loaded.state.events].sort((a, b) => a.id.localeCompare(b.id)), records: [...loaded.state.records].sort((a, b) => a.id.localeCompare(b.id)) },
    { ...state, events: [...state.events].sort((a, b) => a.id.localeCompare(b.id)), records: [...state.records].sort((a, b) => a.id.localeCompare(b.id)) });
  assert.ok(h.reads.includes(h.base + "/recordChunks"));
  assert.ok(!h.reads.includes(h.base + "/records"));
  h.writes.length = 0;
  await runSaverTurn({ store: h.store, branchId: "main", turnId: "chunk_update", mode: "author",
    input: "A is tense and the player is injured.", settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({
      narration: "The current conditions are recorded.",
      events: [{ id: "conditions", kind: "author_setup", description: "A is tense and the player is injured.",
        entityIds: ["char_A", "player"], supersedes: [], evidence: [{ from: "input", quote: "A is tense and the player is injured." }] }],
      operations: ["char_A", "player"].map((id) => {
        const old = state.records.find((r) => r.id === id);
        return { record: { id, kind: "character", data: { ...old.data,
          ...(id === "char_A" ? { emotion: "tense" } : { condition: "injured" }) } }, reason: "Author establishes conditions.",
          eventIds: ["conditions"], evidence: [{ from: "input", quote: "A is tense and the player is injured." }] };
      }),
    }) }) });
  assert.equal(h.writes.filter((path) => path.includes("/recordChunks/")).length, 1);
  assert.equal((await h.store.load("main")).state.records.find((r) => r.id === "char_A").data.emotion, "tense");
  h.writes.length = 0;
  await runSaverTurn({ store: h.store, branchId: "main", turnId: "chunk_unchanged", input: "I wait.", settings: settings(), count,
    complete: async () => ({ finishReason: "stop", content: JSON.stringify({ narration: "A stays distant.", events: [], operations: [] }) }) });
  assert.equal(h.writes.filter((path) => path.includes("/recordChunks/")).length, 0);
});

test("legacy Firestore state converts once without changing story revision or deleting source records", async () => {
  const h = chunkFirestoreHarness();
  const { state, setup } = await hostileMotherStory();
  await h.store.initialize({ state, messages: [setup], initializationId: "init_legacy" });
  const head = h.documents.get(h.base);
  delete head.recordStorageVersion; delete head.recordChunkCount;
  for (const key of [...h.documents.keys()]) if (key.includes("/recordChunks/")) h.documents.delete(key);
  state.records.forEach((record) => h.documents.set(h.base + "/records/" + record.id, record));
  h.writes.length = 0;
  const loaded = (await h.store.load("main")).state;
  assert.deepEqual({ ...loaded, events: [...loaded.events].sort((a, b) => a.id.localeCompare(b.id)), records: [...loaded.records].sort((a, b) => a.id.localeCompare(b.id)) },
    { ...state, events: [...state.events].sort((a, b) => a.id.localeCompare(b.id)), records: [...state.records].sort((a, b) => a.id.localeCompare(b.id)) });
  assert.equal(h.documents.get(h.base).recordStorageVersion, 2);
  assert.equal(h.documents.get(h.base).revision, state.revision);
  assert.equal(h.writes.filter((path) => path.includes("/recordChunks/")).length, 1);
  assert.ok(h.documents.has(h.base + "/records/char_A"));
  h.reads.length = 0; h.writes.length = 0;
  await h.store.load("main");
  assert.equal(h.writes.length, 0);
  assert.ok(!h.reads.includes(h.base + "/records"));
  h.documents.delete(h.base + "/recordChunks/chunk_000000");
  await assert.rejects(h.store.load("main"), /Missing or invalid/);
});


test("migration excludes archived history and prose preferences, streams extraction, and reports truncated usage", async () => {
  const progress = [];
  let calls = 0;
  await assert.rejects(prepareContinuityMigration({
    legacyMessages: [{ id: "old", order: 1, role: "assistant", content: "ARCHIVED_SECRET_HISTORY" }],
    authorNote: "A is grieving.", settings: settings({ endpoint: "https://openrouter.ai/api/v1/chat/completions",
      continuityStylePrompt: "CUSTOM_NARRATOR_PROMPT", reasoning: { enabled: true, effort: "high" } }), count,
    onProgress: (stats) => progress.push(stats), complete: async (request) => {
      calls++;
      assert.equal(request.settings.streaming, true);
      assert.equal(request.settings.reasoning.enabled, true);
      assert.deepEqual(buildRequestBody(request.settings, request.messages).reasoning, { effort: "high" });
      assert.deepEqual(request.responseFormat, { type: "json_object" });
      assert.ok(!JSON.stringify(request.messages).includes("ARCHIVED_SECRET_HISTORY"));
      assert.ok(!JSON.stringify(request.messages).includes("CUSTOM_NARRATOR_PROMPT"));
      assert.equal(JSON.parse(request.messages[1].content).sources.length, 2);
      return { finishReason: "length", content: '{"patch":', thinking: "thinking", usage: {
        completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1900 } } };
    },
  }), /1,900 reasoning/);
  assert.equal(calls, 1, "Truncation must not trigger an automatic paid retry");
  assert.equal(progress.at(-1).usage.completion_tokens, 2000);
  assert.equal(progress.at(-1).finishReason, "length");
  assert.equal(progress.at(-1).receivedCharacters, 9);
});

test("migration accepts more than fifty distinct facts and preserves them through replay", async () => {
  const facts = Array.from({ length: 60 }, (_, i) => `Region ${i} has its own treaty.`);
  const note = facts.join("\n");
  const complete = async (request) => {
    assert.ok(request.messages[0].content.includes('"maxItems":500'));
    assert.ok(request.messages[0].content.includes("brevity is a preference"));
    const packet = JSON.parse(request.messages[1].content);
    const author = packet.sources.find((source) => source.role === "author");
    const ref = (quote) => ({ messageId: author.id, revision: author.revision, contentHash: author.contentHash, quote });
    const events = facts.map((fact, i) => ({ id: `treaty_event_${i}`, kind: "author_setup", description: fact,
      entityIds: [], sources: [ref(fact)], supersedes: [] }));
    const operations = facts.map((fact, i) => ({ type: "put_record", record: { id: `treaty_${i}`, kind: "world_fact",
      data: { proposition: fact, entityIds: [], visibility: "public" } }, expectedVersion: 0,
      reason: "Author-established treaty.", eventIds: [`treaty_event_${i}`], sources: [ref(fact)] }));
    return { finishReason: "stop", content: JSON.stringify(review(packet.branchId, packet.baseRevision, packet.turnId, events, operations)) };
  };
  const prepared = await prepareContinuityMigration({ legacyMessages: [{ id: "old", order: 1, role: "assistant", content: "The council waits." }],
    authorNote: note, settings: settings({ maxResponseTokens: 16384 }), complete, count });
  assert.equal(prepared.state.records.length, 60);
  assert.equal(prepared.state.events.length, 60);
  assert.deepEqual(prepared.state.records.map((r) => r.data.proposition), facts);
  const store = createMemoryStoryStore();
  await store.initialize({ state: createStoryState("main"), messages: [] });
  await runContinuityTurn({ store, branchId: "main", turnId: "large_migration", mode: "author", input: note,
    migrationReview: true, draftOverride: "Migration note received.", settings: settings({ maxResponseTokens: 16384 }), complete, count });
  const replayed = await forkAtRevision(store, "main", 1, "replayed_migration");
  assert.equal(replayed.state.records.length, 60);
});

test("migration refusals report one extraction attempt rather than two rejected narrator drafts", async () => {
  let calls = 0;
  await assert.rejects(prepareContinuityMigration({ legacyMessages: [{ id: "old", order: 1, role: "assistant", content: "The scene waits." }],
    authorNote: "The scene is both empty and occupied at the same instant.", settings: settings(), count,
    complete: async (request) => {
      calls++;
      const packet = JSON.parse(request.messages[1].content);
      return { finishReason: "stop", content: JSON.stringify({ verdict: "reject", violations: ["Clarify the contradictory scene occupancy."],
        patch: { branchId: packet.branchId, baseRevision: packet.baseRevision, turnId: packet.turnId, events: [], operations: [] } }) };
    } }), /Migration state extraction rejected the note: Clarify/);
  assert.equal(calls, 1);
});

function migrationProfileReview(packet, facts) {
  const author = packet.sources.find((source) => source.role === "author");
  const ref = (quote) => ({ messageId: author.id, revision: author.revision, contentHash: author.contentHash, quote });
  const events = facts.map((fact, i) => ({ id: `profile_event_${i}`, kind: "author_setup",
    description: fact, entityIds: ["char_A"], sources: [ref(fact)], supersedes: [] }));
  const operations = facts.slice(0, 16).map((fact, i) => ({ type: "put_record", record: {
    id: `fact_${i}`, kind: "world_fact", data: { proposition: fact, entityIds: ["char_A"], visibility: "public" },
  }, expectedVersion: 0, reason: "Author-established fact.", eventIds: [events[i].id], sources: [ref(fact)] }));
  operations.push({ type: "put_record", record: { id: "char_A", kind: "character", data: {
    name: "A", aliases: [], controller: "narrator", personality: "", background: facts.join("\n"),
    voice: "", emotion: "", condition: "", goals: [], intentions: [],
  } }, expectedVersion: 0, reason: "Author establishes A's complete history.",
  eventIds: events.map((event) => event.id), sources: [ref(facts[0])] });
  return review(packet.branchId, packet.baseRevision, packet.turnId, events, operations);
}

test("migration preserves more than fifty event references on a single profile through validation and replay", async () => {
  const facts = Array.from({ length: 60 }, (_, i) => `A acquired artifact ${i}.`);
  const note = facts.join("\n");
  const complete = async (request) => {
    const schema = JSON.parse(request.messages[0].content.split("\nSCHEMA:\n")[1]);
    assert.equal(schema.properties.patch.properties.operations.items.properties.eventIds.maxItems, 500);
    const packet = JSON.parse(request.messages[1].content);
    return { finishReason: "stop", content: JSON.stringify(migrationProfileReview(packet, facts)) };
  };
  const prepared = await prepareContinuityMigration({ legacyMessages: [
    { id: "old", order: 1, role: "assistant", content: "A waits in the archive." },
  ], authorNote: note, settings: settings({ maxResponseTokens: 16384 }), complete, count });
  assert.equal(prepared.state.records[16].eventIds.length, 60);
  assert.equal(prepared.state.records[16].data.background, note);
  const store = createMemoryStoryStore();
  await store.initialize({ state: createStoryState("main") });
  await runContinuityTurn({ store, branchId: "main", turnId: "profile_migration", mode: "author", input: note,
    migrationReview: true, draftOverride: "Migration note received.", settings: settings(), complete, count });
  const replayed = await forkAtRevision(store, "main", 1, "profile_replay");
  assert.deepEqual(replayed.state.records[16].eventIds, prepared.state.records[16].eventIds);
});

test("migration event reference bounds remain explicit and normal turns retain their smaller cap", async () => {
  const source = await sourceMessage({ id: "author", role: "author", order: 1, content: "A acquired artifact 0." });
  const packet = { branchId: "main", baseRevision: 0, turnId: "limits", sources: [source] };
  const candidate = migrationProfileReview(packet, [source.content]);
  const op = candidate.patch.operations.at(-1);
  op.eventIds = Array.from({ length: 51 }, (_, i) => `event_${i}`);
  validate(MIGRATION_REVIEW_SCHEMA, candidate);
  assert.throws(() => validate(REVIEW_SCHEMA, candidate), /received 51; expected 1 to 50 items/);
  op.eventIds = [];
  assert.throws(() => validate(MIGRATION_REVIEW_SCHEMA, candidate), /received 0; expected 1 to 500 items/);
  op.eventIds = Array.from({ length: 501 }, (_, i) => `event_${i}`);
  assert.throws(() => validate(MIGRATION_REVIEW_SCHEMA, candidate), /received 501; expected 1 to 500 items/);
});

for (const shape of ['repeated metadata', 'flattened patch']) {
  test(`migration accepts ${shape} without losing state or making another model request`, async () => {
    const facts = Array.from({ length: 60 }, (_, i) => `A acquired artifact ${i}.`);
    let calls = 0;
    const prepared = await prepareContinuityMigration({ legacyMessages: [
      { id: 'old', order: 1, role: 'assistant', content: 'A waits in the archive.' },
    ], authorNote: facts.join('\n'), settings: settings(), count, complete: async (request) => {
      calls++;
      const packet = JSON.parse(request.messages[1].content);
      const candidate = migrationProfileReview(packet, facts);
      const output = shape === 'repeated metadata'
        ? { ...candidate, branchId: candidate.patch.branchId, baseRevision: candidate.patch.baseRevision, turnId: candidate.patch.turnId }
        : { verdict: candidate.verdict, violations: candidate.violations, ...candidate.patch };
      return { finishReason: 'stop', content: JSON.stringify(output) };
    } });
    assert.equal(calls, 1);
    assert.equal(prepared.state.records.length, 17);
    assert.equal(prepared.state.events.length, 60);
    assert.equal(prepared.state.records[16].eventIds.length, 60);
    assert.equal(prepared.state.records[16].data.background, facts.join('\n'));
  });
}

test('migration normalization rejects conflicts and retains unknown fields for strict validation', () => {
  const canonical = review('main', 0, 'normalize');
  assert.throws(() => normalizeMigrationReview({ ...canonical, branchId: 'other' }), /Conflicting migration review field: branchId/);
  assert.throws(() => normalizeMigrationReview({ ...canonical, events: [{ id: 'extra' }] }), /Conflicting migration review field: events/);
  const unknown = normalizeMigrationReview({ ...canonical, branchId: 'main', commentary: 'Extra output' });
  assert.throws(() => validate(MIGRATION_REVIEW_SCHEMA, unknown), /unknown field commentary/);
  const missing = normalizeMigrationReview({ ...canonical.patch });
  assert.throws(() => validate(MIGRATION_REVIEW_SCHEMA, missing), /missing verdict/);
  assert.throws(() => normalizeMigrationReview({ ...canonical, patch: null, branchId: 'main' }), /patch must be an object/);
  assert.equal(Object.hasOwn(canonical, 'branchId'), false, 'Normalization does not mutate the original response');
});

test('migration normalization recognizes identical duplicated patch data regardless of object key order', () => {
  const canonical = review('main', 0, 'identical');
  canonical.patch.events = [{ id: 'same', description: 'Same data' }];
  const normalized = normalizeMigrationReview({ ...canonical, events: [{ description: 'Same data', id: 'same' }] });
  assert.deepEqual(normalized.patch.events, canonical.patch.events);
  assert.equal(Object.hasOwn(normalized, 'events'), false);
});

for (const evidenceMode of ["quote_only", "incorrect_hash_and_revision"]) {
  test(`migration builds authoritative provenance from ${evidenceMode} evidence`, async () => {
    const note = "A acquired artifact 0.";
    const prepared = await prepareContinuityMigration({ legacyMessages: [
      { id: "old", order: 1, role: "assistant", content: "A waits." },
    ], authorNote: note, settings: settings(), count, complete: async (request) => {
      const schema = JSON.parse(request.messages[0].content.split("\nSCHEMA:\n")[1]);
      assert.deepEqual(Object.keys(schema.properties.patch.properties.events.items.properties.sources.items.properties), ["quote"]);
      const packet = JSON.parse(request.messages[1].content);
      const output = migrationProfileReview(packet, [note]);
      for (const item of [...output.patch.events, ...output.patch.operations]) {
        item.sources = evidenceMode === "quote_only" ? [{ quote: note }]
          : item.sources.map((ref) => ({ ...ref, revision: 999, contentHash: "wrong-model-generated-hash" }));
      }
      return { finishReason: "stop", content: JSON.stringify(output) };
    } });
    const author = prepared.messages.find((message) => message.role === "author");
    for (const item of [...prepared.state.records, ...prepared.state.events]) {
      for (const ref of item.sources) assert.deepEqual(ref, sourceRef(author, note));
    }
  });
}

test("migration still rejects paraphrased evidence and never retries it automatically", async () => {
  let calls = 0;
  await assert.rejects(prepareContinuityMigration({ legacyMessages: [
    { id: "old", order: 1, role: "assistant", content: "A waits." },
  ], authorNote: "A acquired artifact 0.", settings: settings(), count, complete: async (request) => {
    calls++;
    const output = migrationProfileReview(JSON.parse(request.messages[1].content), ["A acquired artifact 0."]);
    output.patch.events[0].sources = [{ quote: "A found the first artifact." }];
    return { finishReason: "stop", content: JSON.stringify(output) };
  } }), /Migration evidence for profile_event_0 is not an exact quote/);
  assert.equal(calls, 1);
});

test("migration enables configured thinking but parses and archives only final JSON content", async () => {
  const note = "A acquired artifact 0.";
  const prepared = await prepareContinuityMigration({ legacyMessages: [
    { id: "old", order: 1, role: "assistant", content: "A waits." },
  ], authorNote: note, settings: settings({ reasoning: { enabled: false, mode: "effort", effort: "high" } }), count,
  complete: async (request) => {
    assert.equal(request.settings.reasoning.enabled, true);
    assert.equal(request.settings.reasoning.effort, "high");
    assert.deepEqual(request.responseFormat, { type: "json_object" });
    const output = migrationProfileReview(JSON.parse(request.messages[1].content), [note]);
    return { finishReason: "stop", thinking: "PRIVATE_THINKING_NOT_STORY", content: "```json\n" + JSON.stringify(output) + "\n```" };
  } });
  assert.equal(prepared.state.records.length, 2);
  assert.ok(!JSON.stringify(prepared.messages).includes("PRIVATE_THINKING_NOT_STORY"));
  assert.ok(!JSON.stringify(prepared.state).includes("PRIVATE_THINKING_NOT_STORY"));
});

for (const finishReason of ["stop", "length"]) {
  test(`failed migration ${finishReason} response can be corrected and reused without an LLM call`, async () => {
    const note = "A acquired artifact 0.";
    const legacyMessages = [{ id: "old", order: 1, role: "assistant", content: "A waits." }];
    let recovery, corrected, calls = 0;
    await assert.rejects(prepareContinuityMigration({ legacyMessages, authorNote: note, settings: settings(), count,
      onReviewOutput: (value) => { recovery = value; }, complete: async (request) => {
        calls++;
        corrected = migrationProfileReview(JSON.parse(request.messages[1].content), [note]);
        return { finishReason, content: '{"incomplete":', thinking: "Recovered reasoning" };
      } }));
    assert.equal(recovery.content, '{"incomplete":');
    assert.equal(recovery.thinking, "Recovered reasoning");
    const prepared = await prepareContinuityMigration({ legacyMessages, authorNote: note,
      settings: settings({ maxContextTokens: 10, maxResponseTokens: 100000 }), count,
      migrationTurnId: recovery.turnId, reviewOutputOverride: JSON.stringify(corrected),
      complete: async () => { calls++; throw new Error("A paid call must never occur"); } });
    assert.equal(calls, 1);
    assert.equal(prepared.state.records.length, 2);
    assert.ok(!JSON.stringify(prepared.messages).includes("Recovered reasoning"));
    corrected.patch.events[0].sources = [{ quote: "Invented evidence" }];
    await assert.rejects(prepareContinuityMigration({ legacyMessages, authorNote: note, settings: settings(), count,
      migrationTurnId: recovery.turnId, reviewOutputOverride: JSON.stringify(corrected),
      complete: async () => { calls++; throw new Error("A paid call must never occur"); } }), /not an exact quote/);
    assert.equal(calls, 1);
  });
}


test("malformed migration JSON never interrupts generation; the full response is captured after stream completion", async () => {
  const previousFetch = globalThis.fetch;
  let received, canceled = 0, delivered = 0;
  const pieces = ["INVALID JSON", " keep receiving", " until the final token"];
  const events = [...pieces.map((content) => ({ choices: [{ delta: { content } }] })),
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { completion_tokens: 123 } }];
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      assert.equal(received, undefined, "No JSON validation/capture while model output is still arriving");
      if (delivered < events.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[delivered++])}\n\n`));
      else controller.close();
    },
    cancel() { canceled++; },
  }));
  try {
    await assert.rejects(prepareContinuityMigration({ legacyMessages: [
      { id: "old", order: 1, role: "assistant", content: "A waits." },
    ], authorNote: "A is present.", settings: settings({ apiKey: "test", endpoint: "https://openrouter.ai/api/v1/chat/completions" }), count,
    complete: chatCompletion, onReviewOutput: (output) => { received = output; },
    }), /invalid JSON/);
    assert.equal(delivered, events.length);
    assert.equal(canceled, 0);
    assert.equal(received.content, pieces.join(""));
    assert.equal(received.usage.completion_tokens, 123);
  } finally { globalThis.fetch = previousFetch; }
});
