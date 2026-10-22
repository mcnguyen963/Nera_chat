import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const endpoint='https://openrouter.ai/api/v1/chat/completions';
const settings={endpoint,modelId:'author/model',apiKey:'key',streaming:false,maxResponseTokens:1024,providerOrder:['first','second'],providerCooldownAccount:'owner'};
const plain=value=>JSON.parse(JSON.stringify(value));
const ok=()=>new Response(JSON.stringify({choices:[{message:{content:'Complete reply'},finish_reason:'stop'}]}));
const failure=(status,message='Provider unavailable')=>new Response(JSON.stringify({error:{code:status,message}}),{status});
function storage() {const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data};}
async function fixture(fetch,store=storage()) {
  let now=1000000;class Clock extends Date {static now(){return now;}}
  const calls=[],events=[];
  const use=appHarness({globals:{localStorage:store,Date:Clock,document:{dispatchEvent:event=>events.push(event)},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},fetch:async(url,options)=>{calls.push({url,options,body:options.body?JSON.parse(options.body):null});return fetch(url,options,calls.length);}}});
  return {client:await use('llm-client.js'),routing:await use('provider-routing.js'),calls,events,store,use,advance:ms=>{now+=ms;}};
}

test('discovery gates exact OpenRouter origin, resolves routing shortcuts and retains exact provider tags',async()=>{
  const h=await fixture(()=>new Response(JSON.stringify({data:{endpoints:[{tag:'host/region',provider_name:'Host'},{tag:'host/region',provider_name:'Duplicate'},{provider_name:'Missing tag'}]}})));
  assert.equal(h.routing.supportsProviders(endpoint),true);
  for(const url of ['https://openrouter.ai.evil/api/v1/chat/completions','http://openrouter.ai/api/v1/chat/completions','https://other.test/v1/chat/completions','https://openrouter.ai/other'])assert.equal(h.routing.supportsProviders(url),false);
  const result=await h.routing.fetchProviders({...settings,modelId:'author/model:floor'});
  assert.deepEqual(plain(result),[{tag:'host/region',name:'Host'}]);assert.equal(h.calls[0].url,'https://openrouter.ai/api/v1/models/author/model/endpoints');assert.equal(h.calls[0].options.headers.Authorization,'Bearer key');
  await h.routing.fetchProviders({...settings,modelId:'author/model:free'});assert.match(h.calls[1].url,/model%3Afree\/endpoints$/);
  await assert.rejects(h.routing.fetchProviders({...settings,endpoint:'https://other.test'}),/only for OpenRouter/);
  assert.throws(()=>h.routing.normalizeProviders({data:[]}),/Malformed/);
  for(const invalid of [['a','a'],Array.from({length:11},(_,i)=>''+i),[''],[4]])assert.throws(()=>h.routing.providerOrder(invalid),/10 different/);
});

test('ordered fallback pins each request, preserves all request constraints, and skips failures for exactly 30 minutes',async()=>{
  const h=await fixture((_url,opts)=>JSON.parse(opts.body).provider.only[0]==='first'?failure(503):ok());
  const options={settings:{...settings,maxOutputPrice:.4},messages:[{role:'user',content:'Hello'}],provider:{require_parameters:true},responseFormat:{type:'json_object'}};
  const result=await h.client.chatCompletion(options);assert.equal(result.provider,'second');assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls.map(c=>c.body.provider.only),[['first'],['second']]);
  for(const call of h.calls){assert.equal(call.body.model,settings.modelId);assert.equal(call.body.provider.allow_fallbacks,false);assert.equal(call.body.provider.require_parameters,true);assert.equal(call.body.provider.max_price.completion,.4);assert.equal(call.body.response_format.type,'json_object');assert.deepEqual(call.body.messages,options.messages);}
  assert.equal(h.events.length,1);
  await h.client.chatCompletion(options);assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.provider.only[0],'second');
  h.advance(30*60*1000-1);await h.client.chatCompletion(options);assert.equal(h.calls.length,4);
  h.advance(1);await h.client.chatCompletion(options);assert.equal(h.calls.length,6);assert.equal(h.calls[4].body.provider.only[0],'first');
});

test('all selected providers fail once and later calls stop without sending requests; cooldown is shared across reloads',async()=>{
  const h=await fixture(()=>failure(429));
  await assert.rejects(h.client.chatCompletion({settings,messages:[]}),error=>error.classification==='providers_unavailable' && error.retryAt===2800000);
  assert.equal(h.calls.length,2);
  await assert.rejects(h.client.chatCompletion({settings,messages:[]}),/No selected providers/);assert.equal(h.calls.length,2);
  const reloaded=await fixture(()=>{throw Error('Must not request');},h.store);
  await assert.rejects(reloaded.client.chatCompletion({settings,messages:[]}),/No selected providers/);assert.equal(reloaded.calls.length,0);
  h.routing.resetProviderCooldown(settings,'first');assert.equal(reloaded.routing.providerRetryAt(settings,'first'),0);assert.equal(h.routing.providerRetryAt(settings,'second'),2800000);
  await assert.rejects(h.client.chatCompletion({settings,messages:[]}),/No selected providers/);assert.equal(h.calls.length,3);
});

test('cooldowns separate accounts and models and share matching identities across profiles',async()=>{
  const h=await fixture(()=>ok());h.routing.coolDownProvider(settings,'first');
  assert.equal(h.routing.providerRetryAt({...settings,activeProfileId:'copy'},'first'),2800000);
  assert.equal(h.routing.providerRetryAt({...settings,providerCooldownAccount:'other'},'first'),0);
  assert.equal(h.routing.providerRetryAt({...settings,modelId:'other/model'},'first'),0);
  h.store.removeItem([...h.store.data.keys()][0]);assert.equal(h.routing.providerRetryAt(settings,'first'),0);
});

test('authentication, credit, invalid requests, refusals and unrelated 404 stop immediately without cooldown',async()=>{
  for(const status of [400,401,402,403,404,422]) {
    const h=await fixture(()=>failure(status,'Invalid request'));
    await assert.rejects(h.client.chatCompletion({settings,messages:[]}));assert.equal(h.calls.length,1);assert.equal(h.routing.providerRetryAt(settings,'first'),0);
  }
  const h=await fixture(()=>new Response(JSON.stringify({choices:[{message:{content:'Refused'},finish_reason:'content_filter'}]})));
  await assert.rejects(h.client.chatCompletion({settings,messages:[]}),/content_filter/);assert.equal(h.calls.length,1);assert.equal(h.routing.providerRetryAt(settings,'first'),0);
});

test('provider unavailable 404 and transport loss fall back; user cancellation never does',async()=>{
  for(const first of [()=>failure(404,'No endpoints found for this provider'),()=>{throw Error('connection lost');}]) {
    const h=await fixture((url,opts,n)=>n===1?first():ok());assert.equal((await h.client.chatCompletion({settings,messages:[]})).provider,'second');
  }
  const h=await fixture(()=>ok()),controller=new AbortController();controller.abort('user');
  await assert.rejects(h.client.chatCompletion({settings,messages:[],signal:controller.signal}),error=>error.classification==='cancelled');assert.equal(h.calls.length,0);
});

test('partial content or reasoning cools down provider but keeps recovery instead of starting a fallback',async()=>{
  for(const kind of ['content','reasoning']) {
    let reads=0;const h=await fixture(()=>({ok:true,body:{getReader:()=>({read:async()=>++reads===1?{value:new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{[kind]:'partial'}}]})+'\n\n'),done:false}:{done:true},cancel:async()=>{}})}}));
    const deltas=[];await assert.rejects(h.client.chatCompletion({settings:{...settings,streaming:true},messages:[],onDelta:t=>deltas.push(t),onReasoning:t=>deltas.push(t)}),error=>error.classification==='transport_loss' && (error.partial.content==='partial' || error.partial.thinking==='partial'));
    assert.deepEqual(deltas,['partial']);assert.equal(h.calls.length,1);assert.equal(h.routing.providerRetryAt(settings,'first'),2800000);
  }
});

test('empty selection and unsupported endpoints preserve a single normal request',async()=>{
  for(const value of [{...settings,providerOrder:[]},{...settings,endpoint:'https://other.test/v1/chat/completions'}]) {
    const h=await fixture(()=>ok());await h.client.chatCompletion({settings:value,messages:[]});assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.provider,undefined);
  }
});

test('discovery timeout and cancellation settle even if fetch ignores abort',async()=>{
  for(const timeout of [true,false]) {
    let trigger;const controller=new AbortController();
    const use=appHarness({globals:{fetch:()=>new Promise(()=>{}),setTimeout:fn=>{trigger=fn;return 1;},clearTimeout(){}}});
    const routing=await use('provider-routing.js');const pending=routing.fetchProviders(settings,{signal:controller.signal});
    if(timeout)trigger();else controller.abort();await assert.rejects(pending,timeout?/timed out/:/cancelled/);
  }
});

test('timeout before output falls back and late output from the abandoned attempt is suppressed',async()=>{
  let timeout,lateResponse;const deltas=[],calls=[];
  const streamed=content=>{let read=false;return {ok:true,body:{getReader:()=>({read:async()=>read?{done:true}:(read=true,{done:false,value:new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\n')}),cancel:async()=>{}})}};};
  const use=appHarness({globals:{fetch:async(_url,options)=>{calls.push(JSON.parse(options.body));return calls.length===1?new Promise(resolve=>{lateResponse=resolve;}):streamed('Good');},setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}}});
  const client=await use('llm-client.js');const pending=client.chatCompletion({settings:{...settings,streaming:true},messages:[],onDelta:text=>deltas.push(text)});
  timeout();assert.equal((await pending).content,'Good');assert.equal(calls.length,2);assert.deepEqual(deltas,['Good']);
  lateResponse(streamed('Stale'));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(deltas,['Good']);
});

test('cancelling an active request does not cool down its provider or try another',async()=>{
  let fetches=0;const controller=new AbortController();
  const use=appHarness({globals:{fetch:async()=>{fetches++;return new Promise(()=>{});}}});
  const client=await use('llm-client.js'),routing=await use('provider-routing.js');
  const pending=client.chatCompletion({settings,messages:[],signal:controller.signal});controller.abort('user');
  await assert.rejects(pending,error=>error.classification==='cancelled');assert.equal(fetches,1);assert.equal(routing.providerRetryAt(settings,'first'),0);
});
