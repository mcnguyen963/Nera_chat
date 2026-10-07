# Improvement plan progress — 2026-10-07

Branch: `feature/story-memory`. All required code phases in `improvePlan.md` are implemented locally. Live acceptance checks remain separate, as listed below. Changes are uncommitted; nothing was pushed, published, or migrated.

The continuation began from the clean `03b7a9d` checkpoint with **237 passing tests**. Phase 0, S1–S12 and U4 from that checkpoint were retained. The narrator and current reply contract now specify **200–600 visible words**, with a 600-word maximum. Hidden tags do not count.

## Phase 0 — safety and main ports

Completed in the preceding checkpoint: app-only Pages assembly, private request-log removal, boot error screen, retryable tokenizer loading, strict finish reasons with narrator truncation, reasoning budget validation, recoverable drafts and orphan-user Retry, streaming persistence/render handoff, viewport handling, omitted-turn wording and provider token reporting.

Conflict resolutions remain applied: no separate scene extraction, edits keep summaries, timeout **120 seconds**, token LRU **3000 entries**, and Firebase config stays ignored because CI generates it. Main-only optional features were not introduced. P0.16 belongs to C3.

## Phase 1 — scene and context core

S1–S12 and U4 were already implemented. This continuation completes C1–C4:

- C1/U7: all four prompt defaults load from Markdown, are omitted from stored settings when unchanged, and upgrade only exact outgoing-default hashes. Custom text remains intact. Each prompt has its own Reset button. The outgoing-hash rule is documented.
- C2: the all-off and extraction-only routes use the isolated legacy builder. Frozen main `16b9356` sources and hashes support **13 request/usage parity scenarios**. Old editable-plan flags and request-time plan overrides cannot alter the fixed plan.
- C3: memory requests have one system head containing rules, fixed plan, summary and fact/event books. Opening anchors precede any omission marker and recent conversation. System memory aligns before a user message; user memory prefixes the latest input. Scene reminders finish every Scene-enabled request, with the appropriate active/no-plan form. Required input is retained, and report totals equal framed wire costs.
- C4/S9: prompt wording describes the PC, distinguishes proposed plans from completed events, and removes contradictory prose. Narrator lore omits provenance brackets; extraction and export retain them.

Principal files: `js/legacy-context.js`, `js/context-builder.js`, `js/memory-context.js`, `js/system-prompts.js`, `js/settings.js`, and `system prompts/*.md`.

## Phase 2 — memory

L1–L8 are implemented; L9 was reviewed and requires no mandatory change.

- Edits and scene/acceptance corrections never pause memory. Only content edits/deletions change message revision; bounded content-edit logs support extraction guards. Summary checkpoints survive edits and reset on relevant deletion. Old edit-induced pauses resume below the failure threshold. Partial and full rebuild controls retain backups and offer removal of unreproduced notes only after confirmation.
- Extraction checks only its source range and pointer. Unrelated appends, lore/plan changes and summaries do not discard valid work. Transactions rebase onto fresh cards, persist aliases, deduplicate notes, refresh stale auto twins, skip deleted/full cards, and return written entries plus the new lore revision. Stale/superseded work does not count as an API failure.
- Extraction parsing tolerates common formatting, tag/section synonyms, missing/out-of-range turn stamps and partial batches. Status-only threads are accepted; Timeline never becomes a thread.
- Narration precedes maintenance. Recovery, urgent summary, memory and threshold summary share one slot, with memory fairness and summary backoff. Automatic summaries make one call and commit complete-turn coverage; manual summaries retain multiple chunks. Opening anchors never fold, and new summary records carry order ranges instead of growing evidence arrays.
- Reorganize replaces omitted sent notes, retains user/unsent/fresh notes, guards changed sent text, and backs up affected cards. Preview offers Keep controls for removed source notes. Each new note inherits its matched source evidence rather than the whole section.
- Idle memory explains unset pointers, pending replies and lag. Short stories repair unset pointers; longer stories offer Choose start. Imports start at 0, or the last assistant when lore accompanies the import. Duplicate pointer clamping remains intact.
- Markdown content escapes structural prefixes; v2 imports normalize missing aliases, kinds and section fields. User lines receive priority under lore budgets, with a warning if they cannot fit.

Principal files: `js/continuity.js`, `js/messages.js`, `js/lore-lines.js`, `js/lore-store.js`, `js/memory-updater.js`, `js/summarizer.js`, `js/maintenance.js`, `js/memory-reorganize.js`, `js/lore-format.js`, `js/turns.js`, and `js/import-export.js`.

## Phase 3 — budgets

C5 is implemented. `maxContextTokens` is the input limit; reply capacity is independent unless optional `modelContextTokens` supplies a total model window. Narration, summaries, extraction, reorganization and scene recovery use the same helper. Indicator/viewer labels distinguish input from max reply. Automatic threshold checks include the next memory reminder without adding a stored turn.

## Phase 4 — UI and concurrency

U1–U9 are implemented, using U2's documented safe fallback:

- One busy token owns sends, retry/regenerate, edit/delete/accept/scene saves, summary and reset. Captured account/story/epoch checks prevent stale callbacks from changing the active story. History bridges use the pre-save revision. Completed save transactions return session metadata, removing duplicate reconciliation and the post-stream session read.
- The authoritative chat session listener remains; sidebar snapshots no longer write the active session. This resolves competing state sources but deliberately saves **zero listener reads**. Cached/pending/revision-downgrade snapshots cannot roll back history. Deleted active stories return to the empty state.
- Lore listeners retry at 2/5/15/60 seconds, and show offline status. Successful extraction updates the verified lore revision. Manual lore gates use `increment` with zero reads. Backups use a compact 20-group index and fetch full parts only for restore.
- Stop cancels generation and recovery; the owner-selected idle timeout is 120 seconds. Partial narrator replies can be retained as cut off. Strict maintenance callers reject truncated output. Unknown reasoning effort normalizes to medium, and capped budgets are visible. Tokenizer fallback is labeled and warns once.
- Composer drafts clear after successful user persistence. Mobile fields use 16px fonts; inserted message editors grow to their text. Quick profile/thinking overrides survive server sync locally. Failed settings loads cannot overwrite server preferences.
- Composer indicator work is debounced. Context-viewer reconciliation happens on Open/Refresh, not reactive rendering. IndexedDB stores three recent sessions via metadata rather than repeated full-value scans. Logout/account changes clear account caches and retain device UI preferences.
- Catch-up/update feedback, rebuild confirmation, paste limits, failed-button recovery, normalized memory-save baselines, shared clipboard fallback, sheet listener cleanup, accessibility disclosure state and the CI-config comment are addressed.

Principal files: `js/ui/chat-view.js`, `js/ui/busy-token.js`, `js/ui/clipboard.js`, `js/ui/memory-ui.js`, `js/ui/memory-settings-view.js`, `js/ui/lorebook-view.js`, `js/ui/settings-view.js`, `js/ui/context-viewer.js`, `js/chat-cache.js`, `js/device-caches.js`, `js/llm-client.js`, `index.html`, and `css/style.css`.

## Phase 5 — performance and lore polish

C6–C9 are implemented: memoized message rendering/costs, one 3000-entry feature LRU that excludes fallback estimates, safe timeline rendering, relevant fact ordering, case-sensitive unique first-name matching, a separate protagonist allowance, stable turn-block boundaries after deletions, and bounded optional known-name lists while retaining mentioned names.

## Verification and read/call accounting

- **279 tests passed**, zero failures or skips: `node --experimental-vm-modules --test tests/*.mjs`. All 13 frozen-main scenarios pass. New tests cover layout/framing, range guards, rebasing, rebuild cleanup, parser tolerance, evidence inheritance, export/import, busy ownership, timeout/cancellation, settings guards, backup indexing and IndexedDB metadata.
- A simulated **20-turn replay records 40 calls/jobs, at most 2 per turn**, and **20 session reconciliation reads**. The counter includes mocked background memory starts; this is an orchestration regression test, not a paid-provider or Firestore billing measurement. Its numeric ledger is `/tmp/nera-twenty-turns.json`.
- Warm legacy sends use one direct session reconciliation and the two save transactions: **3 direct session reads**, plus conditional history/migration reads. Because U2 retains the chat listener, sidebar/session/chunk listeners can add about **6 reads** for two saves: about **9 total**, rather than the recommended 7-read listener consolidation. Live billing was not measured. Manual lore gates use **0 reads**; warm backup writes and backup listing each use **1 index read**. Old backup-index initialization is a one-time fallback listing. Reorganize reads only affected cards. Explicit rebuild cleanup uses affected-card transaction reads to preserve concurrent notes.
- The 200-message benchmark against `03b7a9d` measured **44.62 ms → 4.48 ms**, about **9.97× faster**, using a deterministic tokenizer stub. It is not native provider-token or device latency evidence.
- Replay of **52 archived SSE responses**: **31 → 33 parsed scene tags**, **zero regressions**, and no new provider calls. Generation rate is unchanged evidence because responses were fixed.
- Syntax checks, unique HTML IDs, `git diff --check`, and scratch Pages assembly pass. The artifact contains app files and all **39 runtime prompt assets**, excluding tests, plans, investigations and private files. Firebase config is generated by CI.

Local measurements are also recorded in `investigate/report.md` and `investigate/final-local-checks.json`.

## Remaining external checks

No required code task is intentionally deferred. The optional pending-copy cleanup from L9 is not enabled, as the plan says none is required.

A browser connection was unavailable, so visual/interaction QA and real iPhone keyboard/viewport checks remain unverified. No new paid provider calls, live Firestore billing measurement, long-real-history generation evaluation, or Pages publication was performed. The available archived story export has only two messages and cannot establish the requested long-history model evaluation. Q5 remains an explicit owner task: move tracker instructions from an existing user-owned story plan into its summarizer prompt by hand. Stored user plans were not rewritten.

## Subsequent approved provider verification — 7 October 2026

Five real OpenRouter calls using `z-ai/glm-5.3-flash:floor` completed, all via Relace with normal stop. Four narrative replies (585, 543, 264, 392 words) had readable scene and plan-thread tags. A 54-word OOC answer correctly tracked Krail's exit. Returned total cost: $0.0048984888. The request/client path was real; persistence and next-request lore selection were replayed offline. No browser or Firestore verification. See `investigate/report.md` for evidence and limits.

Remaining observed gaps: both opening samples invented morning, which the lexical scene validator accepts once narrated; one used third-person narration; initial lore selection still omitted Krail's card until scene state existed. Older calls used a different routed provider, so improvement is not a controlled code-only comparison. These results establish improvement on these samples, not full model compliance. No production code changed during the live test, and no further provider calls are authorized by the five-call allowance.
