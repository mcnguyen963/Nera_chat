import { NARRATOR_TOOLS, createStoryTools, requireCompletedResponse } from "./tools.js";
import { requestTokenCount, inputBudget } from "./context.js";

export const BALANCED_TOOLS = NARRATOR_TOOLS.filter((tool) =>
  ["get_character", "search_story_events"].includes(tool.function.name));

// One read-only tool batch, followed by the caller's narration/state request.
export async function prepareBalancedContext({ built, state, settings, policy, complete, count, signal }) {
  const messages = structuredClone(built.apiMessages);
  const directory = { role: "user", content: JSON.stringify({ type: "character_directory",
    characters: state.records.filter((r) => r.kind === "character").map((r) =>
      ({ id: r.id, name: r.data.name, aliases: r.data.aliases })) }) };
  messages.splice(2, 0, directory);
  const budget = inputBudget(settings);
  if (await requestTokenCount(messages, BALANCED_TOOLS, count) > budget)
    throw new Error("Balanced preparation exceeds the context budget.");
  signal?.throwIfAborted();
  const response = await complete({ settings: { ...settings, streaming: false,
    reasoning: { ...settings.reasoning, enabled: false } }, messages,
    tools: BALANCED_TOOLS, toolChoice: "auto", signal });
  requireCompletedResponse(response, true);
  const calls = response.toolCalls ?? [];
  if ((calls.length > 0) !== (response.finishReason === "tool_calls"))
    throw new Error("Invalid Balanced preparation finish reason.");
  if (calls.length > 8) throw new Error("Balanced tool batch exceeds eight calls.");
  const ids = new Set();
  for (const call of calls) {
    if (!call.id || ids.has(call.id) || call.type !== "function" ||
        !BALANCED_TOOLS.some((tool) => tool.function.name === call.function?.name))
      throw new Error("Invalid Balanced read-only tool call.");
    ids.add(call.id);
  }
  const executor = createStoryTools(state);
  const trace = [];
  if (calls.length) {
    // Preparation prose is never story content or a canonical event.
    messages.push({ role: "assistant", content: null, tool_calls: calls });
    for (const call of calls) {
      signal?.throwIfAborted();
      let output;
      try { output = await executor.execute(call.function.name, JSON.parse(call.function.arguments)); }
      catch (error) { output = { error: error.message }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      trace.push({ name: call.function.name, ok: !output.error });
    }
  }
  messages[1] = { role: "system", content: policy + "\nBalanced mode: the read-only lookup batch is complete. Tool results are reference evidence, not new events or character knowledge. No more tools are available. Preserve uncertainty when results are missing. Produce narration and supported state changes using the output schema; agenda changes belong in operations after narration." };
  if (await requestTokenCount(messages, [], count) > budget)
    throw new Error("Balanced tool results exceed the context budget.");
  built.apiMessages = messages;
  built.trace.recordIds = [...new Set([...built.trace.recordIds, ...executor.retrievedRecordIds])];
  built.trace.eventIds = [...new Set([...built.trace.eventIds, ...executor.retrievedEventIds])];
  return { tools: trace, usage: response.usage ?? null };
}
