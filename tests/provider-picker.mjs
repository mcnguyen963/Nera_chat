import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
class Field {
  value='';textContent='';children=[];events={};disabled=false;
  addEventListener(type,fn){(this.events[type]??=[]).push(fn);}
  async fire(type='click'){for(const fn of this.events[type]??[])await fn({type});}
  replaceChildren(...children){this.children=children;}
  append(...children){this.children.push(...children);}
}
async function fixture(discover) {
  const fields=Object.fromEntries(['button','search','list','selected','status','endpoint','apiKey','model'].map(key=>[key,new Field()]));
  fields.endpoint.value='https://openrouter.ai/api/v1/chat/completions';fields.model.value='author/model';fields.apiKey.value='draft-key';
  const current={activeProfileId:'p',providerOrder:[]},resets=[];
  const use=appHarness({globals:{document:{createElement:()=>new Field()}}});
  const {initProviderPicker}=await use('ui/provider-picker.js');
  const picker=initProviderPicker({...fields,connection:()=>current,onChange:order=>{current.providerOrder=[...order];},onReselect:(settings,tag)=>resets.push({settings,tag})},discover);
  picker.reset();return {...fields,picker,current,resets};
}
const providers=Array.from({length:11},(_,i)=>({tag:'host/'+i,name:'Host '+i}));

test('provider selector fetches draft values, filters, ranks, reorders, and caps selections at ten',async()=>{
  let captured;const h=await fixture(async settings=>{captured=settings;return providers;});
  await h.button.fire();assert.equal(captured.apiKey,'draft-key');assert.equal(captured.modelId,'author/model');
  h.search.value='host/10';await h.search.fire('input');assert.equal(h.list.children.length,1);
  h.search.value='';await h.search.fire('input');
  for(let i=0;i<10;i++)await h.list.children[0].children[1].fire();
  assert.equal(h.current.providerOrder.length,10);assert.equal(h.list.children[0].children[1].disabled,true);
  await h.list.children[0].children[1].fire();assert.equal(h.current.providerOrder.length,10);
  assert.match(h.selected.children[9].children[0].textContent,/^10\./);
  await h.selected.children[1].children[1].fire();assert.deepEqual(h.current.providerOrder.slice(0,2),['host/1','host/0']);
});

test('remove and reselect queues only that provider reset, and plain reordering queues none',async()=>{
  const h=await fixture(async()=>providers.slice(0,2));await h.button.fire();
  await h.list.children[0].children[1].fire();await h.list.children[0].children[1].fire();
  await h.selected.children[0].children[2].fire();assert.equal(h.resets.length,0);
  await h.selected.children[0].children[3].fire();assert.equal(h.resets.length,0);
  await h.list.children[0].children[1].fire();assert.equal(h.resets.length,1);assert.equal(h.resets[0].tag,'host/1');
  assert.equal(h.resets[0].settings.modelId,'author/model');
  h.picker.clear();h.current.providerOrder=[];await h.button.fire();await h.list.children[0].children[1].fire();assert.equal(h.resets.length,1);
});

test('stale discovery results are ignored on model, endpoint, key changes and profile switches',async()=>{
  for(const change of ['model','endpoint','apiKey','profile']) {
    let resolve,signal;const h=await fixture((_settings,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});});
    h.current.providerOrder=['saved'];h.picker.reset();const pending=h.button.fire();
    if(change==='profile'){h.current.activeProfileId='other';h.current.providerOrder=['other-provider'];h.picker.reset();}
    else {h[change].value+='-changed';await h[change].fire('input');}
    assert.equal(signal.aborted,true);resolve(providers);await pending;assert.equal(h.list.children.length,0);
    assert.deepEqual(h.current.providerOrder,change==='apiKey'?['saved']:change==='profile'?['other-provider']:[]);
  }
});

test('fetch failure preserves selections and unsupported endpoints disable discovery',async()=>{
  const h=await fixture(async()=>{throw Error('offline');});h.current.providerOrder=['saved'];h.picker.reset();await h.button.fire();
  assert.deepEqual(h.current.providerOrder,['saved']);assert.match(h.status.textContent,/offline/);
  h.endpoint.value='https://other.test/v1/chat/completions';await h.endpoint.fire('change');assert.equal(h.button.disabled,true);assert.deepEqual(h.current.providerOrder,[]);
});
