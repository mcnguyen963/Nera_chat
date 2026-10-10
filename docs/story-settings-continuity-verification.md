# Story settings and continuity verification

Implemented without changing prompt Markdown, provider response formats, or automatic maintenance scheduling. The six-field story allowlist contains narrator, summarizer, extraction, reorganize and rewrite prompts, plus rewrite recent-message count. Model profiles, credentials, model selection, reasoning, context limits, summary preferences and pets remain shared. Scene visibility and stream vibration remain device preferences.

Each story stores explicit prompt strings at `users/{uid}/sessions/{sid}/storySettings/current`, with a schema version and revision mirrored by `storySettingsRevision` on the session. The immutable account migration seed lives at `users/{uid}/settings/storyMigration`; server-loaded account settings establish it once. Existing stories initialize lazily in a transaction. New stories use app defaults. Story saves compare only changed allowlisted fields to their opening values, retain unrelated remote changes, and reject overlapping changes with a reload/review message.

History and canonical scene changes increment evidence revisions and retire affected summaries. Fallback summaries must have known coverage ending before the change and must not be retired. Generated notes from an invalidated range stay excluded until rebuilt or explicitly reviewed; imported and user canon remain available. Extraction fingerprints include scene data, and commit guards reject intervening source edits. Summary Stop discards unfinished output and preserves the previous checkpoint; an already committed summary reports completion.

Copies and prefix branches inherit the current source settings by value, including zero-message copies. Destination stories stay hidden until their settings, history and lore are complete. Copy/export revision checks reject changes in history, lore or settings. Lore revisions commit with content changes. Story/account JSONL and full JSON backups include story settings; imports discard shared/device fields and retain the existing automatic-memory and fallback safeguards. Session deletion removes the settings subtree.

Duplicate review normalizes internal curly/straight apostrophes while preserving display spelling. Ambiguous extraction stops for review without moving its checkpoint. Merge selects a surviving card and, for threads, a surviving status. Background reconciliation replaces only confirmed text, backs up the server card atomically, retains notes, and supports Undo. Two missing narrative scenes expose a confirmation action that opens the existing editor with stale carried values. Coverage reports existing selection and book budgets; it spends no additional context and makes no model calls.

## Local verification

Validation: 613 tests pass with `node --experimental-vm-modules --test tests/*.mjs`; syntax checks on changed JavaScript and `git diff --check` also pass.

The regressions cover transactional migration and overlapping saves, story/account isolation and failed loads, all six serialized request paths, copy/export races, JSONL/full-backup round trips, summary cancellation, scene edits during extraction, summary fallback, duplicate review, atomic reconciliation and Undo. Requests use mocked providers and Firestore; no paid calls are made. The unchanged `investigate/save_conversation/ dev 2 2.jsonl` (581 messages) is replayed locally with 125,000 input tokens and 15,000 output tokens. Those replay settings are assumptions, since the export does not contain account/provider settings.

## Browser checklist

Browser execution is pending: Computer Use returned “Computer Use permissions are not granted.” Local mocks do not establish live Firestore synchronization or device behavior. Use disposable stories and a mocked provider for these checks; no paid model calls are needed.

- [ ] Open two existing stories; confirm each initially retains the preserved account prompts. Reopen on a second device and verify initialization happens once.
- [ ] Create a new story; verify app-default prompts, empty history and empty lorebooks.
- [ ] Save distinct prompts in stories A and B. Switch repeatedly, open context previews, and inspect narration, regeneration, rewrite, summary, extraction and reorganize requests for the selected story's prompts.
- [ ] Save prompts remotely while Settings is open: reload clean drafts; retain dirty drafts with a reload/review message. Save unrelated fields concurrently and verify both survive; overlap the same prompt and verify rejection.
- [ ] Simulate a failed story-settings load after switching from A to B. Confirm generation is blocked and A's prompts do not appear in B's preview.
- [ ] Save Model, Context & summaries and Pets; verify shared settings sync and story prompts remain independent. Verify vibration/scene visibility stay local. Change the quick model/reasoning controls and verify account synchronization.
- [ ] Copy a full story, a prefix branch and zero messages. Edit source/copy prompts and lore independently. Introduce a concurrent source edit while copying and verify a retryable error and no visible incomplete copy.
- [ ] Export/import story JSONL, account JSONL and full JSON backups. Verify story prompts survive and no profile credentials, shared context limits, pets or device values enter story settings. Import an old export and verify the preserved destination seed.
- [ ] Edit text or scene before an active checkpoint. Verify retired summaries remain in history, a valid earlier summary is selected when available, and obsolete summary facts disappear from the next request.
- [ ] Start normal and full-history summaries with a slow mocked response; press Stop during preparation, output and between chunks. Verify the old checkpoint stays active. Stop after commit and verify completion is reported.
- [ ] Simulate transport loss, timeout, Stop, API rejection, malformed output and terminal provider finish reasons. Only loss/timeout/Stop offer partial recovery; inspect original finish/error diagnostics.
- [ ] Open Lorebooks → Duplicate review. Merge the apostrophe variants into an explicitly selected survivor/status; verify notes, backups and Undo.
- [ ] Reconcile a card's background against later notes. Confirm replacement, verify retained evidence, add a concurrent note, then Undo.
- [ ] After two replies with missing scenes, use Confirm scene and verify stale values are prefilled. Save and verify revisions/invalidation; dismiss and verify no scene changes.
- [ ] Open context coverage; compare sent/omitted note counts, omission reasons, pending turns, batch size and lag with the request. Verify unused global space does not expand book budgets.

No automatic contradiction repairs, bulk story-content migrations, combat rules, or F11–F12 security work are included.
