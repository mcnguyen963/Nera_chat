# Director–Narrator live evaluation

The opt-in runner uses `deepseek/deepseek-v4.1-flash:floor` on OpenRouter with `reasoning.effort: high` for both Director and Narrator. It enforces output pricing at most **$0.40 per million tokens**, input pricing at most $0.25 per million, no request fee, at most eight completion requests, and a $0.10 total reservation budget. The rate ceiling is separate from the total run budget.

The four synthetic scenarios cover a pending registration choice, a promise outside the Director's five-turn window after 30 intervening turns, a one-hour journey across game hour 24, and an impassable route. Actual Director contracts determine Narrator context and canonical scene. The runner exercises the production coordinator, context builders, tokenizer, serializer, non-streaming Director and streaming Narrator client. Storage is local/in-memory; no production Firebase data is read or written.

Prepare and review without an API key or completion calls:

```sh
node --experimental-vm-modules tests/tools/director-eval.mjs prepare --out investigate/director-eval
```

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
