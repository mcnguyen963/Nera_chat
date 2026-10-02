# Memory (optional, per story)

Memory is a browser-only extension to the existing narrator, summary, and chunked history. All five toggles default to off. Missing session settings mean off; the legacy context builder remains intact. Collecting memory notes alone does not change narrator requests.

## Controls

Settings → Memory controls Scene line, Use lorebooks in replies, Automatic memory updates, Memory block near the end, and Cache-friendly window. The four books are Characters, Locations, World facts, and Events & threads. Each book's Use checkbox controls both loading and updates. Budgets and card limits belong to the story. Always-load cards do not count toward the character/location limit. Drafts load normally.

The Lorebooks menu opens the editor even when memory is off. Your text is canon. Updates are appended and ordered by the turn stamped at creation, then client time; lower lines are newer. Personality receives no automatic notes. The protagonist's bond notes go to Notes.

Click Context to view the next request, selection reasons, cuts, the scene, and memory gaps. An open viewer includes the composer draft, debounced by 400 ms. Copy request as text copies every message with role headers.

## Firestore paths

All documents are owner-scoped below `users/{uid}/sessions/{sessionId}`. Existing owner rules cover the new subcollections; no rule or paid Firebase feature is needed.

- Session `memory`: version 1; protagonist; five toggles; book on/budget/maxCards settings; batchTurns (10), lagTurns (4), updateMaxTokens (2000), reorganizeMaxTokens (4000), blockDepth (3), blockRole (`system` or `user`). Numeric values are clamped to the settings ranges. The settings form only writes this map when Memory is saved or changed.
- Session `memoryState`: extractedThroughOrder (null means not started), lastUpdateAt, lastUpdateTurns, failureStreak, paused, lastError. Background work writes dotted fields independently of settings.
- `messageChunks`: existing message shape plus `scene`, the raw hidden scene text or null. Scene edits preserve the content's editedAt. Stored tokenCount remains content plus plan_thread; scene tokens are counted in memory requests.
- `lore/{entryId}`: book, kind (`card`, `timeline`, `thread`), name, aliases, alwaysLoad, draft, status, sections, createdFrom, createdAt, updatedAt. Each section has Your text in `text` and an array of `lines`.
- A line: `{id, text, turn, when, src, by, at}`. `src` is the source assistant order, `turn` the number stamped when written, `by` one of auto/user/import/reorganize, and `at` client milliseconds. Imported undated lines have null stamps. Deleting old messages does not renumber stamps.
- `loreBackups/{backupId}`: reason, label, entries (`{id,data}`), createdIds, createdAt, createdMs, partOf, part. Backups above approximately 800 KB split into parts. The newest 20 groups are retained. Restore itself takes a backup, and deletes cards listed in createdIds.

Cards above 700 KB show a storage warning. Writes above 900 KB are refused, below Firestore's 1 MiB limit. Imports are limited to 2 MiB. Batch writes use at most 450 operations. No streamed token causes a lore write.

## Loading and context budgets

Lore has one collection listener only while memory is enabled or the manager is open. Legacy stories have no lore listeners or per-turn lore reads. The context builder uses the cached entries. Backups are fetched on the Backups screen or when creating/pruning a backup.

Characters load in this order: always, latest user mentions, scene presence. Locations load always, current place, then mentions. World facts and open threads load every turn; closed threads do not. Mentions use accent-sensitive Unicode word boundaries and prefer longer overlapping names. Scene names resolve exactly against names/aliases; places additionally resolve comma components and the longest contained term.

Every request reserves maxResponseTokens within maxContextTokens. The opening exchange and latest user are required. Books fit in facts → events → characters → locations order. User text is never truncated. Update lines are fitted newest first, round-robin, with a 2% book margin and final rendered-token accounting. Events give threads up to two lines before the Timeline. Oversized always-load cards are skipped with a warning.

With the memory block enabled, the plan moves from the first system message into that block. The default system block sits before the last three messages, with the latest user after it. The alternate role prepends `<memory>…</memory>` to the latest user. Blocks never enter stored chat history. Scene history uses `<scene>` before `<plan_thread>` only when Scene line is enabled.

Cache-friendly windows align to absolute N-turn blocks. Character/location caps reserve headroom even when fewer cards load; empty or disabled books reserve nothing. If a whole block cannot fit, the builder falls back to contiguous newest-first history. The viewer reports a gap when unextracted turns fall before the recent window.

## Memory update calls

The background scribe processes one eligible batch after a narrator reply. The newest lag turns are excluded. The source pointer advances only after a successful atomic lore/session batch. Narration plus one background job is the per-turn maximum: a due update wins over auto-summary, and in-flight updates suppress auto-summary. Manual Update now, Catch up, Summarize and Reorganize are explicitly requested calls; Update now and Catch up serialize with updates, and summaries wait for updates to finish. Reorganize may run alongside an update.

Calls use the story's current connection and model, with reasoning disabled and a separate response cap. The transcript contains visible user/story content and AUTHOR NOTE lines, never thinking or hidden plans. Whole-turn prefixes fit within 70% of the extraction input budget; relevant current notes fit within 30%. An oversized single turn fails without advancing.

An update runs detached from the composer and does not control pet phases. Commits wait for narration to finish and compare source ids/orders/content/edit timestamps/scene against their snapshot. Changed sources discard the result. Switching stories preserves the original commit target; status toasts only appear in that story. Logout and deletion abort the work. Three consecutive failures pause updates until Retry.

## Model-facing plain-text formats

Scene: `<scene>DATE · TIME · PLACE · present: NAME, NAME</scene>`. Pipe and spaced-dash separators are accepted. Complete, unclosed, and partial scene tags remain hidden during streaming. The last complete scene is stored; missing scenes fall back to the last previous scene.

Memory updates:

```
T41 [char] Mira | appearance: Burn scar on her left forearm.
[loc] Ashford Inn | state: Upstairs room burned.
[fact] Magic | Fire magic leaves silver scars.
[event] Kael attacked Nera at the inn.
[open] Missing letter | Mira knows who took it.
[closed] Missing letter | Nera recovered it.
NONE
```

Turn prefixes are optional for extraction. Valid synonyms, bullets, and code fences are tolerated. Unknown sections become Notes; automatic personality notes and non-name stoplist terms are rejected. Notes cap at 400 characters and 80 operations per run. Names cap at 60 characters. Aliases conflicting with another card are skipped. Duplicate normalized text is not appended. New people/places/topics become drafts. Closing an unknown thread adds a resolved Timeline event.

Reorganize uses the same line grammar and only the selected names/sections. The preview is editable. It rewrites model/import lines, preserves user lines and Your text, and saves with a backup. Lines arriving after its snapshot survive. Book requests pack whole cards within the input limit; oversized cards send the newest lines with an explicit warning.

## Import and export

Markdown v1 starts with `# Lorebooks`, optional `story:` and `format: nera-lorebooks-md 1`, then `## Characters`, `## Locations`, `## World facts`, `## Events`. `### Name` starts a card; aliases/always load/status metadata precedes its sections. `#### Appearance` and other section headings contain Your text before `Updates:` and bullet lines afterward. Stamps are `[T41 · Day 9, Year 40]`, `[T41]`, a date, or absent. Unknown books are skipped with source-line warnings; unknown sections become Notes. Bare Timeline bullets and indented continuation lines are accepted.

JSON v1 has format `nera-lorebooks`, version 1, optional story and exportedAt, character/location arrays with sections, a facts array, and events `{timeline, threads}`. String sections/lines and an events array are accepted. Unknown keys and missing names produce warnings. JSON is only a user file format, never narrator output.

Import auto-detects after stripping code fences. Add and merge unions aliases, ORs alwaysLoad, deduplicates note text, and lets imported closed status win. Conflicting Your text follows Keep mine / Use the file's / Keep both. Replace affects only books present in the file. Imports take an undo backup and replan against cached live entries after preview. Export and the external-AI prompt follow the device's Markdown/JSON preference. Transcript export includes turn numbers and scenes.

## Device state and verification

`nera.memory.showScene` defaults to 1, `nera.lore.format` to md, and `nera.lore.seen.<sessionId>` stores per-card last-view milliseconds. These are device-only and do not write Firestore.

Run `node --experimental-vm-modules --test tests/*.mjs`. Tests include a captured pre-memory builder fixture, pure modules, mocked updates, and fake-Firestore transactions/backups/copies. Local tests do not verify live provider responses, Firestore billing, or phone layout; follow the plan's desktop/phone manual QA checklist before release.
