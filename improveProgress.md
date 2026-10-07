# Improvement plan progress — 2026-10-07

Branch: `feature/story-memory`. This is a checkpoint, not completion of the whole plan.

## Scope and starting state

The actual checkout has Git and began with 157 passing tests, rather than the plan's extracted-folder baseline of 147. Existing dirty changes in the tokenizer, client, settings, summarizer and their tests were retained and verified. No commit, push, deployment, data migration or changes to another checkout were made.

The requested narrator range is **200-600 visible words**. The narrator already used it; the active reply-contract Markdown was aligned. The unused writing contract was aligned before its deletion under S2. Full prompt revisions and old-default delivery remain C1/C4 work.

## Phase 0 — implemented locally

- P0.1: download-marker cleanup and ignore rules. `investigate/` is now ignored, but it was already tracked: this does not remove its existing Git history or untrack it. The current checkout contains no Zone.Identifier files. No other checkout was edited.
- P0.2: Pages assembly copies only app files. The exact workflow assembly script passed in a scratch directory; it produced 83 paths and 24 runtime Markdown prompt assets after S2. Publishing and live Pages verification remain outstanding.
- P0.3–P0.7: private request logging removed; recoverable boot screen added; tokenizer retries and refuses to cache fallback estimates; finish reasons and narrator truncation supported; reasoning defaults and settings validation verified. Encoder errors also clear tokenizer readiness.
- P0.8: obsolete lost-plan instructions removed at request time; fixed-plan Markdown overrides missing historical tags.
- P0.9–P0.11: cut-off replies persist and display their status without recovery; streamed bubbles remain until persistence/render completes; failed user saves restore the exact draft; Retry reuses the saved latest user turn.
- P0.12–P0.15: viewport/zoom handling and scroll clamps ported; summarized-message confirmations added; dropped-turn wording clarified; provider prompt-token usage shown for its captured story.
- P0.16 stays folded into C3. P0.17/P0.18 were reviewed; main-only optional features were not ported. Editor sizing/device checks and C6's final token LRU remain separate work.

Verification after the Phase 0 implementation: **163/163 tests**.

## Phase 1 — scene work implemented; context tasks pending

- S1: missing acceptance means accepted; a later user turn resolves legacy pending replies when read; review controls appear only with Scene on for the latest unresolved reply. A skipped pre-narration summary releases its maintenance slot.
- S2: removed unused extraction mode, its settings, three prompt assets and four tests.
- S3: tolerant canonical parser and final-output cleanup; reasoning ignored; duplicates, aliases, clock times, fences, bracket/comment variants and unclosed tags handled. Streaming still hides unfinished metadata. Invalid starting-scene text remains recoverable in settings.
- S4: one-pass scene timeline; carried state is a reference; accepted candidates replay; stale seeds do not replace legacy story state; transcripts label only a reply's own scene.
- S5/S6: lint produces notes, never pending replies; valid scenes survive warnings; missing scenes use quiet info feedback; more precise speech/decision detection and paragraph-local quote stripping.
- S7/S8: three-way OOC classifier; supported progression and time synonyms; unsupported new dates/times retain known prior values; relative past/future mentions do not establish the clock.
- S9: narrator lore omits provenance brackets while extraction keeps them. Opening-label adjacency is explicitly deferred to C3, as required by R6.
- S10: prose edits retain scene/plan metadata; pending edits apply candidates; canonical manual scene validation; carried/add-scene chips; candidate display for legacy review.
- S11: recovery accepts fenced JSON, maps known names case-insensitively, keeps evidenced unknown names and drops others; malformed output returns null; no `require_parameters`; explicit reasoning disable only on OpenRouter recovery requests.
- S12: recent narration can select cards, after current-input and scene priorities.
- U4 was completed early because S10 depends on it: full render-state comparison, neighbor-dependent labels/review/scene refresh, memoized turn and lore-line context, regeneration clears edit/cut-off/review state appropriately.

C1, C2, C3 and C4 are **not implemented**. Phase 1 is therefore **not complete**. The next work is C1 (including U7 step 3), then C2's frozen-main legacy route and 13-case golden test, then C3 layout/reminders/omission markers, then C4 prompt edits.

## Verification at this checkpoint

- **237/237 tests**, no failures or skips. New coverage includes all 39 scene-parser fixtures, all 25 OOC fixtures, acceptance/timeline/provenance, persistence, UI recovery, and request-body reasoning behavior.
- JavaScript/test syntax checks and `git diff --check` pass.
- Offline replay of the 52 saved SSE provider responses reconstructs visible content before parsing: original parser accepts 31, new parser 33, with zero regressions. Among 36 files classified as narrative by their names, the same counts are 31/36 and 33/36. This is parser replay against fixed responses; it does not measure a changed model tag-generation rate or a new long-history evaluation.
- No added Firestore reads/listeners in these changes. Manual scene edits and retries use their existing persistence/freshness paths. Provider usage is device-local.
- No new automatic LLM jobs. Recovery still consumes the existing maintenance slot, and cut-off replies skip recovery. L4 still needs to replace pre-narration/multi-chunk automatic summaries to enforce the complete per-turn call cap in every path.
- No iPhone, live Firestore, live provider or published Pages verification was performed.

## Outstanding work

Finish C1–C4 before entering Phase 2. Then follow L1–L9 (Phase 2), C5 (Phase 3), U1–U3/U5–U9 (Phase 4; U4 already done), and C6–C9 (Phase 5), in dependency order. P0.13 confirmations still reflect current edit invalidation and must change with L1. The final 20-turn call/read measurement, long-real-history model evaluation, iOS checks and live deployment checks remain outstanding.
