import { maxOf } from './math-utils.js';
import { prompts, renderLoreLabel } from './system-prompts.js';
import { CONTINUITY_RULE, sectionMeta, cutoffLabel } from './continuity.js';
import { normalizeName, STOPLIST, COMMON_ALIAS_WORDS, SECTION_KEYS } from './lore-lines.js';
import { stripTurnStamps } from './story-text.js';
export const MEMORY_RULE = CONTINUITY_RULE;
export function sortLines(lines) { return [...lines].sort((a,b) => (a.turn ?? (a.by==='user'?Infinity:0))-(b.turn ?? (b.by==='user'?Infinity:0))||(a.at ?? 0)-(b.at ?? 0)); }
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildLoreIndex(entries) {
  const index = { entries, characters:[], locations:[], facts:[], events:[] };
  for (const e of entries) {
    const terms = [e.name,...(e.aliases ?? [])];
    if (e.book === 'characters') {const first=normalizeName(e.name).split(' ')[0];if(first.length>=3 && !new Set('lord lady sir dame king queen prince princess master mistress captain father mother brother sister mr. mrs. ms. dr.'.split(' ')).has(first) && entries.filter(x=>x.book==='characters' && normalizeName(x.name).split(' ')[0]===first).length===1)terms.push(e.name.split(' ')[0]);}
    const seen = new Set();
    for (const [i,term] of terms.entries()) {
      const normTerm = normalizeName(term);
      if (normTerm.length < 2 || STOPLIST.has(normTerm) || seen.has(normTerm)) continue;
      if (i>0 && i<= (e.aliases?.length ?? 0) && normTerm.startsWith('the ') && normTerm.slice(4).split(' ').every(word=>STOPLIST.has(word) || COMMON_ALIAS_WORDS.has(word))) continue;
      seen.add(normTerm);
      index[e.book]?.push({ entryId:e.id, term, normTerm, isMain:i === 0,firstName:e.book==='characters' && i>=(1+(e.aliases?.length ?? 0)) });
    }
  }
  return index;
}
export function findMentions(text, index, book) {
  const matches = [], nfc = String(text).normalize('NFC');
  for (const term of index[book] ?? []) {
    // All matches share offsets in the same string; allow names across whitespace.
    const phrase = escapeRegex(term.firstName ? term.term : term.normTerm).replace(/\s+/g, '\\s+');
    const re = new RegExp('(?<![\\p{L}\\p{N}])'+phrase+'(?![\\p{L}\\p{N}])',term.firstName ? 'gu' : 'giu');
    for (const m of nfc.matchAll(re)) matches.push({ id:term.entryId, start:m.index, end:m.index+m[0].length });
  }
  matches.sort((a,b) => (b.end-b.start)-(a.end-a.start)||a.start-b.start);
  const chosen = [];
  for (const m of matches) if (!chosen.some(c => m.start < c.end && c.start < m.end)) chosen.push(m);
  chosen.sort((a,b) => a.start-b.start);
  return [...new Set(chosen.map(m => m.id))];
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
export function selectEntries(entries, mem, text, scene, recentText = '') {
  const index = buildLoreIndex(entries), resolved = resolveScene(scene,index), selected = {}, skipped = [];
  for (const book of ['characters','locations','facts','events']) {
    selected[book] = [];
    const list = entries.filter(e => e.book === book);
    if (!mem.lorebooks || !mem.books[book].on) { for (const e of list) skipped.push({ entryId:e.id, book, name:e.name, reason:'book off' }); continue; }
    const add = (id,reason) => { const entry = list.find(e => e.id === id); if (entry && !selected[book].some(x => x.entry.id === id)) selected[book].push({ entry, reason }); };
    if(book==='facts'){const mentioned=new Set(findMentions(text+' '+(scene?.raw ?? ''),index,book));for(const e of [...list].sort((a,b)=>Number(b.alwaysLoad)-Number(a.alwaysLoad) || Number(mentioned.has(b.id))-Number(mentioned.has(a.id)) || Math.max(0,maxOf(Object.values(b.sections).flatMap(s=>(s.lines ?? []).map(l=>l.at ?? 0))))-Math.max(0,maxOf(Object.values(a.sections).flatMap(s=>(s.lines ?? []).map(l=>l.at ?? 0))))))add(e.id,e.alwaysLoad?'always':mentioned.has(e.id)?'mentioned':'recent');}
    else if (book === 'events') {
      for (const e of list.filter(e => e.kind === 'thread' && e.status !== 'closed').sort((a,b) => Math.max(0,maxOf(Object.values(b.sections).flatMap(s => (s.lines ?? []).map(l => l.at ?? 0))))-Math.max(0,maxOf(Object.values(a.sections).flatMap(s => (s.lines ?? []).map(l => l.at ?? 0)))))) add(e.id,'open thread');
      for (const e of list.filter(e => e.kind === 'timeline')) add(e.id,'timeline');
    } else {
      for (const e of list.filter(e => e.alwaysLoad)) add(e.id,'always');
      const always=selected[book].length;
      const pc=book==='characters' && list.find(e=>[e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(mem.protagonist)));if(pc)add(pc.id,'protagonist');
      if (book === 'locations' && resolved.place) add(resolved.place,'current place');
      if (book === 'characters') for (const id of resolved.characters) add(id,'in scene');
      for (const id of findMentions(text,index,book)) add(id,'mentioned');
      for (const id of findMentions(recentText,index,book)) add(id,'recent mention');
      const cap=always+(pc && !pc.alwaysLoad ? 1 : 0)+mem.books[book].maxCards;
      for (const x of selected[book].splice(cap)) skipped.push({ entryId:x.entry.id, book, name:x.entry.name, reason:`card limit (${mem.books[book].maxCards}) reached` });
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
  const out = [renderLoreLabel('entryHeading',{NAME:entry.name,ALIASES:entry.aliases?.length ? renderLoreLabel('aliases',{ALIASES:entry.aliases.join(', ')}) : ''})];
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
export async function fitBook(selected, budget, count, { protagonist = '', events = false, provenance = false } = {}) {
  const cap = Math.floor(Math.max(0,budget)*.98), included = [], skipped = []; let used = 0;
  for (const item of selected) {
    const base = renderEntry(item.entry,new Set(),protagonist,{provenance});
    const tokens = await count(base+'\n');
    if (used+tokens > cap) { skipped.push({ entryId:item.entry.id, book:item.entry.book, name:item.entry.name, reason:'over budget' }); continue; }
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
    else { const e = included.pop(); skipped.push({ entryId:e.entry.id, book:e.entry.book, name:e.entry.name, reason:'over budget' }); }
    text = included.map(e => renderEntry(e.entry,e.lineIds,protagonist,{provenance})).join('\n\n'); actual = await count(text);
  }
  for (const e of included) { e.linesSent = e.lineIds.size; e.linesCut = Object.values(e.entry.sections).reduce((n,s) => n+(s.lines?.length ?? 0),0)-e.linesSent; e.tokens = await count(renderEntry(e.entry,e.lineIds,protagonist,{provenance})); }
  const userLinesCut=selected.reduce((n,item)=>n+Object.values(item.entry.sections).flatMap(s=>s.lines ?? []).filter(l=>l.by==='user' && !included.find(e=>e.entry.id===item.entry.id)?.lineIds.has(l.id)).length,0);
  return { included, skipped, text, tokens:actual,userLinesCut, cut:included.reduce((n,e) => n+e.linesCut,0) };
}
export function renderFactsBlock(fit) { return fit.text ? prompts.factsHeader+'\n'+fit.text : ''; }
export function renderEventsBlock(fit, { provenance = false } = {}) {
  const out = [], threads = fit.included.filter(e => e.entry.kind === 'thread'), timeline = fit.included.find(e => e.entry.kind === 'timeline');
  if (threads.length) out.push(renderLoreLabel('openThreads'),...threads.map(e => renderEntry(e.entry,e.lineIds,'',{provenance})));
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
