import {archivedThread} from './thread-archive.js';
import { characterCardSlots, allocateCharacterPools } from './character-budget.js';
import { characterImportance } from './character-importance.js';
import { renderPlanUnit } from './scheduled-plan.js';
import { maxOf } from './math-utils.js';
import { prompts, renderLoreLabel } from './system-prompts.js';
import { CONTINUITY_RULE, sectionMeta, cutoffLabel } from './continuity.js';
import { normalizeName, STOPLIST, COMMON_ALIAS_WORDS, SECTION_KEYS, sortLines } from './lore-lines.js';
import { stripTurnStamps } from './story-text.js';
import {threadSummary} from './thread-lifecycle.js';
import { capLoreNotes, noteOmissions, fittedNoteStats } from './lore-note-window.js';
import { createWorkBudget } from './ui-work.js';
export { sortLines } from './lore-lines.js';
export const MEMORY_RULE = CONTINUITY_RULE;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function finish(work) { let step;do{step=work.next();}while(!step.done);return step.value; }
export function buildLoreIndex(entries) {return finish(loreIndexWork(entries));}
function* loreIndexWork(entries) {
  const index = { entries, characters:[], locations:[], facts:[], events:[] };
  const firstCounts=new Map(),titles=new Set('lord lady sir dame king queen prince princess master mistress captain father mother brother sister mr. mrs. ms. dr.'.split(' '));
  for(const e of entries){if(e.book==='characters'){const first=normalizeName(e.name).split(' ')[0];firstCounts.set(first,(firstCounts.get(first) ?? 0)+1);}yield;}
  for (const e of entries) {
    const terms = [e.name,...(e.aliases ?? [])];
    if (e.book === 'characters') {const first=normalizeName(e.name).split(' ')[0];if(first.length>=3 && !titles.has(first) && firstCounts.get(first)===1)terms.push(e.name.split(' ')[0]);}
    const seen = new Set();
    for (const [i,term] of terms.entries()) {
      const normTerm = normalizeName(term);
      if (normTerm.length < 2 || STOPLIST.has(normTerm) || seen.has(normTerm)) continue;
      if (i>0 && i<= (e.aliases?.length ?? 0) && normTerm.startsWith('the ') && normTerm.slice(4).split(' ').every(word=>STOPLIST.has(word) || COMMON_ALIAS_WORDS.has(word))) continue;
      seen.add(normTerm);
      index[e.book]?.push({ entryId:e.id, term, normTerm, isMain:i === 0,firstName:e.book==='characters' && i>=(1+(e.aliases?.length ?? 0)) });
      yield;
    }
  }
  return index;
}
// Patterns contain no story text or entry identity. Term membership is rebuilt
// for every call, so mutable indexes and renamed aliases remain observable.
const matcherCache=new Map(),MATCHER_LIMIT=4096;
function* mentionMatchers(index,book) {
  const matchers=[];
  for(const term of index[book] ?? []){
    // All matches share offsets in the same string; allow names across whitespace.
    const literal=term.firstName ? term.term.replace(/[‘’]/g,"'") : term.normTerm;
    matchers.push({entryId:term.entryId,literal,flags:term.firstName ? 'gu' : 'giu',asciiPrefix:/^[\x00-\x7f]*$/.test(literal)?literal.split(/\s+/)[0].toLowerCase():null});yield;
  }
  return matchers;
}
function matcherRegex(matcher) {
  if(matcher.re)return matcher.re;
  const phrase=escapeRegex(matcher.literal).replace(/\s+/g, '\\s+');
  const pattern='(?<![\\p{L}\\p{N}])'+phrase+'(?![\\p{L}\\p{N}])',key=JSON.stringify([pattern,matcher.flags]);
  let re=matcherCache.get(key);
  if(re)matcherCache.delete(key);
  else re=new RegExp(pattern,matcher.flags);
  matcherCache.set(key,re);
  if(matcherCache.size>MATCHER_LIMIT)matcherCache.delete(matcherCache.keys().next().value);
  return matcher.re=re;
}
export function findMentionOccurrences(text, index, book) {
  return finish(matchOccurrences(text,finish(mentionMatchers(index,book))));
}
function* matchOccurrences(text,matchers) {
  const matches = [], nfc = String(text).normalize('NFC').replace(/[‘’]/g,"'");
  // ASCII letters with punctuation/whitespace have ordinary ASCII case folds.
  // Other Unicode inputs retain the exact /iu/ path, including long s/Kelvin.
  const ascii=/^[\x00-\x7f\p{P}\s]*$/u.test(nfc)?nfc.toLowerCase():null;
  for (const matcher of matchers) {
    const {entryId,asciiPrefix}=matcher;
    if((!nfc && matcher.literal) || (ascii!==null && asciiPrefix!==null && !ascii.includes(asciiPrefix))){yield;continue;}
    const re=matcherRegex(matcher);
    re.lastIndex=0;
    // matchAll clones the regex before this generator yields. Concurrent async
    // requests never share an occurrence iterator or its lastIndex.
    for (const m of nfc.matchAll(re))matches.push({ id:entryId, start:m.index, end:m.index+m[0].length });
    yield;
  }
  matches.sort((a,b) => (b.end-b.start)-(a.end-a.start)||a.start-b.start||stableId(a.id,b.id));
  const chosen = [];
  for (const m of matches){if (!chosen.some(c => m.start < c.end && c.start < m.end)) chosen.push(m);yield;}
  chosen.sort((a,b) => a.start-b.start);
  return chosen;
}
export function findMentions(text, index, book) {
  return [...new Set(findMentionOccurrences(text,index,book).map(m => m.id))];
}
export function resolveScene(scene, index) {
  const characters = [], unmatched = [], ambiguous = [];
  for (const name of scene?.present ?? []) {
    const hits = index.characters.filter(t => t.normTerm === normalizeName(name));
    const canonical = hits.filter(t => t.isMain);
    const ids = [...new Set((canonical.length ? canonical : hits).map(t => t.entryId))];
    if (ids.length === 1) characters.push(ids[0]);
    else if (ids.length > 1) ambiguous.push(name);
    else unmatched.push(name);
  }
  const exact = name => index.locations.find(t => t.normTerm === normalizeName(name))?.entryId;
  let place = scene?.place ? exact(scene.place) : null;
  if (!place && scene?.place) for (const part of scene.place.split(',')) { place = exact(part); if (place) break; }
  if (!place && scene?.place) place = [...index.locations].sort((a,b) => b.normTerm.length-a.normTerm.length).find(t => new RegExp('(?<![\\p{L}\\p{N}])'+escapeRegex(t.normTerm)+'(?![\\p{L}\\p{N}])','iu').test(normalizeName(scene.place)))?.entryId;
  return { characters:[...new Set(characters)], place:place ?? null, unmatched, ambiguous };
}
const stableId = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const newestNote = entry => Math.max(0,maxOf(Object.values(entry.sections).flatMap(s => (s.lines ?? []).map(l => l.at ?? 0))));
const compareMention = (a,b) => !a ? (b ? 1 : 0) : !b ? -1 : b.order-a.order || b.offset-a.offset;
// Structured sources preserve message boundaries. Legacy text is one synthetic message.
export function selectEntries(entries, mem, text, scene, recentText = '', sources = {}) {
  return finish(selectionWork(entries,mem,text,scene,recentText,sources));
}
export async function selectEntriesAsync(entries,mem,text,scene,recentText='',sources={},work={}) {
  const budget=createWorkBudget(work),iterator=selectionWork(entries,mem,text,scene,recentText,sources);
  // Check a small group at a time: awaiting a promise for every term needlessly
  // repeats source fingerprints and extends microtask chains on large indexes.
  try{for(;;){await budget();for(let i=0;i<8;i++){const step=iterator.next();if(step.done){await budget();return step.value;}}}}
  finally{iterator.return();}
}
function* selectionWork(entries, mem, text, scene, recentText, sources) {
  entries=entries.filter(e=>!archivedThread(e));
  const index = yield* loreIndexWork(entries);
  const resolved = resolveScene(scene,index), selected = {}, skipped = [];
  const start=sources.startingScene ? resolveScene(sources.startingScene,index) : null, transition=!!start;
  const required=new Set(sources.directorRequiredIds ?? []),directorIds=new Set(sources.directorMemoryIds ?? []);
  const semanticIds=new Set(sources.semanticIds ?? []);
  const asList = value => value == null ? [] : Array.isArray(value) ? value : [value];
  const recent = sources.recent == null ? [{id:'__lore_recent',order:0,role:null,content:recentText}] : asList(sources.recent);
  const current = sources.current == null ? [{id:'__lore_current',order:recent.reduce((order,m)=>Math.max(order,m.order ?? 0),0)+1,role:'user',content:text}] : asList(sources.current);
  for (const book of ['characters','locations','facts','events']) {
    selected[book] = [];
    const list = [...new Map(entries.filter(e => e.book === book).map(e => [e.id,e])).values()];
    if (!mem.lorebooks || !mem.books[book].on) { for (const e of list) skipped.push({ entryId:e.id, book, name:e.name, reason:'book off' }); continue; }
    // Compile once for this selection; exported lookups still see mutable indexes.
    const matchers=yield* mentionMatchers(index,book);
    const evidence = function*(messages) {
      const hits = new Map();
      for (const m of messages) for (const hit of yield* matchOccurrences(m.content ?? '',matchers)) {
        const mention = {messageId:m.id ?? null,order:m.order ?? 0,role:m.role ?? null,offset:hit.start};
        if (!hits.has(hit.id) || compareMention(mention,hits.get(hit.id)) < 0) hits.set(hit.id,mention);
      }
      return hits;
    };
    const currentHits = yield* evidence(current), recentHits = yield* evidence(recent), latestHits = new Map(recentHits);
    // The old combined pass visited recent sources first: retain them on ties.
    for(const [id,mention]of currentHits)if(!latestHits.has(id) || compareMention(mention,latestHits.get(id))<0)latestHits.set(id,mention);
    const sceneHits = new Set((yield* matchOccurrences(scene?.raw ?? '',matchers)).map(hit=>hit.id));
    const candidates = new Map();
    const add = (entry,priority,reason) => {
      if(transition)priority=['always','protagonist','pinned record'].includes(reason) ? 0 : required.has(entry.id) ? 1 : ['in scene','current place'].includes(reason) ? 2 : ['starting character','starting place'].includes(reason) ? 3 : directorIds.has(entry.id) ? 4 : 5+priority;
      if (!candidates.has(entry.id) || candidates.get(entry.id).priority > priority)
        candidates.set(entry.id,{entry,reason,priority,mention:latestHits.get(entry.id) ?? null});
    };
    const pc = book==='characters' && list.find(e=>[e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(mem.protagonist)));
    for (const e of list) {
      yield;
      if(book==='characters' && sources.directorBackgroundIds?.includes(e.id) && !required.has(e.id) && !e.alwaysLoad && !(sources.records && (e.recordLayout?.records ?? []).some(r=>r.pinned))) {skipped.push({entryId:e.id,book,name:e.name,reason:'present in background; not in focus'});continue;}
      if(directorIds.has(e.id))add(e,4,'Director selection');
      if(start?.characters.includes(e.id) && book==='characters')add(e,3,'starting character');
      if(start?.place===e.id && book==='locations')add(e,3,'starting place');
      if(sources.records && (e.recordLayout?.records ?? []).some(r=>r.pinned))add(e,0,'pinned record');
      if (book === 'events') {
        if (e.kind === 'thread') {
          if (currentHits.has(e.id)) add(e,0,'mentioned');
          if (recentHits.has(e.id)) add(e,1,'recent mention');
          if (e.status !== 'closed' && semanticIds.has(e.id)) add(e,1.5,'semantic match');
          if (e.status !== 'closed') add(e,2,'open thread');
        } else if (e.kind === 'timeline') add(e,3,'timeline');
        continue;
      }
      if (e.alwaysLoad) add(e,0,'always');
      if (semanticIds.has(e.id)) add(e,book==='facts' ? 3.5 : 5,'semantic match');
      if (book === 'characters') {
        if (e.id === pc?.id) add(e,1,'protagonist');
        if (resolved.characters.includes(e.id)) add(e,2,'in scene');
        if (currentHits.has(e.id)) add(e,3,'mentioned');
        if (recentHits.has(e.id)) add(e,4,'recent mention');
      } else {
        if (book === 'locations' && e.id === resolved.place) add(e,1,'current place');
        if (book === 'facts' && sceneHits.has(e.id)) add(e,1,'mentioned');
        if (currentHits.has(e.id)) add(e,2,'mentioned');
        if (recentHits.has(e.id)) add(e,3,'recent mention');
        if (book === 'facts') add(e,4,'recent');
      }
    }
    const alreadySkipped=new Set(skipped.map(s=>s.entryId));
    for(const entry of list) if(!candidates.has(entry.id) && !alreadySkipped.has(entry.id))
      skipped.push({entryId:entry.id,book,name:entry.name,reason:'no name or alias match'});
    const ranked = [...candidates.values()].sort((a,b) => a.priority-b.priority ||
      ((!transition && (book==='facts' && a.priority===4 || book==='events' && a.priority===2))
        ? newestNote(b.entry)-newestNote(a.entry) : compareMention(a.mention,b.mention)) || (book==='characters' ? characterImportance(a.entry)-characterImportance(b.entry) : 0) || stableId(a.entry.id,b.entry.id));
    const isReserved=entry=>entry.alwaysLoad || entry.id===pc?.id || sources.records && (entry.recordLayout?.records ?? []).some(r=>r.pinned);
    const characterSlots=book==='characters' ? characterCardSlots(ranked.filter(item=>!isReserved(item.entry)),mem.books[book].maxCards,{protagonist:mem.protagonist,requiredIds:[...required]}) : null;
    let optional = 0;
    for (const [i,item] of ranked.entries()) {
      yield;
      const {entry,reason,mention} = item;
      const priorityReason = book==='facts' && item.priority===1 ? 'scene mention'
        : book==='facts' && item.priority===4 ? 'other facts' : reason;
      const ranking = {rank:i+1,priorityReason,mention};
      const reserved = isReserved(entry);
      if (['characters','locations'].includes(book) && !reserved && (characterSlots ? !characterSlots.has(item) : optional++ >= mem.books[book].maxCards))
        skipped.push({entryId:entry.id,book,name:entry.name,reason:`card limit (${mem.books[book].maxCards}) reached`,ranking});
      else selected[book].push({entry,reason,ranking});
    }
  }
  if (mem.lorebooks && mem.books.characters.on) for (const name of resolved.unmatched) skipped.push({ entryId:null, book:'characters', name, reason:'no card' });
  if (mem.lorebooks && mem.books.characters.on) for (const name of resolved.ambiguous) skipped.push({ entryId:null, book:'characters', name, reason:'ambiguous scene name; use the full card name' });
  return { selected, skipped, index, resolved };
}
export function renderLine(line,{provenance=false}={}) {
  if (provenance) return renderLoreLabel('lineStamp',{STAMP:[line.turn != null ? renderLoreLabel('turnLabel',{TURN:line.turn}) : null,line.when].filter(Boolean).join(' · '),TEXT:line.text});
  const text=stripTurnStamps(line.text),when=line.when ? stripTurnStamps(line.when) : '';
  return when ? renderLoreLabel('lineDate',{WHEN:when,TEXT:text}) : renderLoreLabel('linePlain',{TEXT:text});
}
export function sectionLabel(key, protagonist) { return key === 'bond' ? renderLoreLabel('bond',{PROTAGONIST:protagonist || renderLoreLabel('protagonistName')}) : key === 'text' ? '' : renderLoreLabel(key); }
export function renderEntry(entry, lineIds = null, protagonist = '', { provenance = false } = {}) {
  if(entry.book==='plan')return [renderPlanUnit({entry,phase:null,reason:entry.schedule?.status ?? 'pending'}),...(entry.schedule?.phases ?? []).map(phase=>renderPlanUnit({entry,phase,reason:phase.status},false))].join('\n\n');
  const out = [renderLoreLabel('entryHeading',{NAME:entry.name,ALIASES:entry.aliases?.length ? renderLoreLabel('aliases',{ALIASES:entry.aliases.join(', ')}) : ''})];
  if(entry.kind==='thread' && threadSummary(entry))out.push('Thread: '+entry.status+' · '+threadSummary(entry));
  for (const key of SECTION_KEYS[entry.book]) {
    const s = entry.sections[key]; if (!s) continue;
    const lines = sortLines(s.lines ?? []).filter(l => !lineIds || lineIds.has(l.id));
    if (!s.text && !lines.length) continue;
    const label = sectionLabel(key,protagonist);
    if (s.text) { const meta = sectionMeta(s,entry),text=provenance ? s.text : stripTurnStamps(s.text); if (provenance) out.push(renderLoreLabel('provenance',{KIND:meta.kind,ORIGIN:meta.origin,CUTOFF:meta.kind === 'canon' ? renderLoreLabel('authorAuthority') : cutoffLabel(meta.cutoff)})); out.push(label ? label+':'+(text.includes('\n') ? '\n' : ' ')+text : text); }
    else if (label) out.push(label+':');
    out.push(...lines.map(l=>renderLine(l,{provenance})));
  }
  return out.join('\n');
}
export async function fitBook(selected, budget, count, { protagonist = '', events = false, provenance = false, requiredIds=[], loreNotesPerSection=3 } = {}) {
  selected=selected.map(item=>({...item,entry:capLoreNotes(item.entry,loreNotesPerSection)}));
  if(selected.length && selected.every(item=>item.entry.book==='characters'))return fitLegacyCharacters(selected,budget,count,{protagonist,provenance,requiredIds});
  const cap = Math.floor(Math.max(0,budget)*.98), included = [], skipped = []; let used = 0;
  for (const item of selected) {
    const base = renderEntry(item.entry,new Set(),protagonist,{provenance});
    const tokens = await count(base+'\n');
    if (used+tokens > cap) { skipped.push({ entryId:item.entry.id, book:item.entry.book, name:item.entry.name, ranking:item.ranking, reason:'over budget' }); continue; }
    included.push({ ...item, lineIds:new Set(), tokens, queue:sortLines(Object.values(item.entry.sections).flatMap(s => s.lines ?? [])).reverse().sort((a,b)=>Number(b.by==='user')-Number(a.by==='user')), stopped:false }); used += tokens;
  }
  const add = async e => {
    if (e.stopped || !e.queue.length) return false;
    const ln = e.queue[0], tokens = await count(renderLine(ln,{provenance})+'\n');
    if (used+tokens > cap) { e.stopped = true; return false; }
    e.queue.shift(); e.lineIds.add(ln.id); e.tokens += tokens; used += tokens; return true;
  };
  const roundRobin = async list => { let changed; do { changed = false; for (const e of list) if (await add(e)) changed = true; } while (changed); };
  if (events) {
    const threads = included.filter(e => e.entry.kind === 'thread');
    for (let n=0;n<2;n++) for (const e of threads) await add(e);
    await roundRobin(included.filter(e => e.entry.kind === 'timeline'));
    await roundRobin(threads);
  } else await roundRobin(included);
  // Verify the complete rendering: section labels and separators also cost tokens.
  let text = included.map(e => renderEntry(e.entry,e.lineIds,protagonist,{provenance})).join('\n\n');
  let actual = await count(text);
  while (actual > budget && included.length) {
    const candidates=[...included].reverse();
    const victim=candidates.find(e=>Object.values(e.entry.sections).some(s=>(s.lines ?? []).some(l=>e.lineIds.has(l.id) && l.by!=='user'))) ?? candidates.find(e=>e.lineIds.size);
    if (victim) { const oldest = sortLines(Object.values(victim.entry.sections).flatMap(s => s.lines ?? []).filter(l => victim.lineIds.has(l.id) && (l.by!=='user' || !Object.values(victim.entry.sections).some(s=>(s.lines ?? []).some(n=>victim.lineIds.has(n.id) && n.by!=='user')))))[0]; victim.lineIds.delete(oldest.id); }
    else { const e = included.pop(); skipped.push({ entryId:e.entry.id, book:e.entry.book, name:e.entry.name, ranking:e.ranking, reason:'over budget' }); }
    text = included.map(e => renderEntry(e.entry,e.lineIds,protagonist,{provenance})).join('\n\n'); actual = await count(text);
  }
  for (const e of included) { Object.assign(e,fittedNoteStats(e.entry,e.lineIds)); e.tokens = await count(renderEntry(e.entry,e.lineIds,protagonist,{provenance})); }
  const userLinesCut=selected.reduce((n,item)=>n+Object.values(item.entry.sections).flatMap(s=>s.lines ?? []).filter(l=>l.by==='user' && !included.find(e=>e.entry.id===item.entry.id)?.lineIds.has(l.id)).length,0);
  return { included, skipped, text, tokens:actual,userLinesCut, noteOmissions:selected.flatMap(i=>noteOmissions(i.entry)),cut:included.reduce((n,e) => n+e.linesCut,0) };
}
async function fitLegacyCharacters(selected,budget,count,options) {
  const records=selected.map(item=>({...item,identity:false,lineIds:new Set(),queue:sortLines(Object.values(item.entry.sections).flatMap(s=>s.lines ?? [])).reverse().sort((a,b)=>Number(b.by==='user')-Number(a.by==='user'))}));
  const renderOne=r=>r.identity ? renderEntry(r.entry,r.lineIds,options.protagonist,options) : '';
  const fill=async(active,fits,protectedOnly=false)=>{
    for(const r of active)if(!r.identity){r.identity=true;if(!await fits())r.identity=false;}
    if(protectedOnly)return;
    const queues=new Map(active.map(r=>[r,r.queue.filter(line=>!r.lineIds.has(line.id))]));
    let pending=true;while(pending){pending=false;for(const r of active){if(!r.identity)continue;const queue=queues.get(r);while(queue.length){pending=true;const line=queue.shift();r.lineIds.add(line.id);if(await fits())break;r.lineIds.delete(line.id);}}}
  };
  const characterBudget=await allocateCharacterPools(records,Math.max(0,budget),count,renderOne,fill,options),included=[],skipped=[];
  for(const r of records){
    if(!r.identity){skipped.push({entryId:r.entry.id,book:'characters',name:r.entry.name,ranking:r.ranking,reason:'over budget; complete character background does not fit'});continue;}
    included.push({...r,...fittedNoteStats(r.entry,r.lineIds),tokens:await count(renderOne(r))});
  }
  const text=records.map(renderOne).filter(Boolean).join('\n\n');
  const userLinesCut=records.reduce((n,r)=>n+r.queue.filter(line=>line.by==='user'&&!r.lineIds.has(line.id)).length,0);
  return {text,included,skipped,tokens:await count(text),userLinesCut,noteOmissions:selected.flatMap(i=>noteOmissions(i.entry)),cut:included.reduce((n,r)=>n+r.linesCut,0),characterBudget};
}
export function renderFactsBlock(fit) { return fit.text ? prompts.factsHeader+'\n'+fit.text : ''; }
export function renderEventsBlock(fit, { provenance = false } = {}) {
  const out = [], threads = fit.included.filter(e => e.entry.kind === 'thread'), timeline = fit.included.find(e => e.entry.kind === 'timeline');
  const open=threads.filter(e=>e.entry.status!=='closed'),closed=threads.filter(e=>e.entry.status==='closed');
  if (open.length) out.push(renderLoreLabel('openThreads'),...open.map(e => renderEntry(e.entry,e.lineIds,'',{provenance})));
  if (closed.length) out.push(renderLoreLabel('closedThreads'),...closed.map(e => renderEntry(e.entry,e.lineIds,'',{provenance})));
  if (timeline && (timeline.entry.sections.text?.text || timeline.lineIds.size)) {
    out.push(renderLoreLabel('timeline',{OMITTED:timeline.linesCut ? renderLoreLabel('omittedEvents',{COUNT:timeline.linesCut}) : ''}));
    if (timeline.entry.sections.text?.text) { const meta = sectionMeta(timeline.entry.sections.text,timeline.entry); if (provenance) out.push(renderLoreLabel('provenance',{KIND:meta.kind,ORIGIN:meta.origin,CUTOFF:cutoffLabel(meta.cutoff)})); const text=timeline.entry.sections.text.text; out.push(provenance ? text : stripTurnStamps(text)); }
    out.push(...sortLines(timeline.entry.sections.text?.lines ?? []).filter(l => timeline.lineIds.has(l.id)).map(l=>renderLine(l,{provenance})));
  }
  return out.length ? prompts.eventsHeader+'\n'+out.join('\n') : '';
}
export function renderMemoryBlock({ scene, staleScene, plan = '', characters, locations }) {
  const out = [prompts.memoryHeader];
  if (scene) out.push(renderLoreLabel(staleScene ? 'staleScene' : 'currentScene',{SCENE:scene.raw}));
  if (plan) out.push(plan);
  if (characters?.text) out.push(renderLoreLabel('characters'),characters.text);
  if (locations?.text) out.push(renderLoreLabel(locations.included?.length>1?'places':'place'),locations.text);
  return out.join('\n');
}
