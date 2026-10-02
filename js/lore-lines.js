import { evidenceFor, revisionOf, noteNeedsReview } from './continuity.js';
import { computeTurns } from './turns.js';
import { latestScene } from './scene.js';
export const STOPLIST = new Set('he she they him her them i you me we it someone somebody man woman boy girl guard the a narrator user unknown'.split(' '));
export function normalizeName(s) { return String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '').trim(); }
export const SECTION_MAP = {
  characters: { appearance:'appearance', looks:'appearance', look:'appearance', status:'status', state:'status', condition:'status', health:'status', bond:'bond', relationship:'bond', relations:'relations', relationships:'relations', alias:'alias', aka:'alias', 'also called':'alias', name:'alias', notes:'notes', note:'notes', other:'notes', personality:'personality', traits:'personality' },
  locations: { description:'description', look:'description', appearance:'description', state:'state', status:'state', condition:'state', alias:'alias', aka:'alias', 'also called':'alias', notes:'notes', note:'notes' },
};
export const SECTION_KEYS = { characters:['personality','appearance','status','bond','relations','notes'], locations:['description','state','notes'], facts:['text'], events:['text'] };
export function sectionKey(book, value, protagonist = '') {
  const name = normalizeName(value);
  if (book === 'characters' && /^(bond with |relation(?:ship)? with )/.test(name)) return normalizeName(name.replace(/^(?:bond|relation(?:ship)?) with /,'')) === normalizeName(protagonist) || name.startsWith('bond with ') ? 'bond' : 'relations';
  return SECTION_MAP[book]?.[name] ?? (book === 'facts' || book === 'events' ? 'text' : 'notes');
}
export function newLoreId(prefix = 'lore') { return prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10); }
export function makeEntry(book, name, extra = {}) {
  return { id:newLoreId(), book, kind:'card', name, aliases:[], alwaysLoad:false, draft:false, status:null, sections:Object.fromEntries(SECTION_KEYS[book].map(k => [k,{ text:'',lines:[],origin:extra.createdFrom === 'import' ? 'import' : 'user',kind:extra.createdFrom === 'import' ? 'background' : 'canon',cutoff:null }])), createdFrom:'user', ...extra };
}
export function parseMemoryLines(text, ctx = {}) {
  const ops = [], skipped = []; let sawNone = false;
  const synonyms = { character:'char', chr:'char', location:'loc', place:'loc', thread:'open', opened:'open', close:'closed', resolved:'closed' };
  const assistants = ctx.range?.assistants ?? [];
  for (const [i, source] of String(text ?? '').split('\n').entries()) {
    const line = source.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/,'').replace(/^`+|`+$/g,'').trim();
    const skip = reason => skipped.push({ line:i+1, text:source, reason });
    if (!line || /^```/.test(source.trim())) continue;
    if (/^NONE$/i.test(line)) { sawNone = true; continue; }
    const m = line.match(/^(?:T(\d+)\s+)?\[([a-z]+)\]\s*(.*)$/i);
    if (!m) { skip('not a note'); continue; }
    const tag = synonyms[m[2].toLowerCase()] ?? m[2].toLowerCase();
    if (!['char','loc','fact','event','open','closed'].includes(tag)) { skip('unknown tag'); continue; }
    const book = tag === 'char' ? 'characters' : tag === 'loc' ? 'locations' : tag === 'fact' ? 'facts' : 'events';
    if (ctx.mem?.books?.[book]?.on === false) { skip('book off'); continue; }
    let name, value, section = 'text';
    const pipe = m[3].indexOf('|');
    if (tag === 'event') { name = 'Timeline'; value = m[3]; }
    else if (tag === 'fact' && pipe < 0) { name = 'General'; value = m[3]; }
    else { if (pipe < 0) { skip('missing separator'); continue; } name = m[3].slice(0,pipe); value = m[3].slice(pipe+1); }
    name = name.trim().replace(/^["'“”]+|["'“”]+$/g,'');
    if (name.length > 60) { skip('name exceeds 60 characters'); continue; }
    if (!name || STOPLIST.has(normalizeName(name)) || normalizeName(name).length < 2) { skip('not a name'); continue; }
    if (book === 'characters' || book === 'locations') {
      const colon = value.indexOf(':');
      if (colon < 0) { skip('missing section'); continue; }
      const label = value.slice(0,colon).trim(); value = value.slice(colon+1).trim(); section = sectionKey(book,label,ctx.protagonist ?? ctx.mem?.protagonist);
      if (section === 'personality' && !ctx.allowPersonality) { skip('personality is written by you'); continue; }
      if (section === 'relations' && /^relationship with /i.test(label)) value = label.replace(/^relationship with /i,'')+' — '+value;
      if (section === 'notes' && !SECTION_MAP[book][normalizeName(label)]) value = label+': '+value;
    }
    value = value.trim();
    if (!value) { skip('empty note'); continue; }
    if (value.length > 400) { skip('note exceeds 400 characters'); continue; }
    if (ops.length >= 80) { skip('too many lines'); continue; }
    let turn = Number(m[1]);
    let assistant = assistants.find(a => a.turn === turn);
    let evidence = [];
    if (ctx.reorganize) {
      const candidates = ctx.entries?.find(e => normalizeName(e.name) === normalizeName(name))?.sections?.[section]?.lines ?? [];
      const chosen = candidates.find(l => l.turn === turn);
      if (!chosen) { skip('invalid source turn'); continue; }
      assistant = { turn:chosen.turn,order:chosen.src };
      evidence = [...new Map(candidates.flatMap(l => l.evidence ?? []).map(e => [e.id,e])).values()];
    } else {
      if (!m[1] || !assistant) { skip('a valid source turn is required'); continue; }
      const turns = computeTurns(ctx.messages ?? []);
      evidence = evidenceFor((ctx.messages ?? []).filter(m => m.role !== 'summary' && turns.turnById.get(m.id) === turn));
      if (!evidence.some(e => e.id === assistant.id)) { skip('missing source evidence'); continue; }
    }
    const when = assistant ? latestScene(ctx.messages ?? [], assistant.order+1).scene?.when ?? null : null;
    ops.push({ tag, book, name, section, text:value, turn, when, src:assistant?.order ?? null, evidence, line:i+1 });
  }
  return { ops,skipped,sawNone,valid:skipped.length === 0 && !(sawNone && ops.length) && (ops.length > 0 || sawNone) };
}
export function applyOps(entries, ops, stampCtx = {}) {
  const working = structuredClone(entries), creates = [], appends = [], statusChanges = [], aliases = [], skipped = [];
  const match = (book,name) => working.find(e => e.book === book && [e.name,...(e.aliases ?? [])].some(n => normalizeName(n) === normalizeName(name)));
  const now = stampCtx.now ?? Date.now();
  for (const op of ops) {
    if (stampCtx.mem?.books?.[op.book]?.on === false) { skipped.push({ ...op, reason:'book off' }); continue; }
    let e = op.tag === 'event' ? working.find(e => e.kind === 'timeline') : match(op.book,op.name);
    if (stampCtx.reorganize && (!e || stampCtx.allowedIds && !stampCtx.allowedIds.includes(e.id))) { skipped.push({ ...op, reason:'name outside the notes' }); continue; }
    let text = op.text;
    if (op.tag === 'closed' && (!e || e.kind !== 'thread' || e.status === 'closed')) { e = working.find(e => e.kind === 'timeline'); text = `Resolved: ${op.name} — ${text}`; }
    if (!e && op.section === 'alias') { const clash = match(op.book,text); if (clash) { skipped.push({ ...op,reason:'name already used by '+clash.name }); continue; } }
    if (!e) {
      const timeline = op.tag === 'event' || op.tag === 'closed';
      e = makeEntry(op.book, timeline ? 'Timeline' : op.name, { kind:timeline ? 'timeline' : ['open','closed'].includes(op.tag) ? 'thread' : 'card', draft:!['event','open','closed'].includes(op.tag), createdFrom:'auto', status:op.tag === 'open' ? 'open' : null });
      working.push(e); creates.push(e);
    }
    let section = e.kind === 'timeline' ? 'text' : op.section;
    if (section === 'bond' && [e.name,...e.aliases].some(n => normalizeName(n) === normalizeName(stampCtx.protagonist ?? stampCtx.mem?.protagonist))) section = 'notes';
    if (section === 'personality' && !stampCtx.allowPersonality) { skipped.push({ ...op, reason:'personality is written by you' }); continue; }
    if (section === 'alias') {
      const clash = match(op.book,text);
      if (clash && clash.id !== e.id) { skipped.push({ ...op,reason:'name already used by '+clash.name }); continue; }
      section = 'notes'; text = 'Known alias: '+text;
    }
    const s = e.sections[section];
    if (!s) { skipped.push({ ...op, reason:'unknown section' }); continue; }
    if (!stampCtx.reorganize && s.lines.some(l => normalizeName(l.text) === normalizeName(text) && !noteNeedsReview(l,stampCtx.messages ?? [],stampCtx.session ?? {}))) continue;
    if (op.tag === 'open' || op.tag === 'closed' && e.kind === 'thread') { e.status = op.tag === 'closed' ? 'closed' : 'open'; statusChanges.push({ entryId:e.id, status:e.status }); }
    const original = stampCtx.reorganize ? [...(entries.find(x => x.id === e.id)?.sections[section]?.lines ?? [])].filter(l => l.turn === op.turn).sort((a,b) => a.at-b.at).at(-1) : null;
    const ln = { id:newLoreId('ln'), text, turn:op.turn, when:original?.when ?? op.when, src:original?.src ?? op.src, by:stampCtx.reorganize ? 'reorganize' : 'auto',at:now,evidence:op.evidence ?? [],sourceRevision:stampCtx.sourceRevision ?? 0 };
    if (new TextEncoder().encode(JSON.stringify(e)).length + new TextEncoder().encode(JSON.stringify(ln)).length > 900000) { skipped.push({ ...op, reason:'card storage full' }); continue; }
    s.lines.push(ln);
    if (op.tag === 'open' || op.tag === 'closed' && e.kind === 'thread') { e.statusSource = ln; const status = statusChanges.findLast(c => c.entryId === e.id); if (status) status.source = ln; }
    if (!creates.includes(e)) appends.push({ entryId:e.id, section, line:ln });
  }
  return { creates, appends, aliases, statusChanges, skipped, entries:working };
}
