# Embedding quality evaluation

The local evaluator exercises the real context builder, lore record fitter,
history index and final request fitting. It permits local Qwen embedding calls
only. It does not send narrator requests, call Firebase, or use provider keys.
Private snapshots, questions, vectors and request archives belong in the ignored
`production-reports/` directory; never commit them.

Freeze a snapshot and the original questions before tuning:

```sh
node --experimental-vm-modules tests/tools/embedding-quality.mjs freeze --fixture PATH
node --experimental-vm-modules tests/tools/embedding-quality.mjs run --fixture PATH --system both --split development --out PATH/candidate.json
```

The fixture directory contains `private-snapshot.json`, `history-cases.json` and
`lore-cases.json`. Cases use stable `id`, `group`, `split`, `query`, `required`
evidence anchors and, for lore, an optional `targetId`. Keep original questions,
labels, difficulty and source snapshots unchanged. Resolve ambiguous labels in a
separate audit; an unresolved label cannot pass. Fresh cases must be frozen
before optimization. Run `--split fresh` once a candidate is chosen. Every such
run is appended to `validation-exposure.jsonl`; exposed cases are no longer unseen.

Recall budgets are 1,200, 2,000, 4,000, 6,000 and 15,000 tokens, with at most 20
passages. Lore budgets and recent conversation remain fixed. Request archives
preserve the exact API messages; history captures reference an unchanged base
request plus their inserted recall message. Fingerprints bind reviews to those
captures, the fixture and application sources. `--resume` checkpoints work;
changed application sources require a separate candidate file.

## Strict grading

Anchor hits are diagnostics, not quality scores. A pass requires an evidence review
of complete answer evidence in the final request and every added passage. A
selected card whose required record was cut fails. Missing evidence, misleading
retrieval and unrelated added passages fail. An alternative source must support
the same required facts and be quoted from the captured request. Negative cases
also require checking the unsupported premise.

A review has this shape (hashes use the exported `qualityDigest` helper):

```js
{
  fingerprint: qualityDigest(result),
  requirementsSatisfied: true,
  reason: 'Explain which required facts the final request supports.',
  unsupportedPremiseChecked: true, // required only for negative cases
  alternativeEvidence: [{text: 'Exact request excerpt', reason: 'Same required facts'}],
  passages: [{hash: qualityDigest(passage), judgment: 'relevant', reason: 'How it answers this question'}]
}
```

Unreviewed cases fail acceptance. Score the reviewed captures with:

```sh
node --experimental-vm-modules tests/tools/embedding-quality.mjs score --run PATH/candidate.json --reviews PATH/reviews.json --out PATH/score.json
```

The report includes every failure, category results, missing captures, complete
suite results and fresh validation results. Both lore and history must reach
80% separately on the complete suite and fresh set. The smallest passing recall
budget wins. A 4b run requires `--zero-six-run` and `--zero-six-reviews`; the CLI
recomputes that gate from archived evidence and rejects 4b until it passes.
Indexes and embedding caches are isolated by model.

A later explicit user instruction can authorize a separate 4b comparison before
that milestone. Supply `--authorization PATH` to a private JSON record containing
`model: "qwen3-embedding:4b"`, `scope: "comparison"`, an ISO `authorizedAt`, and
the exact `userInstruction`. The run preserves that record. This exception does
not change the rubric, mark 0.6b as passing, or authorize paid story generation.

For a memory-constrained local comparison, `--batch-size 2 --ollama-context 4096
--ollama-compute-batch 32` uses Ollama's local `/api/embed` endpoint with truncation
disabled. An oversized input fails instead of silently losing evidence. The
underlying model identity and separate cache remain unchanged. The optional
`--shared-query-processing` applies the same 0.6b English query/keyword handling
to 4b inside the evaluation harness, fingerprints that override, and leaves the
application files unchanged. Record the options and monitor actual system memory,
swap and loaded-model use; a smaller model file alone does not establish safe RAM
use. Ollama documents [embedding runtime options](https://docs.ollama.com/api/embed)
and [model unloading](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately).

## Measurements and privacy

Reports record search/context-building time, index time and encoded vector size.
Cached vectors and memoized exact token counts accelerate replay. Cached index
time is not a cold provider benchmark; offline search time is not phone or live
service latency. Record a separate uncached run when measuring provider indexing.
The transport accepts only `http://127.0.0.1:11434/v1/embeddings` during evaluation.
The explicit local memory mode additionally permits its internal request to
`http://127.0.0.1:11434/api/embed`; neither route accepts a remote provider.
No paid final-story calls are made by this tool.

The initial measurement captures from November 1 were invalidated because an
evaluation proxy incorrectly enabled semantic lore in retrieval-off requests.
Only measurement version 3 or later fixes that issue. Invalid captures remain
private for traceability and must never count toward acceptance.
