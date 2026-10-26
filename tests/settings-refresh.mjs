import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
async function fixture({realMigration=false}={}){
 let owner='u',epoch=0,callback,server={maxContextTokens:64000};const cached=new Map(),oldHash=deferred(),documents=new Map(),hooks={},calls={reads:[],writes:[],migrations:[],events:[]};
 const snapshot=data=>({exists:()=>data!==undefined,data:()=>structuredClone(data)});
 const use=appHarness({globals:{localStorage:{getItem:key=>cached.get(key) ?? null,setItem:(key,value)=>cached.set(key,value),removeItem:key=>cached.delete(key)},crypto:{subtle:{digest:async(algorithm,bytes)=>{const text=new TextDecoder().decode(bytes);if(text==='OLD WATCH')await oldHash.promise;await hooks.digest?.(text);return webcrypto.subtle.digest(algorithm,bytes);}}},document:{dispatchEvent:event=>calls.events.push(event)},CustomEvent:class{constructor(type){this.type=type;}}},stubs:{
  'auth.js':{currentUid:()=>{if(!owner)throw Error('Not signed in');return owner;},accountEpoch:()=>epoch},'db.js':{db:{}},
  'chat-cache.js':{loadStoryData:async()=>null,saveStoryData:async()=>true},'story-sync.js':{flushStory:async()=>{}},
  ...(!realMigration?{'story-settings-store.js':{preserveLegacyStorySeed:async(settings,scope)=>{calls.migrations.push({settings:structuredClone(settings),owner:scope.owner});await hooks.migration?.();}}}:{}),
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:(_db,...parts)=>parts.join('/'),
   getDocFromServer:async ref=>{calls.reads.push(ref);return hooks.read ? hooks.read(ref) : snapshot(server);},
   onSnapshot:(_ref,fn)=>{callback=fn;return ()=>{};},
   setDoc:async(ref,value)=>{calls.writes.push({ref,value:structuredClone(value)});await hooks.write?.();},serverTimestamp:()=>1,
   runTransaction:async(_db,work)=>{const writes=[];const value=await work({get:async ref=>{calls.reads.push(ref);await hooks.seedRead?.();return snapshot(documents.get(ref));},set:(ref,value)=>writes.push({ref,value})});for(const write of writes){calls.writes.push(write);documents.set(write.ref,write.value);}return value;},
  },
 }});
 const settings=await use('settings.js'),{state}=await use('state.js');state.settings={maxContextTokens:10000};
 return {settings,state,cached,oldHash,hooks,calls,documents,use,tokenizer:await use('tokenizer.js'),setOwner:value=>{if(value!==owner)epoch++;owner=value;},setServer:value=>server=value,watch:value=>callback({exists:()=>true,data:()=>value,metadata:{}})};
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

test('token counting mode activates only when refreshed settings are accepted',async()=>{
 const h=await fixture();
 h.setServer({tokenCountingMode:'accurate',maxContextTokens:64000});
 const refresh=await h.settings.readSettingsRefresh();
 assert.equal(h.state.settings.tokenCountingMode,undefined);assert.equal(h.tokenizer.tokenizerMode(),'estimate');
 refresh.apply();assert.equal(h.state.settings.tokenCountingMode,'accurate');assert.equal(h.tokenizer.tokenizerMode(),'accurate');
});

const transitions=[['another account',h=>h.setOwner('other')],['signed out',h=>h.setOwner(null)],['the same account after another login',h=>{h.setOwner('other');h.setOwner('u');}]];
for(const [name,change] of transitions)for(const fails of [false,true])test(`a delayed ${fails?'failed':'successful'} settings load cannot publish after ${name}`,async()=>{
 const h=await fixture(),read=deferred(),started=deferred();
 h.cached.set('roleplay-settings:u',JSON.stringify({apiKey:'private-A',tokenCountingMode:'accurate'}));
 h.hooks.read=()=>{started.resolve();return read.promise;};
 const loading=h.settings.loadSettings();await started.promise;
 change(h);h.cached.delete('roleplay-settings:u');
 if(fails)read.reject(Error('Offline'));else read.resolve({exists:()=>true,data:()=>({apiKey:'private-A',narratorSystemPrompt:'Private A prompt',tokenCountingMode:'accurate'})});
 await assert.rejects(loading,/Settings changed/);
 assert.equal(h.cached.size,0);assert.equal(h.calls.migrations.length,0);assert.equal(h.calls.writes.length,0);
 assert.equal(h.state.settings.maxContextTokens,10000);assert.equal(h.state.settingsSource,'defaults');assert.equal(h.tokenizer.tokenizerMode(),'estimate');assert.equal(h.calls.events.length,0);
});

for(const [name,change] of transitions)test(`settings hydration and migration stop after ${name}`,async()=>{
 const hashing=await fixture();hashing.setServer({apiKey:'private-A',narratorSystemPrompt:'OLD WATCH',tokenCountingMode:'accurate'});
 const loading=hashing.settings.loadSettings();await new Promise(resolve=>setTimeout(resolve,0));change(hashing);hashing.oldHash.resolve();
 await assert.rejects(loading,/Settings changed/);assert.equal(hashing.calls.migrations.length,0);assert.equal(hashing.cached.size,0);assert.equal(hashing.tokenizer.tokenizerMode(),'estimate');
 const h=await fixture({realMigration:true}),read=deferred(),started=deferred();
 h.setServer({apiKey:'private-A',narratorSystemPrompt:'Private A prompt'});
 h.hooks.seedRead=async()=>{started.resolve();await read.promise;};
 const migrating=h.settings.loadSettings();await started.promise;change(h);read.resolve();
 await assert.rejects(migrating,/Settings changed/);assert.equal(h.calls.writes.length,0);assert.equal(h.cached.size,0);
 assert.ok(h.calls.reads.every(ref=>ref.startsWith('users/u/')));
});

test('a switch during actual migration hashing cannot write a seed in any account',async()=>{
 const h=await fixture({realMigration:true}),hold=deferred(),started=deferred();let hashes=0;
 h.setServer({narratorSystemPrompt:'Private migration prompt'});
 h.hooks.digest=async text=>{if(text==='Private migration prompt' && ++hashes===2){started.resolve();await hold.promise;}};
 const pending=h.settings.loadSettings();await started.promise;h.setOwner('other');hold.resolve();
 await assert.rejects(pending,/Settings changed/);assert.equal(h.documents.size,0);assert.equal(h.calls.writes.length,0);assert.equal(h.cached.size,0);
});

test('same-account settings loads retain authoritative seeds and cache fallback without extra operations',async()=>{
 const h=await fixture({realMigration:true});h.setServer({apiKey:'private-A',narratorSystemPrompt:'Private A prompt'});
 const loaded=await h.settings.loadSettings();assert.equal(loaded.apiKey,'private-A');assert.equal(loaded.providerCooldownAccount,'u');
 assert.equal(h.calls.reads.length,2);assert.equal(h.calls.writes.length,1);assert.equal(h.calls.writes[0].ref,'users/u/settings/storyMigration');
 assert.equal(h.documents.get('users/u/settings/storyMigration').values.narratorSystemPrompt,'Private A prompt');
 h.hooks.read=()=>{throw Error('Offline');};const fallback=await h.settings.loadSettings();assert.equal(fallback.apiKey,'private-A');assert.equal(h.state.settingsSource,'cache');assert.equal(h.calls.writes.length,1);
});

for(const [name,change] of transitions)test(`new-account initialization cannot continue after ${name}`,async()=>{
 const h=await fixture(),write=deferred(),started=deferred();h.setServer(undefined);
 h.hooks.write=async()=>{started.resolve();await write.promise;};
 const loading=h.settings.loadSettings();await started.promise;change(h);write.resolve();
 await assert.rejects(loading,/Settings changed/);assert.equal(h.calls.writes.length,1);assert.equal(h.calls.writes[0].ref,'users/u/settings/current');
 assert.equal(h.calls.migrations.length,0);assert.equal(h.cached.size,0);assert.equal(h.state.settingsSource,'defaults');
});

for(const [name,change] of transitions)test(`settings save acknowledgements stay scoped after ${name}`,async()=>{
 const h=await fixture(),write=deferred(),started=deferred();h.state.settingsSource='server';
 h.hooks.write=async()=>{started.resolve();await write.promise;};
 const saving=h.settings.saveSettings({...h.settings.DEFAULT_SETTINGS,apiKey:'private-A',tokenCountingMode:'accurate'});await started.promise;change(h);write.resolve();
 await assert.rejects(saving,/Settings changed/);assert.equal(h.calls.writes[0].ref,'users/u/settings/current');assert.equal(h.cached.size,0);
 assert.equal(h.tokenizer.tokenizerMode(),'estimate');assert.equal(h.calls.events.length,0);assert.equal(h.state.settings.maxContextTokens,10000);assert.equal(h.state.settingsSaving,false);
});

test('an older save completion cannot unlock a newer account save',async()=>{
 const h=await fixture(),first=deferred(),second=deferred(),one=deferred(),two=deferred();let n=0;h.state.settingsSource='server';
 h.hooks.write=async()=>{if(++n===1){one.resolve();await first.promise;}else{two.resolve();await second.promise;}};
 const old=h.settings.saveSettings({...h.settings.DEFAULT_SETTINGS,apiKey:'A'});await one.promise;
 h.setOwner('other');const newer=h.settings.saveSettings({...h.settings.DEFAULT_SETTINGS,apiKey:'B'});await two.promise;
 first.resolve();await assert.rejects(old,/Settings changed/);assert.equal(h.state.settingsSaving,true);assert.equal(h.cached.size,0);
 await assert.rejects(h.settings.saveSettings({...h.settings.DEFAULT_SETTINGS,apiKey:'C'}),/already in progress/);
 second.resolve();await newer;assert.equal(h.state.settingsSaving,false);assert.equal(h.state.settings.apiKey,'B');assert.equal(h.cached.has('roleplay-settings:u'),false);assert.equal(JSON.parse(h.cached.get('roleplay-settings:other')).apiKey,'B');
 assert.deepEqual(h.calls.writes.map(w=>w.ref),['users/u/settings/current','users/other/settings/current']);assert.equal(h.calls.reads.length,0);
});

test('startup settings recovery cannot activate a former account after loading its server document',async()=>{
 const h=await fixture(),read=deferred(),started=deferred();h.state.settingsSource='cache';
 h.hooks.read=()=>{started.resolve();return read.promise;};
 const saving=h.settings.saveSettings(h.state.settings);await started.promise;h.setOwner('other');read.resolve({exists:()=>true,data:()=>({apiKey:'private-A'})});
 await assert.rejects(saving,/Settings changed/);assert.equal(h.state.settings.maxContextTokens,10000);assert.equal(h.calls.events.length,0);assert.equal(h.cached.size,0);assert.equal(h.calls.writes.length,0);
});

test('Sync and subscription settings cannot resume across account logout and re-login',async()=>{
 const h=await fixture();h.settings.watchSettings();const refresh=await h.settings.readSettingsRefresh();
 h.setOwner('other');h.setOwner('u');assert.throws(()=>refresh.apply(),/Settings changed/);
 await h.watch({apiKey:'private-A',tokenCountingMode:'accurate'});assert.equal(h.cached.size,0);assert.equal(h.tokenizer.tokenizerMode(),'estimate');
});

test('real auth callbacks identify a new account session while repeated same-account delivery stays valid',async()=>{
 const sdk={currentUser:{uid:'A'}},cleared=deferred();let callback,clearStarted=false;
 const use=appHarness({stubs:{'device-caches.js':{clearAccountCaches:async()=>{clearStarted=true;await cleared.promise;}},
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js':{getAuth:()=>sdk,onAuthStateChanged:(_sdk,fn)=>{callback=fn;return ()=>{};},signOut:async()=>{sdk.currentUser=null;callback(null);},signInWithEmailAndPassword(){},createUserWithEmailAndPassword(){},sendPasswordResetEmail(){},EmailAuthProvider:{},reauthenticateWithCredential(){},updatePassword(){}}
 }}),auth=await use('auth.js'),seen=[];
 auth.initAuth(user=>seen.push(user?.uid ?? null));callback(sdk.currentUser);const initial=auth.accountEpoch();callback(sdk.currentUser);assert.equal(auth.accountEpoch(),initial);
 sdk.currentUser={uid:'B'};callback(sdk.currentUser);sdk.currentUser={uid:'A'};callback(sdk.currentUser);assert.ok(auth.accountEpoch()>initial);
 const beforeLogout=auth.accountEpoch(),loggingOut=auth.logout();assert.equal(clearStarted,true);assert.ok(auth.accountEpoch()>beforeLogout);cleared.resolve();await loggingOut;assert.throws(()=>auth.currentUid(),/Not signed in/);assert.deepEqual(seen,['A','A','B','A',null]);
});
