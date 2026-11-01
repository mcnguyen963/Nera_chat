# Local 4b comparison — November 1, 2026

The user authorized this comparison before the unfinished 0.6b history milestone.
It does not mark 0.6b as passing or authorize paid final-story calls. The app's
default model and the user's story/cloud data have not been changed.

## Lore result

| Frozen set | 0.6b | 4b |
| --- | ---: | ---: |
| Original development | 28/32 — 87.50% | 28/32 — 87.50% |
| Same 20 validation cases | 16/20 — 80.00% | 17/20 — 85.00% |
| Complete | 44/52 — 84.62% | 45/52 — 86.54% |

These are strict, request-bound **agent adjudications**, not independent human
grading. The validation questions were already exposed by the 0.6b evaluation;
they are the same frozen comparison set, not newly unseen questions. Questions,
expected facts, lore budgets, passage limits and grading rules are unchanged.
The 4b run uses the same English history-query processing as the optimized 0.6b
candidate through a fingerprinted evaluation-only override.

For 43 lore cases, the complete final request and every added evidence record
were identical to a previously adjudicated request, so the exact earlier review
was retained. Nine changed captures received explicit new reviews. Required
record content, unrelated additions and unsupported premises were checked.

The net gain is one case. 4b avoids the extra multi-topic record in `lore-20`
and the unrelated family profiles in `lore-fresh-19`, but adds an unrelated record
to the unsupported orbital-bank question `lore-31`.

All seven remaining lore failures:

- `lore-1`: unrelated invitation and other-character records accompany a bare
  character request.
- `lore-9`: inherited-magic background accompanies the requested death evidence.
- `lore-10`: the original invitation ambiguity remains unresolved and extra
  disclosure/visitor material is added.
- `lore-31`: an unsupported premise triggers an unrelated retrieval record.
- `lore-fresh-1`: the contest result is present, but the required personality
  evidence is missing.
- `lore-fresh-4`: contradictory dated relationship states remain unclear.
- `lore-fresh-15`: unrelated military material shares the required source record.

Category passes: name 5/6; alias 3/5; indirect 11/11; old-note 5/5; no-answer
4/5. The validation categories pass 13/16 answerable and 4/4 unsupported-premise
cases.

## History comparison

All 4,524 historical passages were indexed and all original 50+20 history cases
were captured at the five frozen budgets. The 20 fresh history questions remain
held out. No reranker or additional generation model was used; the user explicitly
chose embedding models alone.

| Recall budget | 0.6b source hits /70 | 4b source hits /70 | Confirmed 4b unrelated-passage failures | Optimistic 4b complete-suite ceiling /90 |
| ---: | ---: | ---: | ---: | ---: |
| 1,200 | 48 | 53 | 19 | 78.89% |
| 2,000 | 52 | 56 | 20 | 77.78% |
| 4,000 | 56 | 60 | 24 | 73.33% |
| 6,000 | 61 | 63 | 26 | 71.11% |
| 15,000 | 61 | 63 | 26 | 71.11% |

Source hits are diagnostics, **not strict passes**. The ceilings optimistically
allow every other case, including all 20 held-out questions, to pass. Specific
unrelated passages in the actual final requests already rule out 80% for this
4b candidate at every budget. Positive-case and alternative-evidence reviews
remain incomplete; these are not measured overall quality scores. The two models'
confirmed-failure audits cover different subsets and must not be interpreted as
a complete comparative precision score. No passing budget can be selected.

The union of confirmed 4b history failures is `history-1`, `2`, `4`, `5`, `6`,
`7`, `8`, `9`, `10`, `11`, `14`, `15`, `16`, `17`, `18`, `22`, `23`, `24`,
`25`, `26`, `34`, `35`, `201`, `203`, `204`, and `210`. Each certificate records
the exact unrelated text, case-specific reason, source fingerprint, final-request
hash and affected budgets in `four-b-history-failure-audit.json`. Eight new
case-specific reviews supplement exact matching passages from the earlier audit.
For example, an early sword-training question retrieves an assassination-school
account, and a political-advice question retrieves a cooking-lesson request.

The category table below shows source hits at each ascending budget and the
minimum confirmed failures at those budgets. Unreviewed cases cannot pass.

| Category | Cases | Source hits: 1,200 / 2,000 / 4,000 / 6,000 / 15,000 | Confirmed failures in the same order |
| --- | ---: | --- | --- |
| Indirect | 5 | 1 / 2 / 3 / 3 / 3 | 3 / 4 / 4 / 4 / 4 |
| Identity | 5 | 3 / 3 / 3 / 4 / 4 | 5 / 5 / 5 / 5 / 5 |
| Change | 5 | 4 / 4 / 5 / 5 / 5 | 1 / 1 / 2 / 3 / 3 |
| Claims | 5 | 5 / 5 / 5 / 5 / 5 | 2 / 2 / 3 / 3 / 3 |
| Multiple sources | 5 | 4 / 5 / 5 / 5 / 5 | 3 / 3 / 4 / 4 / 4 |
| Distractors | 5 | 3 / 3 / 3 / 4 / 4 | 0 / 0 / 1 / 1 / 1 |
| Temporal | 5 | 4 / 4 / 5 / 5 / 5 | 1 / 1 / 1 / 2 / 2 |
| Context | 5 | 4 / 4 / 4 / 5 / 5 | 0 / 0 / 0 / 0 / 0 |
| Lore | 5 | 4 / 5 / 5 / 5 / 5 | 0 / 0 / 0 / 0 / 0 |
| Abstention | 4 | 4 / 4 / 4 / 4 / 4 | 0 / 0 / 0 / 0 / 0 |
| Unsupported premise | 5 | 4 / 4 / 4 / 4 / 4 | 0 / 0 / 0 / 0 / 0 |
| Answerable regression | 16 | 13 / 13 / 14 / 14 / 14 | 4 / 4 / 4 / 4 / 4 |

## Memory and performance

This Mac has 16 GiB of unified memory. Installed models are 0.6b Q8_0 and 4b
Q4_K_M; this compares the actual installed models, not equal quantization.
Their vector dimensions are 1,024 and 2,560 respectively, with isolated caches
and indexes. Encoded lore vectors grew from 4,823,988 to 11,628,258 bytes, about
2.41 times the storage. History grew from 26,587,904 to 63,630,641 bytes, about
2.39 times the storage. These are encoded vector payloads, not total app storage.

The initial 4b request using its default allocation hit the memory reserve and
system pressure warning before indexing began. It was stopped and unloaded;
swap remained zero. The retry uses a 4,096-token allocation, compute batch 128,
two input texts per request and no parallel model loads. Truncation is disabled:
an oversized input must fail rather than silently lose source text. All 831 lore
records and 4,524 historical passages indexed successfully under that limit.

The small-context model reports approximately 2.63 GiB allocated by Ollama.
During the complete lore run alongside the history index, system pressure stayed
normal, swap stayed at zero, and the measured reclaimable/free reserve stayed
above 2.89 GiB. That lore evaluation process peaked at 629 MiB. Across the main
41.4-minute run, pressure also stayed normal, swap stayed zero, the reserve stayed
above 2.95 GiB and evaluation-process RSS peaked at 982 MiB. The model was unloaded
afterward. These measurements are not a claim that the whole application uses
only the model's allocation.

The 4b history index took 32 minutes 7.7 seconds with uncached historical vectors;
0.6b previously took 4 minutes 28.9 seconds. The 4b memory-constrained profile and
some overlapping lore work affect this comparison. Its partially cached lore
index took 139.9 seconds; the separate complete lore run replayed cached document
vectors in 1.31 seconds. Neither is a cold 4b lore-index measurement.

After indexing finished, embedding-provider query medians were 101.1 ms for lore
(32 queries, p95 138.5 ms) and 132.4 ms for history (70 queries, p95 140.7 ms).
The earlier eight-query 0.6b sample had a 24.3 ms median. History search including
ranking had a 530.2 ms median and 554.1 ms p95. Lore selection and context building
together had a 4.96-second median, including tokenization and the ordinary-lore
comparison. These are local evaluation measurements, not phone performance or a
matched production latency trial. All 32 repeated development lore requests were
identical to the separate complete lore captures despite different contention.

The memory options are applied only to this local evaluation through Ollama's
native API. Selecting 4b in the unchanged app does not automatically apply this
allocation. The app's default model remains unchanged.

A separate numerical-repeatability probe found small differences between a few
warm-up vectors made at compute batch 32 and fresh vectors at compute batch 128.
The minimum sampled cosine was 0.999983, which flagged the probe's tight 0.99999
identity threshold. Repeating current-profile calls reproduced the same values.
All inspected vectors have the same 4b model identity and 2,560 dimensions; no
0.6b vectors are mixed into this index. The raw failed identity diagnostic is
retained. No retrieval label, relevance threshold or grading rule was relaxed;
the scores describe the captured index rather than guaranteeing bit-identical
vectors across runtime settings.

The larger vectors exposed unnecessary export allocations. On 500 synthetic
2,560-dimensional vectors, sampled JavaScript heap use fell from 121.79 MiB to
29.70 MiB after flattening each encoded vector immediately. Encoded output stayed
at 7,023,218 bytes. Independent Float32/Base64 byte checks and round trips cover
small sizes, 1,024, 2,560 and 8,192 dimensions. This changes allocation behavior,
not the cloud format, hashes, retrieval, or grading. The quality captures retain
their pre-optimization source fingerprint.

The main process captured all 382 requests before its old encoder exhausted the
768 MiB JavaScript heap during final export. This process-local allocation failure
did not trigger system pressure or swap. A separate measurement using the actual
4b vectors and corrected encoder completed both indexes under a 512 MiB heap cap
(665 MiB process RSS), producing the payload sizes above. A 4,524-vector synthetic
export also completed under a 256 MiB heap cap. The original failed run and its
trace remain preserved; no successful full-run exit is claimed.

## Verification and remaining work

The full regression suite passed **1,770 tests, with one skipped and zero failed**,
including isolated browser checks. Frozen fixture hashes and the strict rubric
remain unchanged. Independent byte checks verify compatibility of the export
optimization. Previous disposable Firebase and local-provider browser checks are
documented in `EMBEDDING-IMPLEMENTATION-STATUS.md`; this comparison did not repeat
live Firebase or physical-device acceptance.

The larger model provides a small lore gain and better source recall, with much
more indexing time and storage. It does not solve historical relevance. The 0.6b
milestone remains open, and its next work is development-only precision filtering
and passage selection using embeddings and lexical evidence, without a separate
reranker. Paid final-story tests remain gated on the original 0.6b milestone.

Private requests, reviews, model caches and memory traces are in
`production-reports/2026-11-01-embedding-quality/` and are excluded from the release.
This comparison made no paid story-generation calls. Release status is tracked
separately in Git and GitHub Actions.
