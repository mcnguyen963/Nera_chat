import {promptFetch} from './prompt-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

test('reasoning normalization repairs inactive profiles and request construction clamps token limits',async()=>{
 const use=appHarness({stubs:{'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc(){},getDocFromServer(){},onSnapshot(){},setDoc(){}},'db.js':{db:{}},'auth.js':{currentUid:()=> 'u'},'story-settings-store.js':{preserveLegacyStorySeed:async()=>({})}}}),{hydrateProfiles}=await use('settings.js'),{buildRequestBody}=await use('llm-client.js');
 const hydrated=hydrateProfiles({profiles:[{id:'a',endpoint:'https://x',reasoning:{effort:'extreme'}},{id:'b',endpoint:'https://x',reasoning:{effort:'unknown'}}],activeProfileId:'a'});
 assert.deepEqual(Array.from(hydrated.profiles,p=>p.reasoning.effort),['medium','medium']);
 const base={modelId:'m',endpoint:'https://x',maxResponseTokens:2000};
 assert.equal(buildRequestBody({...base,reasoning:{enabled:true,mode:'max_tokens',maxTokens:4096}},[]).reasoning.max_tokens,1999);
 assert.equal(buildRequestBody({...base,reasoning:{enabled:true,mode:'effort',effort:'unknown'}},[]).reasoning.effort,'medium');
});

test('rewrite prompt failures and empty files can retry and a successful load is cached',async()=>{
 const replies=[{ok:false},{ok:true,text:async()=>''},{ok:true,text:async()=>'  Rewrite prompt  '}];let reads=0;
 let testing=false;const use=appHarness({globals:{fetch:async(url,options)=>testing && String(url).endsWith('/rewrite.md')?(reads++,replies.shift()):promptFetch(url,options)}});await use('system-prompts.js');testing=true;const api=await use('rewrite.js');
 await assert.rejects(api.loadRewriteDefaultPrompt(),/Could not load/);await assert.rejects(api.loadRewriteDefaultPrompt(),/empty/);
 assert.equal(await api.loadRewriteDefaultPrompt(),'Rewrite prompt');assert.equal(await api.loadRewriteDefaultPrompt(),'Rewrite prompt');assert.equal(reads,3);
});

test('SSE preserves every byte split, Unicode characters, comments and blank lines',async()=>{
  const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Café 🌙"},"finish_reason":"stop"}]}\n\n: OPENROUTER PROCESSING\n\ndata: [DONE]\n');
  for(let split=1;split<bytes.length;split++){
    const chunks=[bytes.subarray(0,split),bytes.subarray(split)],deltas=[];
    const api=await appHarness({globals:{fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>chunks.length?{done:false,value:chunks.shift()}:{done:true},cancel:async()=>{}})}})}})('llm-client.js');
    const result=await api.chatCompletion({settings:{modelId:'test',endpoint:'https://example.test',streaming:true},messages:[],onDelta:text=>deltas.push(text)});
    assert.equal(result.content,'Café 🌙','split '+split);assert.equal(deltas.join(''),'Café 🌙','delta split '+split);
  }
});

async function client({ streaming, reason, content = 'Narration.' }) {
  const logs = [], requests = [];
  const use = appHarness({ globals: {
    console: new Proxy({}, {get:(_target,method)=>(...args)=>logs.push([method,args])}),
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
    for (const reason of ['length', 'MAX_TOKENS', 'MAX_OUTPUT_TOKENS']) {
      const h = await client({ streaming, reason });
      await assert.rejects(h.call(), /output limit/);
      assert.equal((await h.call({ allowTruncated: true })).finishReason, 'length');
    }
    for (const reason of ['STOP', 'end_turn', 'eos', 'stop_sequence', 'future_reason', null]) {
      const h = await client({ streaming, reason });
      assert.equal((await h.call()).finishReason, reason?.toLowerCase() ?? null);
    }
    for (const reason of ['content_filter', 'error', 'tool_calls', 'function_call', 'safety', 'recitation', 'blocklist', 'prohibited_content']) {
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
    {id:'u3',order:5,role:'user',content:'Continue'}, {id:'a3',order:6,role:'assistant',content:'Reply'},
  ];
  const use = appHarness({ stubs: {
    'messages.js': { getMessages: async () => all, getCheckpointMessages: async () => all, newMessageId: () => 'summary', addMessage: async () => { saves++; } },
    'tokenizer.js': { countTokens: async text => Math.ceil(String(text).length / 4) },
    'context-builder.js': { buildContextForRequest: async () => ({ usedTokens: 100, report: { warnings: [] } }), computeContextUsage: async () => ({}), MESSAGE_FRAME_TOKENS: 8, REQUEST_FRAME_TOKENS: 8 },

  },globals:{fetch:async(url,init)=>{if(url instanceof URL && url.protocol==='file:')return promptFetch(url,init);calls++;const bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'Partial summary'},finish_reason:'length'}]})+'\ndata: [DONE]\n');let sent=false;return {ok:true,body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:bytes})})}};}} });
  const api = await use('summarizer.js');
  await assert.rejects(api.runSummarization({ id: 'story', breakpointOrder: 0 }, { endpoint:"https://test.example",modelId:"test",streaming:true,maxContextTokens: 20000, maxResponseTokens: 2000, keepRecentMessagesAfterSummary: 2 }, { messages: all }), /summary hit the output limit; the checkpoint was not changed/);
  assert.equal(calls, 1);
  assert.equal(saves, 0);
});
