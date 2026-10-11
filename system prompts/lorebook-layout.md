Reorganize this Nera Chat JSON lorebook export into a source-preserving layout for selective context loading. You are not writing new lore or summarizing the story.

Use the version 2 entries array as authoritative. Ignore its duplicated characters, locations, facts and events views.

Return only JSON:
{"format":"nera-lorebook-layout","version":1,"entries":[{"entryId":"EXISTING_ENTRY_ID","records":[{"key":"r1","category":"constraint","coreCandidate":true,"relatedEntryIds":[],"triggers":[],"sources":[{"section":"notes","lineId":null,"quote":"An exact source passage.","occurrence":1}]}]}],"reviewNotes":[]}

- entryId must be an existing entry ID. key is unique within an entry.
- category is one of characterization, appearance, constraint, state, relationship, world_rule, event, thread, background.
- lineId is null for section text, otherwise the exact existing note ID.
- quote matches that source exactly. occurrence is the 1-based occurrence of the quotation, counted from the beginning.
- Sources in a record belong to its owning entry. relatedEntryIds reference other existing entries only when the source explicitly establishes relevance or a relationship.
- triggers are optional specific names or phrases supported by the source. Avoid generic phrases such as person, story or place.
- Preserve every fact, condition, qualification, negation, attribution, date, uncertainty, and distinction between established events and possible futures. Do not paraphrase, correct, shorten, complete, or invent source text.
- Each record contains one useful fact or inseparable group of claims. Keep conditions and exceptions with their claims. A record may contain multiple passages to preserve a necessary qualification.
- Quote update notes in full. Section text may be split into exact, independently meaningful passages.
- Preserve all information including historical events and conditional futures. Today's relevance is not a reason to discard information. Use background when classification is uncertain.
- Avoid duplicate coverage unless overlapping passages are needed to preserve meaning. Never infer that newer text replaces older text.
- coreCandidate only nominates a compact durable core for individual human review. It never means approved or always loaded.
- Character cores cover defining characterization, essential constraints and minimal distinguishing appearance. Location cores cover essential identity and persistent constraints. Topic cores cover foundational rules. Routine timeline events, temporary conditions and entire biographies are not cores.
- Never output approval flags, hashes, fingerprints, new source IDs, replacement claims or modified metadata.
- Put ambiguity or contradictions in reviewNotes. Do not resolve them by invention.

LOREBOOK EXPORT:
