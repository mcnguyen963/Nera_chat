import { NARRATOR_TOOLS, createStoryTools, requireCompletedResponse } from "./tools.js";
import { requestTokenCount, inputBudget, completionBudgetInstruction } from "./context.js";
import { BALANCED_PREPARE_POLICY } from "./prompts.js";

export const BALANCED_TOOLS = NARRATOR_TOOLS.filter((tool) =>
  ["get_character", "search_story_events"].includes(tool.function.name));

// Resolve a separate connection without switching or mutating the active profile.
export function balancedPreparationSettings(settings) {
  const config = settings.balancedPreparation ?? {};
  const result = structuredClone(settings);
  if (config.profileId && config.profileId !== settings.activeProfileId) {
    const profile = settings.profiles?.find((item) => item.id === config.profileId);
    if (!profile) throw new Error("Balanced first-call profile no longer exists. Select another profile in Settings.");
    const defaults = { endpoint: "https://openrouter.ai/api/v1/chat/completions", apiKey: "", modelId: "",
      maxResponseTokens: 8192, advancedParametersEnabled: false,
      temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null };
    for (const [key, fallback] of Object.entries(defaults)) result[key] = profile[key] ?? fallback;
    if (profile.modelContextTokens !== undefined) result.modelContextTokens = profile.modelContextTokens;
    // A different model must not inherit the narrator model's context limit.
    if (profile.modelContextTokens === undefined) delete result.modelContextTokens;
    result.reasoning = structuredClone(profile.reasoning ?? { enabled: false });
  }
  const mode = config.thinkingMode ?? "off";
  if (mode === "off") result.reasoning = { enabled: false };
  else if (mode === "effort") {
    const effort = config.effort ?? "medium";
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error("Invalid Balanced first-call thinking effort.");
    result.reasoning = { enabled: true, mode: "effort", effort };
  } else if (mode === "max_tokens") {
    const maxTokens = Number(config.maxTokens);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens >= result.maxResponseTokens)
      throw new Error("Balanced thinking budget must be positive and below the first-call profile's max response tokens.");
    result.reasoning = { enabled: true, mode: "max_tokens", maxTokens };
  } else if (mode !== "profile") throw new Error("Invalid Balanced first-call thinking mode.");
  result.streaming = false;
  return result;
}

export function balancedPreparationPolicy(settings) {
  return `${BALANCED_PREPARE_POLICY}\n\n${completionBudgetInstruction(settings, "lookup")}`;
}

export function balancedPreparationMessages(built, state) {
  const messages = structuredClone(built.apiMessages);
  messages.splice(2, 0, { role: "user", content: JSON.stringify({ type: "character_directory",
    characters: state.records.filter((r) => r.kind === "character").map((r) =>
      ({ id: r.id, name: r.data.name, aliases: r.data.aliases })) }) });
  return messages;
}

export function balancedNarrationPolicy(policy) {
  return policy + "\nBalanced mode: the read-only lookup batch is complete. Tool results are reference evidence, not new events or character knowledge. No more tools are available. Preserve uncertainty when results are missing. Produce narration and supported state changes using the output schema; agenda changes belong in operations after narration.";
}

// One read-only tool batch, followed by the caller's narration/state request.
export async function prepareBalancedContext({ built, state, settings, policy, complete, count, signal }) {
  const messages = balancedPreparationMessages(built, state);
  const preparationSettings = balancedPreparationSettings(settings);
  const budget = inputBudget(preparationSettings);
  const preparationInputTokens = await requestTokenCount(messages, BALANCED_TOOLS, count);
  if (preparationInputTokens > budget)
    throw new Error("Balanced preparation exceeds the context budget.");
  signal?.throwIfAborted();
  const response = await complete({ settings: preparationSettings, messages,
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
  messages[1] = { role: "system", content: balancedNarrationPolicy(policy) };
  const narrationInputTokens = await requestTokenCount(messages, [], count);
  if (narrationInputTokens > inputBudget(settings))
    throw new Error("Balanced tool results exceed the context budget.");
  built.apiMessages = messages;
  built.trace.recordIds = [...new Set([...built.trace.recordIds, ...executor.retrievedRecordIds])];
  built.trace.eventIds = [...new Set([...built.trace.eventIds, ...executor.retrievedEventIds])];
  const preparationContextLimit = Math.min(preparationSettings.maxContextTokens,
    preparationSettings.modelContextTokens ?? Infinity);
  const narrationContextLimit = Math.min(settings.maxContextTokens, settings.modelContextTokens ?? Infinity);
  return { tools: trace, usage: response.usage ?? null, model: preparationSettings.modelId,
    context: { preparationInputTokens, preparationContextLimit, narrationInputTokens, narrationContextLimit },
    profileId: settings.balancedPreparation?.profileId || settings.activeProfileId || null,
    thinkingMode: settings.balancedPreparation?.thinkingMode ?? "off" };
}
