import { CONTINUITY_RULE, sectionMeta, cutoffLabel } from './continuity.js';
import { computeTurns, formatTurnsTranscript } from './turns.js';
import { buildLoreIndex, findMentions, resolveScene, fitBook, renderEntry } from './lore-select.js';
import { parseScene } from './scene.js';
export const DEFAULT_MEMORY_EXTRACTION_PROMPT = `You keep the memory notes for an ongoing story. Read the NEW TURNS and write down only new, lasting information that the CURRENT NOTES do not already say.

Write one note per line, in exactly one of these forms:
[char] NAME | SECTION: note
[loc] NAME | SECTION: note
[fact] TOPIC | note
[event] note
[open] THREAD TITLE | note
[closed] THREAD TITLE | how it ended

Every line MUST start with a valid source turn from NEW TURNS, for example:
T41 [char] Mira | appearance: burn scar on her left forearm from Kael's fire spell

Character sections:
- appearance: how they look now (injuries, clothes that matter, changes)
- status: health, where they are, job, important possessions
- bond: their relationship with {{PROTAGONIST}}
- relations: their relationship with another character (name that character)
- alias: another name or title they are called
- notes: anything else worth remembering
Location sections: description, state (what changed: damage, owners, danger), alias, notes.

Rules:
- Only add what changed or was revealed in these turns. Skip anything already in the notes.
- For anyone or anything already known, use the exact NAME, TOPIC or THREAD TITLE from KNOWN NAMES.
- A new character or place gets the name the story uses most.
- Never write personality notes; the author writes personality.
- One short, concrete fact per line. No guesses or long quotes. Preserve intentions and attempts as intentions and attempts; preserve beliefs and accounts with their speaker, never convert them into events.
- [event]: an important story event worth remembering much later — what happened, and to whom.
- [open]: a new unresolved goal, promise, mystery or threat, or progress on an open one. [closed]: an open thread that was resolved.
- AUTHOR NOTE lines are the author speaking; facts they state are true.
- No headings, no bullets, no explanations, no JSON.
- If nothing new happened, write exactly: NONE`;
export const DEFAULT_MEMORY_REORGANIZE_PROMPT = `You tidy up memory notes for a story. Each NOTE has the author's own text (canon; never repeat or change it) and update lines in time order, where source turns establish order and attribution; only explicit corrections or scoped events change state.

Rewrite the update lines of each note into the shortest list that still says everything that is true now:
- Preserve all input lines and qualifiers; merge only equivalent claims with the same attribution. Never turn a belief into truth, or an intended or attempted action into a completed one.
- Merge lines that say the same thing.
- Keep names, numbers and dates exact. Do not invent anything.
- Keep everything the author's text does not already say. Never restate the author's text.
- Keep each line in its section. Follow the EXTRA INSTRUCTION if there is one.
- Start every line with the turn of the newest line it keeps.

Write only lines in exactly these forms, one per line, nothing else:
T41 [char] NAME | SECTION: note
T41 [loc] NAME | SECTION: note
T41 [fact] TOPIC | note
T41 [event] note
T41 [open] THREAD TITLE | note
Use only the NAMES, TOPICS and THREAD TITLES given in the notes.`;
export function fillProtagonist(text, protagonist) { return String(text).replaceAll('{{PROTAGONIST}}', protagonist || 'the main character'); }
const TEMPLATE_INTRO = `You will turn a roleplay chat log into lorebooks for the Nera Chat app.

INPUT
- Either a .jsonl chat export (one message per line: "is_user": true is the user, false is the narrator; "mes" is the text),
- or a .txt transcript where turns are marked "=== Turn N … ===".
Turn numbers: turn 1 is the first narrator message; each later narrator message is the next turn. A user message belongs to the turn of the narrator reply that follows it.

The protagonist is: {{PROTAGONIST}}

OUTPUT
`;
export const LOREBOOK_TEMPLATE_MD = TEMPLATE_INTRO + `One Markdown document in EXACTLY this format, with nothing before or after it:

# Lorebooks

## Characters

### <Name>
aliases: <other names, comma separated — leave this line out if none>
always load: yes   ← only for the protagonist and constant companions; otherwise leave this line out

#### Personality
<stable personality, 1–4 sentences>

#### Appearance
<how they look now, 1–3 sentences>
Updates:
- [T<turn> · <in-story date>] <a change over time, one per line, oldest first>

#### Status
<health, whereabouts, job, important possessions>

#### Bond
<their relationship with {{PROTAGONIST}} now>
Updates:
- [T<turn> · <date>] <how it changed>

#### Relations
<relationships with other characters, by name>

#### Notes
<anything else important>

## Locations

### <Name>
aliases: <optional>

#### Description
<what it is like>

#### State
<what changed: damage, owners, danger>

## World facts

### <Topic, e.g. Magic, Calendar, Politics>
<one rule of the world per line>

## Events

### Timeline
Updates:
- [T<turn> · <date>] <one important event per line, oldest first>

### Thread: <short title of an unresolved goal, promise, mystery or threat>
status: open
<what it is about>
Updates:
- [T<turn> · <date>] <progress>

RULES
- Lines under "Updates:" are in source-turn order; keep attribution, qualifiers and scope.
- Put lasting truths in the text above "Updates:"; put changes over time in Updates.
- Use the story's own date when it gives one (e.g. "Day 9, Year 40"); otherwise write only the turn, like [T41].
- Only include what the chat actually says. Do not invent.
- Leave out empty sections. Keep lines short and concrete.
- Include every named character and place that matters.
- Use "status: closed" for threads that were resolved.`;
export const LOREBOOK_TEMPLATE_JSON = TEMPLATE_INTRO + `Only one JSON object, no code fence, no comments, exactly this shape:
{
  "format": "nera-lorebooks",
  "version": 1,
  "characters": [
    {
      "name": "<Name>",
      "aliases": ["<other name>"],
      "alwaysLoad": false,
      "sections": {
        "personality": { "text": "<stable personality>" },
        "appearance":  { "text": "<look now>", "lines": [ { "text": "<change>", "turn": 41, "when": "<in-story date or omit>" } ] },
        "status":      { "text": "<health, whereabouts, job, possessions>" },
        "bond":        { "text": "<relationship with {{PROTAGONIST}} now>", "lines": [] },
        "relations":   { "text": "<relationships with other characters, by name>" },
        "notes":       { "text": "<anything else>" }
      }
    }
  ],
  "locations": [
    { "name": "<Name>", "aliases": [], "sections": { "description": { "text": "" }, "state": { "text": "", "lines": [] } } }
  ],
  "facts": [
    { "name": "<Topic>", "text": "<one rule per line>", "lines": [] }
  ],
  "events": {
    "timeline": { "lines": [ { "text": "<important event>", "turn": 12, "when": "<date>" } ] },
    "threads": [ { "title": "<unresolved goal, promise, mystery or threat>", "status": "open", "text": "<what it is about>", "lines": [] } ]
  }
}

RULES
- "lines" are in time order, oldest first; later lines are newer.
- Put lasting truths in "text"; put changes over time in "lines".
- "alwaysLoad": true only for the protagonist and constant companions.
- Use the story's own date in "when" when it gives one; otherwise leave "when" out.
- Only include what the chat actually says. Do not invent.
- Leave out empty sections. Keep lines short and concrete.
- Use "status": "closed" for resolved threads.
- The output must be valid JSON: double quotes, no trailing commas.`;
export async function buildExtractionMessages({ settings, mem, entries, messages, range, count }) {
  const prompt = fillProtagonist(settings.memoryExtractionPrompt || DEFAULT_MEMORY_EXTRACTION_PROMPT, mem.protagonist)+"\n\n"+CONTINUITY_RULE+"\nEvery note requires a valid T<number> from NEW TURNS. Output NONE alone if there are no notes.";
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
  const known = ['KNOWN NAMES (reuse these exactly)'];
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
      if (section.text) lines.push(`${key} — section text (${sectionMeta(section,e).kind}, ${cutoffLabel(sectionMeta(section,e).cutoff)}, do not repeat): ${section.text}`);
      const canonLines = section.userCanon ?? section.lines.filter(l => l.by === 'user');
      if (canonLines.length) lines.push(key+' — user lines (canon, do not repeat): '+canonLines.map(l => l.text).join('; '));
      lines.push(key+' — lines, oldest first:');
      for (const ln of section.lines.filter(l => l.by !== 'user').sort((a,b) => (a.turn??0)-(b.turn??0)||a.at-b.at)) lines.push(`T${ln.turn ?? 0} ${ln.text}`);
    }
  }
  return [{ role:'system', content:(settings.memoryReorganizePrompt || DEFAULT_MEMORY_REORGANIZE_PROMPT)+'\n\n'+CONTINUITY_RULE }, { role:'user', content:lines.join('\n') }];
}
