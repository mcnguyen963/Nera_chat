# Memory update fixes

Implemented locally on `feature/story-memory`. No LLM calls were made, and no stored story or lorebook was changed.

## What changed

- Memory extraction and reorganization use the chosen profile's thinking settings without forcing reasoning off. The selected model, including `:floor`, and memory task output budgets remain unchanged.
- The first failure shows its actual error in the toast, Memory settings, and context inspector. A failed manual update no longer produces a misleading “nothing to update” message.
- Catch up and Rebuild report when they stop after a failure instead of claiming completion. Previously saved batches remain saved.
- An oversized note or full card stops the batch without advancing its checkpoint. A full card discovered during the Firestore transaction rolls back every write in that batch.
- Raw-answer inspection shows the current attempt, including failed streamed output when available. Partial output is never committed as memory.
- Narrator lore now includes source turns, dates, snapshot cutoffs, and author/background labels. Their token costs are included in the request budget.
- Shared instructions distinguish a summary's ending from the current scene. Later confirmed completion supersedes an older expectation; extraction is instructed to close completed threads by their existing titles.

## T204 verification

A synthetic local test reproduces the reported conflict: a T204 summary ends mid-hug and expects class postings, while later dialogue establishes the common-room morning and published placements.

The assembled request contains the historical T204 cutoff, later T205 scene and placement evidence, and the newest question about Isolde delivering facilities records. Stored thinking is absent. The final message remains the current user input, and the rendered payload fits its counted budget.

This checks the app's request construction, not whether the provider will follow the instructions.

## Checks

- `node --experimental-vm-modules --test tests/*.mjs`: 301 passed.
- Syntax checks passed for all 11 changed JavaScript/test files.
- `git diff --check`: passed.
- Tests use mocked responses and local prompt files; no provider requests.

## Existing stories

These fixes do not rewrite old summaries or contradictory imported lore. After deploying and reloading, open Memory settings to see the actual error. If memory is paused, resolve that error and press Retry. A full card needs Reorganize or a manual edit before Retry.

For an already completed class-posting thread, review its stored status and mark it closed if the story confirms completion. Do not reset the summary checkpoint just to address this conflict.

Live provider and Firestore behavior have not been tested in this review. Changes remain uncommitted.
