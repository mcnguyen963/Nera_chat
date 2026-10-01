import { buildContinuityContext, requestTokenCount, inputBudget } from "./context.js";
import { BALANCED_TOOLS, balancedPreparationSettings, balancedPreparationMessages, balancedNarrationPolicy, balancedPreparationPolicy } from "./balanced.js";
import { saverOutputPolicy } from "./saver.js";
import { TOOL_POLICY } from "./prompts.js";
import { NARRATOR_TOOLS } from "./tools.js";

// Local preview of the next outgoing request. Never runs tools or calls a model.
export async function computeContinuityUsage({ snapshot, settings, continuityMode = "reviewed",
  input = "", mode = "player", stylePrompt = "", count }) {
  const balanced = continuityMode === "balanced";
  const saver = balanced || continuityMode === "saver";
  const policy = saver ? saverOutputPolicy(settings) : TOOL_POLICY;
  const requestSettings = balanced ? balancedPreparationSettings(settings) : settings;
  const tools = balanced ? BALANCED_TOOLS : saver ? [] : NARRATOR_TOOLS;
  const built = await buildContinuityContext({ state: snapshot.state, messages: snapshot.messages,
    input, mode, settings: requestSettings, stylePrompt, tools,
    policy: balanced ? balancedPreparationPolicy(requestSettings) : policy, preview: true, count });
  const entry = async (label, messages, definitions, config) => ({ label,
    usedTokens: await requestTokenCount(messages, definitions, count),
    max: Math.min(config.maxContextTokens, config.modelContextTokens ?? Infinity),
    budget: inputBudget(config) });
  let requests;
  if (balanced) {
    const messages = balancedPreparationMessages(built, snapshot.state);
    const lookup = await entry("Lookup", messages, tools, requestSettings);
    messages[1] = { role: "system", content: balancedNarrationPolicy(policy) };
    // Retrieval results cannot be known before the first call. Report the baseline honestly.
    requests = [lookup, await entry("Narration before lookups", messages, [], settings)];
  } else requests = [await entry("Narrator", built.apiMessages, tools, settings)];
  return { requests, historyMessages: built.trace.historyMessages,
    droppedMessages: built.trace.droppedMessages };
}
