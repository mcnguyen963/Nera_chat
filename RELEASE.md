# Owner-only release

The application runs on GitHub Pages with Firebase Authentication and Firestore. Pages publishes the UI from `main`; it does not deploy Firestore rules. No server or Cloud Functions are required.

## Website-only release with owner restriction deferred

The owner approved a website-only release on 2026-10-27, leaving the deployed Firestore rules unchanged. Pushing the app to Pages does not require replacing `OWNER_UID_HERE`; do not run the Firebase deployment command for this release. The checked-in owner-only rules and their predeploy guard are preparation for a separate rules deployment. Until then, removing the registration UI does not prevent direct Auth API registration or use of another account's own Firestore tree under the existing rules.

## Configure and deploy access rules first

1. In Firebase console → Authentication → Users, copy the intended owner's **User UID**. Confirm it belongs to the existing account that owns the stories.
2. Replace `OWNER_UID_HERE` in `firestore.rules` with that UID. **Never deploy while the placeholder remains.** The predeploy check rejects it. A wrong UID locks the owner out until the rules are corrected and redeployed; existing data is not deleted.
3. To approve a second owner, change the `isOwner()` return expression to `request.auth != null && request.auth.uid in ['uid1', 'uid2']`. Keep `owner(uid)` and every existing schema/migration restriction: approved accounts can access only their own `/users/{uid}` tree.
4. From the repository root, after verifying the UID, run:

   ```sh
   node scripts/check-owner-rules.mjs
   firebase deploy --project aichat-95df4 --only firestore:rules
   ```

5. For a release that enables owner-only protection, confirm owner access and second-account denial before publishing the UI removal. **Deploy the rules first**, or coordinate both in the same release. The explicitly deferred website-only release above does not enable this protection. Removing the registration form is not the access control.
6. In Firebase console → Authentication → Settings → User actions, untick **Enable create (sign-up)** if the option is shown. Some projects do not expose it. Direct Auth API registration can remain possible; the rules deny those accounts access to every Firestore user tree, including their own.

Permission failures use the application's existing friendly error messages. Rules changes make no document writes. If deployment fails, inspect the deployed rules in the console before proceeding; the UI release cannot substitute for that verification.

## Local validation and publication

Run Node 20 or newer:

```sh
node --experimental-vm-modules --test tests/*.mjs
git diff --check
```

The rules integration test requires the Firestore emulator with project **demo-nera-records**. It reads the allowed UID from the local rules and uses a synthetic token only inside that isolated project. For the unconfigured checked-in rules, that fake UID is the literal placeholder. Never deploy the placeholder to the real project.

The Pages workflow tests every branch and publishes only `main`. Its app-only assembly excludes `firebase.json`, `firestore.rules`, `RELEASE.md`, local registration helpers, tests, scripts, and private story data. After an authorized push, verify regression, build, and Pages deployment for that exact commit.

## Device and live-data acceptance

Automated mocks and the emulator do not establish physical iPhone or production Firebase acceptance. Keep these unchecked until performed against a copy of a story:

- [ ] Play ten phone turns across an evening transition. Time changes without an unsupported-time warning; each completed reply has scene metadata or a stored missing/reasoning-scene warning. Inspect two or three reasoning panes for disagreement with stale time.
- [ ] Interrupt a stream. Offer Keep for the dropped partial; a kept partial is marked cut off. Explicit Stop follows the newer behavior: discard unfinished output and free the composer.
- [ ] Interrupt a save, including once after it reaches the server. Save again and Save as new must retain one reply without a false conflict. Repeat after another device causes a chunk rollover.
- [ ] Sign in as the configured owner on iPhone Safari; sign out, reset the password, and change it. Inspect Safari Web Inspector for CSP violations. Add an origin only after a specific violation demonstrates the need; record the action, blocked URL, and resolution here. **Current result: not yet checked; CSP unchanged.**
- [ ] Create a second test account in Firebase console. In a clean online session or Rules Playground, verify `permission-denied` for `/users/<owner uid>`, nested owner story/chunk/lore paths, and the test account's own user/story tree. Confirm the configured owner still has access.
- [ ] Undo a reorganize without a false rebuild banner; remove notes from multiple cards and Undo, including a partially failed cleanup. Only changed cards should be restored.
- [ ] Confirm the rebuild banner estimates work and Dismiss preserves newer invalidations.
- [ ] Interrupt an import and verify its hidden unfinished story is swept after more than 24 hours.

## Current automated replay evidence

The original parent-path October 9 exports are absent. `play-history/history/dev 2 (1).jsonl` is a shorter snapshot through order 500. The newer `play-history/history/ dev 2 2.jsonl` retains the cited replies and summary 548. Offline checks on that newer file accepted evening/night for 538/545, rendered all twelve legacy rejected times and carried 536/543 as unknown, preserved summary 548 byte-for-byte during stamp stripping, and produced no turn stamps in a replay through order 549. This is reconstructed context, not a captured production request.
