import { prompts, renderPrompt } from './system-prompts.js';
import { CONTINUITY_RULE, sectionMeta, cutoffLabel } from './continuity.js';
import { computeTurns, formatTurnsTranscript } from './turns.js';
import { buildLoreIndex, findMentions, resolveScene, fitBook, renderEntry } from './lore-select.js';
import { parseScene } from './scene.js';
export const DEFAULT_MEMORY_EXTRACTION_PROMPT = prompts.memoryExtraction;
export const DEFAULT_MEMORY_REORGANIZE_PROMPT = prompts.memoryReorganize;
export function fillProtagonist(text, protagonist) { return String(text).replaceAll('{{PROTAGONIST}}', protagonist || 'the main character'); }
export const LOREBOOK_TEMPLATE_MD = prompts.lorebookMarkdown;
export const LOREBOOK_TEMPLATE_JSON = prompts.lorebookJson;
export async function buildExtractionMessages({ settings, mem, entries, messages, range, count }) {
  const prompt = fillProtagonist(settings.memoryExtractionPrompt || DEFAULT_MEMORY_EXTRACTION_PROMPT, mem.protagonist)+"\n\n"+CONTINUITY_RULE+"\n"+prompts.memoryExtractionOutput;
  const inputBudget = settings.maxContextTokens - mem.updateMaxTokens - await count(prompt) - 500;
  const turns = computeTurns(messages);
  let fitted = null;
  for (const assistant of range.assistants) {
    const candidate = { ...range, endOrder: assistant.order, toTurn: assistant.turn, assistants: range.assistants.filter(a => a.order <= assistant.order), messages: range.messages.filter(m => m.order <= assistant.order) };
    if (await count(formatTurnsTranscript(messages, turns, { range: candidate })) > inputBudget * .7) break;
    fitted = candidate;
  }
  if (!fitted) throw new Error('One turn is too long for a memory update. Raise Max context tokens.');
  const transcript = formatTurnsTranscript(messages, turns, { range: fitted });
  const index = buildLoreIndex(entries), ids = new Set();
  for (const book of ['characters', 'locations']) for (const id of findMentions(transcript, index, book)) ids.add(id);
  for (const m of fitted.messages.filter(m => m.scene)) {
    const resolved = resolveScene(parseScene(m.scene), index);
    for (const id of resolved.characters) ids.add(id);
    if (resolved.place) ids.add(resolved.place);
  }
  const known = [prompts.knownNamesHeader];
  for (const [book, label] of [['characters','Characters'],['locations','Locations'],['facts','Fact topics'],['events','Open threads']])
    known.push(label+': '+entries.filter(e => e.book === book && (book !== 'events' || e.kind === 'thread' && e.status !== 'closed')).map(e => e.name+(e.aliases?.length ? ' ('+e.aliases.join(', ')+')' : '')+(e.draft ? ' [draft]' : '')).join('; '));
  const fixed = `PROTAGONIST: ${mem.protagonist || 'the main character'}\n\n${known.join('\n')}\n\nCURRENT NOTES ABOUT THE PEOPLE AND PLACES IN THESE TURNS\n\nNEW TURNS ${fitted.fromTurn}–${fitted.toTurn}\n${transcript}`;
  if (await count(fixed) > inputBudget) throw new Error('Known names and turns exceed the memory update input budget.');
  const notes = await fitBook(entries.filter(e => ids.has(e.id) || e.book === 'facts' || e.book === 'events' && e.kind === 'thread').map(entry => ({ entry, reason: 'mentioned' })), Math.max(0, Math.min(inputBudget * .3, inputBudget - await count(fixed))), count, { protagonist: mem.protagonist });
  const content = fixed.replace('\n\nNEW TURNS', '\n'+notes.included.map(e => renderEntry(e.entry, e.lineIds, mem.protagonist)).join('\n')+'\n\nNEW TURNS');
  if (await count(content)+await count(prompt)+24 > settings.maxContextTokens-mem.updateMaxTokens) throw new Error('Memory update input exceeds the context budget.');
  return { messages: [{ role:'system', content:prompt }, { role:'user', content }], range: fitted };
}
export function buildReorganizeMessages({ settings, mem, entries, sections, instruction = '' }) {
  const lines = [`PROTAGONIST: ${mem.protagonist || 'the main character'}`];
  if (instruction.trim()) lines.push('EXTRA INSTRUCTION: '+instruction.trim());
  for (const e of entries) {
    const tag = e.book === 'characters' ? 'char' : e.book === 'locations' ? 'loc' : e.book === 'facts' ? 'fact' : e.kind === 'timeline' ? 'event' : 'open';
    lines.push(`\nNOTE [${tag}] ${e.name}`);
    for (const [key, section] of Object.entries(e.sections)) {
      if (sections && !sections[e.id]?.includes(key)) continue;
      if (section.text) lines.push(renderPrompt(prompts.reorganizeSection, { SECTION: key, KIND: sectionMeta(section,e).kind, CUTOFF: cutoffLabel(sectionMeta(section,e).cutoff), TEXT: section.text }));
      const canonLines = section.userCanon ?? section.lines.filter(l => l.by === 'user');
      if (canonLines.length) lines.push(renderPrompt(prompts.reorganizeCanon, { SECTION: key, TEXT: canonLines.map(l => l.text).join('; ') }));
      lines.push(key+' — lines, oldest first:');
      for (const ln of section.lines.filter(l => l.by !== 'user').sort((a,b) => (a.turn??0)-(b.turn??0)||a.at-b.at)) lines.push(`T${ln.turn ?? 0} ${ln.text}`);
    }
  }
  return [{ role:'system', content:(settings.memoryReorganizePrompt || DEFAULT_MEMORY_REORGANIZE_PROMPT)+'\n\n'+CONTINUITY_RULE }, { role:'user', content:lines.join('\n') }];
}
