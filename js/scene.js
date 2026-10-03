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
export function latestScene(messages, upToOrder = Infinity) {
  let missingStreak = 0;
  for (const m of [...messages].filter(m => m.role === 'assistant' && m.order < upToOrder).sort((a,b) => b.order-a.order)) {
    if (m.scene) return { scene: parseScene(m.scene), fromOrder: m.order, fromId:m.id, missingStreak };
    if (!m.ooc) missingStreak++;
  }
  return { scene: null, fromOrder: null, fromId:null, missingStreak };
}
