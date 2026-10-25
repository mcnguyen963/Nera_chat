# Selective lorebook evaluation

This runner prepares requests and evaluates the real context builder, serializer, streaming client, scene validator, extraction parser, and canonical record codec. It never writes to production Firebase. Transactional extraction commits and Firestore rules have separate automated tests.

## Free preparation

```sh
node --experimental-vm-modules tests/tools/lorebook-eval.mjs prepare --out play-history/diagnostics/selective-eval
```

The default is a synthetic four-book story. An oversized unrelated passage puts pressure on the character budget, while a complete older immunity note and reviewed character cores remain useful. Preparation verifies exact source/metadata round trips, builds both legacy and selective serialized requests, runs the production tokenizer, and reads the public provider listing. It makes no completion request and requires no API key.

For the current story, supply a fresh native full backup JSON or single-story Nera JSONL export plus a scenario expectation file:

```sh
node --experimental-vm-modules tests/tools/lorebook-eval.mjs prepare \
  --fixture /path/to/story.jsonl --expectations /path/to/expectations.json \
  --anchor 'Friday 21/10/738' --out play-history/diagnostics/current-story-eval
```

The anchor override applies only to the local evaluation copy. Saved narrator/extraction prompts from the export are used. An account-wide multi-story backup is rejected; select one story. Existing direct fixtures can contain `session`, `lore`, `messages`, `storySettings`, and `expected` instead.

Example expectation file (adapt names and facts to the actual story):

```json
{
  "constraintInput": "Describe how Mira Vale responds to moonflower poison while honoring her established constraints.",
  "constraintTerms": ["moonflower", "immune"],
  "newNote": "Mira Vale locked the recovered letter in the blue chest.",
  "noteTerms": ["blue", "chest", "letter"],
  "followupInput": "Where did Mira Vale put the recovered letter? Continue from established NPC state."
}
```

Review `preflight.json`, both request previews, and the fixture before approving a paid run. Token estimates use the app's vendored tokenizer; conservative UTF-8 input bounds reserve extra cost. Estimates cannot establish provider tokenization or reasoning compliance.

## Separately approved paid run

The user's approval must be obtained immediately before executing this command:

```sh
node --experimental-vm-modules tests/tools/lorebook-eval.mjs run \
  --out play-history/diagnostics/selective-eval --key-file .secret/key.txt --approved-budget 0.10
```

Use `deepseek/deepseek-v4.1-flash:floor`, high narrator reasoning, and disabled/low extraction reasoning. The output rate ceiling is $0.50 per million tokens. The harness additionally fixes input pricing at at most $0.25 per million tokens and prohibits request fees so it can reserve a total bound. If no compatible provider is eligible, stop; do not substitute a model or relax the ceilings.

The ledger enforces $0.10 total and eight calls, including failed calls. Every request is sequential and reserved before submission. Unknown usage retains the whole reservation and blocks further calls. A run with existing ledger entries cannot be accidentally restarted. Raw request/response captures and parsed results redact the selected key and are written only to private local artifacts.

If the fourth `new-memory` response completes but omits only the required scene tag, stop and review its artifacts. After that review, the narrow `--continue-reviewed new-memory-missing-scene` option carries the previous scene as the app does and finishes the remaining scenarios. It requires exactly four settled calls, retains the original failure and responses, repeats no paid calls, and shares the original ledger and caps. Other failures and unresolved usage cannot use this continuation.

The eight scenarios are legacy/selective constraint comparison; a locally seeded 23:50 midnight continuation; a new event; disabled-thinking extraction; a next request after a local checkpoint removes that event from recent conversation; low-thinking extraction over the identical transcript; and OOC freezing. Local deterministic tests cover month/year and leap-day boundaries. Fixture seeds and checkpoints are explicit evaluation inputs, not claimed model outputs.

The next-request check requires the fresh fact in the *selected* record text, not merely in omitted records or a transcript. Extraction fails if it misses the declared new fact. Semantic characterization, constraints, player agency, reasonable estimated duration, and follow-up accuracy still need human review. Literal `noteTerms` are an extraction probe, not a semantic judge.

`results.json` always states that release review is required. Passing a small sample establishes observed compatibility only. Inspect serialized requests, raw responses, reasoning usage, actual routing and finish reasons; do not infer compliance just because a parameter was submitted. No browser or deployed-Firebase verification follows from this run.

## Expanded follow-up budget

After the user explicitly increases the session's total budget to $0.20, use:

```sh
node --experimental-vm-modules tests/tools/lorebook-eval.mjs followup \
  --out play-history/diagnostics/selective-eval --key-file .secret/key.txt --approved-budget 0.20
```

This keeps the same ledger, all prior spend, and the $0.50/M output-price ceiling. The expanded session has a 24-call safety ceiling; the scheduled follow-up adds twelve probes to the original eight. It repeats the previously omitted-tag scenario twice, checks an explicitly absent protagonist twice, entry and exit, month/year/leap-day rollover, AM/PM-to-24-hour conversion, a quoted future appointment, and OOC freezing. Follow-ups currently use only the synthetic fixture. The actual current story still needs its own export and scenario inputs.

Each boundary and attendee probe validates the model's raw modern format and its expected final date, clock and physical attendees. A structural failure stops further calls for review. After reviewing a settled failure, `--reviewed-through N` resumes only the remaining probes, where N is the ledger's last call number; it cannot replay calls or erase earlier failures. Unresolved usage cannot resume. The larger cost cap does not change routing or extraction thinking settings.

After the twelve follow-ups, `recovery` tests the existing recovery prompt, JSON schema and parser on the omitted original scene and AM/PM scene, with disabled thinking and the harness's stricter routing/price bounds. After those two probes, `backend-check --provider-tag TAG` repeats the absent and entering protagonist cases with identical message arrays on another eligible backend. Both commands require `--approved-budget 0.20 --reviewed-through N`, share all prior costs/counts, and keep the `:floor` model tag and output-price ceiling. The scheduled total is 24 calls. Recovery remains opt-in in the app; these probes do not change any live story setting.

Provider reference: [model endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model), [routing and price ceilings](https://openrouter.ai/docs/guides/routing/provider-selection), [floor variant](https://openrouter.ai/docs/guides/routing/model-variants/floor).
