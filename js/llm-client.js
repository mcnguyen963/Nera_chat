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
      body.reasoning = {effort:['minimal','low','medium','high','xhigh','max','none'].includes(r.effort) ? r.effort : 'medium'};
    } else {
      body.reasoning = {max_tokens:Math.max(0,Math.min(Number(r.maxTokens)||0,settings.maxResponseTokens-1))};
    }
  }
  if (r?.enabled === false && r.explicitDisable && /^https:\/\/openrouter\.ai\//.test(settings.endpoint)) body.reasoning = {enabled:false};
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

const BAD_FINISH = new Set(['content_filter', 'error', 'tool_calls', 'function_call']);

function finishKind(reason) {
  const kind = String(reason ?? '').toLowerCase();
  return kind === 'length' || kind === 'max_tokens' ? 'length' : kind;
}

function emptyReplyError(reason) {
  return new Error(finishKind(reason) === 'length'
    ? "The output limit left no reply. Raise Max response tokens or lower the reasoning budget."
    : "The model returned no reply; nothing was saved.");
}

function checkFinishReason(reason, allowTruncated) {
  const kind = finishKind(reason);
  if (kind === "length") {
    if (allowTruncated) return;
    throw new Error("The model stopped at its output limit. The incomplete reply was not saved.");
  }
  if (BAD_FINISH.has(kind)) {
    throw new Error(`The model stopped with ${reason}; the incomplete reply was not saved.`);
  }
}

function serializedRequestBody(settings, messages, stream = false, format = {}) {
  const body = { ...buildRequestBody(settings, messages), ...(stream ? { stream: true } : {}),
    ...(format.responseFormat ? { response_format:format.responseFormat } : {}),
    ...(format.provider ? { provider:format.provider } : {}) };
  const serialized = JSON.stringify(body);
  return serialized;
}

export async function chatCompletion(options) {
  const controller=new AbortController();let timer,content='',thinking='';
  const kick=()=>{globalThis.clearTimeout?.(timer);timer=setTimeout(()=>controller.abort('timeout'),120000);timer?.unref?.();};
  const cancel=()=>controller.abort(options.signal?.reason ?? 'user');
  if(options.signal?.aborted)cancel();else options.signal?.addEventListener('abort',cancel,{once:true});
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(Object.assign(new Error(controller.signal.reason==='timeout' ? 'The model stopped responding (120 s).' : 'Stopped.'),{aborted:controller.signal.reason,partial:{content,thinking}}));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  kick();
  try {
    if(controller.signal.aborted)rejectAbort();
    return await Promise.race([unboundedCompletion({...options,signal:controller.signal,kick,onDelta:t=>{content+=t;options.onDelta?.(t);},onReasoning:t=>{thinking+=t;options.onReasoning?.(t);}}),aborted]);
  } finally {globalThis.clearTimeout?.(timer);options.signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);}
}

async function unboundedCompletion({ settings, messages, onDelta, onReasoning, signal, responseFormat, provider, allowTruncated = false, kick }) {
  if (!settings.modelId) throw new Error("No model ID set — configure it in Settings.");
  if (!settings.endpoint) throw new Error("No endpoint set — configure it in Settings.");

  if (!settings.streaming) {
    return nonStreamedCompletion({ settings, messages, signal, responseFormat, provider, allowTruncated, kick });
  }
  return streamedCompletion({ settings, messages, onDelta, onReasoning, signal, responseFormat, provider, allowTruncated, kick });
}

async function nonStreamedCompletion({ settings, messages, signal, responseFormat, provider, allowTruncated }) {
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: serializedRequestBody(settings, messages, false, { responseFormat,provider }),
    signal,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error || !data.choices?.[0]?.message) throw responseError(data);
  const msg = data.choices[0].message;
  if (typeof msg.content !== "string" || !msg.content.trim()) {
    throw emptyReplyError(data.choices[0].finish_reason);
  }
  checkFinishReason(data.choices[0].finish_reason, allowTruncated);
  return {
    content: msg.content ?? "",
    thinking: msg.reasoning ?? null,
    usage: data.usage ?? null,
    finishReason: finishKind(data.choices[0].finish_reason) || null,
  };
}

async function streamedCompletion({ settings, messages, onDelta, onReasoning, signal, responseFormat, provider, allowTruncated, kick }) {
  const res = await fetch(settings.endpoint, {
    method: "POST",
    headers: headers(settings),
    body: serializedRequestBody(settings, messages, true, { responseFormat,provider }),
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

  const cancelReader=()=>{Promise.resolve(reader.cancel?.()).catch(()=>{});};
  signal?.addEventListener('abort',cancelReader,{once:true});
  try {
  while (true) {
    const { done, value } = await reader.read();
    kick?.();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      processLine(line);
    }
  }
  } finally {signal?.removeEventListener('abort',cancelReader);cancelReader();}
  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
  if (!completed) throw new Error("The model response stream ended before completion. The partial reply was not saved.");
  if (!content.trim()) throw emptyReplyError(finishReason);
  checkFinishReason(finishReason, allowTruncated);

  return {
    content,
    thinking: thinking || null,
    usage,
    finishReason: finishKind(finishReason) || null,
  };
}
