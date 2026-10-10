const escapeContent=t=>String(t).split('\n').map(l=>/^(?:\\|#|Updates:|<!-- nera-)/.test(l)?'\\'+l:l).join('\n');
import { cardFingerprint } from './lore-card-state.js';
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
export function normalizeLoreEntry(e){
      if(!e || typeof e!=='object' || !SECTION_KEYS[e.book] || typeof e.name!=='string' || !e.name.trim())throw new Error('Invalid version 2 lorebook entry.');
      const normalized={...makeEntry(e.book,e.name),...e,id:typeof e.id==='string' && e.id && !e.id.includes('/') && !/^__.*__$|^\.{1,2}$/.test(e.id) ? e.id : newLoreId(),aliases:Array.isArray(e.aliases)?e.aliases:[],kind:e.kind ?? (e.book==='events' ? e.name==='Timeline' ? 'timeline' : 'thread' : 'card')};
      normalized.sections=Object.fromEntries(SECTION_KEYS[e.book].map(key=>{
        const raw=e.sections?.[key],section=typeof raw==='string' ? {text:raw} : raw ?? {};
        if(section.lines!=null && !Array.isArray(section.lines))throw new Error('Invalid version 2 section.');
        return [key,{...section,text:String(section.text ?? ''),...sectionMeta({...section,kind:section.kind ?? 'background',origin:section.origin ?? 'import'},normalized),lines:(section.lines ?? []).map(l=>typeof l==='string' ? importedLine(l) : {...importedLine(l),...l})}];
      }));return normalized;
}

export function fromJson(text) {
  validateInput(text); const source = unfence(text); let data;
  try { data = JSON.parse(source); } catch (e) { const p = Number(e.message.match(/position (\d+)/)?.[1]); if (Number.isFinite(p)) { const before = source.slice(0,p), line = before.split('\n').length, column = before.length-(before.lastIndexOf('\n')+1)+1; throw new Error(`JSON error at line ${line}, column ${column}: ${e.message}`); } throw new Error('JSON error: '+e.message); }
  if (!data || typeof data !== 'object' || !['characters','locations','facts','events'].some(k => k in data)) throw new Error('This file doesn\'t look like lorebooks. Expected \'## Characters\' style headings (Markdown) or a JSON object with "characters".');
  if(data.version===2 && Array.isArray(data.entries)) {
    const entries=data.entries.map(normalizeLoreEntry);
    return {entries,warnings:[],books:Object.keys(BOOK_LABELS).filter(k=>k in data || entries.some(e=>e.book===k)),story:data.story ?? '',format:'json'};
  }
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
export function toMarkdown(entries, { title = '', books = Object.keys(BOOK_LABELS), includeEmpty = false } = {}) {
  const out = ['# Lorebooks','story: '+title,'format: nera-lorebooks-md 2',''];
  for (const book of books) {
    out.push('## '+(book === 'events' ? 'Events' : BOOK_LABELS[book]),'');
    for (const e of entries.filter(e => e.book === book)) {
      out.push('### '+(e.kind === 'thread' ? 'Thread: ' : '')+e.name);
      out.push('<!-- nera-entry: '+JSON.stringify({ id:e.id,draft:e.draft,createdFrom:e.createdFrom,...(e.statusSource ? {statusSource:e.statusSource} : {}),...(e.createdAt ? {createdAt:e.createdAt} : {}),...(e.updatedAt ? {updatedAt:e.updatedAt} : {}) })+' -->');
      if (e.aliases?.length) out.push('aliases: '+JSON.stringify(e.aliases));
      if (e.alwaysLoad) out.push('always load: yes');
      if (e.kind === 'thread') out.push('status: '+e.status);
      out.push('');
      for (const key of SECTION_KEYS[book]) {
        const s = e.sections[key]; if (!s || !includeEmpty && !s.text && !s.lines.length) continue;
        if (key !== 'text') out.push('#### '+(key==='bond' ? 'Bond' : sectionLabel(key,'')));
        out.push('<!-- nera-section: '+JSON.stringify({ ...sectionMeta(s,e),...(s.unavailable!=null ? {unavailable:s.unavailable} : {}),...(s.sourceRevision!=null ? {sourceRevision:s.sourceRevision} : {}) })+' -->');
        if (s.text) out.push(escapeContent(s.text));
        if (s.lines.length) { out.push('Updates:'); for (const l of sortLines(s.lines)) { const stamp = [l.turn != null ? 'T'+l.turn : '',l.when ?? ''].filter(Boolean).join(' · '); out.push('- '+(stamp ? '['+stamp+'] ' : '')+String(l.text).split('\n').map((v,i)=>(i?'  ':'')+escapeContent(v)).join('\n'),'<!-- nera-line: '+JSON.stringify(exportLine(l))+' -->'); } }
        out.push('');
      }
    }
  }
  return out.join('\n');
}
export function fromMarkdown(text, { protagonist = '', strictFields = false } = {}) {
  validateInput(text); const source = unfence(text).split('\n'), entries = [], warnings = [], books = []; const noteMetadata = new Map(); let book = null, entry = null, key = null, updates = false, metadata = false, prefix = '', story = '';
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
    if (provenance) {
      try {
        const value = JSON.parse(provenance[2]);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        if (provenance[1] === 'entry') {
          for (const prop of ['id','draft','createdFrom','statusSource','createdAt','updatedAt']) if (prop in value) entry[prop] = value[prop];
        } else if (provenance[1] === 'section') {
          for (const prop of ['origin','kind','cutoff','unavailable','sourceRevision']) if (prop in value) entry.sections[key][prop] = value[prop];
        } else if (entry.sections[key].lines.length && !noteMetadata.has(entry.sections[key].lines.at(-1))) noteMetadata.set(entry.sections[key].lines.at(-1),value);
      } catch { throw new Error('Invalid provenance metadata at line '+(i+1)); }
      continue;
    }
    if (metadata) {
      const m = trimmed.match(/^(aliases|always load|status|name):\s*(.*)$/i);
      if (m) { const prop = m[1].toLowerCase(); if(strictFields && prop==='status' && !/^(open|closed)$/i.test(m[2]))throw new Error('Thread status must be open or closed.');if(strictFields && prop==='always load' && !/^(yes|no|true|false|1|0)$/i.test(m[2]))throw new Error('Always load must be yes or no.'); if (prop === 'aliases') entry.aliases = m[2].startsWith('[') ? JSON.parse(m[2]) : m[2].split(',').map(n => n.trim()).filter(Boolean); if (prop === 'always load') entry.alwaysLoad = /^(yes|true|1)$/i.test(m[2]); if (prop === 'status' && entry.kind === 'thread') entry.status = /^closed$/i.test(m[2]) ? 'closed' : 'open'; continue; }
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
        if (value.trim()) entry.sections[key].lines.push(importedLine({ text:prefix+(value.startsWith('\\')?value.slice(1):value).trim(),turn,when }));
      } else if (/^\s+\S/.test(line) && entry.sections[key].lines.length) entry.sections[key].lines.at(-1).text += (/^format: nera-(?:lorebooks|lore-card)-md /m.test(unfence(text)) ? '\n' : ' ')+(trimmed.startsWith('\\') ? trimmed.slice(1) : trimmed);
      else if (trimmed) warn(i+1,'update line could not be read');
    } else entry.sections[key].text += (entry.sections[key].text ? '\n' : '')+(trimmed ? prefix+(line.startsWith('\\')?line.slice(1):line) : '');
  }
  for (const e of entries) for (const s of Object.values(e.sections)) {
    s.text = s.text.trim();
    for (const line of s.lines) {
      const saved = noteMetadata.get(line);
      if (!saved) { line.by = 'user'; continue; }
      const visible = { text:line.text,turn:line.turn,when:line.when };
      const unchanged = saved.text === visible.text && (saved.turn ?? null) === visible.turn && (saved.when ?? null) === visible.when;
      Object.assign(line,saved,visible);
      if (!unchanged) Object.assign(line,{by:'user',at:Date.now(),src:null,evidence:[],sourceRevision:0,needsReview:false,kind:'canon',origin:'user',cutoff:null});
    }
  }
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

// Single-card files have one authoritative entry; book exports remain supported.
export function serializeCard(entry,{format='md',storyId=null,title='',now=new Date()}={}) {
  validateCard(entry);
  if (format === 'json') return JSON.stringify({format:'nera-lore-card',version:1,sourceStoryId:storyId,story:title,exportedAt:now.toISOString(),entry},null,2);
  let text=toMarkdown([entry],{title,books:[entry.book],includeEmpty:true});
  text=text.replace('format: nera-lorebooks-md 2','format: nera-lore-card-md 1\n<!-- nera-card: '+JSON.stringify({sourceStoryId:storyId,exportedAt:now.toISOString()})+' -->');
  // Empty sections are explicit so deleting a section and clearing one both replace it with empty text.
  return text;
}
export function validateCard(entry) {
  if (!entry || !SECTION_KEYS[entry.book] || typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('A card needs a supported book and a name.');
  if (entry.book === 'events' ? !['timeline','thread'].includes(entry.kind) : entry.kind !== 'card') throw new Error('Unsupported card kind.');
  if (!Array.isArray(entry.aliases) || entry.aliases.some(a=>typeof a!=='string')) throw new Error('Aliases must be a list of names.');
  for (const key of ['alwaysLoad','draft']) if (entry[key]!=null && typeof entry[key]!=='boolean') throw new Error(key+' must be true or false.');
  if (entry.kind==='thread' && !['open','closed'].includes(entry.status)) throw new Error('Thread status must be open or closed.');
  const ids=new Set();
  for (const [key,s] of Object.entries(entry.sections ?? {})) {
    if (!SECTION_KEYS[entry.book].includes(key)) throw new Error('Unsupported section: '+key);
    if (!s || typeof s.text!=='string' || !Array.isArray(s.lines)) throw new Error('Invalid section: '+key);
    if (s.kind!=null && !['canon','background','snapshot'].includes(s.kind)) throw new Error('Invalid section provenance.');
    for (const l of s.lines) {
      if (!l || typeof l.id!=='string' || !l.id || ids.has(l.id)) throw new Error('Note IDs must be nonempty and unique in the card.');
      ids.add(l.id);
      if (typeof l.text!=='string' || !l.text.trim() || l.turn!=null && (!Number.isSafeInteger(l.turn) || l.turn<0) || l.when!=null && typeof l.when!=='string') throw new Error('Invalid note text, date or turn stamp.');
      if (l.evidence!=null && !Array.isArray(l.evidence)) throw new Error('Invalid note evidence.');
    }
  }
  if (new TextEncoder().encode(JSON.stringify(entry)).length>900000) throw new Error('This card exceeds the card storage limit (900 KB).');
  return entry;
}
function supportedCardFields(entry,warnings) {
  const pick=(obj,allowed,label)=>Object.fromEntries(Object.entries(obj).filter(([key])=>{
    if(allowed.includes(key))return true;
    warnings.push({line:1,reason:`ignored unsupported field '${key}' in ${label}`});return false;
  }));
  const out=pick(entry,['id','book','kind','name','aliases','alwaysLoad','draft','status','sections','createdFrom','createdAt','updatedAt','statusSource'],'card');
  const note=l=>pick(l,['id','text','turn','when','src','by','at','evidence','sourceRevision','needsReview','origin','kind','cutoff'],'note');
  out.sections=Object.fromEntries(Object.entries(out.sections).map(([key,s])=>[key,{...pick(s,['text','lines','origin','kind','cutoff','unavailable','sourceRevision'],key),lines:s.lines.map(note)}]));
  if(out.statusSource)out.statusSource=note(out.statusSource);
  return out;
}
export function parseCard(text,options={}) {
  validateInput(text);
  let parsed,sourceStoryId=null;
  if (detectFormat(text)==='json') {
    let data;try {data=JSON.parse(unfence(text));} catch {throw new Error('Invalid JSON.');}
    if (data.format==='nera-lore-card') {
      if (data.version!==1 || !data.entry || data.entries) throw new Error('Expected one version 1 nera-lore-card entry.');
      // Validate before normalization so unsupported fields cannot silently disappear.
      validateCard(data.entry);
      parsed={entries:[normalizeLoreEntry(data.entry)],warnings:[],format:'json',books:[data.entry.book]};sourceStoryId=data.sourceStoryId ?? null;
    } else {parsed=fromJson(text);sourceStoryId=data.sourceStoryId ?? null;if(data.version!==2 && data.events && !Array.isArray(data.events) && !('timeline' in data.events))parsed.entries=parsed.entries.filter(e=>e.kind!=='timeline');}
  } else {
    parsed=fromMarkdown(text,{...options,strictFields:true});
    const meta=unfence(text).match(/^<!-- nera-card: (.*) -->$/m);
    if(meta) {try {sourceStoryId=JSON.parse(meta[1]).sourceStoryId ?? null;} catch {throw new Error('Invalid card provenance.');}}
  }
  if (parsed.entries.length!==1) throw new Error('Import exactly one card. Use Import & export for a whole lorebook or multiple cards.');
  validateCard(parsed.entries[0]);
  if(sourceStoryId!=null && typeof sourceStoryId!=='string')throw new Error('Invalid source story ID.');
  const entry=supportedCardFields(parsed.entries[0],parsed.warnings);
  return {...parsed,entries:[entry],entry,sourceStoryId};
}
export function suggestCardDestination(entries,parsed,storyId) {
  const source=parsed.entry,compatible=entries.filter(e=>e.book===source.book && e.kind===source.kind);
  if (parsed.sourceStoryId && parsed.sourceStoryId===storyId) {
    const same=compatible.find(e=>e.id===source.id);if(same)return {matches:[same],suggestedId:same.id};
  }
  const names=[source.name,...source.aliases].map(normalizeName);
  const matches=compatible.filter(e=>[e.name,...(e.aliases ?? [])].some(n=>names.includes(normalizeName(n))));
  return {matches,suggestedId:matches.length===1 ? matches[0].id : null};
}
const noteEqual=(a,b)=>a.text===b.text && (a.turn ?? null)===(b.turn ?? null) && (a.when ?? null)===(b.when ?? null);
const authored=(l,now)=>({...l,by:'user',at:now,src:null,evidence:[],sourceRevision:0,needsReview:false,origin:'user',kind:'canon',cutoff:null});
export function planCardImport(entries,parsed,{targetId=null,storyId=null,mode='replace',conflict='file',now=Date.now(),loreRevision=0}={}) {
  if(!['replace','merge'].includes(mode) || !['file','mine','both'].includes(conflict))throw new Error('Choose a supported import mode and conflict choice.');
  const target=targetId ? entries.find(e=>e.id===targetId) : null;
  if(targetId && !target)throw new Error('This card was deleted. Refresh the preview.');
  const source=structuredClone(parsed.entry);validateCard(source);
  if(target && (target.book!==source.book || target.kind!==source.kind))throw new Error('The file and destination must have the same book and card kind.');
  if(!target && source.kind==='timeline' && entries.some(e=>e.kind==='timeline'))throw new Error('A Timeline already exists. Choose Update existing card.');
  const sameStory=!!parsed.sourceStoryId && parsed.sourceStoryId===storyId;
  if(!sameStory) {
    source.statusSource=null;
    for(const s of Object.values(source.sections)) {
      s.cutoff=null;s.sourceRevision=0;s.unavailable=false;
      if(s.kind==='snapshot')s.kind='background';
      for(const l of s.lines) {Object.assign(l,{src:null,evidence:[],sourceRevision:0,needsReview:false,cutoff:null});if(l.kind==='snapshot')l.kind='background';if(l.by!=='user')l.by='import';}
    }
  }
  const result=target ? structuredClone(target) : makeEntry(source.book,source.name,{kind:source.kind,createdFrom:'import'});
  for(const prop of ['name','alwaysLoad','draft','status'])result[prop]=source[prop];
  result.statusSource=null;
  result.aliases=mode==='merge' && target ? [...new Map([...target.aliases,...source.aliases].map(n=>[normalizeName(n),n])).values()] : source.aliases;
  const changes=[],notes={added:[],edited:[],removed:[]};
  const targetNotes=new Map(Object.values(target?.sections ?? {}).flatMap(s=>s.lines).map(l=>[l.id,l]));
  const incomingSections=new Map(Object.entries(source.sections).flatMap(([key,s])=>s.lines.map(l=>[l.id,key])));
  for(const prop of ['name','aliases','alwaysLoad','draft','status'])if(cardFingerprint(target?.[prop] ?? null)!==cardFingerprint(result[prop]))changes.push({field:prop,before:target?.[prop] ?? null,after:result[prop]});
  for(const key of SECTION_KEYS[source.book]) {
    const incoming=source.sections[key],before=target?.sections[key] ?? makeEntry(source.book,'empty').sections[key];
    const next=incoming ? structuredClone(incoming) : {...before,text:'',lines:[],origin:'import',kind:'background',cutoff:null};
    const choice=mode==='merge' && target && before.text && before.text!==next.text ? conflict : 'file';
    if(mode==='merge' && target && (!next.text || choice==='mine'))Object.assign(next,{...before,lines:next.lines});
    if(mode==='merge' && target && incoming?.text && choice==='both')next.text=before.text.endsWith('\n\n'+incoming.text) ? before.text : before.text+'\n\n'+incoming.text;
    if(target && before.text!==next.text)Object.assign(next,{origin:'user',kind:'canon',cutoff:null,unavailable:false,sourceRevision:0});
    const lines=mode==='merge' ? structuredClone(before.lines.filter(l=>!sameStory || !incomingSections.has(l.id) || incomingSections.get(l.id)===key)) : [];
    for(const imported of incoming?.lines ?? []) {
      const matching=sameStory ? targetNotes.get(imported.id) : null;
      const identical=before.lines.find(l=>noteEqual(l,imported));
      let line=matching && noteEqual(matching,imported) ? structuredClone(matching) : matching ? authored({...imported,id:matching.id},now) : identical ? structuredClone(identical) : {...imported,id:newLoreId('ln')};
      if(!matching && !identical && target && sameStory)line=authored(line,now);
      if(!target)line.id=newLoreId('ln');
      const i=lines.findIndex(l=>l.id===line.id || noteEqual(l,line));
      if(i>=0)lines[i]=line;else lines.push(line);
    }
    next.lines=lines;result.sections[key]=next;
    if(before.text!==next.text)changes.push({field:key,before:before.text,after:next.text});
    if(cardFingerprint(sectionMeta(before,target))!==cardFingerprint(sectionMeta(next,result)))changes.push({field:key+' provenance',before:sectionMeta(before,target),after:sectionMeta(next,result)});
    for(const l of lines) {const old=before.lines.find(n=>n.id===l.id);if(!old)notes.added.push({section:key,...l});else if(!noteEqual(old,l))notes.edited.push({section:key,before:old,...l});}
    for(const l of before.lines)if(!lines.some(n=>n.id===l.id))notes.removed.push({section:key,...l});
  }
  const statusEvidence=sameStory ? source.statusSource ?? (mode==='merge' && source.status===target?.status ? target?.statusSource : null) : null;
  if(statusEvidence){const kept=Object.values(result.sections).flatMap(s=>s.lines).find(l=>l.id===statusEvidence.id && noteEqual(l,statusEvidence) && l.by!=='user');if(kept)result.statusSource=structuredClone(kept);}
  validateCard(result);
  return {id:result.id,data:result,expected:target ? cardFingerprint(target) : null,loreRevision,mode,preview:{destination:target?.name ?? 'Create new card',changes,notes,warnings:parsed.warnings ?? []}};
}
