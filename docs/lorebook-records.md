# Selective lorebook records

Existing stories keep their current lore selection. To use records, open **Lorebooks → Import & export → Selective lorebook records**.

## Convert a story

1. Choose **Export sources + conversion prompt**. This downloads a version 2 source JSON and the exact-quotation conversion prompt. Give both files to your external LLM. The authoritative input is `entries`; the other book views duplicate it.
2. Choose **Review layout / migrate**, paste the returned `nera-lorebook-layout` JSON, and preview it. Leaving the input empty performs a lossless migration using complete sources.
3. Review nominated cores individually. Inspect the complete quotations and their conditions, check the review checkbox, and approve each desired core. Unapproved cores remain ordinary information.
4. Choose **Migrate this story**. The application takes a backup, stages a complete generation, and activates it after source/revision checks. Unassigned passages are kept as fallback records. Incorrect quotations, split notes, duplicate keys, and unknown subjects are rejected.

The prompt is also available at `system prompts/lorebook-layout.md`.

## Manage information

The four book tabs remain. A migrated subject contains **Selectable information**, grouped by category, and a **Source archive** for its original section text and notes.

- A core is compact essential information for its subject. It loads when that subject is selected, within the book and request ceilings.
- A pin asks to load a particular record every request. Pins can admit an off-scene subject without using an optional card slot. Pins cannot bypass disabled books or token ceilings.
- Related-subject links and specific literal trigger phrases help retrieve information. Matching is local and deterministic; there are no extra model calls or embeddings. Literal name/alias references in source text also provide links.
- Source bundles keep conditions, negations, and related passages indivisible. Existing update notes cannot be divided.
- Replacement links require separate review and cannot form cycles. The system never infers that a new note erases an old one.
- Source or grouping changes invalidate approval. Previous source versions remain archived for inspection; they are never silently reintroduced into context.

New extraction notes become records through the storage adapter. The extraction prompt, output grammar, batches, lag, checkpoint behavior, and model settings remain unchanged. Extraction and reorganization receive ordinary legacy section projections, not the selection metadata. Personality remains author controlled.

## Selection and inspection

Separate book ceilings and the existing facts → events → characters → locations allocation order remain. Required/recent conversation is reserved first. Subject admission retains always-load, protagonist, scene, current-input, recent-mention priority and the character/location limits.

Within each book, records share space in rounds: pins and approved cores; current-input matches and relevant subject state; recent matches and related subjects; further characterization; remaining background/history. Oversized records are skipped so smaller units can fit. Older related events can outrank unrelated recent events. Links are followed only from the initial relevant subjects, not recursively across the cast. Closed threads retain closed status.

Without an approved character core, complete personality and appearance sources are available as explicitly unreviewed fallback units. A bundle whose qualifier is unavailable cannot release its surviving claim as a new independent fallback.

The context viewer includes **Selected lorebook records**, with exact selected text, omitted record passages, match/link reasons, and per-book budgets. The **Last sent request** report is captured with the actual serialized request. Reports, IDs, fingerprints, approvals and selection metadata do not enter provider messages. Omitted pins and approved cores are reported.

## Storage, portability and recovery

Version 3 JSON is the authoritative export. Each document has a subject, current sources, archived source versions, and selection records. Markdown remains a readable compatibility export of current sections and notes; it does not preserve record organization or approvals.

Canonical documents are stored under `loreV3/{generation}/entries`. The session's `loreGeneration` pointer selects the active collection. Existing store operations project those documents into sections, then encode changes back into records. Backups, restores, copies, deletion and evidence invalidation use this boundary.

**Return to legacy selection** rebuilds the legacy tree from current sources, including notes added after migration. It keeps a backup and changes the pointer atomically. If more than 450 obsolete archived subjects require removal, rollback refuses before activation to stay within Firestore's transaction limits; export the current sources to a new legacy story in that case.

Migration uses a ten-minute write lease. A failed stage never changes the active pointer; expired staging data remains available for cleanup when the story is deleted. Old clients cannot write to the legacy tree while migration is locked or while a version 3 generation is active.

Deploy the included `firestore.rules` together with the updated app before migrating live stories. The rules enforce write protection, rollback write versions, and generation cleanup before deleting a migrated parent. No live stories are migrated by this code change alone.

## Verification

Run the local suite:

```sh
node --experimental-vm-modules --test tests/*.mjs
```

`tests/lore-record-rules.mjs` additionally runs under a Firestore emulator configured for `demo-nera-records`; it skips without `FIRESTORE_EMULATOR_HOST`. It exercises legacy writes, migration barriers, canonical document shape, rollback write versions, atomic rollback deletions, and protection against old-client parent deletion. Use only the demo project for this test.

Local tests verify source preservation, approval invalidation, context budgets, exact mocked serialized requests and transactional behavior. They do not establish live provider compliance or production Firebase deployment.
