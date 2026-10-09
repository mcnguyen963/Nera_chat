# System prompts

Built-in LLM instructions and labels live in this folder. `js/system-prompts.js` loads the registered Markdown files once at startup using `cache: 'no-cache'`. Missing or empty registered files stop startup. Edit the files and reload after publishing; no build step or generated prompt copy is needed.

## Narrative instructions

- `narrator.md`: dark fantasy narration, player agency for the configured protagonist, NPC knowledge and behavior, continuity, and the owner's 600-word visible reply cap.
- `author-direction.md`, `continuity.md`: author directives and source priority. Later chat establishes the current moment.
- `fixed-author-plan.md`, `plan-thread.md`, `plan-status-active.md`, `plan-status-inactive.md`, `no-plan.md`: the author's fixed plan and optional hidden pending-plan notes.
- `scene.md`, `reply-contract.md`, `scene-reminder.md`, `scene-reminder-plan.md`, `scene-recovery.md`: optional scene output and recovery contracts.
- `historical-summary.md`, `opening-exchange.md`: earlier-history wrappers. The narrator receives no app turn or message-order labels in these wrappers. Old summaries are cleaned when rendered, preserving stored text.
- `summarizer.md`, `summary-output.md`: summary instructions and output budget. The summary is the narrative layer next to the lorebooks: story sequence, voice, relationships, knowledge, and promises. Appearance, places, items, setting, and thread lists are left to the lorebooks. New summaries end with **Open stakes at the cutoff** and omit physical blocking and turn labels.

## Lore and maintenance

- `memory-extraction.md`, `memory-extraction-output.md`, `memory-extraction-frame.md`: extraction instructions and transcript frame. Extraction retains source turn stamps.
- `memory-reorganize.md`, `memory-reorganize-section.md`, `memory-reorganize-canon.md`: reorganize generated notes while preserving author text.
- `lore-labels.md`: named label templates consumed by `renderLoreLabel`. Values may contain placeholders; leading/trailing spaces are intentional.
- `memory-header.md`, `world-facts-header.md`, `story-memory-header.md`, `known-names-header.md`: context block labels.
- `lorebook-conversion-markdown.md`, `lorebook-conversion-json.md`: standalone prompts for externally converting an exported story.
- `omitted-turns.md`, `omitted-turns-summary.md`, `omitted-turns-partial.md`, `omitted-turns-partial-uncovered.md`: omission markers. Memory mode attaches the marker to retained user input when possible.

## Compatibility and default migration

`legacy-summary.md`, `legacy-fixed-plan.md`, `legacy-plan-presence.md`, `legacy-no-plan.md`, `legacy-plan.md`, and `legacy-author-direction.md` preserve the request path with all memory toggles off. The golden tests compare it with the frozen MAIN builder, including the complete obsolete plan-recovery rule and a summary followed by an uncovered gap.

Before changing a saved default, append its outgoing trimmed-text SHA-256 and settings key to `legacy-prompt-default-hashes.md`. Exact old defaults migrate when settings load; custom prompts remain saved. The four frozen outgoing texts are in `tests/fixtures/outgoing-prompts/`, with their source identified in `SOURCE.txt`. The duplicate extraction hash and unexplained `f630e25…` narrator trigger were removed. Fixed contracts such as continuity have no saved settings key; their outgoing source hash is documented in the B10 task report rather than made into an inactive migration trigger.

Keep the placeholders present in each template. Runtime facts, lore and transcripts remain data; do not add explanatory prose to registered prompt files unless it should reach the model. The unused `empty-plan.md` is no longer registered. `system-prompts.js` is the authoritative registry, and deployment checks require every registered file.

See [RELEASE.md](../RELEASE.md) for publication and owner acceptance steps. Local tests establish request assembly, not model compliance or live Firebase behavior.

MAIN's Rewrite default is preserved in `rewrite.md`, loaded by `js/rewrite.js` with `cache: 'no-cache'`. A saved custom rewrite prompt still overrides it.
