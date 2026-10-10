import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';
const count=async t=>t.length;
async function setup() {const use=appHarness();return {select:await use('character-select.js'),core:await use('character-core.js'),lore:await use('lore-lines.js'),legacy:await use('lore-select.js'),format:await use('lore-format.js')};}
async function fixture() {
 const api=await setup();const names=['Isolde','Liora','Mira','Kael','Neris','Vesper','Lysandra','Rowan'];
 const entries=names.map((name,i)=>{const e=api.lore.makeEntry('characters',name,{id:'c'+i});
 e.sections.personality.text=i===0 ? 'Obedience is not affection; she chooses her own loyalties.' : i===1 ? 'Her development depends on actual childhood events, if they occur.' : 'Independent and deliberate; cannot read private thoughts.';
 e.sections.appearance.text='Distinct silver eyes.';
 e.sections.notes.text='Background '.repeat(150);
 e.coreReferences=[api.core.reviewCore(e,[api.core.coreSource(e,'personality'),api.core.coreSource(e,'appearance')])];return e;});
 return {...api,entries,selected:entries.map(entry=>({entry,reason:'in scene'}))};
}
test('eight reviewed cores fit before optional background; card cap and lore stay unchanged',async()=>{
 const f=await fixture(),before=JSON.stringify(f.entries),mem={lorebooks:true,protagonist:'',books:{characters:{on:true,maxCards:8},locations:{on:false},facts:{on:false},events:{on:false}}};
 const cards=f.legacy.selectEntries(f.entries,mem,'', {present:f.entries.map(e=>e.name)}).selected.characters;
 assert.equal(cards.length,8);const fit=await f.select.fitCharacters(cards,950,count);
 assert.equal(fit.included.length,8);assert.ok(fit.selectionReport.characters.every(c=>Object.values(c.coreCoverage).every(Boolean)));
 assert.match(fit.text,/Obedience is not affection/);assert.match(fit.text,/depends on actual childhood events, if they occur/);assert.ok(fit.tokens<=950);
 assert.equal(JSON.stringify(f.entries),before);assert.equal(mem.books.characters.maxCards,8);
});
test('full fit preserves legacy rendering exactly, deterministic including shuffled notes',async()=>{
 const f=await fixture();const fit=await f.select.fitCharacters(f.selected,100000,count);const legacy=await f.legacy.fitBook(f.selected,100000,count);
 assert.equal(fit.text,legacy.text);assert.equal(fit.selectionReport.fullFit,true);
 assert.equal(JSON.stringify(await f.select.fitCharacters(f.selected,950,count)),JSON.stringify(await f.select.fitCharacters(f.selected,950,count)));
});
test('distinct literal matches rank older facts above newer unrelated notes; own name and repetition ignored',async()=>{
 const {select,lore}=await setup(),e=lore.makeEntry('characters','Mira');e.sections.notes.lines=[{id:'old',text:'Mira cannot command the academy council.',by:'user',turn:1},{id:'new',text:'Mira Mira Mira likes ribbons.',by:'user',turn:20}];
 const units=select.resolveCharacterUnits(e,'Mira asks the academy council about command command.','');
 assert.equal(units.units[0].sources[0].lineId,'old');assert.deepEqual(Array.from(units.units[0].current),['academy','command','council']);
 assert.equal(units.units[1].current.length,0);
 const limit=(await count('Mira'))+100;const fit=await select.fitCharacters([{entry:e}],limit,count,{currentText:'academy council command'});
 assert.match(fit.text,/cannot command/);
 const m=select.detailMatches('雪の学園 magic','雪の学園 magic magic','',e);assert.equal(m.current.length,2);
});
test('oversized cores do not block smaller units; impossible budgets and absent cores report gaps',async()=>{
 const {select,core,lore}=await setup(),e=lore.makeEntry('characters','Mira');e.sections.personality.text='Long constraint '.repeat(100);e.sections.status.text='Blind.';e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'personality')],['personality','constraints'])];
 const fit=await select.fitCharacters([{entry:e}],100,count);assert.match(fit.text,/Blind/);assert.ok(fit.selectionReport.characters[0].missingCoverage.includes('constraints'));
 const tiny=await select.fitCharacters([{entry:e}],0,count);assert.equal(tiny.text,'');assert.equal(tiny.selectionReport.characters[0].identity,false);
 delete e.coreReferences;const missing=await select.fitCharacters([{entry:e}],100,count);assert.ok(missing.selectionReport.characters[0].missingCoverage.includes('personality'));
});
test('core sources invalidate entire bundles on source edits, deletion or changed provenance',async()=>{
 const f=await fixture(),e=structuredClone(f.entries[0]);e.sections.personality.text+=' Unless forbidden.';
 assert.equal(f.core.resolveCore(e,e.coreReferences[0]).valid,false);let fit=await f.select.fitCharacters([{entry:e}],100,count);assert.equal(fit.selectionReport.characters[0].invalidCores.length,1);
 const note={id:'bond',text:'Obeys orders, but affection is unproven.',by:'user',turn:1};e.sections.bond.lines=[note];const b=f.core.reviewCore(e,[f.core.coreSource(e,'bond','bond')],['constraints']);e.sections.bond.lines=[];assert.equal(f.core.resolveCore(e,b).valid,false);
 assert.throws(()=>f.core.coreSource({...e,sections:{...e.sections,bond:{...e.sections.bond,lines:[note]}}},'bond','bond',0,5),/complete note/);
});
test('JSON/Markdown book and card round trips preserve references; changed imports require review',async()=>{
 const f=await fixture(),e=f.entries[0];for(const text of [f.format.toJson([e]),f.format.toMarkdown([e])]) {
 const parsed=(text.startsWith('{') ? f.format.fromJson(text) : f.format.fromMarkdown(text)).entries[0];assert.equal(f.core.resolveCore(parsed,parsed.coreReferences[0]).valid,true);
 }
 for(const format of ['md','json']) {
 const parsed=f.format.parseCard(f.format.serializeCard(e,{format,storyId:'s'}));assert.equal(f.core.resolveCore(parsed.entry,parsed.entry.coreReferences[0]).valid,true);
 const same=f.format.planCardImport([e],parsed,{storyId:'s',targetId:e.id});assert.equal(f.core.resolveCore(same.data,same.data.coreReferences[0]).valid,true);
 parsed.entry.sections.personality.text+=' Revised.';const edited=f.format.planCardImport([e],parsed,{storyId:'s',targetId:e.id});assert.equal(f.core.resolveCore(edited.data,edited.data.coreReferences[0]).valid,false);
 }
 const n={id:'note',text:'Cannot control the council.',by:'user',turn:1};e.sections.notes.lines=[n];e.coreReferences=[f.core.reviewCore(e,[f.core.coreSource(e,'notes',n.id)],['constraints'])];
 const parsed=f.format.fromJson(f.format.toJson([e])),created=f.format.planImport([],parsed).writes[0].data;
 assert.equal(f.core.resolveCore(created,created.coreReferences[0]).valid,false); // New note IDs require review.
 const backup=structuredClone(e);e.sections.notes.lines=[];assert.equal(f.core.resolveCore(e,e.coreReferences[0]).valid,false);assert.equal(f.core.resolveCore(backup,backup.coreReferences[0]).valid,true);
});
test('optional details cannot split an oversized reviewed bundle or overlapping bundles',async()=>{
 const {select,core,lore}=await setup(),e=lore.makeEntry('characters','Isolde');
 e.sections.bond.lines=[{id:'a',text:'Obeys the council.',by:'user',turn:1},{id:'b',text:'This never establishes affection. '+ 'Long evidence '.repeat(40),by:'user',turn:1}];
 e.coreReferences=[core.reviewCore(e,e.sections.bond.lines.map(l=>core.coreSource(e,'bond',l.id)),['constraints'])];
 const fit=await select.fitCharacters([{entry:e}],100,count,{currentText:'council'});assert.doesNotMatch(fit.text,/Obeys/);assert.ok(fit.selectionReport.characters[0].missingCoverage.includes('constraints'));
});
test('fallback personality and appearance sections are complete units including notes',async()=>{
 const {select,lore}=await setup(),e=lore.makeEntry('characters','Liora');e.sections.personality.text='Development is conditional.';e.sections.personality.lines=[{id:'condition',text:'Only actual childhood events establish it. '+ 'Background '.repeat(40),by:'import'}];
 const fit=await select.fitCharacters([{entry:e}],100,count);assert.doesNotMatch(fit.text,/Development/);assert.ok(fit.selectionReport.characters[0].missingCoverage.includes('personality'));
});
test('partial passages render once, in source order, with exact omitted ranges',async()=>{
 const {select,core,lore}=await setup(),e=lore.makeEntry('characters','Mira');e.sections.notes.text='Background '.repeat(40)+'Cannot read minds. '+ 'Further background '.repeat(40);
 const start=e.sections.notes.text.indexOf('Cannot'),end=start+'Cannot read minds.'.length;e.coreReferences=[core.reviewCore(e,[core.coreSource(e,'notes',null,start,end)],['constraints'])];
 const fit=await select.fitCharacters([{entry:e}],100,count);assert.match(fit.text,/Cannot read minds\./);assert.equal(fit.text.split('Cannot').length,2);
 const whole=fit.selectionReport.characters[0].units.find(u=>u.id==='text:notes').sources[0];assert.equal(whole.included[0].text,'Cannot read minds.');assert.equal(whole.omitted.map(p=>p.text).join(''),e.sections.notes.text.slice(0,start)+e.sections.notes.text.slice(end));
});
test('invalid core metadata is rejected during imports rather than crashing request assembly',async()=>{
 const f=await fixture();const bad=structuredClone(f.entries[0]);bad.coreReferences=[null];assert.throws(()=>f.format.fromJson(f.format.toJson([bad])),/Invalid reviewed core/);
});

test('source changes during review cannot be silently approved',async()=>{
 const {core,lore}=await setup(),e=lore.makeEntry('characters','Mira');e.sections.personality.text='Cannot read minds.';const source=core.coreSource(e,'personality');e.sections.personality.text='Can read minds now.';
 assert.throws(()=>core.reviewCore(e,[source]),/changed during review/);
});
test('source keys distinguish arbitrary note IDs from section text',async()=>{
 const {select,lore}=await setup(),e=lore.makeEntry('characters','Mira');e.sections.notes.text='Long background '.repeat(100);e.sections.notes.lines=[{id:'text',text:'Cannot read minds.',by:'user'}];
 const fit=await select.fitCharacters([{entry:e}],100,count,{currentText:'read minds'});assert.match(fit.text,/Cannot read minds/);assert.doesNotMatch(fit.text,/Long background/);
});
