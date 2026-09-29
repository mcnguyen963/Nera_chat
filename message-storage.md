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

Optional past-chat recall builds a device-local IndexedDB index only after the
feature is enabled and a chat request needs it. It reads one message chunk at a
time, stores keywords and short snippets, and fetches full text only for the
highest-ranked matches. Indexing pauses while chat is busy or the page is
hidden. Semantic search embeds only the keyword shortlist and caches vectors
locally. The index is disposable; Firestore messages remain the source of truth.

Optional short memory is stored on the session document as `shortMemory` and
`shortMemoryThroughOrder`. It is updated after assistant turns only when the
feature is enabled. Both optional memory features are disabled by default.
