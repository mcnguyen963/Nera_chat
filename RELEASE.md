# Release procedure and acceptance

Status on 2026-10-08: local implementation complete, with 475/475 automated tests passing after the merge into main. No deployment, Firebase console change, live provider call, Chrome acceptance run, or iPhone Safari acceptance run is claimed. Running release stamp: local/unpublished. Record the actual deployed SHA/date below when the checklist is run.

## Owner-managed registration and rules (S1)

The owner asked to handle registration restrictions in Firebase. S1's local sign-up removal and owner-only rules were therefore skipped. This checkout still contains the registration form and its current UID-scoped rules allow any authenticated user under their own UID. Disabling sign-up alone does not exclude other accounts that already exist.

1. Firebase Console → Authentication → Settings → User actions: disable **Enable create (sign-up)**. The existing owner account keeps working.
2. Authentication → Users: copy and independently verify the owner's Auth uid. `js/firebase-config.js` identifies the project and contains no account uid.
3. Before deploying rules, replace the existing allow condition with `isOwner() && request.auth.uid == uid`, where `isOwner()` checks a signed-in uid against the verified owner uid. Do not require `email_verified`. A second approved account can later be added with `request.auth.uid in ['owner-uid', 'second-uid']`.
4. Keep the default D4 rule choice: no additional `get()` check of tombstones in Firestore rules. Client transactions enforce existing, non-deleting stories. Enabling a rule lookup would add a billable dependent read per affected write.
5. Optional: restrict the Firebase browser API key to the Pages origin in Google Cloud Console. App Check was not added.

A mistaken UID causes permission errors, not deletion; correct and redeploy the rules. Test owner sign-in/read/write and a second account's rejection before announcing.

## Publish from main (S3)

Every push runs `node --experimental-vm-modules --test tests/*.mjs` on Node 20. Only `main` builds and deploys, after tests pass. The app-only assembly excludes tests, investigations, backups, reports and top-level plans. All relative modules, boot and CSS receive the same `?v=<sha8>` stamp. `_site/version.json` records SHA and build date. No custom secrets are required by the current embedded public web configuration; future required secrets must be checked for non-empty values before building.

Rules deployment is manual; no Firebase token is stored in CI. After the verified owner rule change, use an authenticated Firebase CLI and a temporary config:

```sh
firebase login
```

Create `/tmp/nera-firebase.json` with:

```json
{"firestore":{"rules":"/Users/nguyen/VS Code/AI-dungeon-master/AI chat/firestore.rules"}}
```

Then run:

```sh
firebase deploy --config /tmp/nera-firebase.json --project aichat-95df4 --only firestore:rules
```

Do not deploy the currently permissive rules as if owner-only protection were implemented. Publishing and this console step remain owner actions.

## Manual checklist (P4)

Run each row in desktop Chrome and iPhone Safari unless marked desktop only. All rows currently **Pending**. Record date, SHA stamp, device/browser, result and evidence for each row.

| Check | What to verify | Chrome | iPhone Safari |
|---|---|---|---|
| Auth | Owner signs in, sends and reloads; sign-up disabled; other accounts refused clearly | Pending | Pending |
| Deploy | One ordinary reload loads a single new `?v=` stamp; old focused tab offers Reload | Pending | Pending |
| Send | Ten turns with Scene and memory; Stop says stopped; offline save retains text and Save again succeeds | Pending | Pending |
| Two devices | Send versus regenerate gives an unsaved conflict; deletion versus memory writes creates no orphan cards | Pending | Pending |
| Delete | Interrupt after tombstone; story stays hidden; reconnect/restart finishes sweep | Pending | Pending |
| Import/export | Long-story counts round-trip; memory automation off; malformed/null lore handled; account archive download/cancel works | Pending | Pending |
| Memory | Oversized note/full card skips reported; NONE plus prose succeeds; 300-message reload gives no false deletion badge | Pending | Pending |
| Reorganize | Deleted unsent line stays deleted; generated/user counts accurate; preview holds its lock | Pending | Pending |
| Quota | Inject resource-exhausted/unavailable; friendly errors; paid reply retained | Pending | Not required |
| iOS layout | Keyboard, composer, edit growth and transformed drawer have no blank gap/zoom | Not required | Pending |
| Blocked storage | Private/blocked localStorage and IndexedDB still render messages, scene chips and memory settings | Pending | Pending |
| Quota sanity | After 20 turns inspect actual console reads/writes; target about 12 reads and 4 writes per turn plus maintenance | Pending | Pending |

Additional prompt check: in the owner's dev 2 story choose memory block role **User**, regenerate five times and inspect reasoning for stale T204/old-scene anchoring; then play ten turns and summarize. The new summary must end with Open stakes at the cutoff and contain no app turn labels. The provided local export differs from the Appendix source, so its local replay results cannot establish the owner's exact 64-message acceptance case.

Additional navigation check: open Lorebooks for one story, switch stories, reopen and use Back; only the view's own history entries should pop. Closing Catch-up before starting must not cancel an automatic update.

Pure device/layout acceptance cannot be reproduced by the DOM harness; the keyboard, Safari download, CSP/Firebase sign-in and pet IntersectionObserver behavior require the rows above. `frame-ancestors` cannot be enforced by a meta CSP; it requires a response header unavailable in ordinary GitHub Pages configuration.

## Local evidence and recovery

See `production-reports/IMPLEMENTATION.md` and the per-task reports for automated results, changed files, read/write costs and limitations. Local backup files are retained as `*.bak` under `production-backups/`; delete them only after the owner accepts the work. The owner subsequently authorized smaller commits and pushing the implementation to the feature branch. Backups stay local and are excluded from commits.

A pre-tombstone deletion failure is queued in memory and, where available, IndexedDB for reconnect/startup cleanup. A completed reply whose save fails remains local, with Copy/Save again/Discard. Conflict retries do not call the model. IndexedDB persistence is best effort; blocked storage preserves the visible reply for the current visit. Background memory runs only after saved narration. Multi-card restore/removal can complete earlier card transactions before a later failure; each changed card has a server backup. Story deletion retains a tombstone until all sweeps finish.

Account export is a combined JSONL archive with `neraStorySeparator` records followed by each ordinary v2 story JSONL. For restoration, split at those separator records and import each story block; the ordinary importer rejects the combined archive rather than silently combining stories. Export reads each story document, each message chunk and each lore card, plus initial session listing and legacy migration overhead where applicable.

## Main integration on 2026-10-08

Merged the story-memory implementation with the current remote main, preserving MAIN's Rewrite, streaming vibration, manual Sync latest data and full JSON backup. Input usage remains visible; only the max-reply suffix was removed from the usage line. Max response tokens still works as a setting. The deployment workflow runs tests on every branch and automatically builds/deploys successful pushes to main.

The merged tree passes 475 automated tests. The added Rewrite default lives in `system prompts/rewrite.md` and is included in deployment. Full JSON backup checks the session before and after reading messages and lore: two session reads plus one per chunk and lore card; no writes or model calls. Manual Sync is user-initiated and reloads server history using the existing reconciliation path. Live Firebase and desktop/iPhone acceptance remain pending.
