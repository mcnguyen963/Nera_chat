# Character lore selection

Enable **Fair local character lore selection (opt-in)** in a story's Memory settings. Existing stories remain disabled. Both character fitters use the same ranked candidate list, card limits and token budgets. Always-load cards and the protagonist remain exempt from optional card counts.

When full cards fit, their rendering is unchanged. Otherwise the character budget is shared in rounds: identities, cores, valid state, literal action/context matches, relationships and additional characterization, then background. Each character gets one fitting unit per pass; an oversized unit does not block smaller units. World facts and events still allocate before characters, and locations after them. Required and recent conversation retains its existing reservation. Both the book ceiling and total request limit apply.

## Card admission in each lorebook

Each book ranks independently before fitting cards into its budget:

| Book | Highest to lowest priority |
| --- | --- |
| Characters | Always-load, protagonist, present in scene, current input, recent mentions |
| Locations | Always-load, current scene location, current input, recent mentions |
| World facts | Always-load, scene-text mentions, current input, recent mentions, other facts |
| Events & threads | Threads in current input, recently mentioned threads, other open threads, Timeline |

Within a priority group, the newest message wins, then its last recognized name or alias occurrence, then stable card ID. User and narrator messages have equal weight; repeated mentions add no weight. Scene-present characters use this same mention evidence, so the order of the scene's present list does not decide admission. Unmentioned facts and open threads use newest lore-note timestamps, then stable ID. Mentioned closed threads remain closed and eligible. Timeline keeps its special detail allocation.

Character and location card limits apply after ranking. World facts and events have token budgets without additional card limits. Oversized candidates may be skipped so smaller cards fit. Ranking determines admission; admitted cards continue sharing detail tokens through their existing allocation rules. Reports attach per-book rank, priority reason and latest mention evidence to loaded and excluded candidates, distinguishing card limits from token budgets.

## Review a compact core

Open the context viewer, expand **Character coverage**, and choose **Review core sources**. The same controls are available in the character editor.

1. Pick a source section or note. For section text, select a passage in the source textarea, or include the complete source. Notes are always included whole.
2. Add related passages to the same bundle. Include identity-defining personality, essential behavior/capability constraints, and minimal distinguishing appearance. Keep conditions, negations, attribution and uncertainty alongside their claims. For example, obedience must not imply affection, and childhood-dependent development must retain its dependency on actual childhood events.
3. Mark which kinds of coverage the bundle provides, explicitly review it, approve it, and save the references.

A bundle is indivisible, including when considered later as optional detail. Overlapping bundles carry their connected sources together. References contain source locations and fingerprints, never generated summaries. Edits to the complete referenced section or note, moved/deleted notes, changed provenance, reorganization and unavailable evidence require review again. Remove a stale reference and select its current sources to create a fresh reviewed bundle. Review cannot make stale evidence eligible for a request.

Without valid reviewed cores, complete personality and appearance sections can serve as fallback units. Missing coverage is reported; no personality, appearance or constraint is inferred. If the budget is too small, identities or cores may be omitted, and the report says so.

## Inspect a request

The context viewer shows identity/core coverage, exact included and omitted source passages, and selection reasons. Optional details rank by distinct current-input matches, recent-context matches, author preference, then recency; stable source identifiers break ties. Matching is local, literal and Unicode-aware. Repeated words and generic words add no extra matches, and a character's own names do not make every note relevant. Conditional text keeps its source wording and chronology.

**Last sent request** captures the report and exact request body at serialization, separately from the next-request preview. Draft edits and refreshed previews cannot replace it. This snapshot is local to the current open story and clears on story switch or page reload. Selection reasons and core metadata are never included in provider messages. No extra model calls are made.

## Management and portability

Updated Memory update/Reorganize defaults preserve constraints, qualifications, attribution, history and pending possibilities. Automatic updates still exclude personality changes. Reorganize still protects author text and author-written notes. Conversion templates keep evidenced characterization compact, preserve future conditions and resolved status, and cannot generate or approve core-reference metadata. Note formats, section names, turn stamps and the 400-character limit remain compatible.

Saved management prompts remain unchanged. Use the existing reset/edit controls to adopt updated defaults. JSON and Markdown exports retain reviewed references. Copies and backups preserve them when their sources remain unchanged; imports that change source IDs, content or provenance retain stale references for review instead of silently approving them.

Local tests validate allocation, persistence, prompt construction and mocked serialized requests. They do not establish narrator compliance or live provider/Firebase behavior.
