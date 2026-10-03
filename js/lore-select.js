import { prompts } from './system-prompts.js';
import { CONTINUITY_RULE, sectionMeta, cutoffLabel } from './continuity.js';
import { normalizeName, STOPLIST, SECTION_KEYS } from './lore-lines.js';
export const MEMORY_RULE = CONTINUITY_RULE;
export function sortLines(lines) { return [...lines].sort((a,b) => (a.turn ?? 0)-(b.turn ?? 0)||(a.at ?? 0)-(b.at ?? 0)); }
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildLoreIndex(entries) {
  const index = { entries, characters:[], locations:[], facts:[], events:[] };
  for (const e of entries) {
    const terms = [e.name,...(e.aliases ?? [])];
    if (e.book === 'characters') terms.push(normalizeName(e.name).split(' ')[0]);
    const seen = new Set();
    for (const [i,term] of terms.entries()) {
      const normTerm = normalizeName(term);
      if (normTerm.length < 2 || STOPLIST.has(normTerm) || seen.has(normTerm)) continue;
      seen.add(normTerm);
      index[e.book]?.push({ entryId:e.id, term, normTerm, isMain:i === 0 });
    }
  }
  return index;
}
export function findMentions(text, index, book) {
  const matches = [];
  for (const term of index[book] ?? []) {
    const re = new RegExp('(?<![\\p{L}\\p{N}])'+escapeRegex(term.normTerm)+'(?![\\p{L}\\p{N}])','giu');
    for (const m of normalizeName(text).matchAll(re)) matches.push({ id:term.entryId, start:m.index, end:m.index+m[0].length });
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
export function selectEntries(entries, mem, text, scene) {
  const index = buildLoreIndex(entries), resolved = resolveScene(scene,index), selected = {}, skipped = [];
  for (const book of ['characters','locations','facts','events']) {
    selected[book] = [];
    const list = entries.filter(e => e.book === book);
    if (!mem.lorebooks || !mem.books[book].on) { for (const e of list) skipped.push({ entryId:e.id, book, name:e.name, reason:'book off' }); continue; }
    const add = (id,reason) => { const entry = list.find(e => e.id === id); if (entry && !selected[book].some(x => x.entry.id === id)) selected[book].push({ entry, reason }); };
    if (book === 'facts') for (const e of list) add(e.id,'always');
    else if (book === 'events') {
      for (const e of list.filter(e => e.kind === 'thread' && e.status !== 'closed').sort((a,b) => Math.max(0,...Object.values(b.sections).flatMap(s => s.lines.map(l => l.at)))-Math.max(0,...Object.values(a.sections).flatMap(s => s.lines.map(l => l.at))))) add(e.id,'open thread');
      for (const e of list.filter(e => e.kind === 'timeline')) add(e.id,'timeline');
    } else {
      for (const e of list.filter(e => e.alwaysLoad)) add(e.id,'always');
      const always = selected[book].length;
      if (book === 'locations' && resolved.place) add(resolved.place,'current place');
      if (book === 'characters') for (const id of resolved.characters) add(id,'in scene');
      for (const id of findMentions(text,index,book)) add(id,'mentioned');
      const cap = always+mem.books[book].maxCards;
      for (const x of selected[book].splice(cap)) skipped.push({ entryId:x.entry.id, book, name:x.entry.name, reason:`card limit (${mem.books[book].maxCards}) reached` });
    }
  }
  if (mem.lorebooks && mem.books.characters.on) for (const name of resolved.unmatched) skipped.push({ entryId:null, book:'characters', name, reason:'no card' });
  if (mem.lorebooks && mem.books.characters.on) for (const name of resolved.ambiguous) skipped.push({ entryId:null, book:'characters', name, reason:'ambiguous scene name; use the full card name' });
  return { selected, skipped, index, resolved };
}
export function renderLine(line) { return '- ['+[line.turn != null ? 'T'+line.turn : null,line.when].filter(Boolean).join(' · ')+'] '+line.text; }
export function sectionLabel(key, protagonist) { return key === 'bond' ? 'Bond with '+(protagonist || 'the protagonist') : key === 'text' ? '' : key[0].toUpperCase()+key.slice(1); }
export function renderEntry(entry, lineIds = null, protagonist = '') {
  const out = [`## ${entry.name}${entry.aliases?.length ? ' (also called: '+entry.aliases.join(', ')+')' : ''}`];
  for (const key of SECTION_KEYS[entry.book]) {
    const s = entry.sections[key]; if (!s) continue;
    const lines = sortLines(s.lines ?? []).filter(l => !lineIds || lineIds.has(l.id));
    if (!s.text && !lines.length) continue;
    const label = sectionLabel(key,protagonist);
    if (s.text) { const meta = sectionMeta(s,entry); out.push(`[${meta.kind}; origin: ${meta.origin}; ${meta.kind === 'canon' ? 'author authority' : cutoffLabel(meta.cutoff)}]`); out.push(label ? label+':'+(s.text.includes('\n') ? '\n' : ' ')+s.text : s.text); }
    else if (label) out.push(label+':');
    out.push(...lines.map(renderLine));
  }
  return out.join('\n');
}
export async function fitBook(selected, budget, count, { protagonist = '', events = false } = {}) {
  const cap = Math.floor(Math.max(0,budget)*.98), included = [], skipped = []; let used = 0;
  for (const item of selected) {
    const base = renderEntry(item.entry,new Set(),protagonist);
    const tokens = await count(base+'\n');
    if (used+tokens > cap) { skipped.push({ entryId:item.entry.id, book:item.entry.book, name:item.entry.name, reason:'over budget' }); continue; }
    included.push({ ...item, lineIds:new Set(), tokens, queue:sortLines(Object.values(item.entry.sections).flatMap(s => s.lines ?? [])).reverse(), stopped:false }); used += tokens;
  }
  const add = async e => {
    if (e.stopped || !e.queue.length) return false;
    const ln = e.queue[0], tokens = await count(renderLine(ln)+'\n');
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
  let text = included.map(e => renderEntry(e.entry,e.lineIds,protagonist)).join('\n\n');
  let actual = await count(text);
  while (actual > budget && included.length) {
    const victim = [...included].reverse().find(e => e.lineIds.size);
    if (victim) { const oldest = sortLines(Object.values(victim.entry.sections).flatMap(s => s.lines ?? []).filter(l => victim.lineIds.has(l.id)))[0]; victim.lineIds.delete(oldest.id); }
    else { const e = included.pop(); skipped.push({ entryId:e.entry.id, book:e.entry.book, name:e.entry.name, reason:'over budget' }); }
    text = included.map(e => renderEntry(e.entry,e.lineIds,protagonist)).join('\n\n'); actual = await count(text);
  }
  for (const e of included) { e.linesSent = e.lineIds.size; e.linesCut = Object.values(e.entry.sections).reduce((n,s) => n+(s.lines?.length ?? 0),0)-e.linesSent; e.tokens = await count(renderEntry(e.entry,e.lineIds,protagonist)); }
  return { included, skipped, text, tokens:actual, cut:included.reduce((n,e) => n+e.linesCut,0) };
}
export function renderFactsBlock(fit) { return fit.text ? prompts.factsHeader+'\n'+fit.text : ''; }
export function renderEventsBlock(fit) {
  const out = [], threads = fit.included.filter(e => e.entry.kind === 'thread'), timeline = fit.included.find(e => e.entry.kind === 'timeline');
  if (threads.length) out.push('Open threads:',...threads.map(e => renderEntry(e.entry,e.lineIds)));
  if (timeline && (timeline.entry.sections.text.text || timeline.lineIds.size)) {
    out.push('Timeline (oldest first'+(timeline.linesCut ? ', '+timeline.linesCut+' earlier events not shown' : '')+'):');
    if (timeline.entry.sections.text.text) { const meta = sectionMeta(timeline.entry.sections.text,timeline.entry); out.push(`[${meta.kind}; origin: ${meta.origin}; ${cutoffLabel(meta.cutoff)}]`,timeline.entry.sections.text.text); }
    out.push(...sortLines(timeline.entry.sections.text.lines).filter(l => timeline.lineIds.has(l.id)).map(renderLine));
  }
  return out.length ? prompts.eventsHeader+'\n'+out.join('\n') : '';
}
export function renderMemoryBlock({ scene, sceneFromTurn, sceneFromOrder, staleScene, plan = '', characters, locations }) {
  const out = [prompts.memoryHeader];
  if (scene) out.push(`Established scene snapshot at T${sceneFromTurn ?? '?'} (message order ${sceneFromOrder ?? '?'}${staleScene ? '; later narrative omitted scene metadata' : ''}): ${scene.raw}`);
  if (plan) out.push(plan);
  if (characters?.text) out.push('Characters:',characters.text);
  if (locations?.text) out.push('Place:',locations.text);
  return out.join('\n');
}
