import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

test('Drawer keyboard handlers defer to a sheet or native dialog above it',async()=>{
 const elements=new Map(),listeners=new Map();let sheet=null,native=null,focused=null;
 const classes=()=>{const values=new Set();return{contains:key=>values.has(key),toggle(key,on){if(on??!values.has(key))values.add(key);else values.delete(key);}};};
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:true,dataset:{},classList:classes(),events:{},append(){},setAttribute(){},addEventListener(key,fn){this.events[key]=fn;},contains:()=>false,querySelectorAll:()=>[],focus(){focused=this;}});return elements.get(id);};
 const first=get('first'),last=get('last');get('sidebar').querySelectorAll=()=>[first,last];
 for(const item of [first,last])item.getClientRects=()=>[{}];
 const document={getElementById:get,createElement:()=>get('menu-backdrop'),querySelector:selector=>selector==='dialog[open]'?native:get('main'),querySelectorAll:()=>[],body:{classList:classes()},dispatchEvent(){},addEventListener(key,fn){if(!listeners.has(key))listeners.set(key,[]);listeners.get(key).push(fn);}};
 Object.defineProperty(document,'activeElement',{get:()=>focused});
 const use=appHarness({globals:{document,window:{addEventListener(){}},CustomEvent:class{constructor(type){this.type=type;}}},stubs:{
  'version.js':{initVersion(){}},'errors.js':{installErrorHandlers(){},friendlyError:String},'ui/icons.js':{initIcons(){}},'ui/memory-ui.js':{toast(){},activeSheet:()=>sheet},'device-caches.js':{clearAccountCaches(){}},'viewport.js':{initViewport(){}},'ui/lorebook-view.js':{initLorebookView(){}},'ui/context-viewer.js':{initContextViewer(){}},'memory-updater.js':{stopAll(){}},
  'auth.js':{initAuth(){},login(){},resetPassword(){},changePassword(){},currentUserInfo(){}},'settings.js':{loadSettings(){},watchSettings(){},DEFAULT_SETTINGS:{},hydrateProfiles:x=>x},'state.js':{state:{}},'ui/sidebar.js':{initSidebar(){}},'ui/chat-view.js':{initChatView(){},setSession(){},prepareChatLogout(){}},'ui/settings-view.js':{initSettingsView(){},openSettingsPopup(){}}
 }});
 await use('app.js');
 const key=(key,shiftKey=false)=>{for(const fn of listeners.get('keydown'))fn({key,shiftKey,preventDefault(){}});};
 get('btn-sidebar-toggle').events.click();assert.equal(document.body.classList.contains('sidebar-open'),true);
 for(const covering of ['sheet','native']){
  sheet=covering==='sheet'?{}:null;native=covering==='native'?{}:null;
  focused=last;key('Tab');assert.equal(focused,last);
  key('Escape');assert.equal(document.body.classList.contains('sidebar-open'),true);
 }
 sheet=native=null;focused=last;key('Tab');assert.equal(focused,first);
 key('Escape');assert.equal(document.body.classList.contains('sidebar-open'),false);
});
