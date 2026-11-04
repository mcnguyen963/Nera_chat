import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const endpoint='https://openrouter.ai/api/v1/chat/completions';
const settings={endpoint,modelId:'author/model',apiKey:'key',streaming:false,maxResponseTokens:1024,providerOrder:['first','second'],providerCooldownAccount:'owner'};
const plain=value=>JSON.parse(JSON.stringify(value));
const ok=()=>new Response(JSON.stringify({choices:[{message:{content:'Complete reply'},finish_reason:'stop'}]}));
const failure=(status,message='Provider unavailable')=>new Response(JSON.stringify({error:{code:status,message}}),{status});

test('request-level price caps can only lower the user completion cap',async()=>{
 for(const cap of [2,.2]){
  const h=await fixture(()=>ok());await h.client.chatCompletion({settings:{...settings,maxOutputPrice:.4},messages:[],provider:{max_price:{prompt:1,completion:cap}}});
  assert.deepEqual(h.calls[0].body.provider.max_price,{prompt:1,completion:Math.min(.4,cap)});
 }
});

test('provider discovery rejects bad model ids before fetching and reports HTTP, network and JSON failures',async()=>{
 const h=await fixture(()=>{throw Error('Should not fetch');});
 for(const modelId of ['','gpt-4','a/ b'])await assert.rejects(h.routing.fetchProviders({...settings,modelId}),/Choose a model/);
 assert.equal(h.calls.length,0);
 for(const status of [401,404,500]){const f=await fixture(()=>({ok:false,status}));await assert.rejects(f.routing.fetchProviders(settings),new RegExp('HTTP '+status));assert.equal(f.calls.length,1);}
 const network=await fixture(()=>{throw Error('offline');});await assert.rejects(network.routing.fetchProviders(settings),/Could not fetch providers/);
 const json=await fixture(()=>({ok:true,json:async()=>{throw Error('invalid json');}}));await assert.rejects(json.routing.fetchProviders(settings),/Malformed provider listing: expected JSON/);
});

test('provider body and pre-delta SSE errors fall back using provider codes and report the route',async()=>{
  for(const streaming of [false,true]){
    const h=await fixture((_url,_opts,n)=>{
      if(!streaming)return n===1?new Response(JSON.stringify({error:{code:503,message:'upstream'}})):ok();
      const event=n===1?{error:{code:502,message:'upstream'}}:{choices:[{delta:{content:'Complete reply'},finish_reason:'stop'}]};
      return new Response('data: '+JSON.stringify(event)+'\ndata: [DONE]\n');
    });
    const result=await h.client.chatCompletion({settings:{...settings,streaming},messages:[]});
    assert.equal(result.provider,'second');assert.equal(result.content,'Complete reply');assert.equal(h.calls.length,2);
    assert.deepEqual(plain(h.events[0].detail),{from:'first',to:'second'});
  }
});

test('a provider request error does not fall back even when HTTP status is an availability failure',async()=>{
  const h=await fixture(()=>new Response(JSON.stringify({error:{code:400,message:'Invalid provider request'}}),{status:502}));
  await assert.rejects(h.client.chatCompletion({settings,messages:[]}),/Invalid provider request/);
  assert.equal(h.calls.length,1);assert.equal(h.events.length,0);assert.equal(h.routing.providerRetryAt(settings,'first'),0);
});
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

test('cooldowns survive failed writes, ignore stale persisted values, and allow an explicit in-page reset',async()=>{
 const store=storage();let fail=false;
 const originalSet=store.setItem,originalRemove=store.removeItem;
 store.setItem=(...args)=>{if(fail)throw Error('QuotaExceededError');return originalSet(...args);};
 store.removeItem=(...args)=>{if(fail)throw Error('Read-only storage');return originalRemove(...args);};
 const h=await fixture(()=>ok(),store);
 fail=true;h.routing.coolDownProvider(settings,'first');assert.equal(h.routing.providerRetryAt(settings,'first'),2800000);
 h.advance(30*60*1000);assert.equal(h.routing.providerRetryAt(settings,'first'),0);
 fail=false;h.routing.coolDownProvider(settings,'first');const old=h.routing.providerRetryAt(settings,'first');
 h.advance(1000);fail=true;h.routing.coolDownProvider(settings,'first');assert.equal(h.routing.providerRetryAt(settings,'first'),old+1000);
 h.routing.resetProviderCooldown(settings,'first');assert.equal(h.routing.providerRetryAt(settings,'first'),0);
 assert.equal(Number([...store.data.values()][0]),old,'a failed reset must not resurrect the old persisted deadline');
});

test('another tab resetting cooldown clears a failed local persistence fallback',async()=>{
 const listeners=[];
 const store=storage();store.setItem=()=>{throw Error('QuotaExceededError');};
 const api=await appHarness({globals:{localStorage:store,addEventListener:(type,fn)=>{if(type==='storage')listeners.push(fn);}}})('provider-routing.js');
 const until=api.coolDownProvider(settings,'first',1000);assert.equal(api.providerRetryAt(settings,'first',1001),until);
 listeners.forEach(fn=>fn({key:'nera.provider.cooldown.'+JSON.stringify(['owner','https://openrouter.ai','author/model','first']),newValue:null}));
 assert.equal(api.providerRetryAt(settings,'first',1001),0);
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

test('WP-02 non-streamed total deadline never cools down healthy providers',async()=>{
 let deadline,delay,fetches=0;
 const use=appHarness({globals:{fetch:async()=>{fetches++;return new Promise(()=>{});},setTimeout:(fn,ms)=>{deadline=fn;delay=ms;return 1;},clearTimeout(){}}});
 const client=await use('llm-client.js'),routing=await use('provider-routing.js');
 const pending=client.chatCompletion({settings,messages:[]});
 const rejected=assert.rejects(pending,error=>error.classification==='deadline' && /deadline/i.test(error.message));
 deadline();await new Promise(resolve=>setImmediate(resolve));if(fetches>1)deadline();await rejected;
 assert.ok(delay>=300000);assert.equal(fetches,1);
 for(const tag of settings.providerOrder)assert.equal(routing.providerRetryAt(settings,tag),0);
});

for(const target of ['models','providers'])for(const mode of ['pre-aborted','abort','timeout','success'])test(`${target} discovery shares bounded cancellation and removes caller listeners: ${mode}`,async()=>{
  const jobs=new Map();let next=0,reads=0,attached=0,removed=0;
  const caller=new AbortController(),add=caller.signal.addEventListener.bind(caller.signal),remove=caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener=(...args)=>{attached++;add(...args);};caller.signal.removeEventListener=(...args)=>{removed++;remove(...args);};
  const use=appHarness({globals:{setTimeout:fn=>{jobs.set(++next,fn);return next;},clearTimeout:id=>jobs.delete(id),fetch:async()=>{reads++;if(mode==='success')return {ok:true,status:200,json:async()=>target==='models'?{data:[{id:'a/b'}]}:{data:{endpoints:[{tag:'first'}]}}};return new Promise(()=>{});}}});
  const module=await use(target==='models'?'llm-client.js':'provider-routing.js'),discover=target==='models'?module.fetchModels:module.fetchProviders;
  if(mode==='pre-aborted')caller.abort();
  const pending=discover(settings,{signal:caller.signal});
  if(mode==='abort')caller.abort();if(mode==='timeout')[...jobs.values()][0]();
  if(mode==='success')assert.equal((await pending).length,1);else await assert.rejects(pending,mode==='timeout'?/timed out/:/cancelled/);
  assert.equal(reads,mode==='pre-aborted'?0:1);assert.equal(jobs.size,0);assert.equal(removed,1);assert.equal(attached,mode==='pre-aborted'?0:1);
});
