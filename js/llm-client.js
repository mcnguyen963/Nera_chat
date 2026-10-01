// OpenAI-compatible chat client with SSE streaming + reasoning/thinking handling (spec §7).
// - delta.content  -> visible response, becomes message.content
// - delta.reasoning -> collapsible "thinking" pane, becomes message.thinking.
//                      Stored for reference but NEVER re-sent in context (spec §6/§7).

export function buildRequestBody(settings, messages) {
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
  return body;
}

function headers(settings) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

function responseError(data) {
  const detail = data?.error?.message ?? data?.error;
  return new Error("API error: " + (typeof detail === "string" ? detail : JSON.stringify(detail ?? data)));
}

function checkFinishReason(reason) {
  if (reason === "length") {
    throw new Error("The model stopped at its output limit. The incomplete reply was not saved.");
  }
  if (reason && reason !== "stop") {
    throw new Error(`The model stopped with ${reason}; the incomplete reply was not saved.`);
  }
}

export async function chatCompletion({ settings, messages, onDelta, onReasoning, signal }) {
  if (!settings.modelId) throw new Error("No model ID set — configure it in Settings.");
  if (!settings.endpoint) throw new Error("No endpoint set — configure it in Settings.");

  if (!settings.streaming) {
    return nonStreamedCompletion({ settings, messages, signal });
  }
  return streamedCompletion({ settings, messages, onDelta, onReasoning, signal });
}

async function nonStreamedCompletion({ settings, messages, signal }) {
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(buildRequestBody(settings, messages)),
    signal,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error || !data.choices?.[0]?.message) throw responseError(data);
  checkFinishReason(data.choices[0].finish_reason);
  const msg = data.choices[0].message;
  if (typeof msg.content !== "string" || !msg.content.trim()) {
    throw new Error("The model returned no reply; nothing was saved.");
  }
  return {
    content: msg.content ?? "",
    thinking: msg.reasoning ?? null,
    usage: data.usage ?? null,
  };
}

async function streamedCompletion({ settings, messages, onDelta, onReasoning, signal }) {
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ ...buildRequestBody(settings, messages), stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

  let content = "";
  let thinking = "";
  let usage = null;
  let completed = false;
  let finishReason = null;

  if (!res.body) throw new Error("The model returned no response stream.");
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
    if (payload === "[DONE]") { completed = true; return; }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error("The model returned a malformed response event.");
    }
    if (json.error) throw responseError(json);
    if (!Array.isArray(json.choices) && !json.usage) throw responseError(json);
    const delta = json.choices?.[0]?.delta ?? {};
    if (json.choices?.[0]?.finish_reason) {
      finishReason = json.choices[0].finish_reason;
      completed = true;
    }
    if (delta.content && typeof delta.content !== "string") throw responseError(json);
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
  if (!completed) throw new Error("The model response stream ended before completion. The partial reply was not saved.");
  checkFinishReason(finishReason);
  if (!content.trim()) throw new Error("The model returned no reply; nothing was saved.");

  return {
    content,
    thinking: thinking || null,
    usage,
  };
}
