import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const element=(tag,text='')=>({tag,textContent:text,children:[],listeners:{},append(...items){this.children.push(...items);},addEventListener(type,fn){this.listeners[type]=fn;},focus(){},click(){return this.listeners.click?.();}});
async function setup() {
  const dialogs=[],fields=[],control=element('button'),data={owner:'u',busy:false,changes:0,story:{id:'s',memory:{scene:true,calendar:{mode:'modern',anchor:'Friday 21/10/738'},startingScene:'date: 1/10/738 · time: 10:00 · place: Hall · present: Mira'}},messages:[]};
  const ui={node:element,field:(label,value)=>{const input=element('input');input.value=value;const wrap=element('label',label);wrap.append(input);const f={wrap,input};fields.push(f);return f;},button:(label,fn)=>{const b=element('button',label);b.addEventListener('click',fn);return b;},subSheet:()=>{const dialog=element('dialog'),s={dialog,hidden:false,hide:()=>s.hidden=true};dialogs.push(s);return s;}};
  const use=appHarness({stubs:{'ui/memory-ui.js':ui}}),module=await use('ui/plan-jump.js'),jump=module.createPlanJumpControl(control,{story:()=>data.story,messages:()=>data.messages,owner:()=>data.owner,busy:()=>data.busy,changed:()=>data.changes++});
  const open=()=>{control.click();return dialogs.at(-1);},action=(dialog,label)=>dialog.dialog.children[0].children.find(x=>x.tag==='button' && x.textContent===label);
  return {jump,control,data,fields,open,action};
}
test('destination requires explicit confirmation, and can be cleared without advancing scene',async()=>{
  const h=await setup(),dialog=h.open(),before=JSON.stringify(h.data.story);h.fields.at(-1).input.value='19/10/738';assert.equal(h.jump.get(),null);
  h.action(dialog,'Confirm destination').click();assert.deepEqual(JSON.parse(JSON.stringify(h.jump.get())),{from:'1/10/738',to:'19/10/738'});assert.equal(h.control.textContent,'Skip to 19/10/738');assert.equal(JSON.stringify(h.data.story),before);assert.equal(h.data.changes,1);
  const next=h.open();h.action(next,'Clear time skip').click();assert.equal(h.jump.get(),null);
});
for(const change of ['account','story','date','busy'])test(`confirmation rejects ${change} changes while dialog is open`,async()=>{
  const h=await setup(),dialog=h.open();h.fields.at(-1).input.value='19/10/738';
  if(change==='account')h.data.owner='other';if(change==='story')h.data.story={...h.data.story,id:'other'};if(change==='date')h.data.story.memory.startingScene=h.data.story.memory.startingScene.replace('1/10','2/10');if(change==='busy')h.data.busy=true;
  h.action(dialog,'Confirm destination').click();assert.equal(h.jump.preview(),null);assert.equal(dialog.hidden,false);assert.equal(h.data.changes,0);
});
test('changed story dates block saving a stale destination and disabling modern mode clears it',async()=>{
  const h=await setup(),dialog=h.open();h.fields.at(-1).input.value='19/10/738';h.action(dialog,'Confirm destination').click();h.data.story.memory.startingScene=h.data.story.memory.startingScene.replace('1/10','2/10');assert.throws(()=>h.jump.get(),/story date changed/);
  h.data.story.memory.calendar.mode='legacy';h.jump.refresh();assert.equal(h.control.hidden,true);assert.equal(h.jump.get(),null);
});
