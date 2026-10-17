import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(){
 let owner='u',callback,server={maxContextTokens:64000};const cached=new Map(),oldHash=deferred();
 const use=appHarness({globals:{localStorage:{getItem:key=>cached.get(key) ?? null,setItem:(key,value)=>cached.set(key,value)},crypto:{subtle:{digest:async(algorithm,bytes)=>{if(new TextDecoder().decode(bytes)==='OLD WATCH')await oldHash.promise;return webcrypto.subtle.digest(algorithm,bytes);}}},document:{dispatchEvent(){}},CustomEvent:class{}},stubs:{
  'auth.js':{currentUid:()=>owner},'db.js':{db:{}},'story-settings-store.js':{preserveLegacyStorySeed:async()=>{}},
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:(_db,...parts)=>parts.join('/'),getDocFromServer:async()=>({exists:()=>true,data:()=>server}),onSnapshot:(_ref,fn)=>{callback=fn;return ()=>{};},setDoc:async()=>{}},
 }});
 const settings=await use('settings.js'),{state}=await use('state.js');state.settings={maxContextTokens:10000};
 return {settings,state,cached,oldHash,setOwner:value=>owner=value,setServer:value=>server=value,watch:value=>callback({exists:()=>true,data:()=>value,metadata:{}})};
}
test('account Sync stages settings before applying cache and rejects account switches',async()=>{
 const h=await fixture(),refresh=await h.settings.readSettingsRefresh();assert.equal(h.state.settings.maxContextTokens,10000);assert.equal(h.cached.size,0);
 h.setOwner('other');assert.throws(()=>refresh.apply(),/changed/);assert.equal(h.cached.size,0);assert.equal(h.state.settings.maxContextTokens,10000);
});
test('an older settings hydration cannot restore stale settings after Sync',async()=>{
 const h=await fixture();h.settings.watchSettings();const older=h.watch({narratorSystemPrompt:'OLD WATCH',maxContextTokens:12000});
 const refresh=await h.settings.readSettingsRefresh();refresh.apply();h.oldHash.resolve();await older;
 assert.equal(h.state.settings.maxContextTokens,64000);assert.equal(JSON.parse(h.cached.get('roleplay-settings:u')).maxContextTokens,64000);
});
test('a delayed settings subscription delivery from a former account is ignored',async()=>{
 const h=await fixture();h.settings.watchSettings();h.setOwner('other');await h.watch({maxContextTokens:12000});assert.equal(h.state.settings.maxContextTokens,10000);assert.equal(h.cached.size,0);
});
