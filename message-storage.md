# Message storage

Chat messages are stored in `users/{uid}/sessions/{sessionId}/messageChunks`.
Each chunk contains at most 100 messages and targets 256 KiB of encoded message
data. A single unusually large message gets its own chunk, with an 850 KiB
estimated size ceiling. A session tracks the active chunk and next message
order. New turns update the active chunk and session together.

Normal context loads every message from the active summary checkpoint onward.
The chat view listens to the newest three chunks and loads earlier chunks only
when requested. Full-history summarization and export read all chunks.

Opening an older session converts its existing `messages` documents to chunks
once. The session switches to chunk storage only after all chunk writes finish;
an interrupted conversion retries on the next open. The old message documents
are retained for recovery and are not read during normal chat after conversion.
This one-time conversion incurs a read for each old message document. It also
increases storage until the legacy documents are removed separately.

The `messageChunks.messages` array is never queried directly. Exempting that
field from Firestore single-field indexing can reduce index storage and write
work if Firestore indexes are managed for this project.

Chunks also track `hasLiveSummary` and `lastNarrativeOrder`. Sessions keep a
conservative summary coverage bound (`summaryCoverageOrder` and
`summaryCoverageUnknown`). Recent edits can skip summary discovery when that
bound excludes the changed turn. Covered changes and active-summary deletion
query only live-summary chunks; latest-reply checks query at most one later
narrative chunk. The save transaction rereads candidates and rejects changes
to the discovered history revision or checkpoint.

`lookupVersion: 1` is published on an existing story only after its resumable
per-chunk backfill completes. Opening a story starts initialization, and saves
await it. This metadata migration preserves message content and history
revisions. New stories, imports and copies receive lookup metadata directly.
Refresh other open clients after releasing this change so every writer
maintains the new fields. Local read-count tests verify bounded recent saves;
live Firebase latency has not been measured.
