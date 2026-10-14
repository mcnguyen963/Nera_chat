import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
async function setup(){const use=appHarness();return {r:await use('lore-records.js'),l:await use('lore-lines.js'),s:await use('lore-record-select.js'),f:await use('lore-format.js'),core:await use('character-core.js')};}
const proposal=(e,records)=>({format:'nera-lorebook-layout',version:1,entries:[{entryId:e.id,records}]});
const record=(quote,extra={})=>({key:'r1',category:'constraint',coreCandidate:true,relatedEntryIds:[],triggers:[],sources:[{section:'notes',lineId:null,quote,occurrence:1}],...extra});
function card(l,book='characters',name='Mira'){const e=l.makeEntry(book,name);e.id=name.toLowerCase();return e;}
test('exact conversion preserves unassigned text, all source metadata and v3 JSON round trip',async()=>{
 const {r,l,f}=await setup(),e=card(l);e.sections.notes.text='Obedient. This does not establish affection. Unknown history remains unknown.';e.sections.notes.kind='snapshot';e.sections.notes.cutoff={turn:3,order:6};
 const result=r.convertLayout([e],proposal(e,[record('Obedient. This does not establish affection.')]));
 assert.equal(result.entries[0].recordLayout.records.length,2);assert.equal(result.warnings.length,1);
 const restored=r.fromRecordDocument(r.toRecordDocument(result.entries[0]));assert.deepEqual(plain(restored.sections),plain(e.sections));
 const text=f.toJson([restored]);assert.equal(JSON.parse(text).version,3);assert.deepEqual(plain(f.fromJson(text).entries[0]),plain(restored));assert.equal(r.approvedRecord(restored,restored.recordLayout.records[0]),false);
});
test('external layouts cannot rewrite, approve, split notes or reference foreign subjects',async()=>{
 const {r,l}=await setup(),e=card(l);e.sections.notes.text='Faithful, not affectionate.';e.sections.notes.lines=[{id:'note',text:'May leave if released.',by:'import',turn:2}];
 for(const rec of [record('faithful'),record(e.sections.notes.text,{approval:{fingerprint:'forged'}}),record(e.sections.notes.text,{relatedEntryIds:['foreign']}),record('May leave',{sources:[{section:'notes',lineId:'note',quote:'May leave',occurrence:1}]})])assert.throws(()=>r.convertLayout([e],proposal(e,[rec])));
 const wrong=proposal(e,[record(e.sections.notes.text)]);wrong.entries.push(wrong.entries[0]);assert.throws(()=>r.convertLayout([e],wrong),/repeated/);
});
test('repeated exact quotations use explicit occurrence and only that original passage',async()=>{
 const {r,l}=await setup(),e=card(l);e.sections.notes.text='Same. Other. Same.';const result=r.convertLayout([e],proposal(e,[record('Same.',{sources:[{section:'notes',lineId:null,quote:'Same.',occurrence:2}]})]));
 const ref=result.entries[0].recordLayout.records[0].sources[0];assert.equal(ref.start,13);assert.throws(()=>r.convertLayout([e],proposal(e,[record('Same.',{sources:[{section:'notes',lineId:null,quote:'Same.',occurrence:3}]})])));
});
test('core approval fingerprints complete sources and grouping; edits outside excerpt invalidate it',async()=>{
 const {r,l}=await setup(),e=card(l);e.sections.notes.text='Obedient. Affection is unknown.';let converted=r.convertLayout([e],proposal(e,[record('Obedient.')])).entries[0],core=converted.recordLayout.records[0];r.approveRecord(converted,core);assert.equal(r.approvedRecord(converted,core),true);
 const same=r.convertLayout([converted],proposal(converted,[record('Obedient.')])).entries[0];assert.equal(r.approvedRecord(same,same.recordLayout.records[0]),true);
 converted.sections.notes.text='Obedient. Affection is confirmed.';assert.equal(r.approvedRecord(converted,core),false);assert.equal(r.resolveRecord(converted,core).valid,false);
 converted=r.reconcileRecords(converted);assert.ok(converted.recordLayout.records.some(v=>r.resolveRecord(converted,v).text===converted.sections.notes.text));
});
test('unavailable qualifier never frees its surviving claim into an independent fallback',async()=>{
 const {r,l}=await setup(),e=card(l);e.sections.notes.text='Obedient.';e.sections.notes.lines=[{id:'qualifier',text:'Obedience does not establish affection.',by:'import'}];
 const p=record('Obedient.');p.sources.push({section:'notes',lineId:'qualifier',quote:e.sections.notes.lines[0].text,occurrence:1});const entry=r.convertLayout([e],proposal(e,[p])).entries[0];r.approveRecord(entry,entry.recordLayout.records[0]);entry.sections.notes.lines=[];
 const reconciled=r.reconcileRecords(entry);assert.equal(reconciled.recordLayout.records.length,1);assert.equal(r.resolveRecord(reconciled,reconciled.recordLayout.records[0]).valid,false);
});
test('legacy reviewed source cores survive migration with their original conditions',async()=>{
 const {r,l,core}=await setup(),e=card(l);e.sections.notes.text='Obedient, not affectionate.';e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'notes')],['constraints'])];
 const migrated=r.reconcileRecords(e);assert.equal(r.approvedRecord(migrated,migrated.recordLayout.records[0]),true);assert.equal(r.resolveRecord(migrated,migrated.recordLayout.records[0]).text,e.sections.notes.text);
});
test('explicit replacements require review, invalidate on edits, and cannot cycle',async()=>{
 const {r,l}=await setup(),e=card(l,'locations','Inn');e.sections.state.text='Old owner. New owner.';const p=proposal(e,[record('Old owner.',{category:'state',sources:[{section:'state',lineId:null,quote:'Old owner.',occurrence:1}]}),record('New owner.',{key:'r2',category:'state',sources:[{section:'state',lineId:null,quote:'New owner.',occurrence:1}]})]);const entry=r.convertLayout([e],p).entries[0],[a,b]=entry.recordLayout.records;b.supersedes=[a.id];assert.equal(r.validSupersession(entry,b),false);r.approveSupersession(entry,b);assert.equal(r.validSupersession(entry,b),true);a.supersedes=[b.id];assert.throws(()=>r.approveSupersession(entry,a),/cycle/);entry.sections.state.text+=' Another detail.';assert.equal(r.validSupersession(entry,b),false);
});
test('an older related event outranks an unrelated recent event without expanding linked characters',async()=>{
 const {r,l,s}=await setup(),timeline=card(l,'events','Timeline');timeline.kind='timeline';timeline.sections.text.lines=[{id:'old',text:'Mira recovered the letter.',turn:1,by:'import'},{id:'new',text:'A distant festival opened.',turn:99,by:'import'}];const entry=r.reconcileRecords(timeline);
 // Use the actual index shape rather than inventing a provider or model call.
 const use=appHarness(),select=await use('lore-select.js'),mira=card(l);const actual=await s.fitRecords([{entry,reason:'timeline'}],40,text=>text.length,{anchors:new Set([mira.id]),index:select.buildLoreIndex([mira,timeline])});
 assert.match(actual.text,/Mira recovered/);assert.doesNotMatch(actual.text,/festival/);assert.equal(actual.included.length,1);
});
test('small budgets never split approved bundles or exceed their book ceiling',async()=>{
 const {r,l,s}=await setup(),e=card(l,'facts','Magic');e.sections.text.text='The bond compels service. It does not establish affection.';const p=record(e.sections.text.text,{category:'constraint',sources:[{section:'text',lineId:null,quote:e.sections.text.text,occurrence:1}]});const entry=r.convertLayout([e],proposal(e,[p])).entries[0];r.approveRecord(entry,entry.recordLayout.records[0]);const fit=await s.fitRecords([{entry,reason:'always'}],20,text=>text.length,{anchors:new Set([entry.id])});assert.equal(fit.text,'');assert.ok(fit.tokens<=20);assert.equal(fit.recordReport.entries[0].records[0].selected,false);assert.equal(fit.recordReport.entries[0].text,'');assert.equal(fit.recordReport.entries[0].identity,false);
});
test('new extraction notes retain evidence and become records without model-side format changes',async()=>{
 const {r,l}=await setup(),e=r.reconcileRecords(card(l,'locations','Inn'));const source={id:'a',order:4,role:'assistant',content:'The inn burned.',narratorTurn:2};const range={fromTurn:2,toTurn:2,assistants:[{turn:2,order:4}]};const parsed=l.parseMemoryLines('T2 [loc] Inn | state: Upstairs burned.',{range,messages:[source],mem:{},protagonist:'Mira'});const changes=l.applyOps([e],parsed.ops,{messages:[source],session:{}});const migrated=r.fromRecordDocument(r.toRecordDocument(changes.entries[0]));assert.equal(migrated.sections.state.lines[0].evidence[0].id,'a');assert.ok(migrated.recordLayout.records.some(v=>r.resolveRecord(migrated,v).text==='Upstairs burned.'));
});
test('native v3 replacement preserves source IDs, relationships and valid approvals',async()=>{
 const {r,l,f}=await setup(),e=card(l),other=card(l,'locations','Inn');e.sections.notes.lines=[{id:'known-note',text:'Mira stays at the Inn.',by:'import',turn:3}];let entry=r.reconcileRecords(e);const core=entry.recordLayout.records[0];core.relatedEntryIds=[other.id];r.approveRecord(entry,core);
 const originals=[entry,r.reconcileRecords(other)],parsed=f.fromJson(f.toJson(originals)),plan=f.planImport(originals,parsed,{mode:'replace'}),restored=plan.writes.find(w=>w.data?.id===entry.id).data;
 assert.equal(restored.sections.notes.lines[0].id,'known-note');assert.equal(restored.recordLayout.records[0].relatedEntryIds[0],other.id);assert.equal(r.approvedRecord(restored,restored.recordLayout.records[0]),true);
});
test('conversion preserves an identical previously reviewed legacy core proposal',async()=>{
 const {r,l,core}=await setup(),e=card(l);e.sections.notes.text='Obedient, not affectionate.';e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'notes')],['constraints'])];const converted=r.convertLayout([e],proposal(e,[record(e.sections.notes.text)])).entries[0];assert.equal(r.approvedRecord(converted,converted.recordLayout.records[0]),true);
});
