import { object, id, integer, string, RECORD_DATA, validate } from "./schema.js";
import { activeEvents } from "./state.js";
import { selectContinuity, requestTokenCount, inputBudget } from "./context.js";

const definitions = [
  ["get_character", "Get an established character's state, relationships, knowledge, consequences, and supporting events. This does not advance the story.", object({ characterId: id })],
  ["search_story_events", "Search established event descriptions for historical evidence. Results do not grant character knowledge.", object({ query: string(500) })],
  ["propose_plan_update", "Propose a noncanonical agenda change. This does not save a plan or establish events; the continuity reviewer must accept it.",
    object({ agendaId: id, expectedVersion: integer, agenda: RECORD_DATA.agenda, reason: string() })],
];
export const NARRATOR_TOOLS = definitions.map(([name, description, parameters]) => ({ type: "function", function: { name, description, parameters } }));

export function createStoryTools(state) {
  const proposals = [];
  const retrievedRecordIds = new Set();
  const retrievedEventIds = new Set();
  return {
    proposals, retrievedRecordIds, retrievedEventIds,
    async execute(name, args) {
      const definition = NARRATOR_TOOLS.find((tool) => tool.function.name === name);
      if (!definition) throw new Error(`Unknown story tool: ${name}`);
      validate(definition.function.parameters, args, name);
      if (name === "get_character") {
        if (!state.records.some((r) => r.kind === "character" && r.id === args.characterId)) return { found: false };
        const result = selectContinuity(state, "", [args.characterId]);
        result.records.forEach((r) => retrievedRecordIds.add(r.id));
        result.events.forEach((e) => retrievedEventIds.add(e.id));
        return { found: true, records: result.records, events: result.events };
      }
      if (name === "search_story_events") {
        const words = [...new Set(args.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
        const events = activeEvents(state).map((event) => ({ event,
          score: words.filter((word) => event.description.toLowerCase().includes(word)).length }))
          .filter((entry) => entry.score).sort((a, b) => b.score - a.score || b.event.sequence - a.event.sequence).slice(0, 6).map(({ event }) => event);
        events.forEach((e) => retrievedEventIds.add(e.id));
        return { events };
      }
      const existing = state.records.find((r) => r.id === args.agendaId);
      if ((existing?.version ?? 0) !== args.expectedVersion || (existing && existing.kind !== "agenda")) throw new Error("Stale agenda version.");
      if (args.agenda.origin === "author" && !existing) throw new Error("A narrator tool cannot create an author direction.");
      if (existing?.data.origin === "author" && (args.agenda.direction !== existing.data.direction || args.agenda.origin !== "author"))
        throw new Error("The narrator cannot replace an author direction.");
      if (proposals.some((p) => p.agendaId === args.agendaId)) throw new Error("Only one proposal per agenda per turn.");
      proposals.push(structuredClone(args));
      return { proposed: true, saved: false, agendaId: args.agendaId };
    },
  };
}

export function requireCompletedResponse(result, allowTools = false) {
  if (result.finishReason !== "stop" && !(allowTools && result.finishReason === "tool_calls"))
    throw new Error(`Incomplete model response (${result.finishReason ?? "missing finish reason"}).`);
  if (result.toolCalls?.length && !allowTools) throw new Error("Unexpected tool calls.");
}

// Bounded, sequential tool loop. Write tools stage proposals only. The assistant
// call and matching tool results remain in this request, not in story history.
export async function runNarratorTools({ complete, settings, messages, executor, signal,
  count, maxRounds = 3, maxCalls = 8 }) {
  const transcript = structuredClone(messages);
  const seen = new Set();
  const trace = [];
  for (let round = 0; round <= maxRounds; round++) {
    signal?.throwIfAborted();
    if (await requestTokenCount(transcript, NARRATOR_TOOLS, count) > inputBudget(settings))
      throw new Error("Tool results exceed the context budget.");
    const result = await complete({ settings, messages: transcript, tools: NARRATOR_TOOLS,
      toolChoice: round === maxRounds ? "none" : "auto", signal });
    requireCompletedResponse(result, true);
    const calls = result.toolCalls ?? [];
    if (calls.length && result.finishReason !== "tool_calls") throw new Error("Tool calls arrived without a tool_calls finish reason.");
    if (!calls.length && result.finishReason === "tool_calls") throw new Error("Model finished a tool turn without a tool call.");
    if (!calls.length) {
      if (result.finishReason !== "stop" || !result.content?.trim()) throw new Error("Narrator returned no complete narration.");
      return { ...result, trace };
    }
    if (round === maxRounds || seen.size + calls.length > maxCalls) throw new Error("Story tool call limit reached.");
    transcript.push({ role: "assistant", content: result.content || null, tool_calls: calls });
    for (const call of calls) {
      if (!call.id || seen.has(call.id) || call.type !== "function") throw new Error("Invalid or duplicate tool call.");
      seen.add(call.id);
      let output;
      try {
        const args = JSON.parse(call.function.arguments);
        output = await executor.execute(call.function.name, args);
      } catch (error) { output = { error: error.message }; }
      transcript.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      trace.push({ name: call.function.name, ok: !output.error });
    }
  }
  throw new Error("Story tool loop did not finish.");
}
