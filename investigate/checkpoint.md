# Separate scene extraction — implementation checkpoint

Stopped at the user's request on 3 October 2026. This is a tested foundation, not the completed rollout. Changes remain uncommitted. Nothing was deployed and no saved production story or lore was modified.

## Completed at this checkpoint

- Added `js/scene-extraction.js`: a strict JSON scene snapshot, evidence checks for changed fields and attendance, prior-state retention for unsupported changes, name/alias resolution, extraction provenance, and successful-call usage/latency metadata.
- Extraction inputs contain only the prior scene, latest user input, narration, and canonical character names/aliases. They exclude the author plan, older conversation, and lore-card prose. OpenRouter defaults to GLM Flash floor without requesting reasoning; narrator settings are untouched.
- Added a writing-only contract and a fixed-plan framing that preserves the author's plan text without requiring scene tags or plan breadcrumbs.
- Added the isolated context-builder path: current app scene snapshot even without the optional memory block, no reinjected scene/plan tags in assistant history, and one nearby writing reminder.
- Added internal normalized settings `sceneMode` (default `tag`) and `sceneExtractionModel`. The new mode has NO settings UI at this checkpoint. The builder also requires explicit `separateSceneExtraction: true` from its caller, which the production turn flow does not pass. Existing sessions therefore continue using the existing narrator-tag path.
- Stale inferred snapshots now remain marked stale when reloaded.

## Validation

`node --experimental-vm-modules --test tests/*.mjs`: **147 passed, 0 failed**. Syntax checks for the new extractor and changed context builder, plus `git diff --check`, passed.

Four new tests cover writing-only context and unchanged fixed-plan content, explicit gating of the unwired mode, next-request character/location cards after a supported departure, exclusion of outsiders and unsupported changes, forged evidence and NPC clock claims, proposed departures, and independent extraction request settings. These use fixtures/stubs, not a live provider.

No additional paid calls were made. The existing ledgers contain **52 completed calls**, **$0.072862261182** in returned usage cost, and no started calls. The new extraction schema, provider routing, browser UI, and Firestore integration have not been live verified. The earlier 29/30 score refers to archived output-contract checks, not this new mode or complete semantic writing compliance.

## Resume here

1. Connect the gated context path and extractor to the narrative turn flow. Skip OOC and pending-review turns; complete extraction before the next story request. Preserve prose and stale prior state on extraction failure, with a visible warning and explicit retry/manual correction.
2. Tie extraction to reply/history/author-input revisions and guarded persistence. Discard obsolete results after edits, regeneration, deletion, account changes, or session switches. On acceptance or edited prose, extract from the accepted text rather than promoting rejected metadata.
3. Separate extraction from the automatic-maintenance slot. Permit narrator + extractor + at most one automatic maintenance call. Prioritize urgent summary over lore updates, serialize maintenance per session, retain acceptance gates, and leave the paused updater paused. Ensure automatic summary chunking cannot quietly exceed the call limit.
4. Add the opt-in settings control only once the turn flow is connected. Expose extraction freshness, warnings, retry/manual correction and call metadata in the UI/context inspector. Add orchestration/storage tests before enabling the option.
5. Consolidate the archived eval report with the later agency/time lint and manual findings. Preserve archived scores separately from any re-analysis. The user requested fewer live calls: reuse saved replies and local fixtures; do not run the proposed repeat matrix automatically.

The extraction evidence rules are deliberately conservative and heuristic. Literal excerpt support is not proof of semantic truth. Alias ambiguity, negation, indirect movements, unnamed/new NPCs, and player-authorization interpretation still need review before promoting the new mode.

Preserve unrelated changes in `.gitignore`, `memory.md`, and the preexisting first-name lore indexing. Stage only the authorized implementation scope if a later commit is requested.
