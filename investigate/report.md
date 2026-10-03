# Scene-state and instruction-following investigation

Investigated on 3 October 2026 against the supplied request/export and the current working tree. **The failure has two layers: the tested model/provider does not reliably follow the supplied output contract, and the app had independent scene-handling defects.** The app defects below are repaired locally. A compact reminder produced one structurally valid scene, and an offline replay loads its correct character/location cards on the next turn. Model compatibility remains incomplete: that reply still invents player speech and time and omits the active plan breadcrumb.

## Evidence and limits

- `LLM_request.txt` is the console-captured request for the opening assistant response, confirmed by the user. The exported user text matches its final user message after `</memory>` exactly.
- `chat-history.jsonl` contains one header, one user message and one assistant reply. The header carries 85 lore entries, session settings and history invalidations. It is the entire **exported** history, not a multi-turn trace of later requests.
- The captured request has three system messages and one user message: instructions/fixed plan/scene contract, world facts, story events, then memory-wrapped user input. There is no repeated assistant history in this request. The narrator and rendered scene rules match the current Markdown files.
- The original provider SSE response, completion reason and endpoint were not included. Original creation timestamps are retained across history edits/regeneration and cannot establish the pairing independently. Seven new calls capture the missing response evidence.
- Exact input hashes, selection reasons, parsed fields and reconstructed next requests are in `baseline-replay.json`, `head-replay.json` and `fixed-replay.json`. Selection uses real app logic. Local token fitting uses `ceil(UTF-8 bytes / 4)` and assumes a 120,000-token app limit because that setting is absent from the capture; it is **not** native-model token evidence.

## Confirmed findings

| Finding | Evidence | Effect |
| --- | --- | --- |
| Model output violates player control and serialization | Original `mes` invents Nera's decisions/dialogue and has 1,356 words before an HTML-comment state report; `nera.message.scene` and `planThread` are null | No structured scene reaches the next request; unsupported player actions enter visible history |
| Hidden-looking output is ordinary visible text | `stripPlan` only strips recognized tags; rendering uses `textContent` | `<!--HIDDEN-->`, `<div class="hidden">`, `[Scene:]` and `<scene_state>` are not scene state and can be re-sent as prose |
| Labeled scene fields were not parsed correctly | A compliant fixture returned `when: "date: 18 September 731"`, `time: "time: unknown"`, `place: "place: West Reception Room"` | Labels contaminated values; unknown attendance could be treated as a person's name |
| Attendance was silently truncated | A 704-character fixture containing 25 names was cut to 300 characters and parsed as 10 names | Later attendees disappeared, and the final name could be partial |
| Historical mentions crowd out current actors | First-turn selection exactly reproduces Nera, Cassian, Ilyra, Isolde, Alaric and Liora under the six-card limit | Elise, Bastian Krail and the later-mentioned siblings are excluded before budget fitting; Crownspire also loads alongside the hearing room |
| Scene actors lost priority to unrelated mentions | A one-card reproduction selected an absent mentioned person ahead of a present person | Even a correct scene could fail to load the relevant card |
| Ambiguous scene aliases chose the first card | Two characters sharing `Mira` resolved arbitrarily | The wrong person's card could load |
| Every pure `<ad>` was classified as OOC | `<ad>Continue the hearing. Have Krail leave the room.</ad>` returned `true` | A valid narrative scene would be discarded, and omissions would not count as stale narrative state |

The labeled-place defect alone did **not** prevent the captured hearing-room card from resolving: the existing substring fallback could still match it. The original reply had no `<scene>` at all, so parser corrections alone cannot explain or fix its failure.

The six-card opening omission remains a separate settings/bootstrap issue: no previous scene exists at that point. A generic name matcher cannot infer physical attendance from the first-person opening without guessing. The fixes prioritize a supplied scene, but do not fabricate one or rewrite your session settings.

## Seven real provider calls

Every request used **`z-ai/glm-5.3-flash:floor`**, **`reasoning.effort: high`**, **`max_tokens: 15000`**, and streaming. All seven returned `z-ai/glm-5.3-flash` from **OpenInference**, with `finish_reason: stop`. The resolved response ID omits the routing suffix; the archived requests retain it. The first two request hashes match the captured request byte for byte. Call 7 adds a compact final system reminder and a provider price ceiling; all original messages and model/thinking settings are preserved.

| Call | Scenario | App-visible words | Result |
| --- | --- | ---: | --- |
| 1 | Exact baseline | 1,243 | First-person player actions; HTML hidden report; no scene or plan-thread tag |
| 2 | Exact baseline | 853 | Visible `[Scene: ...]` report; no scene or plan-thread tag |
| 3 | Combine consecutive system messages, preserving all text | 705 | No scene or plan-thread tag |
| 4 | Same combined-system candidate | 806 | No scene or plan-thread tag; ends with an unrequested "What do you do?" |
| 5 | Valid synthetic opening scene, then AD asks Krail to leave without moving Nera | 921 | Invented player decisions/dialogue; third-person narration; `<scene_state>` instead of `<scene>` |
| 6 | OOC attendance question after call 5 | 86 | Correctly brief, no narrative advancement or scene tag; **incorrectly lists Krail inside** after his narrated exit |
| 7 | Original request plus compact system reminder immediately before the user | 805 | Valid final `<scene>`; correct five named actors and room; invented Nera speech and unsupported `late morning`; no active-plan tag |

App-visible word counts include unrecognized state reports because the app renders them as text. They are not automatically equivalent to story-prose word counts.

The calls cost **$0.011969431182 total**, approximately **$0.012**, from returned usage, well below the authorized $0.50 ceiling. Call 7 cost $0.001463116203. Raw requests, complete SSE responses, reasoning, usage, providers and parsed output are archived under `live/`. Seven distinct response IDs confirm seven completed provider calls; the initial sandbox DNS failure did not contact the provider or consume a completion. No summary, extraction, automatic retry or repair calls were made.

**Observed narrative scene structure: 0/5 before the reminder, 1/1 with the reminder.** The valid tag does not make the latest reply fully compliant. Combining system messages did not fix the format, and neither experimental prompt variant is applied to production. Normal completion and output usage well below 15,000 tokens rule out output-limit truncation for these replays. They do not establish that the original response completed normally, or prove whether the model itself or upstream request transformation caused the weak instruction following. No transformed upstream request was captured.

Call 7 narrates Nera saying `"Isolde."` without user authorization and supplies his private interpretation of the room. The source says Nera awakened that morning, not that the hearing is in late morning; the response reasoning explicitly guesses the current time. Its reasoning also treats the fixed plan as absent despite the full fixed plan in the request. The 805-word visible reply slightly exceeds the 800-word limit. These failures make the reminder a promising structural experiment, not a verified behavior fix.

`reminder-replay.json` passes the actual seventh response through the strict inspector and real next-request builder offline. It resolves Nera Veyrath, Bastian Krail, Elise Fen, Liora Fen and Isolde Veyless plus West Reception Room. This verifies the provider-output-to-context path locally, without an eighth provider call. It also shows the limit of structural validation: the unsupported time passes because it is well formed.

The OOC request was prepared before the AD classification repair: its prior narrative reply was incorrectly marked OOC, so the old snapshot was not labeled stale. Its recent history still contained Krail's departure. `ooc-after-fix-request.json` is an **offline**, unsent reconstruction showing the repaired stale-scene label and warning; post-fix provider behavior is unverified.

## Changes implemented locally

- Scene parsing understands the current labels, maps unsupported values to null/empty attendance, preserves separators within labeled values and still accepts historical positional records.
- Scene extraction/editing supports up to 2,000 characters. Larger output is rejected as a whole instead of truncating names; oversized manual edits fail before storage writes. Existing imports are not rewritten.
- Fresh narrative replies with scene tracking enabled require one correctly labeled final tag. Missing, duplicate, malformed or misplaced tags leave scene metadata null and show a warning **after saving the narration**. Historical parsing and scene-disabled handling remain tolerant. No automatic LLM repair call is added.
- Current-scene actors precede other mentions under card limits; always-load entries retain priority. Exact canonical names beat aliases; ambiguous scene names are reported rather than assigned arbitrarily. Your existing first-name indexing change is retained.
- Narrative ADs are no longer automatically OOC. Explicit `<ooc>`, `OOC:` and `[OOC]`, clear AD questions and summary requests preserve the established scene. Mixed summary/progression requests remain narrative. This is a conservative English heuristic, not a semantic intent classifier; explicit OOC marking is safest for ambiguous wording.
- The next-request report warns about missing scene metadata and identifies the prior snapshot's cutoff. Valid scene fixtures load all five opening actors and West Reception Room; Magerrett and Taigar remain outside the fixture's attendance.

No prompt text, fixed story plan, original investigation input or saved story was changed. Existing `.gitignore`, `memory.md` and first-name-indexing work is preserved. No commit or deployment was made.

The strict scene inspector checks structure, not truth. It cannot prove that a plausible date, name or location agrees with story events, or detect every invented player action. Malformed hidden-looking reports remain visible prose rather than being converted into trusted state.

## Prompt and memory compatibility audit

The narrator, AD, continuity, fixed-plan and scene contracts all request the behavior the failed response omitted. The scene prompt is actually present; this is not an obsolete saved-default problem. The fixed plan leaves punishment and other player decisions pending. It must not be rewritten to encode the model's invented decisions.

Summary and memory-extraction prompts use separate task/output formats. They are not present as narrator task instructions in the captured request. The original session has no active summary, and memory updating is paused with `needsRebuild: true`; imported background/timeline records still appear. Those records repeat some opening facts and contain hidden truths. That is a context-quality hypothesis to review, **not proof that all imported lore is stale or should be deleted**.

Because extraction reads visible story text, an invented player decision could later become a memory update if accepted history is summarized/extracted. The paused updater was not resumed and no saved canon was repaired automatically.

Provider references checked on 3 October 2026:

- [OpenRouter API reference](https://openrouter.ai/docs/api/reference/overview): messages, streaming, response/usage fields, and unsupported-parameter handling.
- [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens): reasoning can share the output-token budget; high effort alone does not establish compliance.
- [Floor routing announcement](https://openrouter.ai/blog/announcements/introducing-nitro-and-floor-price-shortcuts/): `:floor` selects the cheapest provider for the requested model.

## Verification and remaining work

**134 local tests pass**, plus syntax checks for the changed production modules and investigation runners, and `git diff --check`. The new cases failed before the corresponding fixes. They cover long attendance persistence/reload, no partial writes, labeled/legacy/unknown parsing, malformed tags, canonical/ambiguous names, caps, actual chat-save warnings, narrative AD handling and OOC preservation. Local storage/UI tests use substitutes; deployed Firebase, physical devices and the published site were not tested.

`next-experiment-request.json` adds the compact `next-output-contract.md` system reminder immediately before the final user message, after lore and the fixed plan. It was sent once in call 7 and is **not applied to the app**. The single successful tag supports testing instruction proximity; it does not establish repeatability, progression/OOC behavior or semantic correctness.

After the initial six calls, the user raised the cumulative ceiling to **$0.50**, conditional on confidence that a fix would work and minimizing calls. Automatic approval review initially rejected the seventh experiment under that certainty condition. After the user explicitly approved one uncertain experiment, call 7 completed. Paid checks stop here because the result still violates important instructions; there is no evidence-backed claim that another call will make behavior correct.

Before promoting a prompt change, resolve the contradictory reading of the active fixed plan and test explicit player-agency and unsupported-value instructions. Then verify fresh opening, narrative AD departure and OOC attendance against both prose and persisted state. A correct tag alone is insufficient. Do not use the remaining budget merely to repeat a failing contract.

Before evaluating a fresh opening in the app, review its first-turn card limits/budgets or provide a deliberate starting-state mechanism. Do not treat background references to Cassian, Ilyra or Alaric as physical attendance. Keep the user-approved date and location; current time remains unknown unless independently established. Review invented actions before regenerating or continuing the faulty saved reply.

Reproduce local evidence from the repository root:

```sh
node --experimental-vm-modules investigate/replay.mjs
node --experimental-vm-modules investigate/analyze-live.mjs
node --experimental-vm-modules investigate/replay.mjs --live=investigate/live/8-reminder-parsed.json --out=investigate/reminder-replay.json
node --experimental-vm-modules --test tests/*.mjs
```

`analyze-live.mjs` reparses archived responses without making requests. `live-checks.mjs` requires the local ignored key, serializes execution and reserves a conservative per-call amount against the new $0.50 ceiling. Newly prepared reminder scenarios include an [OpenRouter price filter](https://openrouter.ai/docs/guides/routing/provider-selection#max-price), without changing the model or reasoning setting. Each scenario runs once unless an explicit repetition is prepared. Actual transmitted payloads remain archived separately from offline post-fix/next-experiment payloads. Investigation artifacts contain private story text but no copy of the API key.
