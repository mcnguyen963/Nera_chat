import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

async function client({ streaming, reason, content = 'Narration.' }) {
  const logs = [], requests = [];
  const use = appHarness({ globals: {
    console: { ...console, log: (...args) => logs.push(args) },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const choice = { finish_reason: reason, message: { content }, delta: { content } };
      const bytes = new TextEncoder().encode('data: '+JSON.stringify({ choices: [choice] })+'\ndata: [DONE]\n');
      let sent = false;
      return { ok: true, json: async () => ({ choices: [choice] }), body: { getReader: () => ({ read: async () => {
        if (sent) return { done: true };
        sent = true; return { done: false, value: bytes };
      } }) } };
    },
  } });
  const api = await use('llm-client.js');
  return { logs, requests, call: options => api.chatCompletion({ settings: { modelId: 'test', endpoint: 'https://example.test', streaming }, messages: [], ...options }) };
}

for (const streaming of [false, true]) {
  test(`P0.6 ${streaming ? 'streamed' : 'non-streamed'} finish reasons preserve strict callers and opt in to truncated narration`, async () => {
    for (const reason of ['length', 'MAX_TOKENS']) {
      const h = await client({ streaming, reason });
      await assert.rejects(h.call(), /output limit/);
      assert.equal((await h.call({ allowTruncated: true })).finishReason, 'length');
    }
    for (const reason of ['STOP', 'end_turn', 'eos', null]) {
      const h = await client({ streaming, reason });
      assert.equal((await h.call()).finishReason, reason?.toLowerCase() ?? null);
    }
    for (const reason of ['content_filter', 'error', 'tool_calls', 'function_call']) {
      const h = await client({ streaming, reason });
      await assert.rejects(h.call({ allowTruncated: true }), new RegExp(reason));
    }
  });

  test(`P0.6 ${streaming ? 'streamed' : 'non-streamed'} empty length reply explains missing output`, async () => {
    const h = await client({ streaming, reason: 'length', content: '' });
    await assert.rejects(h.call({ allowTruncated: true }), /output limit left no reply/);
  });

  test(`P0.3 ${streaming ? 'streamed' : 'non-streamed'} requests never log private bodies and keep provider options`, async () => {
    const h = await client({ streaming, reason: 'stop' });
    const responseFormat = { type: 'json_object' }, provider = { order: ['test'] };
    await h.call({ responseFormat, provider });
    assert.equal(h.logs.length, 0);
    assert.deepEqual(h.requests[0].response_format, responseFormat);
    assert.deepEqual(h.requests[0].provider, provider);
  });
}

test('P0.6 truncated summaries cannot replace the checkpoint', async () => {
  let saves = 0, calls = 0;
  const all = [
    { id: 'u1', order: 1, role: 'user', content: 'Arrive.' },
    { id: 'a1', order: 2, role: 'assistant', content: 'The gate opens.' },
    { id: 'u2', order: 3, role: 'user', content: 'Enter.' },
    { id: 'a2', order: 4, role: 'assistant', content: 'You see a hall.' },
  ];
  const use = appHarness({ stubs: {
    'messages.js': { getMessages: async () => all, getCheckpointMessages: async () => all, newMessageId: () => 'summary', addMessage: async () => { saves++; } },
    'tokenizer.js': { countTokens: async text => Math.ceil(String(text).length / 4) },
    'context-builder.js': { buildContextForRequest: async () => ({ usedTokens: 100, report: { warnings: [] } }), computeContextUsage: async () => ({}), MESSAGE_FRAME_TOKENS: 8, REQUEST_FRAME_TOKENS: 8 },
    'llm-client.js': { chatCompletion: async opts => { calls++; assert.equal(opts.allowTruncated, true); return { content: 'Partial summary', finishReason: 'length' }; } },
  } });
  const api = await use('summarizer.js');
  await assert.rejects(api.runSummarization({ id: 'story', breakpointOrder: 0 }, { maxContextTokens: 20000, maxResponseTokens: 2000, keepRecentMessagesAfterSummary: 2 }, { messages: all }), /summary hit the output limit; the checkpoint was not changed/);
  assert.equal(calls, 1);
  assert.equal(saves, 0);
});
