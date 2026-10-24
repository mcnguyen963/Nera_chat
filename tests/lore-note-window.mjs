import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const plain=x=>JSON.parse(JSON.stringify(x));
const count=async text=>Math.ceil(text.length/4);
const history=Array.from({length:24},(_,i)=>({id:'m'+(i+1),order:i+1,role:i%2?'assistant':'user',revision:0,content:i===22?'Ask Mira at the Inn about Magic and Letter.':'Story exchange '+i}));
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:100000,maxResponseTokens:2000,keepRecentMessagesAfterSummary:4};
const note=(id,turn,by='auto')=>({id,text:'NOTE_'+id+'_END',turn,by,at:turn,src:turn*2,evidence:[{id:'m'+turn*2,order:turn*2,revision:0}]});
const notes=(prefix,n=5)=>Array.from({length:n},(_,i)=>note(prefix+(i+1),i+1));
async function setup(){const use=appHarness({stubs:{'tokenizer.js':{countTokens:count},'messages.js':{getMessages:async()=>{throw Error('Unexpected history fetch');}}}});return {use,l:await use('lore-lines.js'),r:await use('lore-records.js'),c:await use('character-core.js'),w:await use('lore-note-window.js')};}
function fixture(h,book='characters',id='mira',name='Mira') {
 const e=h.l.makeEntry(book,name,{id,alwaysLoad:true}),key=book==='characters'?'status':book==='locations'?'state':'text';
 e.sections[key].text='FIXED_'+id;
 e.sections[key].lines=notes(id+'_ordinary');
 return {e,key};
}
function pin(h,e,key,ids) {
 const entry=h.r.reconcileRecords(e);
 for(const record of entry.recordLayout.records)if(h.r.resolveRecord(entry,record).sources.some(s=>s.section===key&&ids.includes(s.lineId)))record.pinned=true;
 return entry;
}
const wire=built=>JSON.stringify(built.apiMessages ?? built.messages);

test('defaults, normalization and independent stories retain one note limit',async()=>{
 const h=await setup(),m=await h.use('memory-settings.js');
 assert.equal(m.normalizeMemory().loreNotesPerSection,3);
 for(const value of [undefined,null,'',NaN,Infinity,'invalid'])assert.equal(m.normalizeMemory({loreNotesPerSection:value}).loreNotesPerSection,3);
 assert.equal(m.normalizeMemory({loreNotesPerSection:0}).loreNotesPerSection,0);
 assert.equal(m.normalizeMemory({loreNotesPerSection:-2}).loreNotesPerSection,0);
 const a=m.normalizeMemory({loreNotesPerSection:8}),b=m.normalizeMemory();a.books.characters.budget=1;
 assert.equal(b.loreNotesPerSection,3);assert.equal(b.books.characters.budget,4000);
 assert.deepEqual(plain(m.normalizeMemory(JSON.parse(JSON.stringify(a)))),plain(a));
});

test('separate ordinary and pinned windows preserve author/imported notes and reviewed cores without mutation',async()=>{
 const h=await setup(),{e,key}=fixture(h);
 e.sections[key].lines.push(...notes('pinned'),...notes('core',4),...notes('author',4).map(l=>({...l,by:'user'})),...notes('import',4).map(l=>({...l,by:'import'})));
 e.sections.appearance.lines=notes('appearance');
 e.coreReferences=[h.c.reviewCore(e,e.sections[key].lines.filter(l=>l.id.startsWith('core')).map(l=>h.c.coreSource(e,key,l.id)),['constraints'])];
 const entry=pin(h,e,key,notes('pinned').map(l=>l.id));
 const coreRecord=entry.recordLayout.records.find(r=>r.id===e.coreReferences[0].id);coreRecord.pinned=true;
 const before=JSON.stringify(entry),limited=h.w.capLoreNotes(entry,3),ids=limited.sections[key].lines.map(l=>l.id);
 assert.equal(ids.filter(id=>id.startsWith('mira_ordinary')).length,3);assert.equal(ids.filter(id=>id.startsWith('pinned')).length,3);
 for(const prefix of ['core','author','import'])assert.equal(ids.filter(id=>id.startsWith(prefix)).length,4);
 assert.deepEqual(plain(limited.sections.appearance.lines.map(l=>l.id)),['appearance3','appearance4','appearance5']);
 assert.deepEqual(plain(h.w.noteLimitStats(limited)),{noteLimitCut:4,pinnedNoteLimitCut:2});
 assert.equal(h.c.resolveCore(limited,limited.coreReferences[0]).valid,true);assert.equal(h.r.approvedRecord(limited,coreRecord),true);
 assert.equal(JSON.stringify(entry),before);assert.equal(h.w.capLoreNotes(limited,3),limited);
 assert.equal(h.w.capLoreNotes(entry,0),entry);assert.equal(Object.getOwnPropertySymbols(entry).length,0);
});

test('recency uses turns before timestamps, stable ties, reorganized notes, and ignores imported dates',async()=>{
 const h=await setup(),{e,key}=fixture(h);e.sections[key].lines=[note('latest',5,'reorganize'),{...note('older',4),at:99999},note('tieFirst',5),note('tieLast',5),{...note('undated',1),turn:null,at:999999},note('authored',1,'user')];
 const capped=h.w.capLoreNotes(e,2);assert.deepEqual(plain(capped.sections[key].lines.map(l=>l.id)),['tieFirst','tieLast','authored']);
});

test('tight budgets never backfill capped older notes and Plan is unchanged',async()=>{
 const h=await setup(),{e,key}=fixture(h,'facts','rule','Magic'),api=await h.use('lore-select.js');e.sections[key].lines.at(-1).text='LARGE_LATEST '.repeat(500);
 const fit=await api.fitBook([{entry:e}],100,count,{loreNotesPerSection:1});assert.doesNotMatch(fit.text,/NOTE_rule_ordinary[1234]_END/);assert.equal(fit.included[0].noteLimitCut,4);assert.equal(fit.included[0].budgetLinesCut,1);
 const plan=h.l.makeEntry('plan','Future plans');plan.sections.text.lines=notes('plan',8);assert.equal(h.w.capLoreNotes(plan,1),plan);
});

for(const selection of ['legacy','characters','records'])test('all character loading paths cap full-fit requests and respect unlimited: '+selection,async()=>{
 const h=await setup(),{e,key}=fixture(h),api=await h.use(selection==='legacy'?'lore-select.js':selection==='characters'?'character-select.js':'lore-record-select.js');
 const fn=api.fitBook ?? api.fitCharacters ?? api.fitRecords,entry=selection==='records'?h.r.reconcileRecords(e):e,before=JSON.stringify(entry);
 const fit=await fn([{entry}],10000,count,{loreNotesPerSection:2});
 assert.doesNotMatch(fit.text,/mira_ordinary[123]_END/);assert.match(fit.text,/mira_ordinary4_END/);assert.match(fit.text,/mira_ordinary5_END/);
 assert.equal(fit.included[0].linesSent,2);assert.equal(fit.included[0].noteLimitCut,3);assert.equal(fit.included[0].budgetLinesCut,0);
 const unlimited=await fn([{entry}],10000,count,{loreNotesPerSection:0});assert.match(unlimited.text,/mira_ordinary1_END/);assert.equal(unlimited.included[0].linesSent,5);
 assert.equal(JSON.stringify(entry),before);
});

test('atomic pinned records cannot spill capped sources through fallback; supersession stays effective',async()=>{
 const h=await setup(),{e,key}=fixture(h);e.sections[key].lines=notes('pin',4);
 const entry=pin(h,e,key,['pin1','pin2','pin3','pin4']),source=id=>entry.recordLayout.records.find(r=>h.r.resolveRecord(entry,r).sources.some(s=>s.lineId===id));
 const first=source('pin1'),last=source('pin4'),bundle={...first,id:'bundle',sources:[...first.sources,...last.sources]};
 entry.recordLayout.records=entry.recordLayout.records.filter(r=>![first.id,last.id].includes(r.id)).concat(bundle);
 const api=await h.use('lore-record-select.js'),fit=await api.fitRecords([{entry}],10000,count,{loreNotesPerSection:2});
 assert.doesNotMatch(fit.text,/NOTE_pin[124]_END/);assert.match(fit.text,/NOTE_pin3_END/);
 assert.equal(fit.recordReport.entries[0].records.find(r=>r.id==='bundle').reason,'pinned generated note limit');
 assert.equal(fit.included[0].budgetLinesCut,0);assert.equal(fit.included[0].pinnedNoteLimitCut,3);
 entry.sections.status.lines.find(l=>l.id==='pin4').text+=' Class A roster';
 // Refresh source fingerprints after the authored edit, keeping the grouped pin.
 for(const record of entry.recordLayout.records)for(const ref of record.sources){const s=h.r.recordSources(entry).find(s=>s.id===ref.sourceId);ref.fingerprint=h.r.fingerprint(s);ref.end=s.data.text.length;}
 const director=await h.use('director-context.js'),before={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Mira']},event:null,decisions:[],threads:[],commitments:[]};
 const directed=await director.buildDirectorContext({id:'s',memory:{loreNotesPerSection:2,protagonist:'Mira'}},{...settings,directorProfileId:'small',profiles:[{id:'small',modelId:'small',apiKey:'mock',endpoint:'https://mock.test'}],directorMaxInputTokens:20000,directorMaxOutputTokens:2000,directorRecentTurns:2},[...history,{id:'action',role:'user',order:25,content:'Ask Mira about Class A.'}],[entry],before);
 assert.doesNotMatch(wire(directed),/NOTE_pin4_END/);
 const f=fixture(h,'facts','rule','Magic').e;f.sections.text.lines=[note('oldRule',1,'user'),note('replacement',2),note('latest',3)];
 const revised=h.r.reconcileRecords(f),old=revised.recordLayout.records.find(r=>h.r.resolveRecord(revised,r).text.includes('oldRule'));
 const replacement=revised.recordLayout.records.find(r=>h.r.resolveRecord(revised,r).text.includes('replacement'));replacement.supersedes=[old.id];h.r.approveSupersession(revised,replacement);
 const capped=await api.fitRecords([{entry:revised}],10000,count,{loreNotesPerSection:1});assert.doesNotMatch(capped.text,/oldRule|replacement/);assert.match(capped.text,/NOTE_latest_END/);
});

for(const records of [false,true])test('serialized narration caps each book independently after evidence/cutoff checks: '+records,async()=>{
 const h=await setup(),builder=await h.use('context-builder.js');
 const entries=[fixture(h).e,fixture(h,'locations','inn','Inn').e,fixture(h,'facts','magic','Magic').e,fixture(h,'events','letter','Letter').e,fixture(h,'events','timeline','Timeline').e];
 entries[3].kind='thread';entries[3].status='open';entries[4].kind='timeline';
 entries[0].sections.status.lines.push({...note('stale',11),evidence:[{id:'deleted',order:22,revision:0}]},{...note('future',11),src:24,evidence:[{id:'m24',order:24,revision:0}]});
 const loreEntries=records?entries.map(e=>h.r.reconcileRecords(e)):entries;
 const session={id:'s',loreSchemaVersion:records?3:2,memory:{lorebooks:true,loreNotesPerSection:2}},before=JSON.stringify(loreEntries);
 const built=await builder.buildContextForRequest(session,settings,{messages:history,loreEntries,upToOrder:24,includeInspection:true}),body=wire(built);
 for(const id of ['mira','inn','magic','letter','timeline']){assert.doesNotMatch(body,new RegExp(id+'_ordinary[123]_END'));assert.match(body,new RegExp(id+'_ordinary[45]_END'));}
 assert.doesNotMatch(body,/NOTE_stale_END|NOTE_future_END/);assert.equal(built.report.noteLimits.omitted.length,15);
 assert.ok(built.report.loaded.every(e=>e.budgetLinesCut===0));assert.equal(JSON.stringify(loreEntries),before);
 const preview=await builder.buildContextForRequest(session,settings,{messages:history,loreEntries,upToOrder:24});assert.deepEqual(plain(preview.apiMessages),plain(built.apiMessages));
});

for(const records of [false,true])test('Director hints, excerpts and Narrator reply briefs share the chosen limit: '+records,async()=>{
 const h=await setup(),director=await h.use('director-context.js'),builder=await h.use('context-builder.js');
 const {e,key}=fixture(h);e.sections[key].lines[0].text+=' Class A roster';
 const entries=records?[h.r.reconcileRecords(e)]:[e],before={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Mira']},event:null,decisions:[],threads:[],commitments:[]};
 const config={...settings,narrationMode:'director',directorProfileId:'small',profiles:[{id:'small',endpoint:'https://mock.test',apiKey:'mock',modelId:'small'}],directorMaxInputTokens:20000,directorMaxOutputTokens:2000,directorRecentTurns:2};
 const session={id:'s',loreSchemaVersion:records?3:2,memory:{lorebooks:true,protagonist:'Mira',loreNotesPerSection:1}},messages=[...history.slice(0,22),{id:'latest',order:23,role:'user',content:'Ask Mira about Class A.'}];
 const directed=await director.buildDirectorContext(session,config,messages,entries,before);assert.doesNotMatch(wire(directed),/NOTE_mira_ordinary[1234]_END/);assert.match(wire(directed),/NOTE_mira_ordinary5_END/);
 const turn={id:'t',before,after:before,contract:{memoryIds:['mira'],requiredMemoryIds:[],transition:'unchanged',objective:'Wait',stopCondition:'Wait'}};
 const narrated=await builder.buildContextForRequest(session,config,{messages,loreEntries:entries,directorTurn:turn,includeInspection:true});
 assert.doesNotMatch(wire(narrated),/NOTE_mira_ordinary[1234]_END/);assert.match(wire(narrated),/NOTE_mira_ordinary5_END/);assert.match(narrated.report.replyBrief.text,/NOTE_mira_ordinary5_END/);
 const unlimited=await director.buildDirectorContext({...session,memory:{...session.memory,loreNotesPerSection:0}},config,messages,entries,before);assert.match(wire(unlimited),/NOTE_mira_ordinary1_END/);
});

test('extraction and reorganization requests cap notes, preserve exact sent sources and retain all unsent notes',async()=>{
 const h=await setup(),prompts=await h.use('memory-prompts.js'),reorg=await h.use('memory-reorganize.js'),m=await h.use('memory-settings.js'),t=await h.use('turns.js');
 const {e,key}=fixture(h);e.sections[key].lines.push(note('manual',1,'user'),note('imported',1,'import'));
 const mem=m.normalizeMemory({lorebooks:true,loreNotesPerSection:2,lagTurns:0,batchTurns:2}),range=t.dueRange(history,{extractedThroughOrder:0},mem,{manual:true}),sections={[e.id]:[key]},before=JSON.stringify(e);
 const extracted=await prompts.buildExtractionMessages({settings,mem,entries:[e],messages:history,range,count});
 // Mention the card inside the processed batch, not just the latest user input.
 const mentionedHistory=history.map((v,i)=>i===0?{...v,content:'Ask Mira.'}:v),mentionedRange=t.dueRange(mentionedHistory,{extractedThroughOrder:0},mem,{manual:true});
 const mentioned=await prompts.buildExtractionMessages({settings,mem,entries:[e],messages:mentionedHistory,range:mentionedRange,count});
 assert.doesNotMatch(wire(mentioned),/NOTE_mira_ordinary[123]_END/);assert.match(wire(mentioned),/NOTE_mira_ordinary[45]_END/);assert.equal(mentioned.noteOmissions.length,3);
 const live={session:{id:'s'},settings,mem,messages:history},plan=await reorg.planReorganize(live,[e],sections,'',count);
 assert.equal(plan.batches.length,1);assert.equal(plan.noteOmissions.length,3);assert.ok(plan.warnings.some(s=>s.includes('generated note limit')));
 let request,calls=0;
 const result=await reorg.runReorganizeBatch(live,[e],sections,'',{count,complete:async options=>{calls++;request=options.messages;return {content:'T1 [char] Mira | status: Consolidated eligible notes.'};}});
 const serialized=JSON.stringify(request);assert.doesNotMatch(serialized,/NOTE_mira_ordinary[123]_END/);assert.match(serialized,/NOTE_mira_ordinary[45]_END/);assert.match(serialized,/NOTE_manual_END|NOTE_imported_END/);
 const p=result.previews[0],changed=p.sections[key].find(l=>l.by==='reorganize');assert.equal(changed.turn,1);assert.equal(changed.src,2); // The uncapped import at T1 was actually sent.
 assert.deepEqual(plain(p.sent[key].map(l=>l.id)),['mira_ordinary4','mira_ordinary5','imported']);
 for(const id of ['mira_ordinary1','mira_ordinary2','mira_ordinary3'])assert.ok(p.sections[key].some(l=>l.id===id));
 assert.equal(calls,1);assert.equal(JSON.stringify(e),before);assert.ok(extracted.messages.length);
});

test('reorganization excludes stale notes before the cap and never parses against omitted source turns',async()=>{
 const h=await setup(),reorg=await h.use('memory-reorganize.js'),m=await h.use('memory-settings.js'),{e,key}=fixture(h);
 e.sections[key].lines.push({...note('stale',10),needsReview:true});
 const live={settings,session:{id:'s'},mem:m.normalizeMemory({loreNotesPerSection:1}),messages:history},sections={[e.id]:[key]};
 const result=await reorg.runReorganizeBatch(live,[e],sections,'',{count,complete:async options=>{assert.doesNotMatch(JSON.stringify(options.messages),/NOTE_stale_END|mira_ordinary[1234]_END/);return {content:'T2 [char] Mira | status: Cleaned note.'};}});
 const p=result.previews[0],changed=p.sections[key].find(l=>l.by==='reorganize');assert.equal(changed.turn,5);assert.equal(changed.src,10);assert.deepEqual(plain(changed.evidence),[{id:'m10',order:10,revision:0}]);
 assert.equal(p.sent[key].length,1);assert.ok(p.sections[key].some(l=>l.id==='stale'));assert.equal(result.noteOmissions.filter(n=>n.reason==='generated note limit').length,4);
});

test('serialized story and maintenance requests retain separate pinned caps and exempt reviewed cores',async()=>{
 const h=await setup(),{e,key}=fixture(h);e.sections[key].lines.push(...notes('pin',5),...notes('core',4));
 e.coreReferences=[h.c.reviewCore(e,notes('core',4).map(l=>h.c.coreSource(e,key,l.id)),['constraints'])];
 const entry=pin(h,e,key,notes('pin').map(l=>l.id)),mem=(await h.use('memory-settings.js')).normalizeMemory({lorebooks:true,protagonist:'Mira',loreNotesPerSection:2,lagTurns:0,batchTurns:2});
 const builder=await h.use('context-builder.js'),p=await h.use('memory-prompts.js'),t=await h.use('turns.js');
 const messages=history.map((m,i)=>i===0?{...m,content:'Mira waits.'}:m),session={id:'s',loreSchemaVersion:3,memory:mem};
 const narrator=await builder.buildContextForRequest(session,settings,{messages,loreEntries:[entry]});
 const extraction=await p.buildExtractionMessages({settings,mem,entries:[entry],messages,range:t.dueRange(messages,{extractedThroughOrder:0},mem,{manual:true}),count});
 const reorganize=p.buildReorganizeMessages({settings,mem,entries:[entry],sections:{mira:['status']}});
 for(const body of [wire(narrator),wire(extraction),JSON.stringify(reorganize)]) {
   assert.doesNotMatch(body,/NOTE_mira_ordinary[123]_END|NOTE_pin[123]_END/);
   for(const id of ['mira_ordinary4','mira_ordinary5','pin4','pin5','core1','core2','core3','core4'])assert.match(body,new RegExp('NOTE_'+id+'_END'));
 }
});
