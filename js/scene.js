import { prompts, renderPrompt } from './system-prompts.js';
export const SCENE_RULE = (protagonist = '') => renderPrompt(prompts.scene, { PROTAGONIST: protagonist || 'the main character' });
export function isPureOoc(text) { return /^\s*<(?:ad|ooc)>[\s\S]*?<\/(?:ad|ooc)>\s*$/i.test(String(text ?? '')); }
export function extractScene(text) {
  const matches = [...String(text ?? '').matchAll(/<scene>([\s\S]*?)<\/scene>/gi)];
  return matches.length ? matches.at(-1)[1].replace(/\s*\n\s*/g, ' ').trim().slice(0, 300) : null;
}
export function parseScene(raw) {
  raw = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 300);
  const present = [], parts = [];
  for (const s of raw.split(/\s*(?:·|\||\s-\s)\s*/).filter(Boolean)) {
    if (/^present\s*:/i.test(s)) {
      for (const name of s.replace(/^present\s*:\s*/i, '').split(',').map(x => x.trim()).filter(Boolean))
        if (!present.some(x => x.toLowerCase() === name.toLowerCase())) present.push(name);
    } else parts.push(s);
  }
  return { raw, when: parts.length >= 2 ? parts[0] : null, time: parts.length >= 3 ? parts[1] : null, place: (parts.length >= 3 ? parts.slice(2).join(', ') : parts.at(-1)) || null, present };
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
