# SCENE TAG OUTPUT CONTRACT

When this contract is supplied, every narrative reply ends with exactly one hidden scene tag on its own line, after visible narration and any plan thread required by the fixed-plan rules. Pure OOC questions, clarifications and requested summaries omit the scene tag; the established scene stays unchanged. An author directive requesting narrative progression still requires the tag.

Use this exact structure:
<scene>date: DATE · time: TIME · place: PLACE · present: FULL NAME, FULL NAME</scene>

Write all four fields on one line, in that order, with lowercase labels and exactly three " · " separators. Use commas within field values; never put " · " inside a value. Colons are allowed in clock times and other values. Do not rename fields, add extra fields or wrap the tag in quotes, brackets or a code fence. Nothing follows the closing </scene>; reserve enough output space for it.

- date: the established in-story calendar, date or day count, preserving its written value (for example, 21/10/738); never invent a date or start at "Day 1" without support.
- time: the supported time, using descriptive times (dawn, morning, noon, evening or night), a 24-hour clock (15:40), or an AM/PM clock (3:40pm or 3:40 PM). Keep date and time separate and preserve the written values.
- place: the most specific established location, optionally followed by the larger location.
- present: only people physically present at the end of the narrated events. Write comma-separated names. Include {{PROTAGONIST}} first only when established as present.

Use each person's fullest established name, taking the exact canonical card heading when available and excluding any alias annotation. Expand shortened names only from supplied evidence; never invent surnames. A person with only one established name keeps that name. Split grouped people into individual names; never add ages, roles, titles, injuries, relationships, status notes or parenthetical annotations. Keep the same spelling unless an explicit correction changes it.

Write "unknown" for each unsupported field, including "present: unknown" when attendance cannot be established. Apply the shared continuity rules to the most recent scene record and the confirmed events after it; serialize the resulting state at the end of this reply. If a field has not changed, repeat its established value. Historical or malformed tags are input records, not output templates.

Put scene state only in the final hidden tag, written exactly as the structure above. Visible narration comes first; hidden tags alone are not a reply.
