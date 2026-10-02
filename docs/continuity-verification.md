# Context and memory continuity repair

Both context modes use `memory-context.js` through `context-builder.js`. The fixed author plan remains in the system message. Requests reserve the reply budget, count all rendered tags and message framing, and prioritize the summary, opening anchors, latest user, and recent complete turns before optional lore. Framing remains a conservative estimate; the configured provider's tokenizer and limits still need live validation.

Opening messages are historical background. Section text carries origin and a canon, snapshot, or background classification. Existing unclassified imports become background with an unknown cutoff. Imported beliefs and official accounts remain attributed rather than becoming current truth. The lore editor can declare author canon or assign an existing narrator turn as a snapshot cutoff.

New messages persist a revision and stable narrator turn. Existing chunked sessions gain this metadata lazily before their first mutation or generation. Legacy message documents remain untouched. History edits invalidate the active summary when its covered range is affected and exclude generated notes derived from the affected history. Notes remain visible under Needs review. Rebuild is an explicit lorebook action; it backs up the cards and retains previous generated notes for review.

Narration, summaries and extraction commit only when their captured history and author inputs still match. Message changes use transactions. Cached chats attach subscriptions immediately and check the server history revision before generation or maintenance; unchanged revisions reuse history. Enabled lorebooks await initial readiness and refresh from the server when their revision changes.

Narrative metadata is sent as prose, plan thread, then scene. Explicit pure author/OOC questions preserve the prior scene even if the provider emits a new scene tag. A scene fallback always carries its source cutoff. Summaries fit the next narrative request before their checkpoint is activated. A preflight summary consumes the turn's automatic maintenance slot; all automatic features remain off by default.

Lorebook JSON and Markdown exports use version 2 metadata and accept version 1 inputs. Nera's JSONL chat export remains compatible with ordinary chat readers and carries its version 2 session, lore and message metadata in additional fields. Copies preserve the fixed plan, stable message metadata and only memory evidence through the selected cutoff.

## Local verification

Run `node --experimental-vm-modules --test tests/*.mjs`, syntax-check the changed JavaScript, and run `git diff --check`. The tests use isolated provider and Firestore substitutes; they do not establish deployed Firebase, provider, browser/device or billing behavior.

## Live acceptance to run with an authenticated test story

1. Open the same disposable story on two devices. Edit different messages concurrently. Confirm both edits survive, history revisions change, affected summaries disappear, and derived notes appear under Needs review.
2. Close and reopen a cached story, change an old message from the other device, and send a new turn. Confirm the first device refreshes that history before sending. Repeat with unchanged history and inspect Firestore reads to confirm it reuses the cache.
3. Enable lorebooks on a test story and reconnect. Confirm the first request waits for them and that author edits made during generation cause the result to be discarded.
4. Through the configured provider, send narrative and pure `<ad>...</ad>` questions. Confirm narrative scene tags contain only established conditions, OOC replies preserve the scene, and `<plan>` output cannot modify the fixed author plan.
5. Regenerate the latest reply, copy through an earlier reply, and edit/delete an evidence message. Inspect the request preview for excluded notes and snapshot cutoffs, then explicitly rebuild memory and inspect the backed-up/review notes.
6. Enable auto-summary with a small test budget. Confirm uncovered history is summarized before narration, the summary fits with the recent window, and only one automatic maintenance job runs for the turn. Export/import both formats and compare attribution and provenance.

No live Firebase writes or configured-provider acceptance calls were made during the local implementation run. The narrator prompt source and unrelated worktree edits were preserved. No commit or deployment was made.
