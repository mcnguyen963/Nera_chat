# Production plan implementation — 2026-10-08

## Result

Baseline in this checkout: **307 tests, 307 pass**. The plan's expected missing-git failure did not occur here because old objects were present, but the test still invoked git. Q1 replaced that dependency with four frozen, hash-checked prompt fixtures.

Final validation: **463 tests, 463 pass**; the same suite also passes from an assembled source copy with no `.git` directory. Legacy wire parity is green. Sixty-three JavaScript/script files pass syntax checks. A temporary app-only site stamps successfully, all stamped modules pass syntax checks, and it excludes tests, investigations, reports, backups and registration HTML. No git CLI was used to recover fixtures or implement the changes. The owner subsequently requested smaller commits and a push to the feature branch. The unmodified baseline test still contained the git subprocess removed by Q1. Deployment, live database queries and live LLM calls remain outside this local verification. Commit and push results are reported separately.

**S1 was skipped under the owner's instruction to handle registration in Firebase. P4's deployed desktop/iPhone checklist remains pending.** RELEASE.md states the remaining local registration form/permissive rules explicitly. No owner uid was invented: firebase-config.js has project configuration only. This is not a claim that the deployed app is production-ready.

## Task status

| Tasks | Local result / regression coverage |
|---|---|
| Q1 | Frozen outgoing defaults, exact hash assertions, duplicate/unknown trigger removal; suite runs without git |
| S1 | Owner-managed, skipped; sign-up UI and existing rules remain; console steps and UID verification documented |
| S2 | Local pinned tokenizer 2.9.0 with MIT license; retry/fallback and CSP regression tests |
| S3 | All pushes test; main-only gated deploy; stamped imports/CSS/boot and manifest; manual rules procedure |
| D1–D2 | Paid unsaved reply, IDB recovery, retry without LLM, transactional history/overwrite conflicts |
| D3–D4 | Full-history note removal, re-confirm changed counts, guarded writes, tombstones and resumable sweeps |
| D5–D6 | Hidden publish-last imports, collision-safe rollover, queued failed cleanup, resumable per-chunk migration |
| D7–D8 | Atomic server-card backups, transactional restore, concurrent invalidations/failure streak, changed-leaf settings |
| D9 | Deleted-reply Retry pairing, including a later pending user that must retain its own turn |
| B1–B2 | Saved reply survives maintenance errors; full refreshed history and lore are used; newer post-commit metadata wins |
| B3–B6 | Partial extraction acceptance, NONE prose, parser alias/timeline/range fixes, literal dollar patterns |
| B7–B9 | Consistent mention offsets, bounded OOC stripping/classification, recount/rebuild instead of send failure |
| B10–B12 | Unnumbered narrator context, full MAIN recovery constant, real streamed truncation rejection for summaries |
| B13–B16 | No resurrected unsent lines, preview lock/counts, revision-guarded edits, early composer clearing, correct Stop/timeout labels |
| B17–B22 | Remote draft preservation/profile validation, scene parser/recovery edges, prefix-copy filtering, summary fallback, usage placeholder, User memory default/gap attachment |
| R1–R3 | Friendly/throttled errors and diagnostics, listener retry, async button/startup failure handling, guarded local preferences |
| R4–R8 | Bounded/normalized imports with paid automation off, delayed download helper, accurate offline state, navigation/Catch-up guards, authoritative cache cleanup |
| Q2–Q6 | Markdown labels with byte-identical snapshots, missing regression matrix, corrected docs, scoped dead/null cleanup, visible/throttled pet geometry |
| P1–P2 | Version/banner/safe diagnostics; cancellable combined account JSONL export with read disclosure |
| P3 | Dropped by owner; API-key sync retained |
| P4 | Pending owner/deployed device acceptance; every row recorded in RELEASE.md |

B13's lock/count presentation and R7's browser-history navigation also require the listed manual checks; store resurrection and Catch-up cancellation are tested. CSS/device rendering, actual browser CSP/Auth and download behavior are not established by the fake DOM.

## Changed files

- App/release: `.github/workflows/deploy.yml`, `index.html`, `scripts/stamp-version.mjs`, `RELEASE.md`, `improveProgress.md`.
- Core: `js/app.js`, `chat-cache.js`, `context-builder.js`, `import-export.js`, `legacy-context.js`, `lore-format.js`, `lore-lines.js`, `lore-select.js`, `lore-store.js`, `memory-context.js`, `memory-prompts.js`, `memory-settings.js`, `memory-updater.js`, `messages.js`, `scene.js`, `scene-parser.js`, `scene-recovery.js`, `sessions.js`, `summarizer.js`, `system-prompts.js`, `tokenizer.js`, `turn-review.js`.
- New core files: `js/errors.js`, `local-pref.js`, `memory-skipped.js`, `session-memory.js`, `unsaved-replies.js`, `version.js`; `js/vendor/gpt-tokenizer-2.9.0.js`.
- Views: `js/ui/chat-view.js`, `lorebook-view.js`, `memory-settings-view.js`, `memory-ui.js`, `pet-view.js`, `settings-view.js`, `sidebar.js`.
- Prompts: `system prompts/narrator.md`, `historical-summary.md`, `continuity.md`, `summarizer.md`, `opening-exchange.md`, `legacy-prompt-default-hashes.md`, `README.md`; new `memory-extraction-frame.md`, `lore-labels.md`, `omitted-turns-partial-uncovered.md`.
- Existing tests: `tests/remaining-plan.mjs`, `regressions.mjs`, `legacy-golden.mjs`, `message-chunks.mjs`, `memory.mjs`, `p06-client.mjs`, `p07-settings.mjs`, `scene-contract.mjs`, `scene-parser.mjs`, `scene-resilience.mjs`, `tokenizer.mjs`, `pets.mjs`; MAIN recovery fixture/SOURCE updated.
- New tests/artifacts: `tests/context-layout.mjs`, `production-errors.mjs`, `production-import.mjs`, `production-lore.mjs`, `production-parser.mjs`, `production-session-settings.mjs`, `production-startup.mjs`, `unsaved-replies.mjs`, `version-stamp.mjs`, `prompt-labels.mjs`; prompt-label snapshot, outgoing-prompt fixtures/SOURCE, `tests/tools/replay-context.mjs`.
- Task reports under `production-reports/`; original/intermediate `*.bak` copies under `production-backups/`. Backups remain until owner acceptance.

## Read/write and LLM impact

A normal already-migrated turn still writes **four documents**: user session+chunk and assistant session+chunk. Narrator history guards add **zero normal reads**. Rollover, including a first chunk, adds one target-chunk read; overwrites inspect later chunks and may add reads. At most **two LLM calls per turn** remains enforced; Save again and conflict recovery add none.

| Operation | Additional work |
|---|---|
| Full-history deletion badges/removal | One read per chunk, current affected-card reads, guarded backup/index reads; user initiated |
| Tombstone/delete | One tombstone write; session transaction and resume read, subtree reads/deletes; queued pre-tombstone failures use best-effort IDB |
| Continuity migration | One session check per unfinished chunk plus final session update; more session reads than the old single transaction; completed markers skip rewritten chunks |
| Manual lore/backups/restore | Guard session reads plus current-card/index reads; backup listing scans parts for abandoned preparations; atomic backups add part/index writes |
| Memory failure/rebuild | One session transaction read; the existing failure/rebuild write; no new LLM |
| Settings save | Changed leaves; D4 guards add one session read to the existing update |
| Reconnect | Re-reads story/latest chunks only when listener retries |
| Account export | Session listing, each story document, one read per message chunk and lore card; legacy migration overhead if needed |

The plan's estimate of unchanged migration reads was inaccurate: checking the session revision in every small transaction necessarily adds session reads. Detailed transaction costs and staged validation snapshots are in the individual reports.

## Failure behavior

| Write path | User-visible/recoverable result |
|---|---|
| User message | Failed write leaves the exact draft; a committed send clears only that draft before stale checks |
| Narrator | Failed/conflicted save retains paid text locally with Save again/Copy/Discard; no post-save maintenance runs for it |
| Summary | Truncated/source-changed/failed save never activates a new checkpoint; a saved reply stays saved if background work fails |
| Extraction | Valid cards/checkpoint commit together; invalid/full notes are listed; failed transaction commits nothing, failure streak tracks current server state |
| Delete | Failed tombstone is queued for reconnect/startup; completed tombstone hides the story; unfinished sweep resumes; all guarded writers refuse tombstones |
| Import/copy | Destination stays hidden until publication; failed writes request queued/tombstone cleanup |
| Delete/merge/restore/import lore | Server backups precede each changed transaction atomically; multi-card operations may have earlier completed cards when a later transaction fails, with indexed recovery backups |
| Settings/card edit | Transaction failure reports an error and preserves the draft; busy refusals are visible |

IDB is best effort. If storage is blocked, unsaved reply text remains visible for the visit, but cannot be guaranteed across reload. A failed cleanup before tombstone is remembered in memory and persisted where IDB works. No extra Firestore tombstone rule lookup was added, following the default decision.

## Replay and test evidence

Local export: `investigate/save_conversation/dev 2 (1).jsonl`, upToOrder 522. It is not the plan's unavailable `/home/.../dev 2.jsonl` and has a different baseline.

| Metric | Local baseline | Final User-role replay |
|---|---:|---:|
| API messages | 43 | 41 |
| App turn refs | 121 | 0 |
| System messages | 3 | 1 |
| Rough input tokens | 62,256 | 61,921 |
| Memory-block tokens | 4,335 | 4,260 |

The two-message reduction is B22 merging the memory and gap notes into user messages. Actual story messages and the T205 start remain unchanged. Final request has zero `origin:`, `message order`, and `unknown cutoff`; the old summary heading is superseded and the scene line is Current scene (from the latest reply). B10 with the existing saved System role separately preserves 43 API messages. Extraction retains stamps.

Root's isolated original-source proof: ten reply/UI regressions fail against backed-up chat-view; eight parser/prompt regressions fail against original parser-related modules; startup rejection fails against original app. Agents additionally proved pre-fix failures for guarded saves, migration, deletion, backups, mention offsets, recounts, pet geometry and label/null handling. The final suite passes all of these. No deployment/provider/phone claim follows from these results.

## Remaining limitations / not done

- S1 owner-only sign-up/rules are owner-managed and unchanged locally; verified uid and console setting still needed.
- P4 desktop Chrome/iPhone Safari and live quota/provider tests are pending. No deployment was requested/performed here.
- The exact Appendix export and its 64-message replay are unavailable; local export differences are reported instead of fabricated.
- Global settings success refresh can still replace text typed while an explicit Save is awaiting completion; B17 addressed remote/recovery updates. This separate observation was recorded without extending the plan.
- `frame-ancestors` requires a response header; a meta CSP cannot enforce it on ordinary GitHub Pages.

## Authorized commit sequence

After implementation, the owner requested smaller commits and a push of all implementation changes to `feature/story-memory`. The integrated final tree passed 463/463 tests in the project and in a source copy without `.git`; individual intermediate commits were not tested separately.

1. `40d6a69` — frozen prompt migration fixtures and summary output-limit coverage.
2. `6548073` — guarded story writes, resumable deletion/import and server-backed backups.
3. `3219320` — narrator continuity, memory and scene parsing, legacy parity.
4. `5a83245` — pinned tokenizer and test-gated, versioned main-only Pages releases.
5. `1343605` — paid-reply recovery and UI failure paths.
6. Release checklist, task reports and prompt documentation (this documentation commit).

Safety backups remain local under the ignored `production-backups/` directory. The vendored encoding contains significant whitespace inside token string literals; those upstream literals were preserved. Git whitespace checks pass for authored changes. Pushing this feature branch runs CI tests; it does not deploy Pages under the updated workflow.
