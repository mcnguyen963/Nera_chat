# Continuity scaffold

The continuity pipeline is available in the chat UI as a per-story option. It is
off by default and can be enabled in Settings → This story before the first
message. Existing stories retain their original pipeline until a reviewed
transcript migration is built.

## Verified current-system audit

| Existing feature | What the code does now | Decision in this scaffold |
|---|---|---|
| Long-term `plan` | The narrator emits hidden `<plan>` text; `chat-view.js` extracts it into `session.longTermPlan`, and `context-builder.js` injects it into the next system prompt. | Replace with typed agenda records and tool proposals. A plan is never an event or a character's knowledge. |
| `plan_thread` | The assistant message stores a hidden one-clause reminder; `context-builder.js` appends it to that message when it is sent again. | Remove from the new path. Derive current focus from saved agenda records; never ask the narrator to rewrite a second plan summary. |
| Summary/checkpoint | Summarization creates a replacement story-so-far message and the normal window starts after the checkpoint. It is a compressed transcript, not structured character state. | Keep as an optional transcript aid only if useful; do not treat it as authoritative state. |
| Short memory | `context-builder.js` can prepend `session.shortMemory` when enabled. It can repeat the summary or omit durable relationship consequences. | Do not feed it in the new path. Character/relationship records replace its role as mutable state. |
| Chat recall | The optional recall module fetches selected earlier messages when enabled. Useful for exact callbacks, but retrieval does not determine who knows the retrieved fact. | Keep optional for narrative quotations and details; retrieved material remains evidence and does not update beliefs by itself. |
| Recent-message window | The context builder takes whole messages newest-first for fitting, then restores chronology. | Keep the bounded-window idea; new selection also injects all compact active-character state before history. |
| Tool use | The existing narrator request sends only messages. The new `llm-client.js` accepts optional API `tools`, `tool_choice`, and `response_format`. | Use API tools for retrieval and proposed agenda edits. Put tool-use policy in the system contract; keep tool definitions in the request's `tools` field. |

These are code findings from `js/context-builder.js`, `js/plan-parser.js`,
`js/ui/chat-view.js`, `js/short-memory.js`, `js/chat-recall.js`, and
`js/llm-client.js`. The legacy behavior remains available in stories without
continuity enabled.

## Turn contract

`runContinuityTurn()` accepts a repository, branch ID, unique turn ID, current
player input, and model settings. It loads a branch snapshot; writes an idempotent
pending turn; assembles trusted behavior rules, optional style preferences,
selected continuity data, complete recent exchanges, and the current user input;
handles bounded read-only and plan-proposal tool calls; generates a draft; calls a
separate continuity reviewer; validates every cited source and revision; then
commits the response, state changes, events, and new branch head together.

A rejected draft gets one repair attempt. Invalid patches, timeouts, over-budget
requests, stale branch heads, model truncation, or reviewer failures leave the
accepted branch unchanged. The pending turn is marked failed for retry or review.
Calls to the LLM run outside Firestore transaction callbacks. Tool effects are
read-only, except plan updates, which remain proposals until the reviewer returns
an accepted record update.

## Exact per-turn message order

The narrator request is assembled in this order. The current player input is
always last, and old exchanges are kept whole and chronological.

```js
[
  { role: "system", content: NARRATOR_CONTRACT + TOOL_POLICY },
  { role: "user", content: JSON.stringify({
      type: "application_reference",
      futurePossibilities: [/* agenda records, each marked occurred: false */],
      focus: [/* derived agenda focus */],
  }) }, // only if agenda context exists and fits
  { role: "user", content: "earlier accepted user message" },
  { role: "assistant", content: "earlier accepted narrator response" },
  // ...zero or more complete recent exchanges, oldest first
  { role: "user", content: JSON.stringify({
      type: "current_turn", branchId, stateRevision, mode,
      state: { records: selectedRecords, events: selectedEvents },
      stylePreferences, playerInput,
  }) },
]
```

Tool calls are assistant tool-call messages followed by matching `role: "tool"`
results inside the narrator request. The system contract explains when to use
tools; schemas travel in the request body's `tools` field, with
`tool_choice: "auto"` (then `"none"` at the final allowed round). Tool messages
are not saved as story dialogue.

The reviewer is a separate non-streaming request, ordered as:

```js
[
  { role: "system", content: REVIEWER_CONTRACT + JSON.stringify(REVIEW_SCHEMA) },
  { role: "user", content: JSON.stringify({
      branchId, baseRevision, turnId,
      priorState: { records, events },
      sources: [/* exact quotes, hashes, source roles, and bounded context */],
      planProposals,
  }) },
]
```

Agenda focus replaces `plan_thread`: it is application-derived reference data,
never evidence that a planned event occurred.

## Modules

| Module | Responsibility |
|---|---|
| `schema.js` | Tool and reviewer schemas, plus local schema validation |
| `state.js` | Source hashing, provenance checks, immutable events, and pure state reduction |
| `context.js` | Active cast and dependency selection, message ordering, and request budgets |
| `prompts.js` | Separate narrator, tool-use, and continuity-review contracts |
| `tools.js` | Tool definitions, strict dispatch, and bounded tool-call loop |
| `store.js` | In-memory repository, pending/accepted turn behavior, and historical branch forks |
| `firestore-store.js` | SDK-injected persistent repository under each user's session |
| `turn-controller.js` | Narrator, tool, reviewer, repair, and accepted-turn orchestration |

The Firestore adapter receives Firebase's modular functions through `api`.
`runtime.js` connects it to the app's existing Firebase instance and authenticated
session. It uses the existing per-user session security boundary and never stores
API keys in continuity documents.

## Initializing a branch

Settings → This story → Enable character continuity initializes an empty `main`
branch for an empty story. Choose **Author note** next to the composer to establish
characters, relationships, and corrections. Choose **In story** for player actions.
Author notes use source role `author` and pass through the same review and state
validation as other turns. An author note fails if the review saves no event and
record update. Never infer missing profile details from a name.

```js
import * as firestore from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { currentUid } from "../auth.js";
import { createStoryState } from "../continuity/state.js";
import { createFirestoreStoryStore } from "../continuity/firestore-store.js";

const store = createFirestoreStoryStore({
  api: firestore,
  db,
  uid: currentUid(),
  sessionId: activeSession.id,
});
const initializationId = crypto.randomUUID(); // keep for retrying this creation
await store.initialize({ state: createStoryState("main"), initializationId });
```

The chat adapter calls `runContinuityTurn` with the selected model profile and
active branch. It uses a new `turnId` for each input. `mode: "author"` marks an
explicit out-of-character setup or correction; ordinary roleplay text is never
parsed for author tags.

## State rules enforced in code

- State records are typed characters, relationships, beliefs, consequences, scenes,
  agendas, or world facts. Omitted records remain unchanged.
- Every event and state operation includes source message ID, revision, SHA-256
  content hash, and an exact quote. The reducer checks the source against the
  stored message before accepting the patch.
- State updates require a new event and a current record version. Stale updates,
  duplicate event IDs, missing characters, and unresolved references fail closed.
- Character background and personality, authored agendas, and voluntary player
  emotions, goals, and intentions require explicit author/player evidence.
- A `knows` belief requires an observation or author event that names its holder.
  Beliefs remain distinct from story facts and reports.
- Only explicit author corrections can supersede prior events. Every record that
  references a superseded event must be repaired in the same patch or the whole
  patch is rejected.
- The model can propose plan changes, but a plan is not an event. The app saves it
  only after the reviewer validates a matching typed agenda update.

These checks validate structure, versions, and provenance. They cannot prove that
a quoted passage logically justifies a relationship change. That judgment belongs
to the continuity reviewer and still needs evaluation against human-reviewed
stories.

## Worked continuity example

An authored setup should create an `author_setup` event for the mother's death,
another for A learning who killed her, and a directional `char_A -> player`
relationship plus an open grievance. A's normal cheerful personality stays in
the character record; current grief belongs in `emotion`. The `belief` record
states that A knows the player killed her mother and records the acquisition as
unspecified, so the narrator must not invent how she learned it.

When the player later greets A about the weather, context selection includes A's
stable personality, current emotion, the hostile relationship, the known fact,
and the open grievance even though the input mentions none of them. A might still
use a naturally warm voice with someone else, but toward the player her behavior
must reflect distrust: distance, clipped answers, refusal, or guarded cooperation.
That greeting cannot close the grievance. A later change needs a specific event
and a reviewer-approved relationship/consequence update; politeness, assistance
under pressure, and a momentary softer mood are not forgiveness. A meaningful
apology, restitution, disclosure, or changed circumstance may support gradual
change, but the app records only the development that actually occurred and
leaves the rest unresolved.

The essential records look like this (the implementation also stores versions,
event IDs, and exact source references):

```json
[
  {"id":"char_A","kind":"character","data":{
    "name":"A","controller":"narrator",
    "personality":"Normally cheerful and friendly.",
    "emotion":"Grieving over her mother's death.",
    "goals":[],"intentions":[]
  }},
  {"id":"rel_A_player","kind":"relationship","data":{
    "from":"char_A","to":"player","trust":"deep distrust",
    "hostility":"strong","affection":"not established",
    "boundaries":["No reconciliation established"]
  }},
  {"id":"belief_A_killer","kind":"belief","data":{
    "holder":"char_A","proposition":"The player killed A's mother.",
    "stance":"knows","acquisition":"Known; method unspecified."
  }},
  {"id":"grievance_A_mother","kind":"consequence","data":{
    "holder":"char_A","target":"player","category":"grievance",
    "description":"The player killed A's mother.","status":"open"
  }}
]
```

## Storage and current limits

Continuity data lives below
`users/{uid}/sessions/{sessionId}/continuityBranches/{branchId}` in separate
`records`, `events`, `messages`, `turns`, and `checkpoints` collections. Creation
reserves a branch as `initializing`, stages child documents, and publishes it as
`ready` with its initial checkpoint. A partial initialization cannot be loaded;
retry it with the same initialization ID and unchanged input. Accepted
turn records are bounded below 250 KiB, and a branch head revision protects
against competing devices committing to the same prior state.

The Firestore adapter reads only the newest 24 source messages for ordinary turns;
older source passages are loaded by ID when a reviewer needs them. The in-memory
reference store is intended for deterministic runs and tests, not large imports.
The first scaffold still reads all state and event documents to build the branch
snapshot. Before large-scale use, add paged event retrieval and periodic
materialized checkpoints. Full-history fork/replay is an explicit operation and
reads that branch's event and message history.

SillyTavern JSONL exports the active branch's transcript, including author notes,
but does not preserve continuity records. Imported JSONL stories remain on the
legacy path. Duplicate story copies all accepted continuity branches and records.
An existing story cannot enable continuity until a reviewed migration is built.

## Provider and prompt notes

Tool definitions are sent through the request's `tools` field. Models return
tool-call requests; only this app dispatches the whitelisted functions. Streaming
tool arguments are assembled by call index. The loop allows at most three tool
rounds and eight calls, and sends the tool definitions again on each request.
Model/provider support must be confirmed for the selected endpoint. If it is not
supported, tool calls fail as a failed pending turn; the scaffold does not silently
pretend the tool ran.

Schema-constrained review output is opt-in because support varies by endpoint.
Without it, JSON is parsed and checked locally against the same schema. The
current default narrator prompt has legacy plan guidance, so it must not be passed
as a style prompt in this mode. Supply only creative style preferences alongside
the application-controlled narrator contract. User edits to existing prompt
settings are preserved; prompt migration and UI reconciliation are a separate step.

The current turn controller does not render streaming prose: the UI shows the
accepted response after review. Settings exposes a read-only view of saved state.
The legacy plan and short-memory fields are disabled for continuity stories;
manual and automatic transcript summarization are also skipped there.

Edit, regenerate, and rewind fork at the turn before the selected message. The
new branch becomes active only after a revised turn is accepted, except rewind,
which activates the earlier snapshot immediately. Later turns remain in the old
branch. This prevents their events and knowledge from affecting the revised story.

## Remaining operational limits

The opt-in chat adapter, author notes, saved-state inspection, active-branch
export, and branch-aware edits are implemented. Live provider and Firestore
emulator behavior still need validation in a signed-in deployment. The store
pages transcript display, but ordinary turns still read all event and state
documents; large stories need materialized checkpoints or indexed retrieval.
JSONL is transcript-only, so it is not a full continuity backup. Existing story
migration needs reviewed backfill and conflict handling before it can be enabled.

The default path makes one narrator request plus one continuity-review request;
tool retrieval adds a request only when needed, and an invalid draft can add one
repair request. This increases latency and model cost in exchange for checking
every persistent state update and major continuity violation. Provider structured
output can reduce parse failures but is optional and must be verified per endpoint.

The deterministic tests cover persistence of A's grievance, strict knowledge
acquisition, event provenance, rejected forgiveness and repair, tool request
ordering, plan proposals, retries, branch forks, and the UI's continuity route.
They do not establish that a real reviewer model will consistently judge nuanced
apologies; a human-scored narrative evaluation set remains necessary.
