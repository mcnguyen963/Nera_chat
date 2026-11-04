import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const node=(tag,text='')=>({tag,textContent:text,children:[],listeners:{},append(...xs){this.children.push(...xs);},replaceChildren(...xs){this.children=xs;},contains(other){return this===other||this.children.some(c=>c.contains(other));},addEventListener(type,fn){this.listeners[type]=fn;},click(){return this.listeners.click?.();}});
const all=(root,predicate)=>[...(predicate(root)?[root]:[]),...root.children.flatMap(child=>all(child,predicate))];
const button=(root,label)=>all(root,n=>n.tag==='button'&&n.textContent===label)[0];
async function setup(){
 const dialogs=[],calls=[],ui={node,field:(label,value)=>{const input=node('input');input.value=value;const wrap=node('label',label);wrap.append(input);return {wrap,input};},button:(label,fn)=>{const b=node('button',label);b.addEventListener('click',fn);return b;},subSheet:()=>{const s={dialog:node('dialog'),hide(){this.hidden=true;}};dialogs.push(s);return s;},toast:()=>{},download:()=>{}};
 const use=appHarness({stubs:{'tokenizer.js':{countTokens:async text=>text.length},'ui/memory-ui.js':ui,'auth.js':{currentUid:()=> 'u'},'lore-store.js':{migrateRecords:async(...args)=>calls.push(['migrate',...args]),rollbackRecords:async(...args)=>calls.push(['rollback',...args])}}});
 const l=await use('lore-lines.js'),r=await use('lore-records.js'),entry=l.makeEntry('characters','Mira',{id:'mira'});entry.sections.notes.text='Old rule. New rule.';
 const layout={format:'nera-lorebook-layout',version:1,entries:[{entryId:entry.id,records:['Old rule.','New rule.'].map((quote,i)=>({key:'r'+i,category:'constraint',coreCandidate:true,relatedEntryIds:[],triggers:[],sources:[{section:'notes',lineId:null,quote,occurrence:1}]}))}]};
 return {use,r,entry,layout,dialogs,calls,root:node('div')};
}
test('record editor requires source review for core approval and explicit replacement approval',async()=>{
 const h=await setup(),entry=h.r.convertLayout([h.entry],h.layout).entries[0],api=await h.use('ui/lore-record-editor.js');let changes=0;
 api.renderRecordEditor(h.root,entry,{entries:[entry],onChange:()=>changes++});
 assert.throws(()=>button(h.root,'Approve this core').click(),/Review this core/);
 all(h.root,n=>n.tag==='label'&&n.textContent==='I reviewed the complete passage and its conditions')[0].children[0].checked=true;
 button(h.root,'Approve this core').click();assert.equal(h.r.approvedRecord(entry,entry.recordLayout.records[0]),true);
 const boxes=all(h.root,n=>n.tag==='section'&&n.children.some(c=>c.tag==='button'&&c.textContent==='Approve this core'));
 const replacement=all(boxes[1],n=>n.tag==='label'&&n.textContent==='Old rule.')[0].children[0];replacement.checked=true;replacement.listeners.change();
 assert.equal(h.r.validSupersession(entry,entry.recordLayout.records[1]),false);
 button(boxes[1],'Approve selected replacements').click();assert.equal(h.r.validSupersession(entry,entry.recordLayout.records[1]),true);assert.ok(changes>=3);
});
test('plan editor stages completion, validates dates, and saves only on explicit action',async()=>{
 const h=await setup(),api=await h.use('ui/plan-editor.js'),l=await h.use('lore-lines.js'),entry=l.makeEntry('plan','Festival');let saves=0;
 entry.schedule={start:'1/10/738',end:'20/10/738',status:'pending',phases:[]};entry.sections.text.text='The festival opens.';
 api.renderPlanEditor(h.root,entry,{date:'1/10/738',budget:10000,save:()=>saves++,remove:()=>{},cancel:()=>{}});
 button(h.root,'+ Add phase').click();assert.equal(entry.schedule.phases.length,1);assert.equal(saves,0);
 button(h.root,'Complete phase').click();assert.equal(entry.schedule.phases[0].status,'completed');button(h.root,'Reopen phase').click();assert.equal(entry.schedule.phases[0].status,'pending');
 button(h.root,'Complete event').click();assert.equal(entry.schedule.status,'completed');button(h.root,'Reopen event').click();assert.equal(entry.schedule.status,'pending');
 const start=all(h.root,n=>n.tag==='label'&&n.textContent==='Start date · D/M/YYYY')[0].children[0];start.value='21/10/738';start.listeners.input();assert.throws(()=>button(h.root,'Save').click(),/date|start|end/i);assert.equal(saves,0);
 start.value='1/10/738';start.listeners.input();button(h.root,'Remove phase').click();button(h.root,'Save').click();assert.equal(saves,1);
});
test('record conversion previews before migrating and rollback preserves the expected revision',async()=>{
 const h=await setup(),api=await h.use('ui/lore-record-conversion.js'),snapshot={session:{id:'s',loreRevision:7,loreSchemaVersion:3},entries:[h.entry],messages:[]};let current=true;
 api.addRecordConversion(h.root,{snapshot:()=>snapshot,prepare:async()=>snapshot,isCurrent:()=>current});
 await button(h.root,'Review layout / migrate').click();const dialog=h.dialogs[0];
 await assert.rejects(button(dialog.dialog,'Migrate this story').click(),/Preview/);assert.equal(h.calls.length,0);
 button(dialog.dialog,'Preview conversion').click();current=false;await assert.rejects(button(dialog.dialog,'Migrate this story').click(),/changed/);assert.equal(h.calls.length,0);
 current=true;await button(dialog.dialog,'Migrate this story').click();assert.equal(dialog.hidden,true);assert.equal(h.calls[0][0],'migrate');assert.equal(h.calls[0][1],'s');assert.equal(h.calls[0][2][0].sections.notes.text,h.entry.sections.notes.text);assert.equal(h.calls[0][3].expectedRevision,7);
 await button(h.root,'Return to legacy selection').click();assert.equal(h.calls[1][0],'rollback');assert.equal(h.calls[1][1],'s');assert.equal(h.calls[1][2].expectedRevision,7);
});
