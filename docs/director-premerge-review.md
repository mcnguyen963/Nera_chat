# Director–Narrator pre-merge review

Reviewed 16 October 2026, starting at feature commit `176b242` against main `5153ab6`.

## Outcome and boundaries

The offline review found and fixed the defects below. No remaining critical or high-severity issue was reproduced within the reviewed offline paths. This is not a certification of live services or phone behavior.

Firebase/authentication audits, live Firebase operations, security-rule changes, browser/device automation, and paid model calls were excluded. Existing mocked persistence and provider tests ran locally. Story and lorebook formats remain unchanged; no content migration is required. The unrelated main-worktree chat edit is preserved.

## Fixed findings

| Finding | Severity | Before | Correction and evidence |
| --- | --- | --- | --- |
| Operation journal race | High | A second operation arriving during acknowledgement could start transport before its local journal record finished. | Await the current journal at every queue iteration. A controlled acknowledgement/write test verifies transport ordering. |
| Frozen Settings dismissal | Medium | Close returned false throughout a pending save, with no immediate saving notice. | Show Saving immediately, permit dismissal, and retain the submitted view/draft for reopening. Delayed success/failure tests cover this. |
| New edits overwritten by save completion | High | Settings/card save completion replaced edits made after submission. | Preserve later edits, rebase returned card data, and retain concurrent notes. Regression tests submit then continue typing. |
| Sending with a dismissed settings save | High | Generation could use stale settings or fail against a revision being changed by that save. | Track in-flight settings dependencies without storing settings payloads. Send shows a cancellable wait, uses the saved settings on success, and preserves the composer on failure. Manual Director refresh completes before releasing its dependency. |
| Stale lorebook completion | Medium | Save/delete/create/merge completion could replace a different editor or force navigation after the user moved on. | Capture story/selection/navigation identity and guard UI completion. Tests cover delayed saves and deletion after navigation. |
| Undo targeted the currently open story | High | Some Undo callbacks read mutable global story selection when clicked. | Capture the original story and owner. A delayed-delete test changes stories before Undo. |
| Late dialog close/focus | Medium | A stale hide callback could close a replacement sheet or steal focus. | Make sheet dismissal idempotent and scoped to its own instance; test replacement sheets. |
| Invisible reply-preparation wait | Medium | Lore waits preceded the reply lock/Stop presentation. | Expose Stop as soon as reply preparation starts. Cancellation and late completion tests verify immediate release and isolation. |
| Rewrite cleanup after Stop | Medium | Cleanup could restore the old draft after the user had already typed a new one. | Stop restores the original synchronously, releases the composer, and guards late cleanup by request identity. |
| Memory/Director preparation feedback | Medium | A delayed snapshot could make opening these actions appear to do nothing. | Open a dismissible preparation surface immediately; guard dismissed results. Preserve failed Director save drafts for retry within the page. |
| Delayed story creation/copy navigation | Medium | Completion could interrupt navigation made while the operation ran. | Show pending labels and select the result only if the original navigation/owner is still current. |

Shared dialog actions now display pending labels and accessible busy state, suppress duplicate submission, and restore controls after rejection. Existing validation, source checks, historical-edit review, and destructive-action confirmations remain in place.

## Validation

- Full suite: **1,061 passed, 1 existing emulator-only skip**, no failures (1,062 tests).
- Syntax checked 106 app JavaScript/benchmark files; final modified files rechecked. `git diff --check` passed.
- Existing suites exercise classic/Director requests, contract validation, cancellation/continuation/regeneration, summary invalidation, queue recovery/retries, cache eviction, lore/Plan parsing and backups, and release assembly. They use offline adapters, not live Firebase or paid models.
- Long-story backup: **947 messages, 228 lore cards**. No story text is written to benchmark output or this report.
- Real UI handlers with a desktop DOM fixture and indefinitely delayed persistence: **12.48 ms edit feedback, 12.49 ms delete feedback, 7.01 ms composer release**. All meet the fixture's 100 ms target. These timings include fixture node updates, not browser layout/paint.
- Reducer/context benchmark: local mutation P95 **0.43 ms**, maximum **1.33 ms**; scene/turn derivation maximum **6.51 ms**; context preparation **769.11 ms cold / 181.64 ms warm**. Total context duration is not a measurement of individual main-thread long tasks.

Reproduce the UI-handler benchmark with:

```sh
NERA_BENCHMARK_BACKUP=/absolute/path/to/newest.json node --experimental-vm-modules --test \
  --test-name-pattern='Long-story UX benchmark' tests/tools/benchmark-chat-interactions.mjs
```

The harness supplies settings revision 1 and Classic mode for this local copy, with the real vendored tokenizer. Director-specific interaction/state coverage runs separately in the regression suite. No production data is changed.

## Remaining limitations and phone checklist

- **Phone/browser rendering is unverified.** Fixture timings cannot establish actual touch, keyboard, layout, scroll, or paint latency. Large cold context calculations still warrant device observation; no tokenizer worker was added.
- Necessary conflicting actions still wait: generation must use completed settings/Director corrections, and validated destructive operations must finish persistence. Waiting is visible; dialogs remain dismissible and unrelated navigation remains available.
- Unfinished streamed prose is not continuously checkpointed. Browser suspension/termination can lose a partial reply. Confirmed local chat operations retain their existing replay behavior.
- Closing a Director thread does not directly close its lorebook thread; periodic extraction updates that separate record.
- Retained Settings/failed Director form drafts are page-memory drafts. Dismissing a dialog preserves them; closing/reloading the page before saving does not guarantee their recovery.

On the phone, check: edit/save a recent message and send without refreshing; delete an older visible turn; cancel generation and immediately type/send again; dismiss a pending Settings or live-state save and reopen it; edit Plan/lorebook text while a save finishes; navigate to a different card/story during a delayed action; check keyboard, scroll position and focus. Treat any failure as a new actionable reproduction rather than assuming the desktop timings prove it works.

## Release

Both Pages job guards deploy only `main`, after regression tests. Feature branches continue to run tests. Verify the final main commit's Actions test/build/deploy jobs and published `version.json` SHA. GitHub Pages source metadata must also point to `main`. Firestore deployment is outside this release.
