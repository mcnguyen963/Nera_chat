import { sectionMeta } from './continuity.js';
import { makeEntry, newLoreId, normalizeName, sectionKey, SECTION_MAP, SECTION_KEYS } from './lore-lines.js';
import { sortLines, sectionLabel } from './lore-select.js';
export const BOOK_LABELS = { characters:'Characters',locations:'Locations',facts:'World facts',events:'Events & threads' };
const unfence = text => String(text ?? '').trim().replace(/^```(?:json|markdown|md)?\s*\n?/i,'').replace(/\n?```\s*$/,'').trim();
export function detectFormat(text) { return unfence(text).startsWith('{') ? 'json' : 'md'; }
function validateInput(text) { if (!String(text).trim()) throw new Error('The file is empty.'); if (new TextEncoder().encode(text).length > 2*1024*1024) throw new Error('The file is larger than 2 MB. Split it by book.'); }
function importedLine(value) { const line = typeof value === 'string' ? { text:value } : value; return { id:newLoreId('ln'),text:String(line?.text ?? '').trim(),turn:Number.isSafeInteger(line?.turn) && line.turn>=0 ? line.turn : null,when:line?.when ? String(line.when) : null,src:line?.src ?? null,by:line?.by ?? 'import',at:line?.at ?? Date.now(),evidence:line?.evidence ?? [],sourceRevision:line?.sourceRevision ?? 0,...(line?.needsReview ? { needsReview:true } : {}) }; }
const exportLine = l => ({ ...l });
export function toJson(entries, { title = '', books = Object.keys(BOOK_LABELS), now = new Date() } = {}) {
  const out = { format:'nera-lorebooks',version:2,story:title,exportedAt:now.toISOString(),entries:entries.filter(e => books.includes(e.book)).map(e => ({ ...e,sections:Object.fromEntries(Object.entries(e.sections).map(([key,s]) => [key,{ ...s,...sectionMeta(s,e) }])) })) };
  for (const book of books) {
    const list = entries.filter(e => e.book === book);
    if (book === 'characters' || book === 'locations') out[book] = list.map(e => ({ name:e.name,aliases:e.aliases ?? [],alwaysLoad:!!e.alwaysLoad,sections:Object.fromEntries(Object.entries(e.sections).filter(([,s]) => s.text || s.lines.length).map(([k,s]) => [k,{ text:s.text,lines:sortLines(s.lines).map(exportLine) }])) }));
    if (book === 'facts') out.facts = list.map(e => ({ name:e.name,text:e.sections.text.text,lines:sortLines(e.sections.text.lines).map(exportLine) }));
    if (book === 'events') { const timeline = list.find(e => e.kind === 'timeline'); out.events = { timeline:{ text:timeline?.sections.text.text ?? '',lines:sortLines(timeline?.sections.text.lines ?? []).map(exportLine) },threads:list.filter(e => e.kind === 'thread').map(e => ({ title:e.name,status:e.status,text:e.sections.text.text,lines:sortLines(e.sections.text.lines).map(exportLine) })) }; }
  }
  return JSON.stringify(out,null,2);
}
export function fromJson(text) {
  validateInput(text); const source = unfence(text); let data;
  try { data = JSON.parse(source); } catch (e) { const p = Number(e.message.match(/position (\d+)/)?.[1]); if (Number.isFinite(p)) { const before = source.slice(0,p), line = before.split('\n').length, column = before.length-(before.lastIndexOf('\n')+1)+1; throw new Error(`JSON error at line ${line}, column ${column}: ${e.message}`); } throw new Error('JSON error: '+e.message); }
  if (!data || typeof data !== 'object' || !['characters','locations','facts','events'].some(k => k in data)) throw new Error('This file doesn\'t look like lorebooks. Expected \'## Characters\' style headings (Markdown) or a JSON object with "characters".');
  if (data.version === 2 && Array.isArray(data.entries)) { for (const e of data.entries) { if (!SECTION_KEYS[e.book] || typeof e.name !== 'string' || !e.sections) throw new Error('Invalid version 2 lorebook entry.'); for (const key of SECTION_KEYS[e.book]) { const section = e.sections[key] ??= { text:'',lines:[] }; Object.assign(section,sectionMeta(section,e)); if (!Array.isArray(section.lines) || typeof section.text !== 'string') throw new Error('Invalid version 2 section.'); } } return { entries:data.entries,warnings:[],books:Object.keys(BOOK_LABELS).filter(k => k in data || data.entries.some(e => e.book === k)),story:data.story ?? '',format:'json' }; }
  const entries = [], warnings = [], books = Object.keys(BOOK_LABELS).filter(k => k in data);
  const warnUnknown = (obj,allowed,name) => { for (const key of Object.keys(obj ?? {})) if (!allowed.includes(key)) warnings.push({ line:source.slice(0,Math.max(0,source.indexOf('"'+key+'"'))).split('\n').length,reason:`ignored key '${key}' in ${name}` }); };
  warnUnknown(data,['format','version','story','exportedAt','entries',...Object.keys(BOOK_LABELS)],'file');
  const section = value => typeof value === 'string' ? { text:value,lines:[],origin:'import',kind:'background',cutoff:null } : { text:String(value?.text ?? ''),origin:value?.origin ?? 'import',kind:value?.kind ?? 'background',cutoff:value?.cutoff ?? null,lines:(Array.isArray(value?.lines) ? value.lines : []).map(importedLine).filter(l => l.text) };
  for (const book of ['characters','locations','facts']) for (const [i,item] of (Array.isArray(data[book]) ? data[book] : []).entries()) {
    if (!item?.name?.trim()) { warnings.push({ line:1,reason:`missing name in ${book} card ${i+1}` }); continue; }
    const e = makeEntry(book,item.name.trim(),{ aliases:book === 'facts' ? [] : (item.aliases ?? []).map(String),alwaysLoad:book !== 'facts' && item.alwaysLoad === true,createdFrom:'import' });
    warnUnknown(item,['name','aliases','alwaysLoad','sections','text','lines'],e.name);
    if (book === 'facts') e.sections.text = section(item);
    else { warnUnknown(item.sections,SECTION_KEYS[book],e.name); for (const key of SECTION_KEYS[book]) if (item.sections?.[key] != null) e.sections[key] = section(item.sections[key]); }
    entries.push(e);
  }
  if ('events' in data) {
    const events = data.events;
    const timeline = makeEntry('events','Timeline',{ kind:'timeline',createdFrom:'import' }); timeline.sections.text = section(Array.isArray(events) ? { lines:events } : events?.timeline); entries.push(timeline);
    for (const item of events?.threads ?? []) {
      if (!item.title?.trim()) { warnings.push({ line:1,reason:'missing thread title' }); continue; }
      const e = makeEntry('events',item.title.trim(),{ kind:'thread',status:item.status === 'closed' ? 'closed' : 'open',createdFrom:'import' }); e.sections.text = section(item); entries.push(e);
    }
  }
  return { entries,warnings,books,story:data.story ?? '',format:'json' };
}
export function toMarkdown(entries, { title = '', books = Object.keys(BOOK_LABELS) } = {}) {
  const out = ['# Lorebooks','story: '+title,'format: nera-lorebooks-md 2',''];
  for (const book of books) {
    out.push('## '+(book === 'events' ? 'Events' : BOOK_LABELS[book]),'');
    for (const e of entries.filter(e => e.book === book)) {
      out.push('### '+(e.kind === 'thread' ? 'Thread: ' : '')+e.name);
      out.push('<!-- nera-entry: '+JSON.stringify({ id:e.id,draft:e.draft,createdFrom:e.createdFrom,statusSource:e.statusSource ?? null })+' -->');
      if (e.aliases?.length) out.push('aliases: '+e.aliases.join(', '));
      if (e.alwaysLoad) out.push('always load: yes');
      if (e.kind === 'thread') out.push('status: '+e.status);
      out.push('');
      for (const key of SECTION_KEYS[book]) {
        const s = e.sections[key]; if (!s || !s.text && !s.lines.length) continue;
        if (key !== 'text') out.push('#### '+sectionLabel(key,''));
        out.push('<!-- nera-section: '+JSON.stringify({ ...sectionMeta(s,e),unavailable:s.unavailable ?? false,sourceRevision:s.sourceRevision ?? 0 })+' -->');
        if (s.text) out.push(s.text);
        if (s.lines.length) { out.push('Updates:'); for (const l of sortLines(s.lines)) { const stamp = [l.turn != null ? 'T'+l.turn : '',l.when ?? ''].filter(Boolean).join(' · '); out.push('- '+(stamp ? '['+stamp+'] ' : '')+l.text,'<!-- nera-line: '+JSON.stringify(exportLine(l))+' -->'); } }
        out.push('');
      }
    }
  }
  return out.join('\n');
}
export function fromMarkdown(text, { protagonist = '' } = {}) {
  validateInput(text); const source = unfence(text).split('\n'), entries = [], warnings = [], books = []; let book = null, entry = null, key = null, updates = false, metadata = false, prefix = '', story = '';
  const aliases = { characters:['characters','character','people','cast'],locations:['locations','location','places','place'],facts:['world facts','facts','world','lore'],events:['events','events & threads','events and threads','timeline','threads','story'] };
  const warn = (line,reason) => warnings.push({ line,reason });
  for (const [i,line] of source.entries()) {
    const trimmed = line.trim(), bookMatch = trimmed.match(/^##\s+(.+)$/), cardMatch = trimmed.match(/^###\s+(.+)$/), sectionMatch = trimmed.match(/^####\s*(.+)$/);
    if (bookMatch) { book = Object.keys(aliases).find(k => aliases[k].includes(normalizeName(bookMatch[1]))) ?? null; entry = null; if (book) { if (!books.includes(book)) books.push(book); } else warn(i+1,'unknown book; skipped'); continue; }
    if (!book) { if (/^story:/i.test(trimmed)) story = trimmed.replace(/^story:\s*/i,''); continue; }
    if (cardMatch) {
      const heading = cardMatch[1].trim(), timeline = book === 'events' && /^Timeline$/i.test(heading);
      entry = makeEntry(book,book === 'events' ? heading.replace(/^Thread:\s*/i,'') : heading,{ kind:book === 'events' ? timeline ? 'timeline' : 'thread' : 'card',status:book === 'events' && !timeline ? 'open' : null,createdFrom:'import' }); entries.push(entry); key = book === 'characters' || book === 'locations' ? 'notes' : 'text'; updates = false; metadata = true; prefix = ''; continue;
    }
    if (!entry) { if (trimmed) warn(i+1,'no card heading above it'); continue; }
    const provenance = trimmed.match(/^<!-- nera-(entry|section|line): (.*) -->$/);
    if (provenance) { try { const value = JSON.parse(provenance[2]); if (provenance[1] === 'entry') Object.assign(entry,value); else if (provenance[1] === 'section') Object.assign(entry.sections[key],value); else if (entry.sections[key].lines.length) Object.assign(entry.sections[key].lines.at(-1),value); } catch { throw new Error('Invalid provenance metadata at line '+(i+1)); } continue; }
    if (metadata) {
      const m = trimmed.match(/^(aliases|always load|status|name):\s*(.*)$/i);
      if (m) { const prop = m[1].toLowerCase(); if (prop === 'aliases' && ['characters','locations'].includes(book)) entry.aliases = m[2].split(',').map(n => n.trim()).filter(Boolean); if (prop === 'always load') entry.alwaysLoad = /^(yes|true|1)$/i.test(m[2]); if (prop === 'status' && entry.kind === 'thread') entry.status = /^closed$/i.test(m[2]) ? 'closed' : 'open'; continue; }
      metadata = false;
    }
    if (sectionMatch) {
      key = sectionKey(book,sectionMatch[1],protagonist); updates = false; prefix = '';
      if (['characters','locations'].includes(book) && key === 'notes' && !SECTION_MAP[book][normalizeName(sectionMatch[1])]) { prefix = sectionMatch[1]+': '; warn(i+1,'unknown section → Notes'); }
      continue;
    }
    if (/^(?:Updates:|\*\*Updates:\*\*)$/i.test(trimmed)) { updates = true; continue; }
    // Bare timeline bullets are accepted when all text lines are bullets.
    const bareTimeline = entry.kind === 'timeline' && !entry.sections.text.text.trim() && /^[-*]\s+/.test(trimmed);
    if (updates || bareTimeline) {
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        let value = bullet[1], turn = null, when = null; const stamp = value.match(/^\[([^\]]+)\]\s*/);
        if (stamp) { const t = stamp[1].match(/^T(\d+)(?:\s*[·|,]\s*(.*))?$/i); if (t) { turn = Number(t[1]); when = t[2]?.trim() || null; } else when = stamp[1].trim(); value = value.slice(stamp[0].length); }
        if (value.trim()) entry.sections[key].lines.push(importedLine({ text:prefix+value.trim(),turn,when }));
      } else if (/^\s+\S/.test(line) && entry.sections[key].lines.length) entry.sections[key].lines.at(-1).text += ' '+trimmed;
      else if (trimmed) warn(i+1,'update line could not be read');
    } else entry.sections[key].text += (entry.sections[key].text ? '\n' : '')+(trimmed ? prefix+line : '');
  }
  for (const e of entries) for (const s of Object.values(e.sections)) s.text = s.text.trim();
  if (!books.length) throw new Error('This file doesn\'t look like lorebooks. Expected \'## Characters\' style headings (Markdown) or a JSON object with "characters".');
  return { entries,warnings,books,story,format:'md' };
}
export function planImport(existingEntries,parsed,{ mode = 'merge',conflict = 'mine',now = Date.now() } = {}) {
  const writes = [], warnings = [...parsed.warnings], preview = { books:{},conflicts:0,warnings,format:parsed.format };
  const working = structuredClone(existingEntries);
  if (mode === 'replace') { for (const e of existingEntries.filter(e => parsed.books.includes(e.book))) writes.push({ id:e.id,delete:true }); for (let i=working.length-1;i>=0;i--) if (parsed.books.includes(working[i].book)) working.splice(i,1); }
  for (const source of parsed.entries) {
    const names = [source.name,...source.aliases].map(normalizeName);
    const target = working.find(e => e.book === source.book && (source.kind === 'timeline' ? e.kind === 'timeline' : e.kind === source.kind && [e.name,...e.aliases].some(n => names.includes(normalizeName(n)))));
    const stats = preview.books[source.book] ??= { new:0,merged:0,unchanged:0,cards:[],events:0,open:0,closed:0 };
    let result, type;
    if (!target) { result = structuredClone(source); result.id = newLoreId(); result.draft = false; result.createdFrom = 'import'; type = 'new'; working.push(result); }
    else {
      result = target; const before = JSON.stringify(target);
      for (const alias of source.aliases) {
        const clash = working.find(e => e.book === source.book && e.id !== result.id && [e.name,...e.aliases].some(n => normalizeName(n) === normalizeName(alias)));
        if (clash) warnings.push({ line:1,reason:`name already used by ${clash.name}: ${alias}` });
        else if (![result.name,...result.aliases].some(n => normalizeName(n) === normalizeName(alias))) result.aliases.push(alias);
      }
      result.alwaysLoad ||= source.alwaysLoad;
      if (source.status === 'closed') result.status = 'closed';
      for (const [key,s] of Object.entries(source.sections)) {
        const dest = result.sections[key];
        if (s.text && dest.text !== s.text) { if (!dest.text) Object.assign(dest,{ ...s,lines:dest.lines }); else { preview.conflicts++; if (conflict === 'file') Object.assign(dest,{ ...s,lines:dest.lines }); else if (conflict === 'both') { dest.lines.push({ id:newLoreId('ln'),text:s.text,turn:s.cutoff?.turn ?? null,when:s.cutoff?.when ?? null,src:null,by:'import',at:now,origin:s.origin,kind:s.kind,cutoff:s.cutoff }); } } }
        for (const l of s.lines) if (!dest.lines.some(x => normalizeName(x.text) === normalizeName(l.text))) dest.lines.push({ ...l,id:newLoreId('ln') });
      }
      type = before === JSON.stringify(result) ? 'unchanged' : 'merged';
    }
    if (type === 'new') for (const s of Object.values(result.sections)) for (const l of s.lines) Object.assign(l,{ id:newLoreId('ln') });
    stats[type]++; stats.cards.push({ name:result.name,type }); if (result.kind === 'timeline') stats.events += result.sections.text.lines.length; if (result.kind === 'thread') stats[result.status === 'closed' ? 'closed' : 'open']++;
    if (type !== 'unchanged') { const previous = writes.findIndex(w => w.id === result.id && !w.delete); const write = { id:result.id,data:structuredClone(result) }; if (previous >= 0) writes[previous] = write; else writes.push(write); }
  }
  return { preview,writes };
}
