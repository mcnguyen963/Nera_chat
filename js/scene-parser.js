import { stripThinking } from './thinking-text.js';
const aliases = { date:'date',day:'date',calendar:'date',time:'time','time of day':'time',hour:'time',place:'place',location:'place',setting:'place',where:'place',present:'present',characters:'present','characters present':'present','people present':'present',people:'present',attendees:'present',who:'present' };
const unknown = /^(?:unknown|n\/?a|none|[-?]|unclear|unspecified)$/i;
const placeholder = /^(?:DATE|TIME|TIME OF DAY|PLACE|FULL NAME|TBD|\.{3}|…)$/;
function value(raw) {
  let s = String(raw ?? '').trim().replace(/^["'`*\s]+|["'`*\s]+$/g,'').replace(/[.;·•|]+$/g,'').trim();
  if (!s || unknown.test(s)) return 'unknown';
  s = s.replace(/\s*[·•|]\s*/g,', ').replace(/\b\d{1,2}:\d{2}\b/g,m => m.replace(':','\u0001')).replace(/[·•|:]/g,',').replace(/\u0001/g,':');
  return s;
}
export function parseSceneFields(body) {
  const raw = String(body ?? '').trim().replace(/^["'`]+|["'`]+$/g,'').replace(/^scene(?: state)?\s*:\s*/i,'').replace(/\*\*/g,'');
  if (!raw || raw.length > 2000) return null;
  const matches = [...raw.matchAll(/(?:^|[\n·•|;]| - |\.\s+)(\s*[a-z][a-z ]{0,30}?)\s*[:=]\s*/gi)];
  const fields = {}, supplied = [];
  for (let i=0;i<matches.length;i++) {
    const m = matches[i], key = aliases[m[1].trim().toLowerCase()];
    if (!key) continue;
    const text = raw.slice(m.index+m[0].length,matches[i+1]?.index ?? raw.length).trim();
    fields[key] = text; supplied.push(text);
  }
  const positional = text => text.split(/\s*(?:[·•|;]| - )\s*/).filter(Boolean);
  const prefix = matches.length ? raw.slice(0,matches[0].index) : raw;
  if (!Object.keys(fields).length || Object.keys(fields).every(k => k==='present')) {
    const parts = positional(prefix);
    if (parts.length < 3 && !fields.present) return null;
    if (parts.length >= 3) Object.assign(fields,{date:parts[0],time:parts[1],place:parts.slice(2).join(', ')});
  }
  if (!Object.keys(fields).length || supplied.length && supplied.every(x => placeholder.test(x))) return null;
  const present = [];
  for (const name of String(fields.present ?? '').replace(/\([^)]*\)/g,'').split(/[,;&\n]|\band\b/i)) {
    const n = value(name);
    if (n==='unknown' || /^(?:nobody|no one|full name|everyone|\.{3}|…)$/i.test(n)) continue;
    if (!present.some(x => x.toLowerCase()===n.toLowerCase())) present.push(n);
  }
  return {date:value(fields.date),time:value(fields.time),place:value(fields.place),present};
}
export function canonicalFromFields(fields) {
  if (!fields) return null;
  const raw = `date: ${value(fields.date ?? fields.when)} · time: ${value(fields.time)} · place: ${value(fields.place)} · present: ${fields.present?.length ? fields.present.map(value).join(', ') : 'unknown'}`;
  return raw.length <= 2000 ? raw : null;
}
export function canonicalScene(raw) { return canonicalFromFields(parseSceneFields(raw)); }
export function readSceneOutput(content) {
  let text = stripThinking(content), planThread = null;
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g,(all,body) => /<\s*(?:scene|plan_thread)|scene\s*:/i.test(body) ? body : all);
  for (const m of text.matchAll(/<plan_thread\b[^>]*>([\s\S]*?)<\/plan_thread\s*>/gi)) planThread=m[1].trim() || null;
  const original=text,closedSpans=[];
  const candidates = [];
  const add = (raw,index) => { const scene=canonicalScene(raw); if (scene) candidates.push({scene,index}); };
  const pattern = /<(scene(?:[_-](?:state|info))?|scene\s+(?:tag|data)|state)\b[^>]*>([\s\S]*?)<\/\1\s*>|<!--\s*scene\s*:?([\s\S]*?)-->|^\s*\[Scene:\s*([^\n]*)\]\s*$|^\s*\*\*Scene:\*\*\s*([^\n]*)$/gim;
  text = text.replace(pattern,(all,tag,body,comment,bracket,line,index) => { closedSpans.push([index,index+all.length]); add(body ?? comment ?? bracket ?? line,index); return ''; });
  // Preserve candidate ordering even after cleanup changes string lengths.
  const unclosed = /<scene\b[^>]*>([^\n]*)/gi;
  for (const m of original.matchAll(unclosed)) if (!closedSpans.some(([a,b]) => m.index>=a && m.index<b)) add(m[1],m.index);
  text = text.replace(unclosed,(_,body) => parseSceneFields(body) ? '' : body);
  text = text.replace(/<(plan|plan_thread)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<(?:plan|plan_thread)\b[^>]*>[^\n]*/gi,'')
    .replace(/^\s*<\/?(?:div|span|p|section|scene)\s*>\s*$/gim,'')
    .replace(/<!--[\s\S]*?-->/g,'').replace(/```[^\n]*\n\s*```/g,'')
    .replace(/[ \t]+$/gm,'').replace(/ {2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  candidates.sort((a,b) => a.index-b.index);
  return {scene:candidates.at(-1)?.scene ?? null,planThread,clean:text,count:candidates.length,warning:candidates.length > 1 ? 'Several scene tags; the last one was used.' : candidates.length ? null : 'The model omitted a readable scene tag.'};
}
