import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
test('R2 initializer rejection replaces the half-built app with a recoverable boot error',async()=>{
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,dataset:{},textContent:'',value:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelector(){return null;}});return elements.get(id);};let auth;
 const document={getElementById:get,querySelectorAll:()=>[],addEventListener(){},body:{classList:{toggle(){}}}},state={};const use=appHarness({globals:{document,window:{addEventListener(){},location:{reload(){}}},console:{...console,error(){}}},stubs:{
 'version.js':{initVersion(){}},'ui/memory-ui.js':{toast(){}},'device-caches.js':{clearAccountCaches:async()=>{}},'viewport.js':{initViewport(){}},'ui/lorebook-view.js':{initLorebookView(){}},'ui/context-viewer.js':{initContextViewer(){}},'memory-updater.js':{stopAll(){}},
 'auth.js':{initAuth:fn=>{auth=fn;},login(){},register(){},resetPassword(){},changePassword(){},currentUserInfo:()=>({email:'owner'})},'settings.js':{loadSettings:async()=>({}),watchSettings(){},DEFAULT_SETTINGS:{},hydrateProfiles:x=>x},'state.js':{state},'ui/sidebar.js':{initSidebar(){throw Error('Sidebar unavailable');}},'ui/chat-view.js':{initChatView(){},setSession(){},prepareChatLogout:async()=>{}},'ui/settings-view.js':{initSettingsView(){},openSettingsPopup(){}}
 }});
 await use('app.js');await auth({uid:'owner'});await new Promise(resolve=>setImmediate(resolve));assert.match(get('login-error').textContent,/Could not start the app: Sidebar unavailable.*Reload/);assert.equal(get('login-error').hidden,false);
});
