import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

async function fixture(){
 let doc;
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.dataset={};this.classList={add(){}};}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  dispatchEvent(e){e.target??=this;e.stopPropagation??=()=>{e.stopped=true;};for(const fn of this.listeners[e.type]??[])fn(e);if(!e.stopped)this.parent?.dispatchEvent(e);}
  setAttribute(k,v){this.attrs[k]=v;}
  set open(v){if(this._open===v)return;this._open=v;this.dispatchEvent({type:'toggle',stopped:true});}
  get open(){return !!this._open;}
  focus(){doc.activeElement=this;}
  contains(n){return n===this||this.children.some(c=>c.contains(n));}
  closest(tag){return this.tag===tag?this:this.parent?.closest(tag);}
  getClientRects(){return [1];}
  querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
  querySelector(tag){return this.querySelectorAll(tag)[0];}
 }
 doc=new Element('document');doc.createElement=tag=>new Element(tag);
 const use=appHarness({globals:{document:doc,CustomEvent:class{constructor(type){this.type=type;}}}}),api=await use('ui/message-menu.js');api.initMessageMenus();
 const make=()=>{let count=0;const action=new Element('button');action.addEventListener('click',()=>count++);const menu=api.messageMenu([action]);doc.append(menu);return {menu,trigger:menu.children[0],backdrop:menu.children[1],panel:menu.children[2],action,count:()=>count};};
 return {doc,make};
}

test('message menus close each other and Escape, outside click and backdrop restore the correct state',async()=>{
 const h=await fixture(),a=h.make(),b=h.make();a.menu.open=true;assert.equal(a.trigger.attrs['aria-expanded'],'true');
 b.menu.open=true;assert.equal(a.menu.open,false);assert.equal(a.trigger.attrs['aria-expanded'],'false');
 h.doc.dispatchEvent({type:'keydown',key:'Escape'});assert.equal(b.menu.open,false);assert.equal(h.doc.activeElement,b.trigger);assert.equal(b.trigger.attrs['aria-expanded'],'false');
 a.menu.open=true;h.doc.dispatchEvent({type:'click',target:h.doc});assert.equal(a.menu.open,false);
 b.menu.open=true;b.backdrop.dispatchEvent({type:'click'});assert.equal(b.menu.open,false);assert.equal(h.doc.activeElement,b.trigger);
});

test('message menus wrap Tab around visible controls and close after the selected action runs',async()=>{
 const h=await fixture(),a=h.make();a.menu.open=true;let prevented=0;
 a.action.focus();a.menu.dispatchEvent({type:'keydown',key:'Tab',preventDefault:()=>prevented++});assert.equal(h.doc.activeElement,a.trigger);
 a.menu.dispatchEvent({type:'keydown',key:'Tab',shiftKey:true,preventDefault:()=>prevented++});assert.equal(h.doc.activeElement,a.action);assert.equal(prevented,2);
 a.action.dispatchEvent({type:'click'});assert.equal(a.count(),1);assert.equal(a.menu.open,false);assert.equal(a.trigger.attrs['aria-expanded'],'false');
});
