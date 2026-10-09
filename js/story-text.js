import { stripPlan } from "./plan-parser.js";
import { stripThinking } from "./thinking-text.js";
export { stripThinking };
export function storyText(text) {
  return stripPlan(stripThinking(text));
}

// Provenance stamps are render-only: never alter the stored summary or lore.
export function stripTurnStamps(text) {
  const stamp = String.raw`T\d{1,5}(?:\s*[–-]\s*T?\d{1,5})?`;
  const group = String.raw`(?:${stamp}[,;\s]*)+`;
  const preposition = String.raw`\b(?:[Aa][Tt]|[Oo][Nn]|[Ii][Nn]|[Ss][Ii][Nn][Cc][Ee]|[Bb][Yy]|[Ff][Rr][Oo][Mm]|[Uu][Nn][Tt][Ii][Ll]|[Aa][Ff][Tt][Ee][Rr]|[Bb][Ee][Ff][Oo][Rr][Ee]|[Dd][Uu][Rr][Ii][Nn][Gg]|[Aa][Rr][Oo][Uu][Nn][Dd])\s+`;
  return text.split('\n').map(line => {
    let cleaned = line
      .replace(new RegExp(String.raw`\(\s*${group}\)|\[\s*${group}\]`, 'g'), '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, bracket => bracket.replace(new RegExp(String.raw`\b${stamp}\s*·\s*`, 'g'), ''))
      .replace(new RegExp(String.raw`(?:${preposition})?\b${stamp}\b\s*[,;:]?\s*(\p{Ll})?`, 'gu'), (match,next,offset,source) => next ? (/(?:^|[.!?])\s*$/.test(source.slice(0,offset)) ? next.toUpperCase() : next) : '')
      .replace(/([\[(]\s*)Turn\s+\d+\s*[:·]?\s*/g, '$1')
      .replace(/^\s*Turn\s+\d+\b\s*[:·]?\s*|\bTurn\s+\d+\s*[:·]\s*/g, '');
    if (cleaned === line) return line;
    cleaned = cleaned.replace(/ {2,}/g, ' ').replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').trim();
    return cleaned.replace(/^([\p{Ll}])/u, letter => letter.toUpperCase());
  }).join('\n');
}
