import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

function control() {
  const events = {};
  return {dataset:{}, attributes:{}, classList:{add(){},remove(){}}, append(){}, setAttribute(k,v){this.attributes[k]=v;}, addEventListener(k,fn){events[k]=fn;}, events};
}
const doc = {createElement:() => control()};

test('Composer icons and accessible labels follow Rewrite, Continue and Stop states', async () => {
  const ui = await appHarness({globals:{document:doc}})('ui/icons.js');
  const button = control();
  for (const [state, name, label] of [
    [{rewriting:false,empty:false}, 'rewrite', 'Rewrite'],
    [{rewriting:false,empty:true}, 'continue', 'Continue'],
    [{rewriting:true,empty:false}, 'stop', 'Stop rewriting'],
  ]) {
    const view = ui.rewritePresentation(state); ui.setIcon(button,view.icon,view.label);
    assert.equal(button.dataset.icon,name); assert.equal(button.attributes['aria-label'],label);
    assert.match(button.innerHTML,/aria-hidden="true"/); assert.match(button.innerHTML,/<svg/);
  }
  ui.setIcon(button,'restore','Restore original'); assert.equal(button.attributes['aria-label'],'Restore original');
});

test('Context ring fills and gradually shifts from gray to red toward its input limit', async () => {
  const {contextRingPresentation:view} = await appHarness()('ui/icons.js');
  const empty=view({used:0,max:1000}), half=view({used:500,max:1000}), full=view({used:1000,max:1000});
  assert.equal(empty.color,'rgb(148, 155, 167)');assert.equal(empty.dash,'0 100');
  assert.equal(half.dash,'50 100');assert.equal(full.color,'rgb(244, 92, 92)');assert.equal(full.dash,'100 100');
  const channels = color => color.match(/\d+/g).map(Number);
  const steps=[0,100,250,500,750,900,1000].map(used=>channels(view({used,max:1000}).color));
  for(let i=1;i<steps.length;i++) {
    assert.ok(steps[i][0]>=steps[i-1][0]);assert.ok(steps[i][1]<=steps[i-1][1]);assert.ok(steps[i][2]<=steps[i-1][2]);
  }
  assert.equal(view({used:2000,max:1000}).color,full.color);
  assert.equal(view({used:-10,max:1000}).color,empty.color);
  assert.equal(view({used:100,max:0}).dash,empty.dash);
});

test('More routes settings and every existing maintenance action', async () => {
  const {routeTopMenu} = await appHarness()('ui/menu-routing.js');
  const calls = [], handlers = {settings:()=>calls.push('settings'),dispatch:name=>calls.push(name)};
  for (const name of ['settings','lorebooks','context-details','sync-chat','upload-device-story','summarize-full','reset-summary']) assert.equal(routeTopMenu(name,handlers),true);
  assert.deepEqual(calls,['settings','lorebooks','context-details','sync-chat','upload-device-story','summarize-full','reset-summary']);
  assert.equal(routeTopMenu(undefined,handlers),false); assert.equal(routeTopMenu('unknown',handlers),false);
});

test('Floating Copy requires a completed tall message at the midpoint with its header Copy offscreen', async () => {
  const {eligibleFloatingCopy:eligible} = await appHarness()('ui/message-copy.js');
  const state = {viewport:{top:50,bottom:450,height:400},message:{top:10,bottom:900,height:890},control:{top:856,bottom:900}};
  assert.equal(eligible(state),true);
  assert.equal(eligible({...state,completed:false}),false);
  assert.equal(eligible({...state,blocked:true}),false);
  assert.equal(eligible({...state,control:{top:400,bottom:444}}),false);
  assert.equal(eligible({...state,control:{top:10,bottom:54}}),true);
  assert.equal(eligible({...state,control:{top:50,bottom:94}}),false);
  assert.equal(eligible({...state,message:{top:270,bottom:900,height:630}}),false);
  assert.equal(eligible({...state,message:{top:50,bottom:250,height:200}}),false);
  assert.equal(eligible({...state,control:null}),false);
});

test('Floating Copy targets the reading area below the overlaid glass header', async () => {
  const {readingViewport, eligibleFloatingCopy} = await appHarness()('ui/message-copy.js');
  // Native DOMRect geometry is inherited and cannot be copied with object spread.
  const list = Object.create({top:0,bottom:500,height:500,left:0,right:390,width:390});
  const viewport = readingViewport(list,{bottom:96});
  assert.equal(viewport.top,96);assert.equal(viewport.height,404);assert.equal(viewport.width,390);assert.equal(viewport.bottom,500);
  assert.equal(eligibleFloatingCopy({viewport,message:{top:-200,bottom:330,height:530},control:{top:45,bottom:89}}),true);
  assert.equal(eligibleFloatingCopy({viewport,message:{top:0,bottom:440,height:440},control:{top:390,bottom:434}}),false);
  assert.equal(readingViewport(list,null).height,500);
  assert.equal(readingViewport(list,{bottom:600}).height,0);
  const aboveInput=readingViewport(list,{bottom:52},{top:390});
  assert.equal(aboveInput.bottom,390);assert.equal(aboveInput.height,338);
  assert.equal(eligibleFloatingCopy({viewport:aboveInput,message:{top:20,bottom:450,height:430},control:{top:402,bottom:446}}),true);
});

test('Copy uses only displayed body text, marks success and restores the Copy label', async () => {
  const timers = [], classes = new Set(), body = {innerText:'Visible story\n\nSecond paragraph',textContent:'fallback'};
  const message = {querySelector:selector=>selector === '.msg-content' ? body : null,classList:{add:k=>classes.add(k),remove:k=>classes.delete(k)}};
  const ui = await appHarness({globals:{document:doc,setTimeout:fn=>timers.push(fn)}})('ui/message-copy.js');
  const button = control(); button.dataset.iconLabel = 'Copy message being read';
  let copied;
  await ui.copyDisplayedMessage(message,button,async text=>{copied=text;});
  assert.equal(copied,body.innerText); assert.equal(button.dataset.icon,'check'); assert.equal(classes.has('copied'),true);
  await ui.copyDisplayedMessage(message,button,async()=>{});
  timers.forEach(fn=>fn()); assert.equal(button.dataset.icon,'copy'); assert.equal(button.attributes['aria-label'],'Copy message being read');
  assert.equal(classes.has('copied'),false);
  await assert.rejects(ui.copyDisplayedMessage(message,button,async()=>{throw Error('denied');}),/denied/);
  assert.equal(classes.has('copied'),false);
});

test('Floating Copy coalesces scrolls, hit-tests only the midpoint and hides for selection, dialogs or editing', async () => {
  const frames = [], events = {}, button = control(); let selected=false, dialog=false, editing=false, hits=0, rightOnly=false, gutter=12; const points=[];
  const viewport={top:50,bottom:450,left:0,right:390,width:390,height:400};
  const controlRect={getBoundingClientRect:()=>({top:856,bottom:900})};
  const message={dataset:{copyReady:'true'},getBoundingClientRect:()=>({top:10,bottom:900,height:890}),querySelector:()=>controlRect};
  const list={getBoundingClientRect:()=>viewport,contains:n=>n===message,addEventListener:(k,fn)=>events[k]=fn};
  const document={...doc,body:{classList:{contains:()=>false}},getSelection:()=>({isCollapsed:!selected}),querySelector:()=>dialog ? {} : null,querySelectorAll:()=>[],
    elementsFromPoint:(x,y)=>{hits++;points.push(x);assert.equal(y,250);return rightOnly && x===720 ? [] : [{closest:()=>message}];},addEventListener:(k,fn)=>events[k]=fn};
  const {initFloatingCopy}=await appHarness({globals:{document,window:{addEventListener(){},getComputedStyle:()=>({paddingRight:gutter+'px'})}}})('ui/message-copy.js');
  initFloatingCopy({list,button,editing:()=>editing,onError:()=>{},doc:document,frame:fn=>frames.push(fn)});
  events.scroll(); events.scroll(); assert.equal(frames.length,1); frames.shift()(); assert.equal(button.hidden,false); assert.equal(hits,1);
  selected=true;events.selectionchange();frames.shift()();assert.equal(button.hidden,true);
  selected=false;dialog=true;events['ui-surface-change']();frames.shift()();assert.equal(button.hidden,true);
  dialog=false;editing=true;events.scroll();frames.shift()();assert.equal(button.hidden,true);
  editing=false;message.dataset.copyReady='false';events.scroll();frames.shift()();assert.equal(button.hidden,true);
  message.dataset.copyReady='true';viewport.right=viewport.width=1440;gutter=330;rightOnly=true;points.length=0;
  events.scroll();frames.shift()();assert.equal(button.hidden,false);assert.deepEqual(points,[720,1102]);
});

for (const success of [true,false]) test(`Clipboard fallback restores focus, input and document selection, and both scroll surfaces on ${success ? 'success' : 'failure'}`, async () => {
  const parent={scrollTop:15,scrollLeft:2},conversation={scrollTop:820,scrollLeft:0}, active={scrollTop:30,scrollLeft:0,parentElement:parent,selectionStart:2,selectionEnd:5,selectionDirection:'backward',
    focus(options){assert.equal(options.preventScroll,true); document.activeElement=this;},setSelectionRange(...args){this.restored=args;}};
  const savedRange={id:1},ranges=[{cloneRange:()=>savedRange}];
  const selection={rangeCount:1,getRangeAt:i=>ranges[i],removeAllRanges(){this.restored=[];},addRange(r){this.restored.push(r);}};
  let removed=false;
  const document={activeElement:active,getSelection:()=>selection,querySelectorAll:()=>[conversation],body:{appendChild(){}},
    createElement:()=>({style:{},setAttribute(){},focus(){document.activeElement=this;active.scrollTop=0;parent.scrollTop=0;conversation.scrollTop=0;window.scrollY=99;},select(){},setSelectionRange(){},remove(){removed=true;}}),execCommand:()=>success};
  const window={scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
  const {copyText}=await appHarness({globals:{document,window,navigator:{clipboard:{writeText:async()=>{throw Error('unsupported');}}}}})('ui/clipboard.js');
  if(success) await copyText('Story'); else await assert.rejects(copyText('Story'),/Could not copy/);
  assert.equal(document.activeElement,active);assert.deepEqual(active.restored,[2,5,'backward']);
  assert.equal(active.scrollTop,30);assert.equal(parent.scrollTop,15);assert.equal(conversation.scrollTop,820);assert.equal(window.scrollY,0);
  assert.equal(selection.restored[0],savedRange);assert.equal(removed,true);
});

test('Keyboard safe-area inference distinguishes software keyboard, toolbars, hardware focus and dismissal', async () => {
  const {keyboardVisible}=await appHarness()('viewport.js');
  const base={height:800,layoutHeight:800,baselineHeight:800,focused:true};
  assert.equal(keyboardVisible(base),false);
  assert.equal(keyboardVisible({...base,height:720}),false);
  assert.equal(keyboardVisible({...base,height:450}),true);
  assert.equal(keyboardVisible({...base,height:450,layoutHeight:450}),true);
  assert.equal(keyboardVisible({...base,height:450,focused:false,wasOpen:true}),true);
  assert.equal(keyboardVisible({...base,height:800,focused:false,wasOpen:true}),false);
  assert.equal(keyboardVisible({...base,height:450,focused:false}),false);
});

test('Viewport batches keyboard changes, avoids duplicate safe area and preserves pinch zoom', async () => {
  const events={},frames=[],props={},viewport={scale:1,height:800,offsetTop:0,addEventListener:(key,fn)=>events['visual:'+key]=fn};
  const root={clientHeight:800,dataset:{},style:{setProperty:(key,value)=>props[key]=value}};
  const document={documentElement:root,activeElement:{matches:()=>true},addEventListener:(key,fn)=>events[key]=fn};
  const window={visualViewport:viewport,innerHeight:800,innerWidth:390,scrollX:0,scrollY:0,addEventListener:(key,fn)=>events[key]=fn,scrollTo(){throw Error('No viewport scroll expected');}};
  const {initViewport}=await appHarness({globals:{document,window,navigator:{userAgent:'iPhone'},requestAnimationFrame:fn=>frames.push(fn)}})('viewport.js');
  initViewport(); assert.equal(props['--composer-safe-bottom'],'var(--safe-bottom)');
  viewport.height=450;events['visual:resize']();events['visual:scroll']();assert.equal(frames.length,1);frames.shift()();
  assert.equal(props['--composer-safe-bottom'],'0px');assert.equal(root.dataset.keyboard,'open');
  viewport.scale=2;viewport.height=225;events['visual:resize']();frames.shift()();assert.equal(props['--app-height'],'450px');
  viewport.scale=1;viewport.height=800;events['visual:resize']();frames.shift()();assert.equal(props['--composer-safe-bottom'],'var(--safe-bottom)');
});
