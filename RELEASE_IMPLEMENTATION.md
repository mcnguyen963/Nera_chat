# RELEASE.md implementation report — 2026-10-09

Implemented F1–F10, F13–F18 and F20. F11–F12 (Phase C) were excluded at the owner's request. F19 automated verification is complete; owner-export replay and live device checks remain pending.

The existing owner-edited RELEASE.md was preserved. No commit, push, rule deployment, data migration, or live paid model call was performed.

## Behavior changed

| Tasks | Result |
| --- | --- |
| F1 | Accept declared clocks unless the ending narration contradicts them; preserve stricter date progression. Historical `kept` clocks/dates become unknown in effective context and turn headers without changing stored documents. Scene chips identify model-declared clocks. |
| F2 | Reject unfilled templates, make individual placeholder fields unknown, and preserve unknown keys after a soft hyphen separator. Scene prompt files remain unchanged. |
| F3 | Recover the last filled scene line from provider reasoning, validate it against narration, and store its reasoning source warning. Empty drafts cannot override filled candidates. Otherwise store one carry warning. No thinking is sent back to the narrator. |
| F4–F5 | Strip provenance stamps from rendered summaries and narrator lore, rewrite old Markdown situation headings, preserve ordinary “Turn N” prose and lowercase codes, and retain raw extraction/export/UI provenance. |
| F6 | Return suspect-summary line warnings and show them through the shared handler used by all three summarization callers. No rewriting or acceptance gate. Removed the unused CUTOFF argument. |
| F7 | Clear and null the reconnect timer on story switch/logout. |
| F8 | Query server chunks before either retry action, including chunk rollover and old IndexedDB copies; recognize committed regenerations by content. Refresh the session and report success without another write when found. A real conflict still offers append-as-new. Subsequent append retries use the new append identity/range. |
| F9 | Give automatic summaries their own Stop controller; a user stop does not cause a three-turn failure backoff. |
| F10 | Retain content/reasoning on premature stream termination and rejected reads. Offer to keep a dropped partial reply, saved as truncated, with the connection-drop label. |
| F13 | Back up each current server card atomically with its cleanup in separate transactions under one backup group. Unique part sequences preserve every changed card. Partial failure reports exactly how many cards Undo restores. |
| F14 | Flag restores only for genuinely lost newer source orders, independent of reorganized line IDs. |
| F15 | Sweep hidden imports older than 24 hours through the existing tombstone deletion path, once per account/story per page. Pending timestamps stay fresh. |
| F16 | Show rebuild turn/call estimates and Dismiss in both banners. Dismiss preserves extraction progress, pause/failure state, and concurrent newer invalidations. |
| F17 | Parse repeated and reversed turn ranges; persist adjusted stamps separately from parser rejection decisions in existing bounded status diagnostics. |
| F18 | Implemented E1–E10 and E12–E14: OOC continuation, generic alias/honorific matching, Admin timestamps, mixed import progress, failed-delete reply retention, export/maintenance busy guards, ResizeObserver notices, normalized default migration, loop-based extrema, reserved lore IDs, and recent-message label. E11 was explicitly not planned. |
| F20 | This checkout still had the outgoing defaults despite the plan's “already applied” note. Applied the exact 1,462-word prompt, companion output directive, README guidance, and verified outgoing hash `039940653b9452e1975a00787e0ebfe887b9fecb409a730b380c498d67256609`. Custom prompts remain overrides. |

## Verification

- Baseline: 475/475 passing. Final: **587/587 passing** (112 additional tests).
- Used installed Node v25.2.1 (Node 20+); the plan's specific v24.19.0 path does not exist here.
- Added regression coverage for every implemented defect. Checked defect regressions against pre-fix source through isolated VM source overrides or a temporary copy with individual HEAD modules restored. Compatibility guards intentionally continue passing against old behavior; they are not claimed as defect regressions.
- Root checks against original implementations: F1 17 failures/1 compatibility guard; F3/F7/F8/F10/F16 and E1/E6–E10/E14 all reproduced failures. F9's two stop cases failed before, while its existing network-backoff guard passed before and after. Other task-specific before/after checks were performed with the corresponding original parser, renderer, store, prompt, import, extraction, and helper sources.
- Intentional existing-test changes: S8 now accepts a declared night without contradictory ending prose; scene-resilience accepts a declared late morning, including structured recovery, while retaining narration/provenance checks; the old summary fixture uses a stamp-position `Turn 204:` rather than ordinary prose; D7 restore expects the genuinely lost order 50 rather than unrelated order 2. No tests were deleted.
- `node --experimental-vm-modules tests/prompt-labels.mjs --capture` produced no fixture diff. Legacy golden, prompt migration C1, the unchanged 10,000-token maintenance scheduling fixture, and the twenty-turn two-call budget test pass.
- Synthetic F19 tests capture the actual serialized fetch body, checking effective own/carried scene clocks, memory block, history tags, summary/lore stamps, thinking exclusion, unchanged source data, and extraction/summary turn headers. This is automated fixture evidence, not live provider evidence.
- Syntax checks cover all changed/new JavaScript modules; `git diff --check` passes.

## Firestore and LLM costs

Counts below are code-derived, excluding listener traffic, existing cache/history reloads, automatic transaction retries, and first-use legacy migration. R = document reads; W = document writes. A query reads its returned documents; empty queries may still incur the service's minimum charge.

Normal successful turn: added **0 R / 0 W / 0 LLM calls**. Existing user+reply transactions remain two session reads and four document writes, plus up to two new-chunk existence reads. Existing narrator plus at most one maintenance call remains the two-call ceiling. Reasoning recovery is local and can avoid a paid fallback call.

Retry/failure path: F8 adds server chunk discovery (normally **1–3 R**, potentially more for an old order range), plus **1 session R** when already saved; found retries add **0 W / 0 LLM calls**. A genuine retry uses the existing save transaction. Rejected discovery leaves the unsaved reply available. F9 user-stop and F10 dropped-stream handling add no model calls; a kept partial uses the ordinary save path, and a declined partial writes nothing.

Maintenance: F13 with an initialized backup index uses the existing gate **1 R / 1 W**, then **3 R / 3 W per changed card** (session/card/index reads; card/backup-part/index writes), **3 R / 0 W per skipped card**, plus existing backup pruning when needed; first use adds index/listing reads and existing initialization/cleanup. F14 restore reads are unchanged and removes false rebuild session writes. F16 Dismiss is **1 R / 1 W / 0 LLM calls**. F15 adds one existing delete lifecycle per abandoned import: one session transaction read/tombstone write, server-session read and five subtree queries, returned-document reads, subtree deletes in batches, and final session deletion; **0 LLM calls**. Summaries, import, extraction diagnostics and all remaining maintenance paths retain their prior read/write/call counts.

## Write failures and user-visible results

- Narration/retry/regeneration: a failed or ambiguous save retains the paid reply in the device's existing unsaved bubble. Server discovery failure shows the error and keeps that bubble. A discovered commit is displayed as “Reply saved.” without another append. Account/story changes retain the existing stale-action guard.
- Kept dropped replies: use the same atomic narration transaction and unsaved-bubble failure path. No incomplete extraction is committed as notes.
- Summary: summary content and checkpoint remain in the existing single save transaction. Failure leaves the previous checkpoint intact and shows “Summary skipped”; a user stop shows “Summary stopped” without backoff. Manual summarize's Stop still has no signal (the plan explicitly lists this as outside F9).
- Reviewed-note cleanup: each changed card and its backup commit together. A failed card stays untouched; earlier cards stay backed up. Error: “Removed notes from K of N cards. Undo in Backups restores those K.” Undo restores exactly that group. Backup initialization failure occurs before any card removal and reports its existing error.
- Restore: existing per-card backups allow recovery of already-restored cards if a later transaction fails; the UI reports the restore failure. Each card's restore, backup and genuine rebuild flag are atomic.
- Dismiss: one failed transaction changes none of its fields; the banner remains and the UI toasts the error. Newer invalidations survive a successful dismissal.
- Abandoned import deletion: failure before marking uses the existing queued deletion retry and error callback; failure after marking leaves a hidden tombstone that existing listing/reconnect cleanup resumes. Existing import failure handling is unchanged.
- Sidebar delete: if deleting fails before its tombstone is saved, the local unsaved reply remains available on reopening the story. A committed tombstone continues to trigger existing deletion cleanup.
- Choose-start/import/chunk maintenance: changes are guards, metadata selection, parser normalization or loop-equivalent calculations; existing atomic writes and existing error feedback remain in effect.

## Pending owner/live verification

The referenced sibling `dev 2.jsonl` and `dev 2 (1).jsonl` files are absent in this workspace. Actual orders 538/545 validation, Infinity replay, and order-548 byte-identity cannot be checked against those files here. Synthetic tests cover these code paths.

- [ ] Replay the owner's export at Infinity and verify no narrator T-stamps, unknown historical rejected clocks, and stored summary byte identity.
- [ ] Play 10 phone turns across an evening transition; inspect reasoning and stored scene warnings.
- [ ] Drop the network mid-stream and exercise keep/discard.
- [ ] Simulate both uncommitted and server-committed ambiguous saves, including regeneration and chunk rollover, against live Firestore.
- [ ] Reconnect, switch stories before the retry fires, reconnect again, and verify second-device updates.
- [ ] Check rebuild cost and Dismiss on the phone; verify newer invalidations remain.
- [ ] Remove notes from multiple cards, Undo their backup group, and Undo a reorganize without a false rebuild banner.
- [ ] Verify a >24-hour abandoned import disappears through live cleanup.
- [ ] Summarize a story copy with the new default and review voice, secrets, promises, cutoff wording and narrator continuation.

F11/F12 sign-up, rules deployment and Safari CSP/security checks are excluded, as requested.

## Changed files

Runtime: `index.html`; `js/{errors,import-export,llm-client,lore-format,lore-lines,lore-select,lore-store,math-utils,memory-context,memory-prompts,memory-rebuild,memory-updater,messages,scene-parser,scene,session-memory,sessions,settings,story-text,summarizer}.js`; `js/ui/{chat-view,lorebook-view,memory-settings-view,settings-view,sidebar}.js`.

Prompts: `system prompts/{README,legacy-prompt-default-hashes,summarizer,summary-output}.md`.

Tests: updated existing regression, memory, scene, backup, chunk, error, import and lore suites; added scene validation/template, turn-stamp, dropped-stream, rebuild-dismiss, stale-import, summary-lint/default, adjusted-stamp, extrema and serialized-context suites, plus the outgoing-summary fixture. This report is new; RELEASE.md's pre-existing edit belongs to the owner.
