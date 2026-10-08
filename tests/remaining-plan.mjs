import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {webcrypto} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:100000,maxResponseTokens:2000,keepRecentMessagesAfterSummary:2,summarizerChunkTokens:1};
const history=Array.from({length:10},(_,i)=>({id:'m'+i,order:i+1,narratorTurn:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:'Event '+i,revision:0}));
const use=()=>appHarness({stubs:{'messages.js':{getMessages:async()=>[],getCheckpointMessages:async()=>[],addMessage:async()=>{},newMessageId:()=> 'summary'},'tokenizer.js':{countTokens:async s=>s.length,tokenizerReady:()=>true},'llm-client.js':{chatCompletion:async()=>({content:'A summary',finishReason:'stop'})}}});
test('summary source accepts reordered memory maps and unrelated lore writes, but rejects real source changes',async()=>{
 const c=await use()('continuity.js');
 const initial={historyRevision:3,longTermPlan:'Keep the hearing open',loreRevision:2,activeSummaryMessageId:'s1',breakpointOrder:4,memory:{scene:true,books:{characters:{on:true,budget:4000},events:{on:false}}}};
 const reordered={...initial,memory:{books:{events:{on:false},characters:{budget:4000,on:true}},scene:true},loreRevision:9};
 const expected=c.summarySource(initial);
 assert.doesNotThrow(()=>c.assertSource(reordered,expected));
 assert.throws(()=>c.assertSource(reordered,c.requestSource(initial)),/Changed: lorebooks/);
 for(const [key,value,label] of [['historyRevision',4,'story history'],['longTermPlan','A different direction','fixed plan'],['activeSummaryMessageId','s2','active summary'],['breakpointOrder',6,'summary checkpoint'],['memory',{scene:false},'memory settings']]) {
  assert.throws(()=>c.assertSource({...reordered,[key]:value},expected),new RegExp('Changed: '+label));
 }
 assert.throws(()=>c.assertSource(null,expected),/story deleted/);
});
test('summary commit uses its captured source while allowing a concurrent lore revision',async()=>{
 let saved,session={id:'s',historyRevision:3,loreRevision:2,memory:{scene:false,books:{characters:{budget:4000,on:true}}}};
 const u=appHarness({stubs:{'messages.js':{getMessages:async()=>[],getCheckpointMessages:async()=>[],newMessageId:()=> 'new-summary',addMessage:async(sid,message,opts)=>{const c=await u('continuity.js');c.assertSource({...session,loreRevision:9,memory:{books:{characters:{on:true,budget:4000}},scene:false}},opts.expectedSource);saved=opts;return {...message,historyRevision:4};}},'tokenizer.js':{countTokens:async text=>text.length,tokenizerReady:()=>true},'llm-client.js':{chatCompletion:async()=>({content:'The established hearing remains unresolved.',finishReason:'stop'})}}});
 const result=await(await u('summarizer.js')).runSummarization(session,{...settings,summarizerChunkTokens:100000},{messages:history});
 assert.equal(result.skipped,false);assert.equal(saved.expectedSource.sourceKind,'summary');assert.equal(saved.expectedSource.historyRevision,3);assert.equal(saved.sessionUpdate.activeSummaryMessageId,'new-summary');
});
test('L2 extraction guard accepts unrelated append/lore/plan/scene changes and rejects range edits or superseded pointers',async()=>{
 const c=await use()('continuity.js'),guard={startPointer:2,startRevision:5,fromOrder:3,endOrder:6};
 const base={memoryState:{extractedThroughOrder:2},historyRevision:9,loreRevision:99,longTermPlan:'New',contentEdits:[{order:1,revision:6},{order:8,revision:7}]};
 assert.doesNotThrow(()=>c.assertExtractionSource(base,guard));
 assert.throws(()=>c.assertExtractionSource({...base,contentEdits:[{order:4,revision:6}]},guard),e=>e.name==='StaleSourceError');
 assert.throws(()=>c.assertExtractionSource({...base,contentEditsFloor:6},guard),e=>e.name==='StaleSourceError');
 assert.throws(()=>c.assertExtractionSource({...base,memoryState:{extractedThroughOrder:6}},guard),e=>e.name==='SupersededError');
});
test('L1 old edit pauses resume only below the failure threshold and invalidations remain bounded',async()=>{
 const c=await use()('continuity.js');
 for(const [ms,expected] of [[{},false],[{paused:true,lastError:'History changed',failureStreak:2},false],[{paused:true,lastError:'History changed',failureStreak:3},true],[{paused:true,lastError:'API failed'},true]])assert.equal(c.effectivelyPaused(ms),expected);
 const result=c.trimInvalidations(Array.from({length:60},(_,i)=>({fromOrder:60-i,revision:i+1})));assert.equal(result.length,50);assert.deepEqual(plain(result[0]),{fromOrder:50,revision:11});
});
test('L3 tolerant grammar keeps partial notes, real aliases and status-only threads',async()=>{
 const u=use(),l=await u('lore-lines.js'),t=await u('turns.js'),range={assistants:t.computeTurns(history).assistants,fromTurn:1,toTurn:5};
 const parsed=l.parseMemoryLines('<think>private</think>\n**[character]** Mira | appearance: scar\n[char] Mira | aliases: Witch\n[open] Missing letter\nT999 [event] arrived\nNONE\ninvalid',{range,messages:history});
 assert.equal(parsed.valid,true);assert.equal(parsed.ops.length,4);assert.equal(parsed.skipped.length,1);assert.ok(parsed.info.includes('turn out of range'));assert.equal(parsed.ops[0].turn,5);
 const changes=l.applyOps([],parsed.ops);assert.deepEqual(plain(changes.creates.find(e=>e.name==='Mira').aliases),['Witch']);assert.equal(changes.creates.find(e=>e.name==='Missing letter').status,'open');assert.equal(changes.creates.find(e=>e.name==='Missing letter').sections.text.lines.length,0);
});
test('L3 reorganize binds alias names, null turns and newest older evidence',async()=>{
 const u=use(),l=await u('lore-lines.js'),e=l.makeEntry('characters','Mira');e.aliases=['Witch'];e.sections.notes.lines=[{id:'n',turn:null,text:'undated',src:null,at:1,by:'auto'},{id:'a',turn:2,text:'older',src:4,at:2,evidence:[{id:'m3',revision:0,order:4}]},{id:'b',turn:4,text:'newest',src:8,at:3}];
 const p=l.parseMemoryLines('T0 [char] Witch | notes: clean\nT3 [char] Witch | notes: older clean\n[char] Witch | notes: newest clean',{reorganize:true,entries:[e],messages:history});
 assert.deepEqual(plain(p.ops.map(o=>[o.name,o.turn,o.src])),[['Mira',null,null],['Mira',2,4],['Mira',4,8]]);assert.equal(p.ops[1].evidence[0].id,'m3');
});
test('L4 maintenance fairness and recovery priority hold for twenty completed turns',async()=>{
 const p=await use()('maintenance.js');let deferrals=0,memory=0,summary=0;
 for(let i=0;i<20;i++){const pick=p.pickMaintenance({summary:{urgent:true},memoryDue:true,memoryDeferrals:deferrals});assert.equal(['summary','memory'].includes(pick),true);if(pick==='memory'){memory++;deferrals=0;}else{summary++;deferrals++;}assert.ok(1+Number(!!pick)<=2);}
 assert.equal(memory,6);assert.equal(summary,14);assert.equal(p.pickMaintenance({overwrite:true,needsRecovery:true,memoryRunning:true}),'recovery');assert.equal(p.pickMaintenance({overwrite:true,summary:{urgent:true}}),null);
});
test('L4 pure summary plans preserve opening and complete turns even when one turn exceeds the chunk cap',async()=>{
 const s=await use()('summarizer.js'),plan=s.planSummary({id:'s'},settings,history,{maxChunks:1});
 assert.deepEqual(plain(plan.toFold.map(m=>m.order)),[3,4]);assert.equal(plan.newBreakpointOrder,4);assert.equal(s.planSummary({id:'s'},settings,history,{running:true}).skip,'running');assert.equal(s.planSummary({id:'s'},settings,history,{force:false}).skip,'not-needed');
});
test('L4 automatic summary commits one complete chunk with order coverage and no growing evidence list',async()=>{
 let calls=0,saved;
 const u=appHarness({stubs:{'messages.js':{getMessages:async()=>history,getCheckpointMessages:async()=>history,newMessageId:()=> 'sum',addMessage:async(_sid,msg)=>{saved=msg;return {...msg,historyRevision:1};}},'tokenizer.js':{countTokens:async s=>s.length},'context-builder.js':{buildContextForRequest:async()=>({usedTokens:100,report:{warnings:[]}}),computeContextUsage:async()=>({}),MESSAGE_FRAME_TOKENS:8,REQUEST_FRAME_TOKENS:8},'llm-client.js':{chatCompletion:async opts=>{calls++;assert.equal(opts.allowTruncated,true);return {content:'Summary',finishReason:'stop'};}}}});
 const r=await(await u('summarizer.js')).runSummarization({id:'s'},settings,{messages:history,maxChunks:1});assert.equal(calls,1);assert.equal(r.foldedCount,2);assert.deepEqual(plain(saved.coveredRange),{fromOrder:3,toOrder:4});assert.equal('evidence' in saved,false);
});
test('L7 idle range status distinguishes unset start, pending replies and waiting lag',async()=>{
 const t=await use()('turns.js'),mem={batchTurns:3,lagTurns:1,scene:true};assert.equal(t.dueRangeStatus(history,{},mem).reason,'pointer-unset');
 const pending=history.slice(0,2).map(m=>({...m,...(m.role==='assistant'?{acceptance:'pending'}:{})}));assert.equal(t.dueRangeStatus(pending,{extractedThroughOrder:0},{...mem,lagTurns:0}).reason,'pending');
 const wait=t.dueRangeStatus(history.slice(0,4),{extractedThroughOrder:0},mem);assert.deepEqual(plain(wait),{reason:'waiting',have:1,need:3,lag:1});assert.ok(t.dueRangeStatus(history,{extractedThroughOrder:0},mem).range);
});
test('L8 Markdown escapes structural prefixes and v2 imports default missing aliases and kind',async()=>{
 const u=use(),l=await u('lore-lines.js'),f=await u('lore-format.js'),e=l.makeEntry('characters','Mira');e.createdAt={seconds:3,nanoseconds:4};e.sections.notes.text='# Plain text\nUpdates:\n<!-- nera-not metadata -->\n\\literal';e.sections.notes.lines=[{id:'line',text:'# A note\nUpdates:\n<!-- nera-note -->',by:'user',turn:null,src:null,at:3}];
 const round=f.fromMarkdown(f.toMarkdown([e])).entries[0];assert.equal(round.sections.notes.text,e.sections.notes.text);assert.equal(round.sections.notes.lines[0].text,e.sections.notes.lines[0].text);
 const raw=JSON.parse(f.toJson([e]));delete raw.entries[0].aliases;delete raw.entries[0].kind;const imported=f.fromJson(JSON.stringify(raw));assert.deepEqual(plain(imported.entries[0].aliases),[]);assert.equal(imported.entries[0].kind,'card');assert.deepEqual(plain(imported.entries[0].createdAt),e.createdAt);assert.equal(f.planImport([e],imported).preview.books.characters.new,0);
});
test('C3 memory layout has one system head, user-aligned memory and a final scene reminder with exact framed costs',async()=>{
 const u=use(),b=await u('context-builder.js');
 for(const blockRole of ['user','system'])for(const replyContract of ['off','user','system']){
 const r=await b.buildContextForRequest({id:'s',longTermPlan:'Pending hearing',memory:{scene:true,memoryBlock:true,blockRole,replyContract},activeSummaryMessageId:'sum',breakpointOrder:4},settings,{messages:[...history,{id:'sum',order:11,role:'summary',content:'Earlier events'}],draftText:'Continue'});
 assert.match(r.apiMessages[0].content,/Earlier events/);assert.equal(r.apiMessages.at(-1).role,'user');assert.match(r.apiMessages.at(-1).content,/Scene.*reminder|<scene>/i);assert.equal(r.usedTokens,8+r.apiMessages.reduce((n,m)=>n+8+m.content.length,0));assert.equal(r.report.blocks.reduce((n,x)=>n+x.tokens,0),r.usedTokens);
 if(blockRole==='system'){const i=r.apiMessages.findIndex(m=>m.content.startsWith('STORY MEMORY'));if(i>=0)assert.equal(r.apiMessages[i+1].role,'user');}
 }
});
test('C6 each distinct normal history message is tokenized once and the request cost equals its rendered wire form',async()=>{
 const counts=new Map(),u=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{tokenizerReady:()=>true,countTokens:async text=>{counts.set(text,(counts.get(text)??0)+1);return text.length;}}}}),b=await u('context-builder.js');
 const h=Array.from({length:200},(_,i)=>({id:'h'+i,order:i+1,role:i%2?'assistant':'user',content:'distinct event '+i}));const r=await b.buildContextForRequest({id:'s',memory:{lorebooks:true}},settings,{messages:h});for(const m of h.slice(2,-2))assert.equal(counts.get(m.content),1);assert.equal(r.usedTokens,8+r.apiMessages.reduce((n,m)=>n+8+m.content.length,0));
});
test('C7 first names are case-sensitive, unique and untitled; protagonist is outside the optional card limit',async()=>{
 const u=use(),l=await u('lore-lines.js'),s=await u('lore-select.js'),m=await u('memory-settings.js');const entries=['Nera Veyrath','Rose Thorn','Lady Violet','Mira One','Mira Two','Kael'].map(n=>l.makeEntry('characters',n));const index=s.buildLoreIndex(entries);assert.equal(s.findMentions('a rose and a lady',index,'characters').length,0);assert.equal(s.findMentions('Mira',index,'characters').length,0);assert.deepEqual(plain(s.findMentions('Rose',index,'characters')),[entries[1].id]);
 const selected=s.selectEntries(entries,m.normalizeMemory({lorebooks:true,protagonist:'Nera Veyrath',books:{characters:{maxCards:1}}}),'Kael',null).selected.characters;assert.equal(selected.length,2);assert.equal(selected[0].reason,'protagonist');
});
test('U1 busy ownership rejects stale releases and history bridges only from the captured revision',async()=>{
 const b=await use()('ui/busy-token.js');let state={sid:'s',epoch:1,owner:'u'},released=0;const gate=b.createBusyGate({current:()=>state,onChange:()=>{},onRelease:()=>released++}),a=gate.acquire('send');assert.equal(gate.acquire('send'),null);assert.equal(gate.release({...a}),false);state={...state,epoch:2};assert.equal(gate.stillActive(a),false);assert.equal(gate.release(a),true);const next=gate.acquire('edit');assert.equal(gate.release(a),false);assert.ok(gate.stillActive(next));gate.release(next);assert.equal(released,2);assert.equal(b.bridgeHistory([],1,{id:'m',order:1,historyRevision:3}),null);assert.equal(b.bridgeHistory([],2,{id:'m',order:1,historyRevision:3}).length,1);
});
test('C1 all four outgoing defaults migrate by exact hash; customized and omitted settings stay distinct',async()=>{
 const fields=[['narratorSystemPrompt','narrator.md'],['summarizerSystemPrompt','summarizer.md'],['memoryExtractionPrompt','memory-extraction.md'],['memoryReorganizePrompt','memory-reorganize.md']];
 const u=appHarness({globals:{crypto:webcrypto},stubs:{'db.js':{db:{}},'auth.js':{currentUid:()=> 'u'},'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:()=>({}),getDocFromServer:async()=>({exists:()=>true,data:()=>({})}),onSnapshot:()=>()=>{},setDoc:async()=>{}}}}),s=await u('settings.js');
 const hashLines=await readFile(new URL('../system prompts/legacy-prompt-default-hashes.md',import.meta.url),'utf8');
 for(const [key,file]of fields){const old=(await readFile(new URL('./fixtures/outgoing-prompts/'+file,import.meta.url),'utf8')).trim();assert.ok(hashLines.split('\n').includes(key+' '+createHash('sha256').update(old).digest('hex')),file+' outgoing fixture hash');assert.equal((await s.mergeDefaults({[key]:old}))[key],s.DEFAULT_SETTINGS[key]);assert.equal((await s.mergeDefaults({[key]:old+' custom'}))[key],old+' custom');assert.equal((await s.mergeDefaults({}))[key],s.DEFAULT_SETTINGS[key]);assert.equal(key in s.storedSettings(s.DEFAULT_SETTINGS),false);}
 const hashes=await readFile(new URL('../system prompts/legacy-prompt-default-hashes.md',import.meta.url),'utf8');for(const line of hashes.trim().split('\n'))assert.match(line,/^(narratorSystemPrompt|summarizerSystemPrompt|memoryExtractionPrompt|memoryReorganizePrompt) [0-9a-f]{64}$/);
});
test('U5 silent stream times out at the owner-selected 120 seconds, cancels the reader and preserves partial content',async()=>{
 let fire,timerMs,cancelled=0,readCount=0;const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial story"}}]}\n');
 const u=appHarness({globals:{setTimeout:(fn,ms)=>{fire=fn;timerMs=ms;return 1;},clearTimeout:()=>{},fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>{if(readCount++===0)return {done:false,value:bytes};queueMicrotask(()=>fire());return new Promise(()=>{});},cancel:async()=>{cancelled++;}})}})}}),client=await u('llm-client.js');
 await assert.rejects(client.chatCompletion({settings:{modelId:'m',endpoint:'https://example.test',streaming:true},messages:[]}),e=>e.aborted==='timeout' && e.partial.content==='Partial story');assert.equal(timerMs,120000);assert.ok(cancelled>0);
});
test('U9 cache clearing selects account credentials and lore marks but preserves device UI preferences',async()=>{
 const c=await use()('device-caches.js');assert.deepEqual(plain(c.accountCacheKeys('u',['roleplay-settings:u','roleplay-settings:other','nera.settings.local.u','nera.lore.seen.s','nera.memory.showScene','nera.lore.format'])),['roleplay-settings:u','nera.settings.local.u','nera.lore.seen.s']);
});
test('L8 user lines are retained ahead of generated notes under a tight lore budget',async()=>{
 const u=use(),l=await u('lore-lines.js'),s=await u('lore-select.js'),e=l.makeEntry('facts','Magic');e.sections.text.lines=[{id:'auto',text:'a'.repeat(100),by:'auto',turn:10,at:10},{id:'mine',text:'My rule',by:'user',turn:1,at:1}];const fit=await s.fitBook([{entry:e}],55,async t=>t.length);assert.ok(fit.included[0].lineIds.has('mine'));assert.equal(fit.included[0].lineIds.has('auto'),false);assert.doesNotMatch(s.renderEntry(e),/\[T/);assert.match(s.renderEntry(e,null,'',{provenance:true}),/\[T/);
});
test('C6 3000-entry LRU refreshes hits, evicts one old entry, and never caches fallback counts',async()=>{
 const t=await use()('token-cache.js');let calls=0,ready=true;const count=t.createTokenCounter({count:async()=>++calls,ready:()=>ready});for(let i=0;i<3000;i++)await count('text '+i);assert.equal(count.size,3000);assert.equal(await count('text 0'),1);await count('extra');assert.equal(count.size,3000);const before=calls;await count('text 0');assert.equal(calls,before);await count('text 1');assert.equal(calls,before+1);ready=false;await count('fallback');await count('fallback');assert.equal(calls,before+3);assert.equal(count.size,3000);
});
test('L6 reorganized notes inherit only their matched source evidence instead of the entire section',async()=>{
 const u=use(),l=await u('lore-lines.js'),r=await u('memory-reorganize.js'),m=await u('memory-settings.js'),e=l.makeEntry('characters','Mira');e.sections.notes.lines=[{id:'a',text:'older',turn:2,src:4,when:'Day 1',at:1,by:'auto',sourceRevision:3,evidence:[{id:'m3',order:4,revision:0}]},{id:'b',text:'newer',turn:4,src:8,at:2,by:'auto',sourceRevision:8,evidence:[{id:'m7',order:8,revision:0}]}];const result=await r.runReorganizeBatch({settings,mem:m.normalizeMemory(),messages:history},[e],{[e.id]:['notes']},'',{complete:async()=>({content:'T3 [char] Mira | notes: combined older note'})});const note=result.previews[0].sections.notes[0];assert.equal(note.turn,2);assert.equal(note.src,4);assert.equal(note.sourceRevision,3);assert.deepEqual(plain(note.evidence),[{id:'m3',order:4,revision:0}]);
});
test('U8 IndexedDB writes initialize metadata once, retain three recent sessions and clear only the departing account',async()=>{
 const documents=new Map();let bulkReads=0;
 const db={transaction:()=>{const tx={};tx.objectStore=()=>({get:key=>request(()=>documents.get(key)),getAll:()=>{bulkReads++;return request(()=>[...documents.values()]);},getAllKeys:()=>request(()=>[...documents.keys()]),put:value=>documents.set(value.key,structuredClone(value)),delete:key=>documents.delete(key)});setTimeout(()=>tx.oncomplete?.(),0);return tx;}};
 const request=read=>{const r={};queueMicrotask(()=>{r.result=structuredClone(read());r.onsuccess?.();});return r;};
 const u=appHarness({globals:{indexedDB:{open:()=>{const r={result:db};queueMicrotask(()=>r.onsuccess?.());return r;}}}}),cache=await u('chat-cache.js');for(const sid of ['a','b','c','d','d'])await cache.saveChatCache('u',sid,{sid});assert.equal(bulkReads,1);assert.deepEqual(documents.get('meta:u').order,['d','c','b']);assert.equal(documents.has('u:a'),false);await cache.saveChatCache('other','x',{});await cache.clearChatCache('u');assert.ok(![...documents.keys()].some(k=>k.startsWith('u:') || k==='meta:u'));assert.ok(documents.has('other:x'));
});

test('main adaptation: stopping preparation releases a hung operation and ignores its late result',async()=>{
 const w=await use()('ui/busy-token.js'),controller=new AbortController();let resolveLate,continued=false;
 const pending=w.waitForPreparation(new Promise(resolve=>{resolveLate=resolve;}),controller).then(()=>{continued=true;});
 controller.abort('user');await assert.rejects(pending,/Stopped/);
 resolveLate('Old context');await Promise.resolve();assert.equal(continued,false);
});
test('main adaptation: preparation times out after 120 seconds without waiting for a hung read',async()=>{
 let fire,delay,cleared=0;const u=appHarness({globals:{setTimeout:(fn,ms)=>{fire=fn;delay=ms;return 1;},clearTimeout:()=>{cleared++;}}}),w=await u('ui/busy-token.js'),controller=new AbortController();
 const pending=w.waitForPreparation(new Promise(()=>{}),controller);assert.equal(delay,120000);fire();
 await assert.rejects(pending,/preparation stopped responding/);assert.equal(controller.signal.reason,'timeout');assert.equal(cleared,1);
});
test('main adaptation: failed chat cache cleanup still clears account settings and permits sign-out',async()=>{
 const removed=[],errors=[];const u=appHarness({stubs:{'chat-cache.js':{clearChatCache:async()=>{throw Error('Cache unavailable');}}},globals:{console:{error:e=>errors.push(e)},localStorage:{'roleplay-settings:u':'saved','nera.settings.local.u':'local','nera.memory.showScene':'1',removeItem:key=>removed.push(key)}}});
 await(await u('device-caches.js')).clearAccountCaches('u');
 assert.deepEqual(removed,['roleplay-settings:u','nera.settings.local.u']);assert.equal(errors.length,1);
});
