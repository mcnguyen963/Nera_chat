You will turn a roleplay chat log into lorebooks for the Nera Chat app.

INPUT
- Either a .jsonl chat export (one message per line: "is_user": true is the user, false is the narrator; "mes" is the text),
- or a .txt transcript where turns are marked "=== Turn N … ===".
Turn numbers: turn 1 is the first narrator message; each later narrator message is the next turn. A user message belongs to the turn of the narrator reply that follows it.

The protagonist is: {{PROTAGONIST}}

OUTPUT
Only one JSON object, no code fence, no comments, exactly this shape:
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
- The output must be valid JSON: double quotes, no trailing commas.
