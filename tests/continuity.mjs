import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContinuityContext } from "../js/continuity/context.js";
import { createStoryState, sourceMessage, sourceRef, applyContinuityPatch } from "../js/continuity/state.js";
import { createMemoryStoryStore, forkAtRevision } from "../js/continuity/store.js";
import { createFirestoreStoryStore } from "../js/continuity/firestore-store.js";
import { createStoryTools, NARRATOR_TOOLS, runNarratorTools } from "../js/continuity/tools.js";
import { runContinuityTurn } from "../js/continuity/turn-controller.js";
import { buildRequestBody } from "../js/llm-client.js";

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
  assert.deepEqual(JSON.parse(built.apiMessages[1].content),
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
