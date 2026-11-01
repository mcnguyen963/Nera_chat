# Embedding implementation status — November 1, 2026

The overall 0.6b milestone is **not complete**. Lore passes its complete and fresh
quality gates under agent adjudication. Historical retrieval does not pass. The
user subsequently authorized a separate 4b comparison with memory limits; that
comparison captured all development requests and remains below the history gate;
see `EMBEDDING-4B-COMPARISON.md`. It does not mark 0.6b as passing. No paid final-story
generation has been performed. This report records the pre-release validation;
publishing the implementation does not mark the unfinished quality gate as passed.

## Frozen benchmark

The private snapshot, original lore questions, original 50+20 history questions,
20 additional questions per system, and strict rubric are fingerprinted in
`production-reports/2026-11-01-embedding-quality/fixture-lock.json`.
Questions and expected facts have not been weakened. Request archives preserve
the actual fitted API messages. A source-anchor hit is a diagnostic, not a pass.
Unrelated additions, ambiguous unresolved evidence and unreviewed cases fail.
See `README-embedding-quality.md` for reproduction and grading instructions.

| 0.6b lore set | Strict passes | Result |
| --- | ---: | ---: |
| Original development | 28/32 | 87.50% |
| First fresh validation | 16/20 | 80.00% |
| Complete | 44/52 | 84.62% |

These are request-bound **agent adjudications**, not independent human grading.
The fresh lore questions are now exposed and must not be called unseen again.
They have not been used to tune lore after this run. The 20 fresh history cases
remain held out.

Lore category results: name 5/6; alias 3/5; indirect 10/11; old-note 5/5;
no-answer 5/5. Fresh categories: answerable 12/16; unsupported premise 4/4.

Every remaining lore failure:

- `lore-1`: broad character retrieval adds unrelated relationship records.
- `lore-9`: death evidence is accompanied by unrelated background records.
- `lore-10`: the frozen short question is ambiguous between two invitations;
  mixed evidence and the unresolved ambiguity fail.
- `lore-20`: a relevant comparison shares an oversized record with unrelated
  military material.
- `lore-fresh-1`: required answer evidence is incomplete.
- `lore-fresh-4`: contradictory states on the same date leave the answer unclear.
- `lore-fresh-15`: the required figure shares a record with unrelated equipment
  and tactics.
- `lore-fresh-19`: other family profiles are added to the requested evidence.

## Historical retrieval remains below the gate

The latest actual-request candidate uses the original passage embeddings,
English inflection matching for Qwen 0.6b, and standalone query handling for
suitable self-contained English questions. Literal keyword-only behavior and
other providers retain their previous query behavior. Recent conversation and
lore budgets remain fixed. Each run uses at most 20 historical passages.

| Recall budget | Required-source hits /70 | Confirmed unrelated-passage failures | Optimistic complete-suite ceiling /90 |
| ---: | ---: | ---: | ---: |
| 1,200 | 48 | 19 | 78.89% |
| 2,000 | 52 | 23 | 74.44% |
| 4,000 | 56 | 23 | 74.44% |
| 6,000 | 61 | 24 | 73.33% |
| 15,000 | 61 | 24 | 73.33% |

**The ceilings are not measured quality scores.** They optimistically count all
other cases, including every held-out case, as passes. Confirmed noise alone
already prevents the current candidate from reaching 80%. Missing-source cases
may have valid alternative evidence and need separate review; they were not
automatically added to these failure counts. Positive-case and alternative-source
adjudication is incomplete. No recall budget can yet be selected as passing.

The union of confirmed history noise failures is `history-1`, `2`, `4`, `5`, `7`,
`8`, `9`, `10`, `11`, `14`, `15`, `16`, `17`, `18`, `20`, `22`, `23`, `24`, `25`,
`26`, `32`, `34`, `35`, and `40`. Exact passages, reasons, per-budget membership,
request hashes, and missing-source diagnostics are in
`history-stem-failure-audit.json`. Larger budgets retain or add wrong-scene
material; retrieving a correct passage somewhere in a longer request is
insufficient.

Development-only experiments covered task instructions, standalone queries,
lexical/vector weights, English inflections, whole-message and paired-message
ranking, shorter passages, multiple resolutions, query facets, temporal
neighborhoods, role priors, generic-topic subtraction, preceding dialogue in
document embeddings, and common vector-component removal. The last two did not
improve the development source probes and were not adopted. None of these probe
scores substitutes for actual-request grading. No additional reranking model has
been introduced. The user explicitly chose embedding models alone. The history
precision problem remains open.

## Implemented behavior

- Saved eligible lore changes start a durable, coalesced device-index refresh.
  Unchanged vectors are reused; deleted or ineligible sources are removed.
  Interrupted work resumes, including the crash gap immediately after a source
  save. Superseded, purged or wrong-account jobs cannot publish stale vectors.
- Scheduled and manual memory batches update historical embeddings, including
  catch-up. Full-history indexing remains available. Checkpoint movement alone
  does not cancel an index or memory operation; actual source changes do.
- The composer progresses from memory extraction to search indexing. Failed
  indexing leaves saved memory intact and presents a retry status. Completion
  while viewing another story clears that story's progress correctly. Clearing
  or deleting one index invalidates its own in-flight work without discarding
  another story's index.
- Upload, Download and Repair remain explicit for both indexes. The old
  automatic-upload setting no longer triggers uploads. Uploads use immutable
  chunks followed by a revision-checked manifest; interrupted writes preserve
  the previous complete index. Empty indexes and repair of a missing manifest
  are supported. Pending/stale device indexing blocks a partial upload.
- Downloads validate original source fingerprints and compatible model,
  dimension and processing-version metadata. Existing vector formats remain
  supported. Provider credentials stay device-local.
- Manual regular and full-history summaries can generate concurrently with
  memory extraction/indexing. Each captures independent sources and has separate
  cancellation. Short saves update owned fields and preserve newer lore, memory
  progress and summary metadata. Original messages before a new checkpoint remain
  available to memory.
- Lore ranking and fitting prioritize the matched records, suppress incidental
  unrelated additions and retain protected cores/pins. Explicit past questions
  can retrieve closed, unarchived threads as historical evidence. Historical
  message recall remains Classic-only.

## Measurements and verification

Real uncached indexing against local `qwen3-embedding:0.6b`, already resident:
831 lore records in 34.8 seconds; 4,524 historical passages from 2,178 messages in
268.9 seconds. These runs used an in-memory save adapter; they do not measure
phone or IndexedDB write performance. Eight embedding query requests had a
median of about 24 ms and a maximum of 29.2 ms. All vectors have 1,024 dimensions.
Freshly recomputed samples matched 21 existing vectors with cosine 1.0.

Encoded vector payloads: lore 4,823,988 bytes; history 26,587,904 bytes. Offline
cached replay had a median historical search time of about 313 ms, plus about
2.19 seconds for base context construction. Lore selection and final context
construction together took a median of about 5.01 seconds on development and
4.87 seconds on fresh cases. Those combined times include exact tokenization and
the additional ordinary-selection comparison; they are not embedding-provider
latency or mobile performance claims. Further context-fitting performance work
may be needed for large stories.

- Full regression suite after the 4b comparison: **1,770 passed, 1 skipped, 0 failed**.
- Browser tests exercised real IndexedDB queues, interruption/reopen recovery,
  coalescing and summary-field merging in an isolated unsigned profile.
- A separate isolated browser check successfully indexed and queried synthetic
  lore/history through the real local 0.6b provider.
- Actual memory and summary modules were exercised with a fake generation
  provider for both completion orders, simultaneous saves, cancellation, source
  edits and processing messages before a new checkpoint. This is not a live
  paid-generation concurrency claim.
- A disposable signed-in Firebase story successfully uploaded and downloaded
  four historical vectors and one lore vector. Every restored Float32 element
  and persisted model/format metadata matched. This used current-source vector
  encodings with the unchanged deployed Firestore adapter; it was not a deploy
  of the whole modified app. Existing user stories were not written.
- The deployed origin could not call local Ollama because of its current CORS
  configuration. Browser security was not weakened; the local-origin provider
  check succeeded. Physical-device and complete new-code production acceptance
  remain unverified.

Detailed private artifacts and logs are in the ignored report directory. The
early invalid evaluation-proxy captures remain marked invalid and are excluded.
Paid final-story tests remain gated on both 0.6b quality gates. A later explicit
user instruction permits the separate 4b comparison before those gates pass.
Release commit and deployment status are tracked separately in Git and GitHub Actions.
