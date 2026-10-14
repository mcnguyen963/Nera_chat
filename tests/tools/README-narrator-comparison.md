# Narrator before/after comparison

This optional evaluator compares the Narrator builder at commit
`86b910f148ead0a983e9d26ee486d3a55915c3cc` with the current implementation.
It uses synthetic story data and identical validated Director contracts. It
makes no paid Director requests and never reads or writes Firebase stories.

Extract that commit with `git archive` into a temporary directory. The evaluator
checks a pinned fingerprint of its JavaScript, prompts and loader before use.
Prepare freezes eight requests, alternating old/new order for four scenarios:
arrival, pending choice, blocked travel, and emotional continuity with a longer
conversation. Both legacy and selective lorebooks are covered.

```sh
node --experimental-vm-modules tests/tools/narrator-comparison.mjs prepare \
  --baseline-root /path/to/frozen-baseline \
  --out investigate/narrator-comparison-1
```

For a focused retest after fixes, prepare in a fresh output directory with
`--suite candidate`. This freezes four new Narrator calls using the same scene
cases, and caps the run at four calls. It also requires fresh confirmation;
the existing eight-call allowance cannot be reused. Keep the earlier paired
results for review, and disclose any fixture or prompt changes.

Preparation only builds requests and reads the free endpoint catalog. A cached
catalog may be supplied with `--providers-file`. It does not read the API key.
Check `preflight.json` and `prepared.json`, then obtain fresh user confirmation
before running:

```sh
node --experimental-vm-modules tests/tools/narrator-comparison.mjs run \
  --out investigate/narrator-comparison-1 \
  --key-file /path/to/private/key.txt \
  --confirm-live yes --approved-budget 0.10
```

Model: `deepseek/deepseek-v4.1-flash:floor`. Reasoning: high. Eight calls maximum,
$0.10 total, $0.25/M input and $0.40/M output ceilings, no request fee, no retries.
The runner refreshes provider eligibility and validates the final production
serializer against the frozen requests. Code/request edits require preparation
and confirmation again. Used directories cannot be replayed.

Each request reserves a conservative UTF-8 byte bound plus maximum output cost.
Missing cost, unexpected provider/model, empty narration or truncation stops the
run. Requests, raw responses, routing, costs and elapsed time remain private in
the output directory. The exact API key is redacted from captures.

Review `blind-review.json` first, then use `review-key.json` to reveal variants.
For each output record hard failures (agency, stop boundary, canonical state,
lore and NPC knowledge) and rate NPC voice, emotional continuity and repetition
on a 0–2 scale. Compare within each scenario; subjective ties are inconclusive.
A candidate hard failure requires a fix and local regression verification before
release. Another paid run requires separate confirmation. Eight synthetic calls
do not establish broad model superiority, full-size-context reliability,
production persistence or browser/device behavior.
