import { promptFetch, promptImportMeta } from './prompt-files.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const plain = x => JSON.parse(JSON.stringify(x));
async function setup(stubs = {}, globals = {}) {
  const cache = new Map(), context = vm.createContext({ URL,fetch:promptFetch,console,structuredClone,TextEncoder,Date,Map,Set,AbortController,setTimeout,clearTimeout,...globals });
  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    const pending = create(path); cache.set(path, pending); return pending;
  }
  async function create(path) {
    const source = stubs[path];
    const module = source ? new vm.SyntheticModule(Object.keys(source),function () { for (const [k,v] of Object.entries(source)) this.setExport(k,v); },{ context,identifier:path }) : new vm.SourceTextModule(await readFile(new URL('../js/'+path,import.meta.url),'utf8'),{ context,identifier:path,initializeImportMeta:promptImportMeta });
    await module.link((specifier,parent) => load(specifier.startsWith('https:') ? specifier : new URL(specifier,'https://local/'+parent.identifier).pathname.slice(1)));
    return module;
  }
  return async path => { const m = await load(path); if (m.status !== 'evaluated') await m.evaluate(); return m.namespace; };
}
const count = async text => text.length;
const settings = { narratorSystemPrompt:'Narrate.',maxContextTokens:230000,maxResponseTokens:8192 };
const messages = Array.from({ length:12 },(_,i) => ({ id:'m'+(i+1),order:i+1,role:i%2 ? 'assistant' : 'user',content:'text '+i,scene:i%2 ? 'Day '+Math.ceil((i+1)/2)+' · night · Inn · present: Nera, Mira' : null,tokenCount:6 }));
function line(id,text,turn,by = 'auto') { return { id,text,turn,when:turn ? 'Day '+turn : null,src:turn ? turn*2 : null,by,at:turn ?? 0 }; }

test('memory defaults are off, deep normalized, bounded and request activity excludes collection alone',async () => {
  const use = await setup(), { normalizeMemory,memoryActive } = await use('memory-settings.js');
  const a = normalizeMemory(); assert.equal(memoryActive(a),false); assert.equal(a.autoUpdate,false);
  const b = normalizeMemory({ autoUpdate:true,batchTurns:1,lagTurns:999,books:{ characters:{ budget:-1,maxCards:99,on:false } } });
  assert.equal(memoryActive(b),false); assert.equal(b.batchTurns,2); assert.equal(b.lagTurns,50); assert.equal(b.books.characters.budget,0); assert.equal(b.books.characters.maxCards,50); assert.equal(b.books.events.budget,3000);
});
test('scene parsing accepts separators and missing fields, selects last tag, tracks missing streak',async () => {
  const use = await setup(), s = await use('scene.js');
  for (const separator of [' · ',' | ',' - ']) { const p = s.parseScene(['Day 9','night','Inn','present: A, a, B'].join(separator)); assert.equal(p.when,'Day 9'); assert.equal(p.place,'Inn'); assert.deepEqual(plain(p.present),['A','B']); }
  assert.equal(s.parseScene('Inn').when,null); assert.equal(s.parseScene('Day 2 | Inn').time,null);
  assert.equal(s.extractScene('<scene>one</scene>\n<SCENE>two\nthree</SCENE>'),null);
  const history = [{ role:'assistant',order:1,scene:'Inn' },{ role:'assistant',order:2,scene:null },{ role:'assistant',order:3 }];
  assert.equal(s.latestScene(history).missingStreak,2); assert.equal(s.latestScene(history,2).fromOrder,1); assert.equal(s.formatSceneForDisplay('Day 2 · present: A'),'Day 2 · A');
});
test('streamed complete, unclosed and partial scene prefixes never appear',async () => {
  const use = await setup(), { stripPlan } = await use('plan-parser.js'); let text = '';
  for (const chunk of ['the door closed.\n<sc','ene>Day 9 · night',' · Inn · present: A</scene>']) { text += chunk; assert.equal(stripPlan(text),'the door closed.'); }
  for (const prefix of ['<','<s','<sc','<sce','<scen','<scene']) assert.equal(stripPlan('Story'+prefix),'Story');
  assert.equal(stripPlan('A<scene>x</scene>B<plan_thread>x</plan_thread>'),'AB');
});
test('turn numbering handles greeting, consecutive users, summaries, trailing user and bounded due ranges',async () => {
  const use = await setup(), t = await use('turns.js'), { normalizeMemory } = await use('memory-settings.js');
  const ms = [{ id:'a',order:1,role:'assistant',content:'greeting' },{ id:'u',order:2,role:'user',content:'<ad>canon</ad> story' },{ id:'s',order:3,role:'summary' },{ id:'v',order:4,role:'user',content:'more' },{ id:'b',order:5,role:'assistant',content:'reply' },{ id:'w',order:6,role:'user',content:'next' }];
  const turns = t.computeTurns(ms); assert.equal(turns.lastTurn,2); assert.equal(turns.turnById.get('u'),2); assert.equal(turns.turnById.get('v'),2); assert.equal(turns.turnById.get('w'),3); assert.equal(t.turnStartOrder(turns,2),2); assert.equal(t.turnStartOrder(turns,3),6);
  const mem = normalizeMemory({ batchTurns:2,lagTurns:1 }); assert.equal(t.dueRange(messages,{ extractedThroughOrder:null },mem),null);
  const range = t.dueRange(messages,{ extractedThroughOrder:0 },mem); assert.equal(range.endOrder,4); assert.equal(range.messages.length,4);
  assert.equal(t.dueRange(messages,{ extractedThroughOrder:8 },mem),null); assert.equal(t.dueRange(messages,{ extractedThroughOrder:8 },mem,{ manual:true }).endOrder,10);
  const transcript = t.formatTurnsTranscript(ms,turns); assert.match(transcript,/AUTHOR NOTE: canon/); assert.doesNotMatch(transcript,/<ad>|greeting.*thinking/s);
});
test('mention boundaries, diacritics, possessives and overlapping longest names',async () => {
  const use = await setup(), { makeEntry } = await use('lore-lines.js'), select = await use('lore-select.js');
  const tom = makeEntry('characters','Tom'), old = makeEntry('characters','Old Tom'), mira = makeEntry('characters','Míra'); const index = select.buildLoreIndex([tom,old,mira]);
  assert.deepEqual(plain(select.findMentions("Old Tom greets Míra's friend and Tommy, Mira",index,'characters')),[old.id,mira.id]);
});
test('selection orders always, scene and mentioned, caps exclude always and drafts load',async () => {
  const use = await setup(), { makeEntry } = await use('lore-lines.js'), { normalizeMemory } = await use('memory-settings.js'), select = await use('lore-select.js');
  const a = makeEntry('characters','Nera',{ alwaysLoad:true }), b = makeEntry('characters','Mira',{ draft:true }), c = makeEntry('characters','Kael'), inn = makeEntry('locations','Ashford Inn',{ aliases:['the inn'] });
  const index = select.buildLoreIndex([a,b,c,inn]); assert.equal(select.resolveScene({ present:['Kael','Guard captain'],place:'Ashford Inn, upstairs' },index).place,inn.id);
  const result = select.selectEntries([a,b,c,inn],normalizeMemory({ lorebooks:true,books:{ characters:{ maxCards:1 } } }),"Mira's scar",{ present:['Kael'],place:'the inn' });
  assert.deepEqual(plain(result.selected.characters.map(e => e.reason)),['always','in scene']); assert.match(result.skipped[0].reason,/card limit/);
  const mentioned = select.selectEntries([a,b,c,inn],normalizeMemory({ lorebooks:true,books:{ characters:{ maxCards:2 } } }),"Mira's scar",{ present:['Kael'],place:'the inn' });
  assert.equal(mentioned.selected.characters.find(x => x.entry.id === b.id).entry.draft,true);
});
test('fitBook never truncates canon, preserves newest contiguous notes, rounds fairly and prioritizes events',async () => {
  const use = await setup(), { makeEntry } = await use('lore-lines.js'), { fitBook,renderEntry,renderEventsBlock } = await use('lore-select.js');
  const a = makeEntry('characters','Aaa'), b = makeEntry('characters','Bbb'); a.sections.notes.text = 'x'.repeat(300);
  const skipped = await fitBook([{ entry:a,reason:'always' }],50,count); assert.equal(skipped.included.length,0); assert.equal(a.sections.notes.text.length,300);
  a.sections.notes.text = ''; for (const e of [a,b]) e.sections.notes.lines = [line(e.id+'1','old'.repeat(40),1),line(e.id+'2','new',2),line(e.id+'3','newer',3)];
  const fitted = await fitBook([{ entry:a },{ entry:b }],130,count); assert.ok(fitted.included.every(e => e.lineIds.has(e.entry.id+'3'))); assert.ok(fitted.included.every(e => !e.lineIds.has(e.entry.id+'1')));
  assert.doesNotMatch(renderEntry(a,new Set([a.id+'3'])),/Personality:/);
  const thread = makeEntry('events','Find letter',{ kind:'thread',status:'open' }), timeline = makeEntry('events','Timeline',{ kind:'timeline' }); thread.sections.text.lines = [line('t1','first',1),line('t2','second',2),line('t3','third',3)]; timeline.sections.text.lines = [line('e1','event',1)];
  const events = await fitBook([{ entry:thread },{ entry:timeline }],120,count,{ events:true }); assert.ok(events.included[0].lineIds.has('t3')); assert.match(renderEventsBlock(events),/Open threads:/);
});
test('memory lines parse synonyms, reject personality and stoplist, cap text and dedupe, alias clashes and threads',async () => {
  const use = await setup(), l = await use('lore-lines.js'), { normalizeMemory } = await use('memory-settings.js'), { computeTurns } = await use('turns.js');
  const turns = computeTurns(messages), range = { assistants:turns.assistants,fromTurn:1,toTurn:6 }, mem = normalizeMemory({ protagonist:'Nera' });
  const parsed = l.parseMemoryLines('- T2 [character] Mira | looks: scar\n[char] Mira | personality: angry\n[char] she | status: tired\nT2 [place] Inn | state: burned\nT2 [char] Mira | relationship with Kael: rivals\nT2 [open] Letter | find it\nT2 [closed] Debt | repaid\nNONE',{ range,messages,mem });
  assert.equal(parsed.sawNone,true); assert.equal(parsed.ops[0].turn,2); assert.equal(parsed.ops[0].when,'Day 2'); assert.ok(parsed.skipped.some(s => /personality/.test(s.reason))); assert.ok(parsed.ops.some(o => o.text === 'Kael: rivals'));
  const mira = l.makeEntry('characters','Mira'), kael = l.makeEntry('characters','Kael'); mira.sections.appearance.lines = [line('existing','scar',2)];
  const applied = l.applyOps([mira,kael],[...parsed.ops,{ tag:'char',book:'characters',name:'Mira',section:'alias',text:'Kael' }],{ mem });
  assert.ok(applied.creates.some(e => e.name === 'Inn' && e.draft)); assert.ok(applied.skipped.some(s => /name already used/.test(s.reason))); assert.ok(applied.creates.find(e => e.kind === 'timeline').sections.text.lines[0].text.startsWith('Resolved: Debt'));
  const closed = l.makeEntry('events','Letter',{ kind:'thread',status:'closed' }); const reopened = l.applyOps([closed],[{ tag:'open',book:'events',name:'Letter',section:'text',text:'new lead',turn:6 }]); assert.equal(reopened.statusChanges[0].status,'open');
  const many = l.parseMemoryLines(Array.from({ length:85 },() => '[fact] Magic | '+ 'x'.repeat(450)).join('\n'),{ range,messages,mem }); assert.equal(many.ops.length,0); assert.equal(many.valid,false); assert.ok(many.skipped.every(s => /oversized/.test(s.reason)));
});
test('Markdown and JSON round trips preserve canon, stamps, aliases and thread status with lenient warnings',async () => {
  const use = await setup(), f = await use('lore-format.js');
  const source = '# Lorebooks\n## Characters\n### Mira\naliases: Witch\nalways load: yes\n\n#### Personality\nProud\n#### Appearance\nRed hair\n**Updates:**\n- [T41 · Day 9, Year 40] scar\n  left arm\n#### Hobby\nGardening\n## Events\n### Timeline\n- [T12] Arrival\n### Thread: Letter\nstatus: closed\nLost letter\nUpdates:\n- [Day 10] Found\n## Unknown\nSkipped';
  const parsed = f.fromMarkdown(source); assert.equal(parsed.entries[0].alwaysLoad,true); assert.equal(parsed.entries[0].sections.appearance.lines[0].text,'scar left arm'); assert.equal(parsed.entries[0].sections.appearance.lines[0].when,'Day 9, Year 40'); assert.ok(parsed.warnings.every(w => w.line>0));
  const canonical = entries => entries.map(e => ({ book:e.book,kind:e.kind,name:e.name,aliases:e.aliases,alwaysLoad:e.alwaysLoad,status:e.status,sections:Object.fromEntries(Object.entries(e.sections).map(([k,s]) => [k,{ text:s.text,lines:s.lines.map(({ text,turn,when }) => ({ text,turn,when })) }])) }));
  assert.deepEqual(plain(canonical(f.fromMarkdown(f.toMarkdown(parsed.entries)).entries)),plain(canonical(parsed.entries)));
  assert.deepEqual(plain(canonical(f.fromJson(f.toJson(parsed.entries)).entries)),plain(canonical(parsed.entries)));
  const lenient = f.fromJson('```json\n{"characters":[{"name":"Mira","mood":"x","sections":{"appearance":"red","notes":{"lines":["hello"]}}},{"sections":{}}],"events":["arrived"]}\n```'); assert.equal(lenient.entries[0].sections.notes.lines[0].text,'hello'); assert.equal(lenient.warnings.length,2); assert.equal(f.detectFormat('```json\n{}\n```'),'json');
  assert.throws(() => f.fromJson(''),/empty/); assert.throws(() => f.fromJson('{"characters":[]} bad'),/JSON error/);
});
test('import planning merges safely, respects conflicts, thread closure and replaces only books present',async () => {
  const use = await setup(), l = await use('lore-lines.js'), f = await use('lore-format.js');
  const e = l.makeEntry('characters','Mira'), place = l.makeEntry('locations','Inn'); e.sections.appearance.text = 'mine'; e.sections.appearance.lines = [line('old','scar',1)];
  const parsed = f.fromJson('{"characters":[{"name":"Mira","alwaysLoad":true,"sections":{"appearance":{"text":"file","lines":["scar","new"]}}}]}');
  const mine = f.planImport([e,place],parsed); assert.equal(mine.writes[0].data.sections.appearance.text,'mine'); assert.equal(mine.writes[0].data.sections.appearance.lines.length,2);
  assert.equal(f.planImport([e],parsed,{ conflict:'file' }).writes[0].data.sections.appearance.text,'file'); const both = f.planImport([e],parsed,{ conflict:'both' }).writes[0].data.sections.appearance; assert.equal(both.text,'mine'); assert.ok(both.lines.some(l => l.text === 'file' && l.kind === 'background'));
  const replace = f.planImport([e,place],parsed,{ mode:'replace' }); assert.equal(replace.writes.filter(w => w.delete).length,1); assert.ok(!replace.writes.some(w => w.id === place.id));
});

test('all-off and extraction-only modes use the same corrected request builder',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), builder = await use('context-builder.js');
  let expected;
  for (const memory of [undefined,{}, { autoUpdate:true }]) {
    const result = await builder.buildContextForRequest({ id:'s',memory,longTermPlan:'Fixed',allowLlmPlanUpdates:true },settings,{ messages,requireLatestUser:true });
    expected ??= JSON.stringify(result.apiMessages);
    assert.equal(JSON.stringify(result.apiMessages),expected); assert.equal(result.report.mode,'legacy');
    assert.match(result.apiMessages[0].content,/set by the user/);
  }
});
test('memory builder adds plan threads before scenes, keeps fixed plan in system and inserts block at depth or in user text',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), b = await use('context-builder.js'), l = await use('lore-lines.js');
  const history = [...messages,{ id:'latest',order:13,role:'user',content:'Ask Mira' }]; history[1].planThread = 'letter';
  const e = l.makeEntry('characters','Mira'); e.sections.appearance.text = 'scar';
  const only = await b.buildContextForRequest({ id:'s',longTermPlan:'unique plan',memory:{ scene:true } },settings,{ messages:history,requireLatestUser:true }); assert.match(only.apiMessages[0].content,/unique plan/); assert.match(only.apiMessages.find(m => m.content.includes('text 1')).content,/<plan_thread>.*<\/plan_thread>\n<scene>/s);
  for (const blockRole of ['system','user']) { const result = await b.buildContextForRequest({ id:'s',longTermPlan:'unique plan',memory:{ scene:true,lorebooks:true,memoryBlock:true,blockDepth:3,blockRole } },settings,{ messages:history,loreEntries:[e],requireLatestUser:true }); assert.match(result.apiMessages[0].content,/unique plan/); const memory = result.apiMessages.find(m => m.content.includes('## Mira')); assert.doesNotMatch(memory.content,/unique plan/); assert.doesNotMatch(memory.content,/fixed author plan/); if (blockRole === 'system') assert.equal(result.apiMessages.length-result.apiMessages.indexOf(memory)-1,3); else assert.match(result.apiMessages.at(-1).content,/^<memory>/); assert.ok(result.usedTokens+settings.maxResponseTokens<=settings.maxContextTokens); }
});
test('cache window aligns, falls back for oversized blocks, reports gaps and unused budget returns with F5 off',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), b = await use('context-builder.js'), l = await use('lore-lines.js');
  const overhead = (await b.buildContextForRequest({ id:'s',memory:{blockWindow:true} },settings,{ messages:[] })).usedTokens;
  const history = Array.from({ length:81 },(_,i) => ({ id:'m'+i,order:i+1,role:i%2 ? 'assistant' : 'user',content:'x'.repeat(60) }));
  const session = { id:'s',memory:{ blockWindow:true,batchTurns:10,autoUpdate:true },memoryState:{ extractedThroughOrder:2 } };
  const result = await b.buildContextForRequest(session,{ ...settings,maxContextTokens:overhead+2900,maxResponseTokens:100 },{ messages:history,requireLatestUser:true }); const window = result.report.blocks.find(b => b.key === 'window'); assert.equal(window.mode,'block'); assert.equal((window.fromTurn-1)%10,0); assert.ok(result.report.gap);
  const next = await b.buildContextForRequest(session,{ ...settings,maxContextTokens:overhead+2900,maxResponseTokens:100 },{ messages:[...history,{ id:'next',order:82,role:'assistant',content:'x'.repeat(60) },{ id:'user',order:83,role:'user',content:'x'.repeat(60) }],requireLatestUser:true }); assert.equal(next.report.blocks.find(b => b.key === 'window').fromTurn,window.fromTurn);
  const fallback = await b.buildContextForRequest(session,{ ...settings,maxContextTokens:overhead+900,maxResponseTokens:100 },{ messages:history,requireLatestUser:true }); assert.equal(fallback.report.blocks.find(b => b.key === 'window').mode,'fallback');
  const card = l.makeEntry('characters','Mira'); card.sections.notes.text = 'canon';
  const a = await b.buildContextForRequest({ ...session,memory:{ lorebooks:true,books:{ characters:{ budget:1200 } } } },{ ...settings,maxContextTokens:overhead+3600,maxResponseTokens:100 },{ messages:history,loreEntries:[card],requireLatestUser:true }); const c = await b.buildContextForRequest({ ...session,memory:{ lorebooks:true,blockWindow:true,books:{ characters:{ budget:1200 } } } },{ ...settings,maxContextTokens:overhead+3600,maxResponseTokens:100 },{ messages:history,loreEntries:[card],requireLatestUser:true }); assert.ok(a.windowedCount>=c.windowedCount);
});
test('extraction input bounds whole turns and excludes thinking and hidden plans; reorganize never rewrites user text',async () => {
  const use = await setup(), p = await use('memory-prompts.js'), t = await use('turns.js'), { normalizeMemory } = await use('memory-settings.js'), l = await use('lore-lines.js');
  const mem = normalizeMemory({ batchTurns:2,lagTurns:0,updateMaxTokens:256 }), range = t.dueRange(messages,{ extractedThroughOrder:0 },mem);
  const built = await p.buildExtractionMessages({ settings:{ ...settings,memoryExtractionPrompt:'extract {{PROTAGONIST}}' },mem,entries:[],messages,range,count }); assert.equal(built.range.endOrder,4); assert.match(built.messages[1].content,/NEW TURNS 1–2/);
  await assert.rejects(() => p.buildExtractionMessages({ settings:{ ...settings,maxContextTokens:800,memoryExtractionPrompt:'prompt' },mem,entries:[],messages:messages.map(m => ({ ...m,content:'x'.repeat(5000) })),range:{ ...range,messages:range.messages.map(m => ({ ...m,content:'x'.repeat(5000) })) },count }),/One turn is too long/);
  const entry = l.makeEntry('characters','Mira'); entry.sections.appearance.text = 'canon'; entry.sections.appearance.lines = [line('a','scar',2)]; const input = p.buildReorganizeMessages({ settings,mem,entries:[entry] }); assert.match(input[1].content,/canon, unknown cutoff/); assert.equal(entry.sections.appearance.text,'canon');
});

async function updaterHarness(complete) {
  const events = [], commits = [], writes = [];
  const use = await setup({
    'tokenizer.js':{ countTokens:count },'llm-client.js':{ chatCompletion:complete },
    'lore-store.js':{ markGeneratedForReview:async () => {},commitExtraction:async (...args) => commits.push(args) },
    'sessions.js':{ updateSession:async (...args) => writes.push(args) },'auth.js':{ currentUid:() => 'owner' },
  },{ document:{ dispatchEvent:e => events.push(e.detail) },CustomEvent:class { constructor(type,init) { this.type=type; this.detail=init.detail; } } });
  const updater = await use('memory-updater.js'), { normalizeMemory } = await use('memory-settings.js');
  const live = { session:{ id:'s',memory:normalizeMemory({ autoUpdate:true,batchTurns:2,lagTurns:0,updateMaxTokens:256 }),memoryState:{ extractedThroughOrder:0,failureStreak:0 } },settings,messages:structuredClone(messages),entries:[] };
  let busy = false, unlock;
  updater.configureMemoryUpdater({ get:() => live,busy:() => busy,waitIdle:() => busy ? new Promise(resolve => unlock=resolve) : Promise.resolve(),patch:(sid,patch,entries) => { Object.assign(live.session.memoryState,patch); if (entries) live.entries=entries; } });
  return { updater,live,events,commits,writes,setBusy(value) { busy=value; },unlock:() => unlock?.() };
}
test('updater waits for narration before commit, advances only on success and targets original story',async () => {
  let finish;
  const h = await updaterHarness(() => new Promise(resolve => finish=resolve));
  const pending = h.updater.updateNow('s');
  for (let i=0;i<30 && !finish;i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updater.isRunning('s'),true); h.setBusy(true); finish({ content:'T1 [char] Mira | appearance: scar' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.commits.length,0);
  h.setBusy(false); h.unlock(); await pending; assert.equal(h.commits.length,1); assert.equal(h.commits[0][0],'s'); assert.equal(h.live.session.memoryState.extractedThroughOrder,4); assert.equal(h.live.entries[0].draft,true);
});
test('source edits discard updates and three failures pause without advancing pointer',async () => {
  let finish;
  const stale = await updaterHarness(() => new Promise(resolve => finish=resolve)); const task = stale.updater.updateNow('s');
  for (let i=0;i<30 && !finish;i++) await new Promise(resolve => setImmediate(resolve));
  stale.live.messages[0].content = 'edited'; finish({ content:'[event] happened' }); await task; assert.equal(stale.commits.length,0); assert.equal(stale.live.session.memoryState.extractedThroughOrder,0);
  const failure = await updaterHarness(async () => { throw new Error('network failed'); });
  for (let i=0;i<3;i++) await failure.updater.updateNow('s'); assert.equal(failure.live.session.memoryState.paused,true); assert.equal(failure.live.session.memoryState.extractedThroughOrder,0); assert.equal(failure.writes.length,3);
});
test('ledger starts one update, rejects duplicate starts and skips auto-summary while due or running',async () => {
  let finish; const h = await updaterHarness(() => new Promise(resolve => finish=resolve));
  assert.equal(h.updater.maybeStartAfterTurn('s'),true); assert.equal(h.updater.maybeStartAfterTurn('s'),false);
  assert.equal(h.updater.shouldSkipAutoSummary({ autoUpdate:true },false,{}),true); assert.equal(h.updater.shouldSkipAutoSummary({ autoUpdate:false },true,null),true); assert.equal(h.updater.shouldSkipAutoSummary({ autoUpdate:false },false,null),false);
  for (let i=0;i<30 && !finish;i++) await new Promise(resolve => setImmediate(resolve)); finish({ content:'NONE' });
  for (let i=0;i<30 && h.updater.isRunning('s');i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(h.commits.length,1); assert.equal(h.live.session.memoryState.extractedThroughOrder,4);
});
test('memory updates explicitly disable OpenRouter reasoning without changing the floor model or output budget',async () => {
  let request;
  const h=await updaterHarness(async options => { request=options; return {content:'NONE'}; });
  h.live.settings={...settings,endpoint:'https://openrouter.ai/api/v1/chat/completions',modelId:'z-ai/glm-5.3-flash:floor',reasoning:{enabled:true,mode:'max_tokens',maxTokens:20000}};
  assert.equal(await h.updater.updateNow('s'),true);
  const use=await setup(),client=await use('llm-client.js');
  const body=client.buildRequestBody(request.settings,request.messages);
  assert.deepEqual(plain(body.reasoning),{enabled:false});
  assert.equal(body.max_tokens,256);assert.equal(body.model,'z-ai/glm-5.3-flash:floor');
  assert.match(body.messages[0].content,/under 400 characters/);
  assert.match(body.messages[0].content,/exact thread title/);
  assert.equal(client.buildRequestBody({...request.settings,endpoint:'https://example.test'},request.messages).reasoning,undefined);
});
test('reorganize explicitly disables reasoning in its serialized request',async () => {
  const use=await setup(),r=await use('memory-reorganize.js'),l=await use('lore-lines.js'),m=await use('memory-settings.js'),client=await use('llm-client.js');
  const entry=l.makeEntry('characters','Mira');entry.sections.appearance.lines=[line('a','scar',2)];
  let request;
  const live={settings:{...settings,endpoint:'https://openrouter.ai/api/v1/chat/completions',modelId:'z-ai/glm-5.3-flash:floor',reasoning:{enabled:true,effort:'high'}},mem:m.normalizeMemory(),messages};
  await r.runReorganizeBatch(live,[entry],{[entry.id]:['appearance']},'',{complete:async options=>{request=options;return {content:'T2 [char] Mira | appearance: scar'};}});
  const body=client.buildRequestBody(request.settings,request.messages);
  assert.deepEqual(plain(body.reasoning),{enabled:false});assert.equal(body.max_tokens,live.mem.reorganizeMaxTokens);
});
test('mixed valid and oversized notes never advance extraction past a dropped note',async () => {
  const content='T1 [event] Mira arrives.\nT2 [event] '+'x'.repeat(401);
  const h=await updaterHarness(async()=>({content}));
  assert.equal(await h.updater.updateNow('s'),false);assert.equal(h.commits.length,0);
  assert.equal(h.live.session.memoryState.extractedThroughOrder,0);assert.equal(h.live.entries.length,0);
  assert.match(h.live.session.memoryState.lastError,/400 characters/);assert.equal(h.updater.lastRawAnswer('s'),content);
  assert.equal(h.events.find(e=>e.status==='failed').lastError,h.live.session.memoryState.lastError);
});
test('full cards fail the whole memory batch and a paused retry commits and clears the error',async () => {
  const h=await updaterHarness(async()=>({content:'T1 [char] Mira | appearance: scar\nT2 [event] Mira arrives.'}));
  const use=await setup(),l=await use('lore-lines.js'),card=l.makeEntry('characters','Mira');
  card.sections.appearance.text='x'.repeat(900000);h.live.entries=[card];
  for(let i=0;i<3;i++)assert.equal(await h.updater.updateNow('s'),false);
  assert.equal(h.live.session.memoryState.paused,true);assert.equal(h.commits.length,0);
  assert.equal(h.live.session.memoryState.extractedThroughOrder,0);assert.match(h.live.session.memoryState.lastError,/Reorganize/);
  card.sections.appearance.text='Short canon';
  assert.equal(await h.updater.updateNow('s',{retry:true}),true);assert.equal(h.commits.length,1);
  assert.equal(h.live.session.memoryState.extractedThroughOrder,4);assert.equal(h.live.session.memoryState.lastError,null);
  assert.equal(h.live.session.memoryState.failureStreak,0);assert.equal(h.live.session.memoryState.paused,false);
});
test('duplicate memory notes are a successful no-op rather than repeated failures',async()=>{
  const h=await updaterHarness(async()=>({content:'T1 [char] Mira | appearance: scar'}));
  assert.equal(await h.updater.updateNow('s'),true);
  h.live.session.memoryState.extractedThroughOrder=0;
  assert.equal(await h.updater.updateNow('s'),true);assert.equal(h.live.entries[0].sections.appearance.lines.length,1);
  assert.equal(h.events.filter(e=>e.status==='success').at(-1).notes,0);
});
test('raw-answer inspection belongs to the current attempt and preserves rejected partial output only for inspection',async()=>{
  let attempt=0;
  const h=await updaterHarness(async()=>{
    if(++attempt===1)return {content:'bad old response'};
    if(attempt===2)throw Object.assign(new Error('The model stopped at its output limit.'),{partial:{content:'T1 [event] Incomplete'}});
    throw new Error('network failed');
  });
  assert.equal(await h.updater.updateNow('s'),false);assert.equal(h.updater.lastRawAnswer('s'),'bad old response');
  assert.equal(await h.updater.updateNow('s'),false);assert.equal(h.updater.lastRawAnswer('s'),'T1 [event] Incomplete');
  assert.equal(h.commits.length,0);assert.equal(h.live.session.memoryState.extractedThroughOrder,0);
  assert.equal(await h.updater.updateNow('s'),false);assert.equal(h.updater.lastRawAnswer('s'),'');
});
test('failed streamed memory notes remain inspectable without being committed',async()=>{
  const h=await updaterHarness(async options=>{options.onDelta('T1 [event] Partial note');throw new Error('The model stopped at its output limit.');});
  assert.equal(await h.updater.updateNow('s'),false);assert.equal(h.updater.lastRawAnswer('s'),'T1 [event] Partial note');
  assert.equal(h.commits.length,0);assert.equal(h.live.session.memoryState.extractedThroughOrder,0);
});
test('catch up reports a stopped failure and resumes only the uncommitted batches',async()=>{
  let calls=0;
  const h=await updaterHarness(async()=>{if(++calls===1)throw new Error('network failed');return {content:'NONE'};});
  assert.equal(await h.updater.catchUp('s'),false);assert.equal(calls,1);assert.equal(h.live.session.memoryState.extractedThroughOrder,0);
  assert.equal(await h.updater.catchUp('s'),true);assert.equal(calls,4);assert.equal(h.live.session.memoryState.extractedThroughOrder,12);
  assert.equal(h.live.session.memoryState.lastError,null);
  const controller=new AbortController();controller.abort();assert.equal(await h.updater.catchUp('s',{signal:controller.signal}),false);
});
test('T204 summary cutoff stays historical while later scene, placements and current user survive the narrator request',async()=>{
  // Synthetic reproduction of the reported conflict, not an export of the live story.
  const use=await setup({'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:count}});
  const b=await use('context-builder.js'),l=await use('lore-lines.js'),client=await use('llm-client.js');
  const history=[
    {id:'u1',order:1,narratorTurn:1,role:'user',content:'Begin the term.'},
    {id:'a1',order:2,narratorTurn:1,role:'assistant',content:'The term begins.'},
    {id:'summary',order:409,role:'summary',cutoffTurn:204,coveredRange:{toOrder:408},content:'End of T204: Nera is mid-hug with Vesper on her floor. Placements are expected on the fourth day.'},
    {id:'u205',order:410,narratorTurn:205,role:'user',content:'The class placements have been published.'},
    {id:'a205',order:411,narratorTurn:205,role:'assistant',revision:0,content:'It is morning in the common room. Isolde has the facilities records. The published list places Lysandra in Class A and Vesper in Class B.',thinking:'PRIVATE_REASONING_MUST_NOT_BE_SENT',scene:'date: First week of term · time: morning · place: Common room · present: Nera, Isolde'},
    {id:'u206',order:412,narratorTurn:206,role:'user',content:'A and B class so I will see Lysandra today. Did you give the records of our meeting with facilities office yesterday to group 3 Isolde? If yes we can go to the class now.'},
  ];
  const vesper=l.makeEntry('characters','Vesper',{createdFrom:'import',alwaysLoad:true});
  Object.assign(vesper.sections.status,{text:'Mid-hug with Nera on her floor.',kind:'snapshot',cutoff:{turn:204,order:408}});
  const placements=l.makeEntry('facts','Class placements');placements.sections.text.lines=[{id:'placed',text:'Lysandra is in Class A; Vesper is in Class B.',turn:205,when:'First week of term',src:411,by:'auto',at:1,evidence:[{id:'a205',revision:0,order:411}]}];
  const thread=l.makeEntry('events','Class posting',{kind:'thread',status:'open',createdFrom:'import'});thread.sections.text.text='The posting is expected on the fourth day.';
  const timeline=l.makeEntry('events','Timeline',{kind:'timeline'});timeline.sections.text.lines=[{id:'published',text:'Class placements were published.',turn:205,when:'First week of term',src:411,by:'auto',at:2,evidence:[{id:'a205',revision:0,order:411}]}];
  const session={id:'s',activeSummaryMessageId:'summary',breakpointOrder:408,memory:{scene:true,lorebooks:true,memoryBlock:true,protagonist:'Nera'}};
  const built=await b.buildContextForRequest(session,{...settings,keepRecentMessagesAfterSummary:10},{messages:history,loreEntries:[vesper,placements,thread,timeline],requireLatestUser:true});
  const body=client.buildRequestBody({...settings,modelId:'z-ai/glm-5.3-flash:floor'},built.apiMessages),wire=JSON.stringify(body),all=body.messages.map(m=>m.content).join('\n');
  assert.equal(body.model,'z-ai/glm-5.3-flash:floor');assert.equal(body.messages.at(-1).role,'user');
  assert.match(body.messages.at(-1).content,/facilities office yesterday to group 3 Isolde/);
  assert.match(all,/Historical summary through T204.*message order 408; this is not the current scene/);
  assert.match(all,/snapshot; origin: import; T204.*message order 408/);
  assert.match(all,/\[T205 · First week of term\] Lysandra is in Class A; Vesper is in Class B/);
  assert.match(all,/\[T205 · First week of term\] Class placements were published/);
  assert.match(all,/Established scene snapshot at T205 \(message order 411\).*Common room/);
  assert.match(all,/published class placements supersede an earlier expectation/);
  assert.doesNotMatch(wire,/PRIVATE_REASONING_MUST_NOT_BE_SENT/);
  assert.equal(built.report.scene.fromTurn,205);assert.equal(built.droppedCount,0);
  // Provenance is counted in the fully rendered payload, including event re-rendering.
  assert.equal(built.usedTokens,8+body.messages.reduce((n,m)=>n+8+m.content.length,0));
});
test('reorganize batches stay bounded, ignore outside names and leave user lines and canon intact',async () => {
  const use = await setup({ 'tokenizer.js':{ countTokens:count },'llm-client.js':{ chatCompletion:async () => ({ content:'T2 [char] Mira | appearance: scar' }) } }), r = await use('memory-reorganize.js'), l = await use('lore-lines.js'), { normalizeMemory } = await use('memory-settings.js');
  const e = l.makeEntry('characters','Mira'); e.sections.appearance.text = 'canon'; e.sections.appearance.lines = [line('a','old',1),line('b','scar',2),line('user','my note',2,'user')]; const live = { settings,mem:normalizeMemory(),messages }, sections = { [e.id]:['appearance'] };
  const plan = await r.planReorganize(live,[e],sections); assert.equal(plan.batches[0][0].sections.appearance.lines.length,2);
  const result = await r.runReorganizeBatch(live,plan.batches[0],sections,''); assert.equal(result.previews.length,1); assert.equal(result.previews[0].sections.appearance.length,1); assert.equal(result.skipped.length,0); assert.equal(e.sections.appearance.text,'canon'); assert.equal(e.sections.appearance.lines.length,3);
});

test('first-turn memory block keeps the latest user after it and small books cannot displace required messages',async () => {
  const use=await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), builder=await use('context-builder.js'), { makeEntry }=await use('lore-lines.js');
  const first=[{ id:'user',order:1,role:'user',content:'Begin' }]; const result=await builder.buildContextForRequest({ id:'s',memory:{ memoryBlock:true } },settings,{ messages:first,requireLatestUser:true }); assert.equal(result.apiMessages.at(-1).role,'user'); assert.equal(result.apiMessages.at(-2).role,'system');
  const overhead=(await builder.buildContextForRequest({ id:'s',memory:{lorebooks:true} },settings,{ messages:[] })).usedTokens;
  const card=makeEntry('facts','Magic'); card.sections.text.text='x'.repeat(20000); const bounded=await builder.buildContextForRequest({ id:'s',memory:{ lorebooks:true } },{ ...settings,maxContextTokens:overhead+1000,maxResponseTokens:100 },{ messages:first,loreEntries:[card],requireLatestUser:true }); assert.equal(bounded.apiMessages.at(-1).content,'Begin'); assert.ok(bounded.report.skipped.some(e => e.reason === 'over budget'));
});

test('an alias clash never leaves an empty automatic draft behind',async () => {
  const use=await setup(), l=await use('lore-lines.js'), e=l.makeEntry('characters','Kael'); const result=l.applyOps([e],[{ book:'characters',tag:'char',name:'Stranger',section:'alias',text:'Kael' }]); assert.equal(result.creates.length,0); assert.equal(result.skipped[0].reason,'name already used by Kael');
});

test('checkpoint-hidden latest user and duplicate opening anchors appear once in both modes',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), b = await use('context-builder.js');
  const history = [{ id:'u',order:1,role:'user',content:'Opening' },{ id:'a',order:2,role:'assistant',content:'Elise is alive' },{ id:'last',order:3,role:'user',content:'Ask about Elise' },{ id:'sum',order:4,role:'summary',content:'Liora believes Elise died' }];
  for (const memory of [{},{ scene:true,memoryBlock:true }]) {
    const result = await b.buildContextForRequest({ id:'s',activeSummaryMessageId:'sum',breakpointOrder:3,memory },settings,{ messages:[...history,history[0]],requireLatestUser:true });
    assert.equal(result.apiMessages.filter(m => m.content.includes('Ask about Elise')).length,1);
    assert.equal(result.apiMessages.filter(m => m.content.endsWith('Opening')).length,1);
    assert.equal(result.apiMessages.filter(m=>m.content.includes('Elise is alive')).length,1);
    assert.match(result.apiMessages.find(m=>m.content.includes('Liora believes')).content,memory.scene ? /message order 3/ : /Story so far/);
    assert.equal(result.usedTokens,8+result.apiMessages.reduce((n,m) => n+8+m.content.length,0));
  }
});
test('draft preview and actual send have identical rendered requests and accounting',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), b = await use('context-builder.js');
  for (const memory of [{},{ scene:true,memoryBlock:true,blockRole:'user',lorebooks:true }]) {
    const session = { id:'s',longTermPlan:'Fixed plan',memory };
    const preview = await b.buildContextForRequest(session,settings,{ messages,draftText:'Next action',requireLatestUser:true });
    const send = await b.buildContextForRequest(session,settings,{ messages:[...messages,{ id:'saved',order:13,role:'user',content:'Next action' }],requireLatestUser:true });
    assert.deepEqual(plain(preview.apiMessages),plain(send.apiMessages)); assert.equal(preview.usedTokens,send.usedTokens); assert.equal(preview.report.blocks.reduce((n,block) => n+block.tokens,0),preview.usedTokens);
  }
});
test('tight budgets reserve a recent suffix before optional lore and report its reduction',async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } }), b = await use('context-builder.js'), l = await use('lore-lines.js');
  const history = Array.from({ length:25 },(_,i) => ({ id:'r'+i,order:i+1,role:i%2 ? 'assistant' : 'user',content:('Mira '+i+' ').repeat(20) }));
  const session = { id:'s',memory:{ lorebooks:true } }, card = l.makeEntry('facts','World'); card.sections.text.text = 'Lore '.repeat(600);
  const required = await b.buildContextForRequest(session,settings,{ messages:[history[0],history[1],history.at(-1)],requireLatestUser:true });
  const cfg = { ...settings,maxResponseTokens:100,maxContextTokens:required.usedTokens+650+100,keepRecentMessagesAfterSummary:10 };
  const result = await b.buildContextForRequest(session,cfg,{ messages:history,loreEntries:[card],requireLatestUser:true });
  assert.ok(result.report.warnings.some(w => w.startsWith('Recent window reduced')));
  assert.ok(result.report.skipped.some(s => s.reason === 'over budget'));
  const retained = result.apiMessages.filter(m => m.role !== 'system').slice(2).map(m => history.find(x => x.content.trim() === m.content.trim())?.order);
  assert.deepEqual(plain(retained),Array.from({ length:retained.length },(_,i) => 25-retained.length+1+i));
  assert.equal(result.droppedCount,result.report.gaps.reduce((n,g) => n+history.filter(m => m.order >= g.fromOrder && m.order <= g.toOrder).length,0));
});
test('equal dates preserve source turns and distinct hidden truth, belief and official record',async () => {
  const use = await setup(), l = await use('lore-lines.js'), f = await use('lore-format.js'), select = await use('lore-select.js');
  const parsed = f.fromJson('{"facts":[{"name":"Elise","text":"Elise is alive; this is a hidden truth.","lines":[{"turn":7,"when":"Day 2","text":"Liora believes Elise died."},{"turn":8,"when":"Day 2","text":"Cassian recorded her death in the official account."}]}]}');
  const rendered = select.renderEntry(parsed.entries[0],null,'',{provenance:true});
  assert.match(rendered,/background; origin: import; unknown cutoff/);
  assert.match(rendered,/\[T7 · Day 2\] Liora believes Elise died/); assert.match(rendered,/\[T8 · Day 2\] Cassian recorded/);
  assert.match(select.MEMORY_RULE,/narrator-only secrets, public accounts, NPC beliefs, rumors/);
  assert.match(select.MEMORY_RULE,/intentions and attempts, not completed events/);
  const e = l.makeEntry('characters','Player'); e.sections.personality.text = 'Bold';
  const { prompts } = await use('system-prompts.js');
  assert.match(prompts.narrator,/personality card does not authorize acting for the PC/i);
});
test('extraction validates source turns, attaches all turn evidence and preserves attempts and qualifiers',async () => {
  const use = await setup(), l = await use('lore-lines.js'), { computeTurns } = await use('turns.js');
  const history = [{ id:'u1',order:1,narratorTurn:41,revision:2,role:'user',content:'I intend to approach if safe.' },{ id:'u2',order:2,narratorTurn:41,revision:0,role:'user',content:'I attempt the lock.' },{ id:'a',order:3,narratorTurn:41,revision:3,role:'assistant',content:'The outcome is unknown.' }];
  const range = { assistants:computeTurns(history).assistants,toTurn:41 };
  const parsed = l.parseMemoryLines('T41 [event] Player intends to approach if safe; attempted the lock, outcome unknown.',{ range,messages:history });
  assert.equal(parsed.valid,true); assert.deepEqual(plain(parsed.ops[0].evidence),[{ id:'u1',revision:2,order:1 },{ id:'u2',revision:0,order:2 },{ id:'a',revision:3,order:3 }]);
  assert.equal(l.parseMemoryLines('T999 [event] invented',{ range,messages:history }).ops[0].turn,41);
  assert.equal(l.parseMemoryLines('[event] unstamped',{ range,messages:history }).ops[0].turn,41);
  const applied = l.applyOps([],parsed.ops,{ sourceRevision:9 });
  const note = applied.creates[0].sections.text.lines[0]; assert.match(note.text,/intends.*if safe; attempted.*unknown/); assert.equal(note.sourceRevision,9);
});
test('invalid extraction batches leave notes and checkpoints unchanged',async () => {
  for (const content of ['unreadable answer','T1 [event] '+ 'x'.repeat(401)]) {
    const h = await updaterHarness(async () => ({ content }));
    assert.equal(await h.updater.updateNow('s'),false);
    assert.equal(h.commits.length,0); assert.equal(h.live.entries.length,0); assert.equal(h.live.session.memoryState.extractedThroughOrder,0);
  }
});
test('stale notes remain stored while edits, deleted evidence and regeneration exclude them',async () => {
  const use = await setup(), c = await use('continuity.js'), l = await use('lore-lines.js');
  const e = l.makeEntry('facts','Events'), source = [{ id:'u',order:1,revision:0,role:'user' },{ id:'a',order:2,revision:0,role:'assistant' }];
  const note = { id:'note',text:'Confirmed',turn:1,src:2,by:'auto',sourceRevision:1,evidence:plain(c.evidenceFor(source)) }; e.sections.text.lines = [note];
  assert.equal(c.usableLore([e],source,{}).entries[0].sections.text.lines.length,1);
  for (const [ms,session,cutoff] of [[[{ ...source[0],revision:1 },source[1]],{},Infinity],[[source[0]],{},Infinity],[source,{},2]]) {
    const result = c.usableLore([e],ms,session,cutoff); assert.equal(result.entries[0].sections.text.lines.length,0); assert.match(result.skipped[0].reason,/Needs review/);
  }
  assert.equal(e.sections.text.lines.length,1);
});
test('snapshots at regeneration cutoff cannot supply state; undated imports remain background',async () => {
  const use = await setup(), c = await use('continuity.js'), l = await use('lore-lines.js'), f = await use('lore-format.js');
  const e = l.makeEntry('characters','Elise'); Object.assign(e.sections.status,{ text:'At the palace',kind:'snapshot',cutoff:{ turn:5,order:10 },sourceRevision:0 });
  assert.equal(c.usableLore([e],[],{},10).entries[0].sections.status.text,'');
  assert.equal(c.usableLore([e],[],{ memoryInvalidations:[{ fromOrder:8,revision:1 }] }).entries[0].sections.status.text,'At the palace');
  const imported = f.fromJson('{"characters":[{"name":"Elise","sections":{"status":"At the palace"}}]}').entries[0];
  assert.equal(imported.sections.status.kind,'background'); assert.equal(imported.sections.status.cutoff,null);
});
test('OOC omissions preserve scene without a narrative failure and fallback scenes carry their cutoff',async () => {
  const use = await setup(), scene = await use('scene.js'), select = await use('lore-select.js');
  const result = scene.latestScene([{ id:'a',order:2,role:'assistant',scene:'unknown · night · Inn · present: Mira' },{ id:'o',order:4,role:'assistant',ooc:true,scene:null }]);
  assert.equal(result.fromOrder,2); assert.equal(result.missingStreak,0);
  const rendered = select.renderMemoryBlock({ scene:result.scene,sceneFromTurn:1,sceneFromOrder:2 }); assert.match(rendered,/snapshot at T1 \(message order 2/);
  assert.match(scene.SCENE_RULE(),/never invent a date/); assert.equal(scene.isPureOoc('<ad>What does Mira believe?</ad>'),true); assert.equal(scene.isPureOoc('<ad>Canon</ad> I walk away.'),false);
});
test('JSON and Markdown version 2 preserve evidence, classification and review metadata',async () => {
  const use = await setup(), l = await use('lore-lines.js'), f = await use('lore-format.js');
  const e = l.makeEntry('characters','Mira'); Object.assign(e.sections.status,{ text:'At Inn',origin:'import',kind:'snapshot',cutoff:{ turn:7,order:14 },unavailable:true,sourceRevision:3 });
  e.sections.status.lines = [{ id:'line',text:'Attempts departure if safe',turn:8,when:'Day 2',src:16,by:'auto',at:9,sourceRevision:3,needsReview:true,evidence:[{ id:'source',revision:2,order:16 }] }];
  assert.equal(JSON.parse(f.toJson([e])).version,2);
  for (const parsed of [f.fromJson(f.toJson([e])),f.fromMarkdown(f.toMarkdown([e]))]) { const s = parsed.entries[0].sections.status; assert.equal(s.kind,'snapshot'); assert.deepEqual(plain(s.cutoff),{ turn:7,order:14 }); assert.equal(s.unavailable,true); assert.deepEqual(plain(s.lines[0]),plain(e.sections.status.lines[0])); }
});
test('reorganized lines retain matched evidence and omitted inputs remain in the preview source',async () => {
  const use = await setup({ 'tokenizer.js':{ countTokens:count },'llm-client.js':{ chatCompletion:async () => ({ content:'T2 [char] Mira | status: Still at Inn; departure only intended.' }) } }), r = await use('memory-reorganize.js'), l = await use('lore-lines.js'), { normalizeMemory } = await use('memory-settings.js');
  const e = l.makeEntry('characters','Mira'); e.sections.status.lines = [{ ...line('a','At Inn',1),evidence:[{ id:'u',revision:1,order:1 }] },{ ...line('b','Intends departure',2),evidence:[{ id:'a',revision:0,order:4 }] }];
  const result = await r.runReorganizeBatch({ settings,mem:normalizeMemory(),messages },[e],{ [e.id]:['status'] },'');
  assert.deepEqual(plain(result.previews[0].sections.status[0].evidence),[{ id:'a',revision:0,order:4 }]);
  assert.equal(e.sections.status.lines.length,2); assert.match(result.previews[0].sections.status[0].text,/only intended/);
});

test('version 2 chat imports preserve hidden metadata and fixed author plan; version 1 still imports',async () => {
  const saved = [], updates = [], imported = [];
  const use = await setup({ 'sessions.js':{ createSession:async () => 'copy',getSession:async () => null,updateSession:async (...args) => updates.push(args) },'messages.js':{ getMessages:async () => [],addMessagesBulk:async (...args) => saved.push(args) },'lore-store.js':{ getLore:async () => [],importLore:async (...args) => imported.push(args) } }), api = await use('import-export.js');
  const payload = [JSON.stringify({ character_name:'Story',nera:{ version:2,session:{ longTermPlan:'Fixed',historyRevision:7,breakpointOrder:4 },lore:[{ id:'note',book:'facts',sections:{ text:{ kind:'background',text:'Liora believes Elise died',lines:[] } } }] } }),JSON.stringify({ mes:'Hidden metadata',is_user:false,nera:{ message:{ id:'a',order:4,role:'assistant',revision:2,narratorTurn:9,scene:'Day 2 · Inn',planThread:'Thread' } } })].join('\n');
  await api.importSillyTavern({ name:'story.jsonl',text:async () => payload });
  assert.equal(saved[0][1][0].revision,2); assert.equal(saved[0][1][0].narratorTurn,9); assert.equal(saved[0][1][0].scene,'Day 2 · Inn'); assert.equal(updates[0][1].longTermPlan,'Fixed'); assert.equal(imported[0][1].writes[0].data.sections.text.kind,'background');
  const old = api.parseSillyTavernJsonl('{"character_name":"Old"}\n{"is_user":true,"mes":"Hello"}'); assert.equal(old.messages[0].role,'user'); assert.equal(old.metadata,null);
});

test('narrator requests inject each shared contract once and keep plan rules outside the narrative prompt', async () => {
  const use = await setup({ 'messages.js':{ getMessages:async () => [] },'tokenizer.js':{ countTokens:count } });
  const { prompts } = await use('system-prompts.js');
  const builder = await use('context-builder.js');
  assert.doesNotMatch(prompts.narrator, /plan/i);
  const options = { messages:[{ id:'u',order:1,role:'user',content:'Begin.' }],requireLatestUser:true };
  const base = { id:'s',longTermPlan:'Meet Mira at the inn.' };
  const config = { ...settings,narratorSystemPrompt:prompts.narrator };
  const request = await builder.buildContextForRequest({...base,memory:{memoryBlock:true}}, config, options);
  const system = request.apiMessages[0].content;
  for (const heading of ['# AUTHOR DIRECTIVES AND OOC','# AUTHORITY AND SOURCE PRIORITY','# LONG-TERM PLAN']) {
    assert.equal(system.split(heading).length-1, 1, heading);
  }
  assert.doesNotMatch(system, /treat that plan as lost|include a new <plan>|# SCENE TAG OUTPUT CONTRACT/);
  assert.match(system, /Meet Mira at the inn/);
  const sceneRequest = await builder.buildContextForRequest({ ...base,memory:{ scene:true } }, config, options);
  assert.equal(sceneRequest.apiMessages[0].content.split('# SCENE TAG OUTPUT CONTRACT').length-1, 1);
  assert.match(sceneRequest.apiMessages[0].content, /Pure OOC questions, clarifications and requested summaries omit the scene tag/);
});
