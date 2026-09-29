// OpenAI-compatible chat client with SSE streaming + reasoning/thinking handling (spec §7).
// - delta.content  -> visible response, becomes message.content
// - delta.reasoning -> collapsible "thinking" pane, becomes message.thinking.
//                      Stored for reference but NEVER re-sent in context (spec §6/§7).

export function buildRequestBody(settings, messages, options = {}) {
  const body = {
    model: settings.modelId,
    messages,
    max_tokens: settings.maxResponseTokens,
  };
  if (settings.advancedParametersEnabled) {
    for (const [key, parameter] of [["temperature", "temperature"], ["topP", "top_p"], ["frequencyPenalty", "frequency_penalty"], ["presencePenalty", "presence_penalty"]]) {
      const value = settings[key];
      if (value !== null && value !== undefined && value !== "") body[parameter] = Number(value);
    }
  }
  const r = settings.reasoning;
  if (r?.enabled) {
    // Never send both effort and max_tokens together (spec §4.1).
    if (r.mode === "effort") {
      body.reasoning = { effort: r.effort };
    } else {
      body.reasoning = { max_tokens: r.maxTokens };
    }
  }
  if (options.tools?.length) body.tools = options.tools;
  if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
  if (options.responseFormat) body.response_format = options.responseFormat;
  return body;
}

function headers(settings) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

export async function chatCompletion(options) {
  const { settings } = options;
  if (!settings.modelId) throw new Error("No model ID set — configure it in Settings.");
  if (!settings.endpoint) throw new Error("No endpoint set — configure it in Settings.");

  if (!settings.streaming) {
    return nonStreamedCompletion(options);
  }
  return streamedCompletion(options);
}

async function nonStreamedCompletion(options) {
  const { settings, messages, signal } = options;
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(buildRequestBody(settings, messages, options)),
    signal,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Completion failed.");
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? "",
    thinking: msg.reasoning ?? null,
    usage: data.usage ?? null,
    toolCalls: msg.tool_calls ?? [],
    finishReason: data.choices?.[0]?.finish_reason ?? null,
  };
}

async function streamedCompletion(options) {
  const { settings, messages, onDelta, onReasoning, signal } = options;
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ ...buildRequestBody(settings, messages, options), stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

  let content = "";
  let thinking = "";
  let usage = null;
  let finishReason = null;
  const calls = new Map();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line) => {
    line = line.trim();
    if (!line) return;
    // OpenRouter sends ":"-prefixed keep-alive comments — skip, do not JSON.parse (spec §14.2).
    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error("Malformed completion stream event.");
    }
    if (json.error) throw new Error(json.error.message || "Completion stream failed.");
    const choice = json.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (finishReason === "error") throw new Error("Completion stream failed.");
    const delta = json.choices?.[0]?.delta ?? {};
    for (const fragment of delta.tool_calls ?? []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0) throw new Error("Invalid tool call index.");
      const call = calls.get(fragment.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (fragment.id) call.id = fragment.id;
      if (fragment.type) call.type = fragment.type;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(fragment.index, call);
    }
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (delta.reasoning) {
      thinking += delta.reasoning;
      onReasoning?.(delta.reasoning);
    }
    // Final content chunk or a trailing usage-only chunk carries usage.
    if (json.usage) usage = json.usage;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    content,
    thinking: thinking || null,
    usage,
    toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    finishReason,
  };
}
