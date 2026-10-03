# System prompts

All built-in LLM instruction text lives here. The app loads the Markdown files directly at startup, once per page load. Edit the files, publish the site as usual, and reload the app; no generated JavaScript prompt copy is needed. Missing or empty files stop loading with an error.

## Where to edit

- `narrator.md`: dark fantasy narration, Nera's player control, NPC behavior and knowledge, context interpretation, style, length and a compact private workflow. It contains no plan references.
- `author-direction.md`: scoped author directives, markup handling and OOC replies.
- `continuity.md`: the shared source-priority, attribution and chronology rules. It is also supplied to summary and memory operations.
- `fixed-author-plan.md`: the user-controlled outline and hidden plan-thread rules, injected separately from the narrator default.
- `scene.md`: the optional hidden scene-tag contract, including exact fields, full names, unknown values and the OOC exception.
- `summarizer.md`, `summary-output.md`: summary task and runtime output budget.
- `memory-extraction.md`, `memory-extraction-output.md`: memory-update task and mandatory source-turn/output contract.
- `memory-reorganize.md`: consolidating update lines without changing author text.
- `lorebook-conversion-markdown.md`, `lorebook-conversion-json.md`: standalone prompts exported for external conversion. Each includes its own input instructions because it is used independently.
- `historical-summary.md`, `opening-exchange.md`, `memory-header.md`, `world-facts-header.md`, `story-memory-header.md`: context templates and labels.
- `known-names-header.md`, `memory-reorganize-section.md`, `memory-reorganize-canon.md`, `empty-plan.md`: additional request templates.
- `legacy-narrator-default-hashes.md`: SHA-256 identifiers for two obsolete untouched app defaults. These identifiers are migration data and are never sent to the model; conflicting old prompt text is not retained.

The previous narrator draft has been consolidated into `narrator.md`. Shared contracts are defined in their own files rather than repeated in the narrator. The obsolete plan-loss rule and the repeated memory-block plan reminder were removed.

Keep the placeholders used by each template: `{{PROTAGONIST}}`, `{{PLAN}}`, `{{MAX_OUTPUT_TOKENS}}`, `{{CUTOFF}}`, `{{SUMMARY}}`, `{{TURN}}`, `{{CONTENT}}`, `{{SECTION}}`, `{{KIND}}` and `{{TEXT}}`. The code fills them at runtime. Do not add explanatory prose to prompt files unless you want it sent to the model.

## Existing accounts

The two exact obsolete narrator defaults are replaced with the current default when settings load or sync. Custom prompts stay as saved. To use the new narrator with an existing custom prompt, reset prompts in Settings and save, or copy `narrator.md` into the narrator field. The migrated value is saved to Firestore on the next explicit Settings save.

Story facts, user-authored outlines, lorebook entries and transcript formatting remain runtime data. Local tests check request assembly and settings migration; they do not establish provider compliance with the prose or hidden-tag rules.
