import { prompts, renderPrompt } from './system-prompts.js';
export const MAX_SCENE_LENGTH = 2000;
export const SCENE_RULE = (protagonist = '') => renderPrompt(prompts.scene, { PROTAGONIST: protagonist || 'the main character' });
export function normalizeSceneLine(raw) {
  const text = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (text.length > MAX_SCENE_LENGTH) throw new Error(`The scene line exceeds ${MAX_SCENE_LENGTH} characters. Shorten it before saving.`);
  return text || null;
}
export function isPureOoc(text) {
  if (/^\s*(?:OOC\s*:|\[OOC\])/i.test(String(text ?? ''))) return true;
  const match = String(text ?? '').match(/^\s*<(ad|ooc)>([\s\S]*?)<\/\1>\s*$/i);
  if (!match) return false;
  if (match[1].toLowerCase() === 'ooc') return true;
  const body = match[2].trim();
  // AD is an author directive, not an OOC classification. Freeze state only for
  // explicit OOC requests or recognizable information-only questions/summaries.
  // Arbitrary mixed-language intent cannot be inferred reliably; <ooc> is explicit.
  if (/\b(?:then|and)\s+(?:continue|advance|narrate|play|resume)\b/i.test(body)) return false;
  if (/^OOC\s*:|\b(?:answer|respond)\s+(?:in\s+)?OOC\b/i.test(body)) return true;
  return /^(?:who|what|when|where|why|how|which)\b/i.test(body)
    || /^(?:can|could|would|should|is|are|do|does|did|was|were|has|have)\b[\s\S]*\?\s*$/i.test(body)
    || /^(?:summari[sz]e|give(?:\s+me)?\s+(?:a\s+)?summary)\b/i.test(body);
}
export function extractScene(text) {
  const matches = [...String(text ?? '').matchAll(/<scene>([\s\S]*?)<\/scene>/gi)];
  if (!matches.length) return null;
  try { return normalizeSceneLine(matches.at(-1)[1]); } catch { return null; }
}
// Fresh model output must follow the current contract. Historical scene records
// still use the tolerant parser below, including the earlier positional format.
export function inspectSceneOutput(text) {
  text = String(text ?? '');
  const matches = [...text.matchAll(/<scene>([\s\S]*?)<\/scene>/gi)];
  const invalid = warning => ({ scene:null,warning });
  if (!matches.length) return invalid('The model omitted the scene tag.');
  if (matches.length !== 1) return invalid('The model returned multiple scene tags.');
  const match = matches[0], raw = match[1];
  const before = text.slice(0,match.index), after = text.slice(match.index+match[0].length);
  if (!match[0].startsWith('<scene>') || !match[0].endsWith('</scene>') || after.trim()
    || before.split('\n').at(-1).trim() || (before.match(/```/g)?.length ?? 0)%2) {
    return invalid('The scene tag must be the final line, outside a code block.');
  }
  if (!/^date: [^:\r\n·]+ · time: [^:\r\n·]+ · place: [^:\r\n·]+ · present: [^:\r\n·]+$/.test(raw)
    || raw.split(' · ').some(field => !field.slice(field.indexOf(':')+1).trim())) {
    return invalid('The scene tag does not follow the date, time, place and present format.');
  }
  try { return { scene:normalizeSceneLine(raw),warning:null }; }
  catch (error) { return invalid(error.message); }
}
export function parseScene(raw) {
  raw = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const present = [], parts = [], fields = {};
  const separator = /^(?:date|time|place)\s*:/i.test(raw) && raw.includes('·')
    ? /\s*·\s*/ : /\s*(?:·|\||\s-\s)\s*/;
  for (const s of raw.split(separator).filter(Boolean)) {
    if (/^present\s*:/i.test(s)) {
      for (const name of s.replace(/^present\s*:\s*/i, '').split(',').map(x => x.trim()).filter(Boolean))
        if (!/^unknown$/i.test(name) && !present.some(x => x.toLowerCase() === name.toLowerCase())) present.push(name);
    } else {
      const labeled = s.match(/^(date|time|place)\s*:\s*(.*)$/i);
      if (labeled) fields[labeled[1].toLowerCase()] = labeled[2];
      else parts.push(s);
    }
  }
  const known = value => value?.trim() && !/^unknown$/i.test(value.trim()) ? value.trim() : null;
  const labeled = Object.keys(fields).length > 0;
  return { raw, when:known(labeled ? fields.date : parts.length >= 2 ? parts[0] : null),
    time:known(labeled ? fields.time : parts.length >= 3 ? parts[1] : null),
    place:known(labeled ? fields.place : parts.length >= 3 ? parts.slice(2).join(', ') : parts.at(-1)), present };
}
export function formatSceneForDisplay(raw) { return String(raw ?? '').replace(/present\s*:\s*/i, ''); }
export function latestScene(messages, upToOrder = Infinity, startingScene = null) {
  let missingStreak = 0;
  for (const m of [...messages].filter(m => m.role === 'assistant' && m.order < upToOrder).sort((a,b) => b.order-a.order)) {
    if (m.scene && m.acceptance !== 'pending' && m.acceptance !== 'rejected') {
      const carried = m.sceneMeta?.kind === 'carried';
      return { scene:parseScene(m.scene),fromOrder:carried ? m.sceneMeta.fromOrder : m.order,
        fromId:carried ? m.sceneMeta.fromId : m.id,kind:m.sceneMeta?.kind ?? 'declared',
        missingStreak:missingStreak+(carried ? m.sceneMeta.missingStreak ?? 1 : 0) };
    }
    if (!m.ooc) missingStreak++;
  }
  if (startingScene) return { scene:parseScene(startingScene),fromOrder:0,fromId:null,kind:'seed',missingStreak };
  return { scene: null, fromOrder: null, fromId:null, missingStreak };
}

export function sceneLine({ date, when, time, place, present }) {
  const value = text => String(text ?? '').trim() || 'unknown';
  const raw = `date: ${value(date ?? when)} · time: ${value(time)} · place: ${value(place)} · present: ${present?.length ? present.join(', ') : 'unknown'}`;
  const result = inspectSceneOutput('<scene>'+raw+'</scene>');
  if (!result.scene) throw new Error(result.warning);
  return result.scene;
}

export function carryScene(prior) {
  return { scene:prior?.scene?.raw ?? null,sceneMeta:{ kind:'carried',stale:true,
    fromOrder:prior?.fromOrder ?? null,fromId:prior?.fromId ?? null,missingStreak:(prior?.missingStreak ?? 0)+1 } };
}

// Only text outside metadata is evidence. This is a conservative lexical check,
// not proof that narrated events are true or that an earlier action caused them.
export function validateSceneValues(raw, { narration = '', userText = '', prior = null } = {}) {
  const parsed = parseScene(raw), warnings = [], provenance = {};
  const narrative = String(narration).replace(/<(?:scene|plan|plan_thread)>[\s\S]*?<\/(?:scene|plan|plan_thread)>/gi,'').replace(/["“][\s\S]*?["”]/g,'');
  const normalized = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  const supports = (text,needle) => {
    text = normalized(text);
    const at = needle ? text.indexOf(needle) : -1;
    return at >= 0 && !/[\p{L}\p{N}]/u.test(text[at-1] ?? '') && !/[\p{L}\p{N}]/u.test(text[at+needle.length] ?? '');
  };
  for (const [key,field] of [['date','when'],['time','time']]) {
    const value = parsed[field];
    const needle = normalized(value);
    if (!value) provenance[key] = 'unknown';
    else if (normalized(prior?.[field]) === needle) provenance[key] = 'prior';
    else if (supports(userText,needle)) provenance[key] = 'user';
    else if (supports(narrative,needle)) provenance[key] = 'narration';
    else { parsed[field] = null;provenance[key] = 'unknown';warnings.push(`Unsupported scene ${key} was stored as unknown.`); }
  }
  return { scene:sceneLine(parsed),sceneMeta:{ kind:'declared',stale:false,provenance },warnings };
}
