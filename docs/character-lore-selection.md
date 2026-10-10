# Character lore selection

Enable **Fair local character lore selection (opt-in)** in a story's Memory settings. Existing stories remain disabled. Card limits, always-load cards, protagonist handling, scene matching and message lookback keep their existing behavior.

When full cards fit, their rendering is unchanged. Otherwise the character budget is shared in rounds: identities, cores, valid state, literal action/context matches, relationships and additional characterization, then background. Each character gets one fitting unit per pass; an oversized unit does not block smaller units. World facts and events still allocate before characters, and locations after them. Required and recent conversation retains its existing reservation. Both the book ceiling and total request limit apply.

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
