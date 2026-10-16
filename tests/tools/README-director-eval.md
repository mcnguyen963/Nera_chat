# Director–Narrator live evaluation

The opt-in runner uses `deepseek/deepseek-v4.1-flash:floor` on OpenRouter with `reasoning.effort: high` for both Director and Narrator. It enforces output pricing at most **$0.40 per million tokens**, input pricing at most $0.25 per million, no request fee, at most eight completion requests, and a $0.10 total reservation budget. The rate ceiling is separate from the total run budget. This high-effort evaluation allows 8,192 output tokens per Director call, including reasoning: a real-story run exhausted the earlier 4,000-token allowance before producing its contract. This evaluation setting does not overwrite a story's saved Director limit; 8,192 is a retest allowance, not proof that every high-effort run will fit.

The four synthetic scenarios cover a pending registration choice, a promise outside the Director's five-turn window after 30 intervening turns, a one-hour journey across game hour 24, and an impassable route. Actual Director contracts determine Narrator context and canonical scene. The runner exercises the production coordinator, context builders, tokenizer, serializer, non-streaming Director and streaming Narrator client. Storage is local/in-memory; no production Firebase data is read or written.

Prepare and review without an API key or completion calls:

```sh
node --experimental-vm-modules tests/tools/director-eval.mjs prepare --out investigate/director-eval
```

Use `prepare --suite chained --out investigate/director-chain` for four connected turns: finish dinner and activate an old promise, confirm travel across hour 24, receive a choice from the established healer, then answer it. Each turn uses the preceding real Director state and Narrator reply. A deliberately incorrect historical scene tag checks that it cannot override canonical state. The runner also checks that Regenerate reuses each completed contract and Continue makes no call at pending choices. Checkpoints are simulated in memory; this does not test Firestore persistence.

The application recognizes clear unquoted instructions such as “Stop when we arrive” and “stop upon arrival.” It passes that boundary to both models and rejects a completed-journey Director contract that opens a new player decision beyond it before saving or calling the Narrator. A genuine interruption may stop an attempted or blocked journey earlier. Other stopping instructions remain model-interpreted. The gesture review is a limited diagnostic, not proof that the prose preserves agency.

OpenRouter Director requests use request-specific `response_format: {type: 'json_schema'}` with `strict: true`, offered-ID enums and schema-aware token/cost bounds and a final system reminder beside the latest action. OpenRouter routing requires parameter support, and this evaluator checks both `response_format` and `structured_outputs` support before selecting routes for the Director. Other Director endpoints retain compatible JSON mode. Structured output does not establish character attendance or validate story semantics: the application still checks the schema, memory IDs, canonical state and player boundaries. Invalid replies stop before the Narrator or any state save; there is no automatic repair request. Narrator calls keep their normal prose format.

`prepared.json`, `previews.json` and `preflight.json` are private ignored artifacts. Narrator previews are provisional because the real Director has not yet answered. Model/provider eligibility is checked from the public listing; run checks it again before completions. Limits are never relaxed when no eligible route exists.

**Ask the user to confirm this exact run before executing any live completion request.** After confirmation:

```sh
node --experimental-vm-modules tests/tools/director-eval.mjs run \
  --out investigate/director-eval --key-file /path/to/dedicated-openrouter-key.txt \
  --confirm-live yes --approved-budget 0.10
```

The runner rejects changed prepared data/prompts/code, reserves each call before submission, records exact redacted requests and raw responses, reported reasoning tokens, actual model/provider, usage cost, latency, state transitions, and warnings. Unknown or over-bound usage stops further requests. Failure stops the run for review; there are no automatic retries. Completed or interrupted runs cannot be replayed in the same directory.

Hard checks verify JSON validity, expected scene/time and ledger outcomes. Prose quality, agency, natural stopping and whether the provider actually honored high effort require review of the captured outputs; reported reasoning usage alone cannot prove effort compliance. This does not establish long-context production quality, browser rendering, or deployed Firebase behavior.

Run `node --experimental-vm-modules --test tests/director-live.mjs` for a fully mocked rehearsal. The regular CI suite uses mocked responses only and never reads a real key or makes completion requests.

References: [model](https://openrouter.ai/deepseek/deepseek-v4.1-flash), [floor](https://openrouter.ai/docs/guides/routing/model-variants/floor), [routing and price caps](https://openrouter.ai/docs/guides/routing/provider-selection).
