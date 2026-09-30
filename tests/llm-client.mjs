import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, buildRequestBody } from "../js/llm-client.js";

const settings = { endpoint: "https://openrouter.ai/api/v1/chat/completions", modelId: "test", maxResponseTokens: 8192,
  apiKey: "test", streaming: true, reasoning: { enabled: false, mode: "effort", effort: "high" } };

test("explicit reasoning off reaches OpenRouter without altering other providers or high thinking", () => {
  assert.deepEqual(buildRequestBody(settings, []).reasoning, { enabled: false });
  assert.equal(buildRequestBody({ ...settings, endpoint: "https://api.example.com/v1/chat/completions" }, []).reasoning, undefined);
  assert.deepEqual(buildRequestBody({ ...settings, reasoning: { ...settings.reasoning, enabled: true } }, []).reasoning, { effort: "high" });
});

test("stream reports received text and usage even when the model finishes with length", async () => {
  const original = globalThis.fetch;
  const progress = [];
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    const rows = [
      { choices: [{ delta: { reasoning: "Thinking." }, finish_reason: null }] },
      { choices: [{ delta: { content: '{"patch":' }, finish_reason: "length" }] },
      { choices: [], usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8100 } } },
    ];
    const wire = rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(wire);
      controller.enqueue(bytes.slice(0, 35)); controller.enqueue(bytes.slice(35)); controller.close();
    } }));
  };
  try {
    const result = await chatCompletion({ settings, messages: [], onProgress: (stats) => progress.push(stats) });
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(result.finishReason, "length");
    assert.equal(result.usage.completion_tokens, 8192);
    assert.equal(progress.at(-1).receivedCharacters, 9);
    assert.equal(progress.at(-1).reasoningCharacters, 9);
    assert.equal(progress.at(-1).usage.completion_tokens_details.reasoning_tokens, 8100);
  } finally { globalThis.fetch = original; }
});

test("alternate reasoning fields stay separate from final JSON without duplicating primary reasoning", async () => {
  const original = globalThis.fetch;
  try {
    for (const [message, expected] of [
      [{ content: '{"ok":true}', reasoning_content: "Thinking via alias" }, "Thinking via alias"],
      [{ content: '{"ok":true}', reasoning_details: [{ type: "reasoning.text", text: "Detailed thinking" }] }, "Detailed thinking"],
      [{ content: '{"ok":true}', reasoning: "Primary", reasoning_details: [{ type: "reasoning.text", text: "Primary" }] }, "Primary"],
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
      const result = await chatCompletion({ settings: { ...settings, streaming: false }, messages: [] });
      assert.deepEqual(JSON.parse(result.content), { ok: true });
      assert.equal(result.thinking, expected);
    }
  } finally { globalThis.fetch = original; }
});
