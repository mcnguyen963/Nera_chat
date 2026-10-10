import {stripThinking} from './thinking-text.js';
import { evidenceFor, revisionOf, noteNeedsReview } from './continuity.js';
import { computeTurns } from './turns.js';
import { latestScene } from './scene.js';
export const STOPLIST = new Set('he she they him her them i you me we it someone somebody man woman boy girl guard the a narrator user unknown'.split(' '));
export const COMMON_ALIAS_WORDS = new Set('captain guard old lady lord man woman girl boy'.split(' '));
export function normalizeName(s) { return String(s ?? '').normalize('NFC').toLowerCase().replace(/[‘’]/g,"'").replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’.,;:!?]+$/g, '').trim(); }
export function duplicateCards(entries) {
  const names=new Map(),ids=new Set();
  for(const e of entries)for(const n of new Set([e.name,...(e.aliases ?? [])].map(normalizeName).filter(Boolean))){const key=e.book+':'+n;const previous=names.get(key);if(previous && previous!==e.id){ids.add(e.id);ids.add(previous);}else names.set(key,e.id);}
  const timelines=entries.filter(e=>e.kind==='timeline');if(timelines.length>1)for(const e of timelines)ids.add(e.id);
  return ids;
}
export const SECTION_MAP = {
  characters: { appearance:'appearance', looks:'appearance', look:'appearance', status:'status', state:'status', condition:'status', health:'status', bond:'bond', relationship:'bond', relations:'relations', relationships:'relations', alias:'alias', aka:'alias', 'also called':'alias', name:'alias', notes:'notes', note:'notes', other:'notes', personality:'personality', traits:'personality' },
  locations: { description:'description', look:'description', appearance:'description', state:'state', status:'state', condition:'state', alias:'alias', aka:'alias', 'also called':'alias', notes:'notes', note:'notes' },
};
export const SECTION_KEYS = { characters:['personality','appearance','status','bond','relations','notes'], locations:['description','state','notes'], facts:['text'], events:['text'] };
export function sectionKey(book, value, protagonist = '') {
  const name = normalizeName(value);
  if (book === 'characters' && /^(bond with |relation(?:ship)? with )/.test(name)) return normalizeName(name.replace(/^(?:bond|relation(?:ship)?) with /,'')) === normalizeName(protagonist)  ? 'bond' : 'relations';
  return SECTION_MAP[book]?.[name] ?? (book === 'facts' || book === 'events' ? 'text' : 'notes');
}
export function newLoreId(prefix = 'lore') { return prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10); }
export function makeEntry(book, name, extra = {}) {
  return { id:newLoreId(), book, kind:'card', name, aliases:[], alwaysLoad:false, draft:false, status:null, sections:Object.fromEntries(SECTION_KEYS[book].map(k => [k,{ text:'',lines:[],origin:extra.createdFrom === 'import' ? 'import' : 'user',kind:extra.createdFrom === 'import' ? 'background' : 'canon',cutoff:null }])), createdFrom:'user', ...extra };
}
export function parseMemoryLines(text,ctx={}) {
  const ops=[],skipped=[],adjusted=[],info=[];let sawNone=false;
  const tags={char:'char',character:'char',characters:'char',chars:'char',chr:'char',loc:'loc',location:'loc',locations:'loc',place:'loc',places:'loc',fact:'fact',facts:'fact',world:'fact',event:'event',events:'event',open:'open',thread:'open',threads:'open',opened:'open',closed:'closed',close:'closed',resolved:'closed'};
  const assistants=ctx.range?.assistants ?? [],turns=computeTurns(ctx.messages ?? []);
  for(const [i,source] of stripThinking(text).split(/\r?\n/).entries()) {
    const line=source.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/,'').replace(/`|\*\*|__/g,'').replace(/[｜│∣]/g,'|').trim();
    const skip=reason=>skipped.push({line:i+1,text:source,reason});
    if(!line || /^```/.test(line))continue;
    if(/^(?:none|no new notes?|nothing new)\.?$/i.test(line)){sawNone=true;continue;}
    if(/^#{1,6}\s|^Here are (?:the )?notes:?$/i.test(line)){info.push('heading ignored');continue;}
    const m=line.match(/^(?:\[?\s*(?:T|Turn\s*)(\d+)(?:\s*[-–]\s*(?:T|Turn\s*)?(\d+))?\s*\]?\s*:?\s*)?\[\s*([A-Za-z ]+?)\s*\]\s*(.*)$/i);
    if(!m){skip('not a note');continue;}
    let tag=tags[m[3].toLowerCase()];if(!tag){skip('unknown tag');continue;}
    const book=tag==='char'?'characters':tag==='loc'?'locations':tag==='fact'?'facts':'events';
    if(ctx.mem?.books?.[book]?.on===false){skip('book off');continue;}
    let body=m[4],name,value,section='text';
    if(tag==='event' || (tag==='open' && /^Timeline\s*[|:]/i.test(body))){tag='event';name='Timeline';value=body.replace(/^(?:Timeline\s*)?[|:]\s*/i,'');}
    else if(tag==='fact' && !body.includes('|')){name='General';value=body;}
    else if(body.includes('|')){const at=body.indexOf('|');name=body.slice(0,at);value=body.slice(at+1);}
    else if(['open','closed'].includes(tag)) {const at=body.search(/:| [—-] /);name=at<0?body:body.slice(0,at);value=at<0?'':body.slice(at).replace(/^(?::| [—-] )\s*/,'');}
    else {const match=body.match(/^([^:]+):\s*([^:]+):\s*(.*)$/);if(!match || !SECTION_MAP[book]?.[normalizeName(match[2])]){skip('missing separator');continue;}name=match[1];value=match[2]+': '+match[3];}
    name=name.trim().replace(/^["'“”[\]]+|["'“”[\]]+$/g,'');
    if(!name || name.length>60 || STOPLIST.has(normalizeName(name)) || normalizeName(name).length<2){skip('not a valid name');continue;}
    if(book==='characters' || book==='locations') {
      value=value.trim();
      const label=value.match(/^(.+?)(?::| [—-] )\s*(.*)$/);
      if(label) {
        const relation=label[1].match(/^(?:bond|relation(?:ship)?) with (.+)$/i);
        if(relation){section=normalizeName(relation[1])===normalizeName(ctx.protagonist ?? ctx.mem?.protagonist)?'bond':'relations';value=section==='relations'?relation[1]+': '+label[2]:label[2];}
        else if(SECTION_MAP[book]?.[normalizeName(label[1])] || /^(?:aliases|also known as)$/i.test(label[1])){section=/^(?:aliases|also known as)$/i.test(label[1])?'alias':sectionKey(book,label[1]);value=label[2];}
        else section='notes';
      } else section='notes';
      if(section==='personality' && !ctx.allowPersonality){skip('personality is written by you');continue;}
    }
    value=value.trim();
    if(section==='alias' && (normalizeName(value).length<2 || normalizeName(value).split(' ').every(w=>STOPLIST.has(w)))){skip('not a valid alias');continue;}
    if((!value && !['open','closed'].includes(tag)) || value.length>400){skip('empty or oversized note');continue;}
    if(ops.length>=80){info.push('too many notes; first 80 kept');continue;}
    let turn=Math.max(Number(m[1]),Number(m[2] ?? m[1])),startTurn=Math.min(Number(m[1]),Number(m[2] ?? m[1])),assistant,evidence=[],original=null;
    const declaredStart=startTurn,declaredTurn=turn;
    if(ctx.reorganize) {
      const entry=ctx.entries?.find(e=>[e.name,...(e.aliases ?? [])].some(n=>normalizeName(n)===normalizeName(name)));
      const candidates=entry?.sections?.[section]?.lines ?? [];
      original=[...candidates].filter(l=>(l.turn ?? 0)===turn).at(-1) ?? [...candidates].filter(l=>(l.turn ?? 0)<=turn).sort((a,b)=>a.at-b.at).at(-1) ?? [...candidates].sort((a,b)=>a.at-b.at).at(-1);
      if(!original){skip('invalid source turn');continue;}
      name=entry.name;assistant={turn:original.turn,order:original.src};evidence=original.evidence ?? [];
    } else {
      if(m[1] && (startTurn<(ctx.range?.fromTurn ?? startTurn) || turn>(ctx.range?.toTurn ?? turn)))info.push('turn out of range');
      if(m[1]){if(startTurn>turn)[startTurn,turn]=[turn,startTurn];startTurn=Math.max(ctx.range?.fromTurn ?? startTurn,startTurn);turn=Math.min(ctx.range?.toTurn ?? turn,turn);if(startTurn>turn){startTurn=ctx.range?.fromTurn;turn=ctx.range?.toTurn;}}
      assistant=assistants.find(a=>a.turn===turn);
      if(!m[1] || !assistant){turn=ctx.range?.toTurn ?? assistants.at(-1)?.turn;startTurn=ctx.range?.fromTurn ?? turn;assistant=assistants.find(a=>a.turn===turn);info.push(m[1]?'turn out of range':'turn missing');}
      if(!assistant){skip('missing source evidence');continue;}
      if(m[1] && (startTurn!==declaredStart || assistant.turn!==declaredTurn))adjusted.push({line:i+1,text:source,card:name,reason:'adjusted: turn '+(declaredStart===declaredTurn ? 'T'+declaredTurn : 'T'+declaredStart+'–T'+declaredTurn)+' → '+(startTurn===assistant.turn ? 'T'+assistant.turn : 'T'+startTurn+'–T'+assistant.turn)});
      evidence=evidenceFor((ctx.messages ?? []).filter(m=>m.role!=='summary' && turns.turnById.get(m.id)>=startTurn && turns.turnById.get(m.id)<=turn));
    }
    const when=original?.when ?? latestScene(ctx.messages ?? [],assistant.order+1).scene?.when ?? null;
    ops.push({tag,book,name,section,text:value,turn:assistant.turn,when,src:assistant.order,evidence,sourceRevision:original?.sourceRevision,line:i+1});
  }
  if(sawNone && ops.length)info.push('NONE ignored because notes were present');
  return {ops,skipped,adjusted,info,sawNone,valid:ops.length>0 || sawNone && !skipped.some(s=>s.reason!=='not a note')};
}
export function applyOps(entries, ops, stampCtx = {}) {
  const working = structuredClone(entries), creates = [], appends = [], statusChanges = [], aliases = [], skipped = [];
  const match = (book,name) => {const matches=working.filter(e => e.book === book && [e.name,...(e.aliases ?? [])].some(n => normalizeName(n) === normalizeName(name)));if(matches.length>1)throw Object.assign(new Error('Duplicate cards match '+name+'. Open Lorebooks → Duplicate review and choose the surviving card before retrying memory extraction.'),{code:'duplicate-lore'});return matches[0];};
  const timeline=()=>{const cards=working.filter(e=>e.kind==='timeline');if(cards.length>1)throw Object.assign(new Error('Duplicate timeline cards. Open Lorebooks → Duplicate review and choose the surviving card before retrying memory extraction.'),{code:'duplicate-lore'});return cards[0];};
  const now = stampCtx.now ?? Date.now();
  for (const op of ops) {
    if (stampCtx.mem?.books?.[op.book]?.on === false) { skipped.push({ ...op, reason:'book off' }); continue; }
    let e = op.tag === 'event' ? timeline() : match(op.book,op.name);
    if (stampCtx.reorganize && (!e || stampCtx.allowedIds && !stampCtx.allowedIds.includes(e.id))) { skipped.push({ ...op, reason:'name outside the notes' }); continue; }
    let text = op.text;
    if (op.tag === 'closed' && (!e || e.kind !== 'thread' || e.status === 'closed')) { e = timeline(); text = `Resolved: ${op.name} — ${text}`; }
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
      if(!(e.aliases ?? []).some(n=>normalizeName(n)===normalizeName(text))){(e.aliases ??= []).push(text);aliases.push({entryId:e.id,alias:text});}
      continue;
    }
    const s = e.sections[section];
    if (!s) { skipped.push({ ...op, reason:'unknown section' }); continue; }
    if ((op.tag === 'open' || op.tag === 'closed') && e.kind === 'thread') { e.status = op.tag === 'closed' ? 'closed' : 'open'; statusChanges.push({ entryId:e.id, status:e.status }); }
    if (!stampCtx.reorganize && s.lines.some(l=>normalizeName(l.text)===normalizeName(text) && !l.needsReview && !noteNeedsReview(l,stampCtx.messages ?? [],stampCtx.session ?? {})))continue;
    if(!text)continue;
    const original = stampCtx.reorganize ? [...(entries.find(x => x.id === e.id)?.sections[section]?.lines ?? [])].filter(l => l.turn === op.turn).sort((a,b) => a.at-b.at).at(-1) : null;
    const ln = { id:newLoreId('ln'), text, turn:op.turn, when:original?.when ?? op.when, src:original?.src ?? op.src, by:stampCtx.reorganize ? 'reorganize' : 'auto',at:now,evidence:op.evidence ?? [],sourceRevision:op.sourceRevision ?? stampCtx.sourceRevision ?? 0 };
    if (new TextEncoder().encode(JSON.stringify(e)).length + new TextEncoder().encode(JSON.stringify(ln)).length > 900000) { skipped.push({ ...op, reason:'card storage full' }); continue; }
    s.lines.push(ln);
    if ((op.tag === 'open' || op.tag === 'closed') && e.kind === 'thread') { e.statusSource = ln; const status = statusChanges.findLast(c => c.entryId === e.id); if (status) status.source = ln; }
    if (!creates.includes(e)) appends.push({ entryId:e.id, section, line:ln });
  }
  return { creates, appends, aliases, statusChanges, skipped, entries:working };
}
