You will turn a roleplay chat log into lorebooks for the Nera Chat app.

INPUT
- Either a .jsonl chat export (one message per line: "is_user": true is the user, false is the narrator; "mes" is the text),
- or a .txt transcript where turns are marked "=== Turn N … ===".
Turn numbers: turn 1 is the first narrator message; each later narrator message is the next turn. A user message belongs to the turn of the narrator reply that follows it.

The protagonist is: {{PROTAGONIST}}

OUTPUT
One Markdown document in EXACTLY this format, with nothing before or after it:

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
- Use "status: closed" for threads that were resolved.

- Keep defining characterization and identifying appearance compact for user review, using only evidenced traits. Preserve essential behavioral/capability constraints, authority, character independence, knowledge boundaries and consequential relationship history. Obedience alone does not establish affection.
- Separate played events from plans, invitations, predictions and open possibilities. Retain every conditional trajectory, including dependencies on actual childhood events; never invent traits or outcomes or convert a possible future into an established fact.
- Preserve evidence and attribution, uncertainty, source-turn stamps, dates and resolved-thread status. Do not reopen resolved events. Keep durable information even when it is irrelevant to the current scene.
- Keep each update note under 400 characters. Split only into independently meaningful notes, with conditions and negations accompanying the claims they qualify.
- Never generate or approve core-reference metadata. Keep the existing section names and output format exactly.
