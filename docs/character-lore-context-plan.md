# Character lore context selection: requirements and implementation plan

Status: proposed for review; implementation has not started.

## Goal and scope

When the user permits eight character cards and eight characters are selected, distribute the available character token budget across those eight characters before spending it on less important detail. Load essential personality and appearance, then useful state, relationships, and action-relevant facts. Explain the choices in the app.

Eight is an example, not a new limit. Preserve the user's configured card limit, character budget, input limit, and recent-history priority. Do not bypass or reinterpret the card limit. This feature adds no LLM requests, including embeddings, summarization, classification, or reranking calls.

Initial scope is character cards. Keep location, world-fact, event, memory-extraction, and summary behavior unchanged except for reserving the character core's token space during shared-budget allocation, described below. Implement phase by phase after review of this plan.

## Requirements review

| Requirement | Planned behavior |
| --- | --- |
| Cover all selected characters | Allocate names and reviewed cores across the selected set before optional expansion. Selection still obeys the existing card limit. |
| Filter unimportant details | Rank complete lore units locally; omit lower-priority units when the budget is exhausted. |
| Keep personality and appearance available | Support user-reviewed core selections from those sections, without automatically inventing or summarizing traits. |
| Use relevance | Match the current input, current scene, and configured recent-message lookback using deterministic text matching. |
| No more LLM requests | Selection runs on already available data in JavaScript. It does not invoke existing maintenance calls. |
| Minimize changes to narrator handling | Keep existing headings, section labels, roles, insertion positions, continuity instructions, and provider settings. Do not send scores or selection explanations to the narrator. |
| Explain why details were chosen | Show source text, section, reason, matched terms, token cost, and omission reason in the Context viewer. |
| Preserve lore | Selecting context never modifies stored section text or notes. User edits to selection preferences are separate metadata. |
| Honor configured limits | Never enlarge budgets, remove recent conversation to fund lore, or silently increase card count. |
| Review before implementation | This document is the deliverable for this task. Implementation requires a subsequent instruction. |

Changing supplied facts can change narration. Preserving the request format reduces unnecessary changes; it cannot guarantee identical model behavior after filtering.

## What the code currently does

- `js/lore-select.js::selectEntries()` determines eligible character cards from always-load flags, protagonist, scene attendees, current mentions, and recent mentions, then applies the existing card cap.
- `fitBook()` treats each selected card's section text as an indivisible base. It tries those bases in card order, skipping bases that cannot fit.
- After bases fit, individual notes are added across included cards. User-written notes have priority, followed by newer notes. Notes are not ranked by relevance to the current action.
- `js/memory-context.js` preserves required context and a recent-message target before fitting optional lore. It currently allocates facts and events before characters and locations.
- `js/continuity.js::usableLore()` filters unavailable snapshots and stale/unverified notes before selection. New selection logic must use that filtered data.
- The existing Context viewer reports loaded cards, budget exclusions, and omitted note counts. It does not explain individual relevance decisions or omitted section text.
- Section and note provenance already exist. `js/lore-format.js` has explicit single-card field allowlists, and `js/lore-store.js` explicitly merges editable card fields. New metadata must be supported there, not merely added to the editor.

The issue is token allocation among permitted cards, not changing the user's card count.

## Recommended selection policy

### Priority order for review

| Tier | Content | Reason |
| --- | --- | --- |
| 1 | Canonical name and reviewed core personality/appearance for every selected character | Everyone should remain identifiable and retain defining characterization. |
| 2 | User-protected essential constraints and valid current-state units | Prevent losing facts needed to depict a character correctly. |
| 3 | Details directly matched to the current action or question | An older poison-resistance fact can matter more than recent unrelated notes. |
| 4 | Relevant bond and relationships | Guide reactions toward the protagonist and other selected characters. |
| 5 | Further personality, appearance, and recent state detail | Add depth after shared coverage and relevant information. |
| 6 | Remaining history and miscellaneous notes | Use spare capacity for background. |

Explicit protected units take precedence over automatically scored details. Appearance-related questions promote appearance details; relationship questions promote relationship details. Promotions affect optional expansion, not the core reserved for other characters.

Protection is an allocation preference, not permission to exceed the budget or bypass evidence validation. Any protected unit that cannot fit must be reported explicitly.

### Complete units and reviewed cores

Use existing note lines as atomic units. Treat section text as an atomic unit unless the user has approved an exact excerpt from it. Do not split arbitrary prose automatically: one sentence may depend on a negation, condition, list, or explanation elsewhere in the paragraph.

Add optional per-card selection metadata containing:

- Core references, grouped under existing sections.
- Protected references for essential facts.
- Optional topic terms associated with specific references.
- A metadata version and source fingerprints.

References identify the section and either a note ID or reviewed excerpt of section text. Excerpts must be exact source text, not generated summaries. A fingerprint verifies that the source and its relevant provenance have not changed since review. The implementation should use a shared resolver for preview and sending.

If the source changes, is deleted, is excluded by `usableLore()`, or lies beyond a regeneration cutoff, the reference becomes unavailable and needs review. It must never revive stale lore or retain an old copied excerpt silently. Reorganizing notes may invalidate references; do not automatically attach them to a vaguely similar replacement note.

For a card without reviewed cores, short complete personality/appearance sections can be candidates, but must be labeled as unreviewed coverage. Do not silently choose the first sentence as its personality. If a section cannot fit, include identity when possible and report missing core coverage. Existing cards do not require a bulk migration or automatic rewrite.

### Deterministic relevance

Implement a pure local module, provisionally `js/lore-relevance.js`, operating on filtered lore units and an immutable request snapshot.

1. Normalize Unicode, capitalization, and whitespace for matching while preserving original output text.
2. Use bounded words/phrases, canonical names, explicit aliases, and available scene entities. Do not weaken name disambiguation or treat common words as character names.
3. Rank by priority tier first, then current-input phrase/topic matches, scene/relationship matches, recent-message matches, existing authorship preference, and recency. Break remaining ties with stable IDs.
4. Prefer specific matching terms over frequent generic words. Repeated occurrences of the same word must not dominate the ranking.
5. Use a small, editable local topic map for explicit equivalents such as `poison`/`toxin`. Unknown topics use literal matching; report only actual matching evidence.
6. Use section identity for broad prompts such as asking about appearance, including when no specific appearance keyword appears in the notes.
7. On weak or absent relevance matches, fall back to section priority and existing note ordering. Do not treat a zero score as proof that a fact is unimportant.

Start with explainable lexical/topic matching. No external model, remote embedding service, or downloaded inference model is needed. Cache indexes by card content and policy fingerprints; invalidate them after edits. Avoid network reads per note or per preview.

The selector cannot reliably infer arbitrary synonyms, implied motives, or contradictory facts from prose. Keep chronology/provenance checks authoritative. Do not claim that recency alone proves a status has superseded another, and do not automatically delete contradictions.

### Budget allocation

1. Apply existing lore eligibility and card selection, including the user's card limit.
2. Cost required context and the existing recent-conversation target using the current request accountant.
3. Compute the character pool from the user's character budget and remaining overall input space, including headings and message framing.
4. Reserve a minimal identity tier across all selected characters, then allocate reviewed cores fairly across them. No character receives optional depth while another still has a fitting core unit waiting.
5. Reserve that fitted character coverage against optional facts/events allocation. Preserve their output positions and existing per-book limits. This changes allocation priority under overall pressure, not message ordering.
6. Allocate protected units and optional details in tiered rounds. Within a tier, use relevance ranking while rotating across characters so the first character cannot consume the entire pool.
7. If a whole unit does not fit, mark it omitted and continue checking other fitting units. An oversized item must not prevent smaller useful facts from loading.
8. Render selected content in the existing section order and chronological note order. Ranking determines inclusion, not a new narrator-facing order.
9. Count the complete rendered request again. If adjustments are needed, remove optional units before cores, and record every change in the final report.

If all selected character content fits, send it in the existing format without substituting compact excerpts for complete sections. Deduplicate core excerpts against expanded source text. With the feature disabled, preserve the legacy selection and payload exactly.

An extremely small budget cannot guarantee eight names plus eight personalities plus eight appearances. The report must distinguish identity coverage, core coverage, and optional detail. Never show “8 characters covered” when only names were sent.

## Phased implementation

### Phase 1: selection contract and read-only prototype

- Capture local baseline fixtures for eight selected characters with the card limit set to eight, plus ordinary full-fit requests.
- Implement pure unit resolution, ranking, and fair allocation behind an internal test/prototype path.
- Produce a dry-run report with matched terms and exclusions. Do not change narrator requests yet.
- Review fixtures showing selected and omitted text, including an old relevant fact and newer unrelated notes.

Acceptance: deterministic results, complete units, honest coverage reporting, and zero network/provider calls from ranking.

### Phase 2: user-controlled metadata and settings

- Add an opt-in per-story character selection mode; existing stories retain current behavior until enabled.
- Add core/protected/topic selection controls to `js/ui/lorebook-view.js`, with token costs and exact source previews.
- Extend card validation, whole-book and single-card JSON/Markdown import/export, card edit merging, backups, copies, and restoration to preserve policy metadata.
- Validate references after edits and reorganization. Remap note IDs during cross-story import or duplication only when the source correspondence is known; otherwise flag the references for review.
- Preserve concurrent new notes and existing ownership/session guards. Keep selection preferences user-controlled; automatic extraction must not overwrite them.
- Update memory settings help text to explain the enabled policy without changing the meaning of card limits or budgets.

Acceptance: old cards round-trip unchanged; new policies survive save/export/import/copy; source edits cannot silently retain outdated core excerpts.

### Phase 3: integrate into outgoing context

- Integrate a character-specific fitter with `selectEntries()` and `buildMemoryContext()`; leave the legacy fitter available for disabled mode and other books.
- Pass the same filtered input, scene, lookback, continuation/regeneration cutoff, and token counter to preview and send paths.
- Reserve fitted character core space before optional facts/events consume overall capacity. Preserve recent-history priority and existing prompt roles/positions.
- Add partial-section rendering support without introducing narrator-facing ranking labels or new instructions.
- Return an exact selection report containing chosen units, omitted units, real token costs, missing core sections, and source validity reasons.

Acceptance: eight permitted, eligible cards can receive core coverage when the budget fits their cores even if it cannot fit eight complete cards; the complete request respects all configured limits.

### Phase 4: explanations and request verification

- Extend `js/ui/context-viewer.js` to show per-character identity/core/detail coverage and expandable original source text.
- Explain inclusions using actual evidence: protected core, valid state, current-input match, scene match, recent mention, or fallback priority.
- Explain omissions: unavailable source, no core configured, oversized complete unit, lower relevance under budget pressure, card limit, or overall request capacity.
- Keep explanations and scoring metadata out of `apiMessages` and `serializedRequestBody()`.
- Ensure a latest-sent report is attached to the actual request snapshot rather than overwritten by a later next-turn preview. Check the current report flow in `js/ui/chat-view.js`; reuse existing capture mechanisms where available.
- Provide preview/review through the viewer. Do not require a modal approval before every send.

Acceptance: the displayed sent text and selection reasons agree with captured serialized requests. Local preview cannot be mistaken for proof of a provider response.

### Phase 5: local validation and review checkpoint

Use the app's VM harness and mocked fetch/provider boundaries. Do not make live LLM calls.

Required fixtures and assertions:

- Eight selected characters, configured cap eight: all reviewed cores fit, full cards do not.
- A different configured card cap still applies; no hidden cap changes.
- Enough space: complete original content and format remain intact.
- Feature disabled: legacy payload parity.
- Old relevant facts survive newer unrelated notes; repeated generic words do not dominate.
- Negation, conditions, punctuation, Unicode, multiline source text, and aliases retain their meaning and wording.
- Unmatched topics use a predictable fallback.
- An oversized note does not block smaller useful notes for the same character or others.
- Missing/oversized cores and impossible budgets report partial coverage accurately.
- Pins and matching cannot bypass stale evidence, unavailable snapshots, or regeneration cutoffs.
- Current/recent input and scene changes invalidate caches; a new preview cannot change a captured sent report.
- A tight overall budget preserves required/recent conversation and reserved character coverage; other book formatting/order remains intact.
- Concurrent edits, reorganization, import/export, partial-session copying, backup, and restore preserve or invalidate metadata correctly.
- Selection does not mutate cards; ranking/preview makes zero provider calls; a mocked narrator send adds no calls beyond the existing narrator path.
- Final serialized requests contain selected lore only, without ranking metadata or explanation text.

Run focused tests after each phase. At the final checkpoint run `node --experimental-vm-modules --test tests/*.mjs`, syntax checks for changed JS modules, and `git diff --check`. Use UI checks for review controls, coverage labels, and source-edit invalidation. Report local/mock validation separately from any unperformed live Firestore/browser/provider verification.

## Decisions to review

1. **Priority:** use the proposed tier order, with core personality/appearance shared across all selected characters before optional depth.
2. **Core preparation:** use exact, user-reviewed excerpts or whole notes; do not automatically summarize or guess a compact personality from arbitrary prose.
3. **Overall allocation:** reserve fitted character core coverage before optional facts/events, while retaining recent conversation priority and all configured budgets.
4. **Rollout:** make the policy opt-in per story and begin with characters only.
5. **Review flow:** show detailed reasons in the viewer; do not add a compulsory per-turn confirmation.

Implementation, commits, and deployment are outside this planning task.
