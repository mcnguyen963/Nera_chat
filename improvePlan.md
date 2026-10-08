\# FIX PLAN — Nera_chat feature/story-memory branch (2026-10-07)
\

\
This plan fixes every problem in [REVIEW_FINDINGS.md]\(REVIEW_FINDINGS.md) (about 110 items) and ports the fixes that main already has.
\
It is written for smaller coding agents. Give an agent \*\*one task\*\* (for example \`S3\`). The agent should first read:
\
\- the Ground rules below,
\
\- the Conflict resolutions (section 4),
\
\- the task itself.
\

\
Each task has these parts: \*\*Findings covered\*\*, \*\*Problem\*\*, \*\*Root cause\*\*, \*\*Fix\*\*, \*\*Acceptance\*\*, \*\*Tests\*\*, \*\*Depends on\*\*. Line numbers are approximate (\`\~\`). Find the code by function name.
\

\
FEATURE = this folder. MAIN = \`../../Nera_chat-main/Nera_chat-main\` (its own plan is \`FIX_PLAN_MAIN.md\`).
\

\
\---
\

\
\## 1. Ground rules (apply to every task)
\

\
1\. \*\*Do not break tests.\*\*
\
&#x20; \- Run \`node --experimental-vm-modules --test tests/\*.mjs\` before you start and after you finish. The baseline is 147 passing.
\
&#x20; \- A task may only change an existing assertion when the task says so.
\
2\. \*\*House rules.\*\*
\
&#x20; \- At most \*\*2 LLM calls per user turn\*\*: the narrator plus at most one maintenance call. No task adds a call.
\
&#x20; \- The narrator never outputs JSON.
\
&#x20; \- No server and no Cloud Functions. The app stays on GitHub Pages and the Firestore Spark tier.
\
&#x20; \- No data migration. New fields are optional, and old documents must keep working.
\
&#x20; \- Count Firestore reads. If a task changes reads, say how many in the task report.
\
3\. \*\*Legacy parity.\*\* With every memory toggle off, the request must equal what MAIN's builder sends. C2 adds a golden test that enforces this. Until C2 lands, do not make the toggles-off path any worse.
\
4\. \*\*All LLM-facing text lives in \`system prompts/\*.md\`.\*\* Do not add prompt strings to JS.
\
5\. \*\*No build step.\*\* Use vanilla ES modules, and match the style of the code around your change.
\
6\. \*\*Keep the scope small.\*\* Do only the task you were given. If you find another bug, write it in your report and leave it for its own task.
\
7\. \*\*There is no git in this folder.\*\* Before a task, back up every file you will change (for example, copy it to \`\*.bak\` outside \`js/\`). Delete the backups when the task is accepted.
\
8\. \*\*Report back\*\* with:
\
&#x20; \- the files you changed,
\
&#x20; \- the test count before and after,
\
&#x20; \- any read or LLM-call change,
\
&#x20; \- anything you could not do.
\

\
\---
\

\
\## 2. Owner decisions (defaults assumed by this plan)
\

\
The owner can override any row. If a row changes, only the tasks in the last column change.
\

\
\| # | Decision | Default used | Tasks affected |
\
\|---|---|---|---|
\
\| D1 | Player-agency lint | \*\*Warn only.\*\* It never blocks or discards a reply or its tag. | S5, S6 |
\
\| D2 | When is a reply "accepted"? | A later user message accepts it, decided when the data is read. A missing acceptance field means accepted. | S1, S10 |
\
\| D3 | Separate scene-extraction mode | \*\*Delete it.\*\* Otherwise a turn would use 3 calls. | S2 |
\
\| D4 | Toggles-off request | Byte-identical to MAIN's \`buildContextForRequest\`, checked by a golden test | C2 |
\
\| D5 | Narrator word range | \*\*Decided: 200-600 words\*\* (owner, 2026-10-07). Written literally in the prompt files, never as a placeholder. | C4 |
\
\| D6 | End-of-request scene reminder | Always present when Scene is on | C3 |
\
\| D7 | Automatic summary | Runs \*\*after\*\* narration, one chunk per turn, and shares the single maintenance slot | L4 |
\
\| D8 | Extraction parse errors | Partial acceptance: keep the good lines and report the bad ones | L3 |
\
\| D9 | Length-limited narrator reply | Saved and marked "cut off". It is never thrown away. | P0.6, P0.9, U5 |
\
\| D10 | Edit a summarized message | The summary checkpoint is kept. Only deletes invalidate it, and memory never pauses on an edit. | L1 (overrides P0.13 wording) |
\
\| D11 | Stream idle timeout | \*\*120 s\*\*, the same as FIX_PLAN_MAIN M8. Part U says 90 s; use 120 s. | U5 |
\
\| D12 | Token-count cache | One LRU of \*\*3000\*\* entries, the same as FIX_PLAN_MAIN M5 | C6 (P0.5 is interim) |
\
\| Q1 | Narrator hash migration for legacy users | Keep it (recommended in C) | C1, C2 |
\
\| Q2 | Protagonist wording in the narrator | "the PC" (no \`{{SETTING}}\` field) | C4 |
\
\| Q3 | Word range value | \*\*Decided: 200-600\*\* | C4 |
\
\| Q4 | Soft cap on history turns | No cap for now; measure again after C3 | — |
\
\| Q5 | Tracker section inside the story plan | The owner moves it into the summarizer prompt by hand | — (manual) |
\
\| Q6 | Main-only features (rewrite, private note, sync, clear cache, …) | See P0.18. Only the clear-cache item is ported (U9i). | P0.18 |
\

\
\---
\

\
\## 3. Phases and task list
\

\
Do the phases in order. Inside a phase, follow the "Depends on" column. Tasks with no dependency between them can run in parallel, but only if they touch different files.
\

\
\| Phase | Task | Title | Priority | Depends on |
\
\|---|---|---|---|---|
\
\| \*\*0 Safety + port main\*\* | P0.1 | Zone.Identifier files, \`.gitignore\` | P1 | — |
\
\| | P0.2 | Deploy only app files | P1 | P0.1 |
\
\| | P0.3 | Remove request-body \`console.log\` | P1 | — |
\
\| | P0.4 | Boot error screen | P2 | — |
\
\| | P0.5 | Tokenizer retry, no fallback caching | P1 | — |
\
\| | P0.6 | LLM client finish reason / \`allowTruncated\` | P1 | — |
\
\| | P0.7 | Reasoning budget < response budget | P1 | — |
\
\| | P0.8 | Remove the legacy "plan is lost" rule | P1 | — |
\
\| | P0.9 | Save cut-off replies | P1 | P0.6 |
\
\| | P0.10 | Stream bubble kept until render | P1 | — |
\
\| | P0.11 | Keep draft, Retry reply | P1 | P0.10 |
\
\| | P0.12 | iOS viewport / editor zoom | P1 | — |
\
\| | P0.13 | Confirm before changing summarized messages (wording per L1) | P2 | — |
\
\| | P0.14 | "Turns not sent" label | P3 | — |
\
\| | P0.15 | Provider token count in the viewer | P3 | — |
\
\| | \~\~P0.16\~\~ | Folded into \*\*C3\*\*; read it as the spec only | — | — |
\
\| | P0.17 / P0.18 | Main review items / main-only features (tables, no code) | — | — |
\
\| \*\*1 Scene + context core\*\* | S1 | Acceptance semantics | P0 | — |
\
\| | S2 | Delete scene-extraction mode | P0 | — |
\
\| | S3 | Tolerant scene parser | P0 | S2 |
\
\| | S4 | Scene timeline + history replay | P0 | S1, S3 |
\
\| | S5 | Warn-only turn flow | P0 | S1, S3, S4 |
\
\| | S6 | Lint precision | P1 | S5 |
\
\| | S7 | OOC classifier | P1 | S5 |
\
\| | S8 | validateSceneValues keeps prior values | P1 | S3, S6 |
\
\| | S9 | No bracket metadata in context (step 3 owned by C3) | P1 | S1 |
\
\| | S10 | Edit, scene chip, pending UI | P1 | S3, S4, S5, U4 |
\
\| | S11 | Scene recovery hardening | P1 | S3, S5 |
\
\| | S12 | Card selection uses recent narration | P2 | S4 |
\
\| | C1 | Prompt delivery to existing users | P1 | U7 step 3 (or do that part here) |
\
\| | C2 | Legacy route + golden test (incl. new \*\*step 0\*\*, see R5) | P0 | P0.5, S3 step 1 |
\
\| | C3 | Memory-mode request layout (+ P0.16) | P0 | C2, S1, S2 |
\
\| | C4 | Prompt text edits | P0 | C1, C3 |
\
\| \*\*2 Memory\*\* | L1 | Edits stop pausing memory | P0 | — |
\
\| | L2 | Range-only staleness, rebase on commit | P0 | L1 |
\
\| | L3 | Lenient extraction grammar | P0 | L2 |
\
\| | L4 | Maintenance arbitration, one-chunk summary | P0 | (L5 recommended first) |
\
\| | L5 | Summary coverage as a range, drop evidence | P1 | L1 |
\
\| | L6 | Reorganize real replace | P1 | L3 |
\
\| | L7 | Explain idle memory, pointer repair | P2 | — |
\
\| | L8 | Export escaping, v2 import, user-line order | P2 | — |
\
\| | L9 | Duplicate-story orphans (optional) | P3 | — |
\
\| \*\*3 Budget\*\* | C5 | Input-budget semantics, indicator, auto-summary | P1 | C2, C3 |
\
\| \*\*4 UI / concurrency\*\* | U1 | Busy token, stale-turn checks | P0 | S5, L4 (see R9) |
\
\| | U2 | Send-path reads, single session source | P1 | U1 |
\
\| | U3 | Lore listener recovery, write cost | P1 | L2 (see R11) |
\
\| | U4 | Render correctness and cost | P1 | — (S10 needs it; do it early) |
\
\| | U5 | Stop / timeout / clamp / tokenizer label | P1 | P0.6, P0.9 |
\
\| | U6 | Composer draft, iOS zoom | P2 | P0.11, P0.12 |
\
\| | U7 | Device-local settings, failed-load guard | P1 | — |
\
\| | U8 | Indicator debounce, viewer reads, cache meta | P2 | C5 |
\
\| | U9 | Small fixes a–m | P2/P3 | — |
\
\| \*\*5 Polish\*\* | C6 | Cost memo + token LRU 3000 | P2 | C3 |
\
\| | C7 | Lore render / selection | P2 | S9, S12 |
\
\| | C8 | Block window alignment | P2 | C6 |
\
\| | C9 | Known-names cap | P2 | L3 (same prompt) |
\

\
Phase 1 is where the scene-format complaint gets fixed. If time is short, do Phase 0, then S1–S5, C2, C3 and C4, then measure again with the eval in \`investigate/\` before you continue.
\

\
\---
\

\
\## 4. Conflict resolutions between parts (these override the task text)
\

\
The five parts were written separately. If a task body disagrees with this section, \*\*this section wins\*\*.
\

\
\*\*ID names.\*\*
\
\- Part L's tasks are L1–L9.
\
\- Each part's "new problems" are prefixed by part: B-N\*, C-N\*, L-N\*, U-N\*.
\
\- "Plan B / Plan E" in the text means Part B / Part U. Part C's "section 3 agent" means Part L.
\
\- MAIN task IDs refer to \`FIX_PLAN_MAIN.md\`: M1 freshness, M2 finish reason, M3 deploy, M4 editor height, M5 token cache, M8 stream timeout, M9 logout.
\

\
\| # | Topic | Resolution |
\
\|---|---|---|
\
\| R1 | P0.16 vs C3 | P0.16 is not implemented on its own. C3 rewrites \`render()\` and \*\*must\*\* include P0.16's behaviour: the 3 \`omitted-turns\*.md\` files, the gap block in the report, and P0.16's acceptance and tests. |
\
\| R2 | Token cache | P0.5 keeps only the rule "never cache counts while \`!tokenizerReady()\`" and the interim clear at 5000. C6 replaces it with one LRU of \*\*3000\*\* (Part C says 1000; use 3000). |
\
\| R3 | \`stripThinking\` / \`story-text.js\` | Ported once, in S3 step 1. C3 and C2 import it from there. Never apply it in \`buildRequestBody\` (P0 conflict 1). |
\
\| R4 | \`tokenizerReady\` | Comes from P0.5. |
\
\| R5 | Part C's "0.1 merge of main" | There is no separate merge task. Read "0.1" as follows. \*\*C2 step 0 (new):\*\* port MAIN \`js/request-budget.js\` (\`requestInputLimit\`, \`MESSAGE_FRAME_TOKENS\`, \`REQUEST_FRAME_TOKENS\`) and the optional \`modelContextTokens\` setting (default empty, so behaviour is unchanged). Do not import MAIN's two-argument \`planInjectionBlock\` (C-N8). The \*semantics\* change of \`maxContextTokens\` happens later, in C5. |
\
\| R6 | S9 step 3 (opening label) | Owned by C3. S9 skips step 3. |
\
\| R7 | Writing-contract site in C4 item 1 | If S2 is done first, that file is gone; skip that site. If S2 is not done, update the separate-mode \`.replace()\` strings in the same change (C-N5). |
\
\| R8 | Edit confirm (P0.13) vs L1 | After L1, edits keep the summary checkpoint. Remove the "folded message \*\*edit\*\*" confirm. Keep the \*\*delete\*\* warning and the active-summary warning, worded as "Deleting this will invalidate the summary". Until L1 lands, P0.13's original text is correct. |
\
\| R9 | Summary before narration | L4 removes the pre-narration summary. That supersedes S1 step 4, U1 checkpoint 3 and the pre-narration parts of U2. Whichever task lands second deletes the dead code. |
\
\| R10 | Forced pause on edit | L1 step 8 wins over U2 step 3. Do not set \`paused\`/\`needsRebuild\` on edit. |
\
\| R11 | \`commitExtraction\` | U3 (return \`loreRevision\`, \`gateWrite\`) and L2 (range guard, rebase) both change it. Do L2 first; U3 adds its return value and gate on top. Do not run them in parallel. |
\
\| R12 | Legacy summarizer differences (C-N3: \`CONTINUITY_RULE\`, accepted gate) | Part L owns them, done with L4. With memory off, the summarizer request must equal MAIN's (no \`CONTINUITY_RULE\`, no acceptance gate). C2's golden test only covers the narrator request. |
\
\| R13 | Extraction prompt | C9 (known-names cap) and L3 (T prefix, grammar) both edit it. Do L3 first. |
\
\| R14 | Carried scene | S5 replaces \`carryScene\` with \`scene: null\` plus a carried reference (\`sceneTimeline\`). P0.9 and U5 must use S5's form once S5 lands. Before S5, P0.9 may use \`carryScene\`. |
\
\| R15 | Timeout | 120 s everywhere (D11). |
\
\| R16 | \`.gitignore\` | P0.1 wins over U9m. Keep \`js/firebase-config.js\` ignored, because the deploy generates it. |
\
\| R17 | Clear chat cache on logout | U9i and P0.18 "clearChatCache" are the same item. Do it in U9i only. |
\
\| R18 | Settings prompt copies | C1 builds on U7 step 3 ("prompt defaults are not stored"). Do U7 first, or do U7 step 3 inside C1 and mark it done in U7. |
\
\| R19 | \`sameRenderedMessage\` | U4 owns the full compare, including \`truncated\` from P0.9 and the scene and acceptance fields from S10. |
\
\| R20 | Main freshness model | FEATURE keeps \`historyRevision\`/\`reconcileStory\`. MAIN M1 does \*\*not\*\* apply here. |
\

\
\---
\

\
\## 5. Coverage index (REVIEW_FINDINGS → task)
\

\
\| Findings | Task(s) |
\
\|---|---|
\
\| §0 (merge main first, Zone files, deploy, console log) | P0.1–P0.18 |
\
\| 1.1, 1.9, 1.15 | S1, S10 |
\
\| 1.2, 1.18, 1.23 | S5 |
\
\| 1.3 | S6 |
\
\| 1.4, 1.12, 1.13, 1.19, 1.20, 1.24 | S3 (1.20 salvage also S5) |
\
\| 1.5, 1.10, 1.17, 1.22 | S4 |
\
\| 1.6 | S1 (prefix), S9 |
\
\| 1.7, 1.21 | S8 |
\
\| 1.8 | S7 |
\
\| 1.11, 1.16 | S10 |
\
\| 1.14 | S11 |
\
\| 1.25 | S2 |
\
\| 2.1, 2.2, 2.4, 2.7, 2.8, 2.9 | C3 (2.9 with P0.16) |
\
\| 2.3 | C2 |
\
\| 2.5, §2a 1–13 | C4 |
\
\| §2a 14 | C1 |
\
\| 2.6 | S12 |
\
\| 2.10, 2.11, 2.18 | C5 (2.18 frame constants in C2) |
\
\| 2.12 | C9 |
\
\| 2.13, 2.14 | C6 |
\
\| 2.15 | C8 |
\
\| 2.16, 2.17 | C7 |
\
\| 3.2, 3.8 | L1 |
\
\| 3.1, 3.9, 3.12 | L2 (3.12 parse part in L3) |
\
\| 3.4, 3.5, 3.11, 3.19, 3.20 | L3 |
\
\| 3.3 | L4 |
\
\| 3.10 | L5 |
\
\| 3.6, 3.7 | L6 |
\
\| 3.13, 3.14 | L7 |
\
\| 3.15, 3.16, 3.18 | L8 |
\
\| 3.17 | L9 |
\
\| 4.1 | U1 |
\
\| 4.2, 4.4 | U2, U8 |
\
\| 4.3 | U3 |
\
\| 5.1, 5.10, 5.12 | U4 |
\
\| 5.2, 5.3, 5.5, 5.6 | U5 (client part in P0.6) |
\
\| 5.4, 5.8 | U6 (port part in P0.11, P0.12) |
\
\| 5.7 | U7, C1 |
\
\| 5.9 | U1 |
\
\| 5.11 | P0.3 |
\
\| 5.13 | U9 |
\

\
Each part also lists its own \*\*corrections\*\* to REVIEW_FINDINGS and the \*\*new problems\*\* it found (B-N\*, C-N\*, L-N\*, U-N\*). They are near the top of each part. The most serious new one is \*\*U-N1\*\*: a history truncation race in \`handleSend\`, fixed in U1.
\

\

\
\---
\

\
\# Part A — Phase 0: safety, and port main's fixes (P0.x)
\

\
Folders:
\
\- MAIN = \`Nera_chat-main/Nera_chat-main\` (17 FIX_PLAN fixes applied, 120 tests pass).
\
\- FEATURE = \`Nera_chat-feature-story-memory/Nera_chat-feature-story-memory\` (147 tests pass, forked before the fixes).
\

\
Neither folder is a git repo. Line numbers are approximate (±5). Test command, run from the FEATURE root: \`node --experimental-vm-modules --test tests/\*.mjs\`. The baseline is 147/147. Every task below must end with the full suite green.
\

\
House rules for every task:
\
\- At most 2 LLM calls per user turn.
\
\- No server; count Firestore reads.
\
\- With every memory toggle off, FEATURE must behave like the pre-memory app.
\
\- No data migration: old docs must keep working, and new fields are optional.
\

\
None of the tasks below adds an LLM call, a Firestore listener or a stored-data migration. P0.11 (Retry) and P0.13 add no reads beyond what a normal send already does.
\

\
\## Status table
\

\
FEATURE status is one of: present, missing, partial, conflict, n/a.
\

\
\| FIX_PLAN task | Status in FEATURE | Porting task |
\
\|---|---|---|
\
\| 1. Black gap after a reply (stream bubble swap) | missing | P0.10 |
\
\| 2. Black gap below the composer (viewport, zoom) | missing | P0.12 |
\
\| 3. Stream vibration | skipped by the owner | none |
\
\| 4. Cached story never loads remote turns | present, done another way (\`historyRevision\` + \`reconcileStory\` + listener on cached restore). Do not port MAIN's catch-up. | none (M1 does not apply) |
\
\| 5. Orphan user message, no Retry, lost draft | missing | P0.11 |
\
\| 6. Length-limited reply thrown away | missing | P0.6 (client) + P0.9 (save and UI) |
\
\| 7. Reasoning budget vs response budget | missing (default is 20000 > 8192) | P0.7 |
\
\| 8. Summarizer input can exceed the window | present (\`summarizer.js\` uses \`maxContextTokens - maxResponseTokens\`) | none |
\
\| 9. Tokenizer failure is permanent | missing | P0.5 |
\
\| 10. Summary placement, missing gap marker | missing, and it conflicts (different builder: \`memory-context.js\`) | P0.16 |
\
\| 11. Plan "lost" contradiction | partial (MAIN's two old defaults are auto-upgraded; custom prompts still carry the rule) | P0.8 |
\
\| 12. Folded edit/delete warnings | missing, and it conflicts (FEATURE also clears the summary on edits) | P0.13 |
\
\| 13. Regenerate blocked when the plan is locked | n/a (FEATURE has no LLM plan updates and no \`planBefore\` guard) | none |
\
\| 14. Silent dropped turns | partial (label says "out of window", always, with no hint) | P0.14 |
\
\| 15. \`default_prompt\` summary section | n/a (\`default_prompt\` is MAIN-only; FEATURE \`narrator.md\` has no such section) | none |
\
\| 16. Provider \`usage\` ignored | missing | P0.15 |
\
\| 17. Export loses summaries/plan/thinking | present, done another way (v2 \`nera\` JSONL export and import, with lore and full messages) | none |
\

\
\*\*Count:\*\*
\
\- Missing: 9 (tasks 1, 2, 5, 6, 7, 9, 10, 12, 16).
\
\- Partial: 2 (tasks 11, 14).
\
\- Present or done another way: 4 (tasks 4, 8, 13, 17).
\
\- n/a: 1 (task 15).
\
\- Skipped: 1 (task 3).
\

\
\*\*Hard conflicts.\*\* Read these before porting anything.
\
1\. \*\*Do not port MAIN's \`buildRequestBody\` change.\*\* It runs \`storyText()\` over every assistant message. In FEATURE, \`stripPlan\` also strips \`\<scene>\` (plan-parser.js \~26-33). That would delete the \`\<plan_thread>\`/\`\<scene>\` examples that \`memory-context.js contentFor\` (\~51) adds on purpose. MAIN's \`chatCompletion\` also dropped the \`responseFormat\`/\`provider\` parameters, which scene-recovery and scene-extraction need. Port only the pieces named in P0.6.
\
2\. \*\*Freshness model.\*\* MAIN (Task 4) uses \`checkTurnFreshness\`/\`catchUpMessages\`/\`expectedNextOrder\`/\`sessionEpoch\`. FEATURE uses \`historyRevision\`, \`reconcileStory()\` (one server read per turn) and \`assertSource\`. Keep FEATURE's model. Do not port MAIN's catch-up. Because of that, MAIN open item M1 (the false "New messages arrived" error) does not apply to FEATURE.
\
3\. \*\*Summary on edit.\*\*
\
&#x20; \- MAIN keeps the summary checkpoint when a message is edited ("Edits preserve the active checkpoint; only deletions invalidate it").
\
&#x20; \- FEATURE \`changeMessage\` (messages.js \~276) clears it when you edit any folded message. It even clears it when you edit the active summary itself. \`memory-context.js\` (\~41) also drops the summary when any evidence message's revision changed.
\
&#x20; \- With every memory toggle off, this differs from the pre-memory app. This is a house-rule break that review item 2.3 does not list. P0.13 adds warnings that match today's FEATURE behaviour. Phase 3 (legacy parity) must decide the semantics. The recommendation: editing the active summary must keep it active, in every mode.
\
4\. \*\*What \`maxContextTokens\` means.\*\*
\
&#x20; \- MAIN changed it to "max input tokens", added an optional \`modelContextTokens\`, and removed the "max context > max response" check.
\
&#x20; \- FEATURE treats it as the total budget (\`limit = maxContextTokens - maxResponseTokens\`, memory-context.js \~16).
\
&#x20; \- Do not port MAIN's meaning, its validation removal, or \`request-budget.js\` in Phase 0. That is review item 2.3/2.11 (Phase 3).
\
5\. \*\*Context inspector.\*\* MAIN has \`js/ui/context-view\.js\` (a \`\<dialog>\` with "Next turn / Latest sent"). FEATURE has \`js/ui/context-viewer.js\` (a sheet with memory blocks). Both bind the toolbar indicator. Keep FEATURE's and add only provider usage (P0.15).
\
6\. \*\*MAIN's plan sentence is false in FEATURE.\*\* MAIN's sentence says "The app removes \`\<plan>\` and \`\<plan_thread>\` tags from the visible history". FEATURE re-appends \`\<plan_thread>\` to accepted replies, so P0.8 uses different wording.
\

\
Order: P0.1–P0.4 are safety work and can ship on their own. P0.5–P0.8 are small module ports. P0.9–P0.15 touch \`chat-view\.js\`; do them in this order, one at a time, because they edit the same functions. P0.16 is the riskiest and goes last. P0.17 and P0.18 are follow-ups and owner decisions.
\

\
\---
\

\
\## P0.1 Delete Zone.Identifier files and fix \`.gitignore\`
\

\
\*\*Findings covered:\*\* 0.2 (part), MAIN open item 5, 5.13 (\`.gitignore\` comment).
\

\
\*\*Problem:\*\*
\
\- FEATURE has 282 \`\*:Zone.Identifier\` files and MAIN has 48. These are Windows download markers.
\
\- They reveal local paths, for example \`ReferrerUrl=\\\wsl.localhost\Ubuntu-24.04\home\nguyennhp\projects\Nera_chat-feature-story-memory.zip\`, and today they get deployed.
\
\- \`investigate/\` holds real chat history (\`chat-history.jsonl\`, \`LLM_request.txt\`, \`live/\`).
\
\- GitHub Pages on the free plan needs a \*\*public\*\* repository. So anything committed is public even if the deploy step is fixed.
\

\
\*\*Root cause:\*\* The files were extracted from a zip on Windows. \`.gitignore\` covers neither the Zone files nor \`investigate/\`. The \`.gitignore\` comment says firebase-config.js is "injected by CI from repo secrets", but deploy.yml hard-codes it.
\

\
\*\*Fix:\*\*
\
1\. In both folders, run: \`find . -name '\*:Zone.Identifier' -type f -delete\`. Check with \`find . -name '\*Zone.Identifier' | wc -l\`, which must print 0.
\
2\. Replace FEATURE \`.gitignore\` with:
\
&#x20; \`\`\`gitignore
\
&#x20; \# Generated by the deploy workflow (Firebase web config is public by design;
\
&#x20; \# access is enforced by firestore.rules)
\
&#x20; js/firebase-config.js
\

\
&#x20; \# Local-only account registration page — never commit, never deploy
\
&#x20; register.html
\

\
&#x20; \# Private material: never commit (GitHub Pages repos are public)
\
&#x20; .private/
\
&#x20; private/
\
&#x20; investigate/
\

\
&#x20; \# OS / download artefacts
\
&#x20; .DS_Store
\
&#x20; \*:Zone.Identifier
\
&#x20; \`\`\`
\
3\. MAIN \`.gitignore\`: add the same \`private/\`, \`\*:Zone.Identifier\` and corrected comment lines. MAIN has no \`investigate/\`.
\
4\. Leave \`investigate/\` where it is. Its scripts resolve paths with \`new URL('../', import.meta.url)\` and import \`../tests/app-harness.mjs\`, so moving it breaks them. Ignoring it is enough.
\
5\. Tell the owner:
\
&#x20; \- If this repo was ever pushed with \`investigate/\`, \`starting/\` or \`docs/\` in it, those files are already public in git history. Remove them with \`git rm -r --cached investigate\` and decide whether to rewrite history.
\
&#x20; \- \`starting/lorebooks.md\`, \`docs/\`, \`memory.md\` and \`opencode.json\` are not needed at runtime. The owner decides whether they are private (if so, add them to \`.gitignore\`).
\

\
\*\*Acceptance:\*\* No Zone files in either tree. A fresh \`git init && git add -A && git status\` in a scratch copy of FEATURE lists no \`investigate/\` and no \`\*:Zone.Identifier\`.
\

\
\*\*Tests:\*\* Run the full suite (no code change). It must stay at 147/147.
\

\
\---
\

\
\## P0.2 Deploy only app files
\

\
\*\*Findings covered:\*\* 0.2.
\

\
\*\*Problem:\*\* The deploy publishes the whole checkout.
\

\
\*\*Root cause:\*\* \`.github/workflows/deploy.yml:38-40\` uses \`actions/upload-pages-artifact@v3\` with \`path: .\`. Today this publishes \`investigate/\` (when committed), \`docs/\`, \`starting/\`, \`memory.md\`, \`opencode.json\`, \`REVIEW_FINDINGS.md\`, \`tests/\`, \`scripts/\`, the Zone files and \`firestore.rules\`. Confirmed. MAIN's deploy.yml is byte-identical, so MAIN publishes \`REVIEW_FINDINGS.md\`, \`FIX_PLAN_MAIN.md\`, \`default_prompt\` and the rest as well.
\

\
The runtime files FEATURE needs were checked by grepping every \`fetch\`, \`import\`, \`new URL\` and HTML \`src\`/\`href\`:
\
\- \`index.html\`
\
\- \`css/style.css\`
\
\- \`js/\*\*\` (including the generated \`js/firebase-config.js\`)
\
\- \`system prompts/\*.md\` (system-prompts.js:33)
\
\- \`resources/pets/\*\` (pet-view\.js:4,30)
\

\
Nothing else is loaded.
\

\
\*\*Fix:\*\* In FEATURE \`deploy.yml\`, keep the "Write firebase-config.js" step exactly as it is. Replace the \`upload-pages-artifact\` step (lines 38-40) with:
\

\
\`\`\`yaml
\
&#x20; \- name: Assemble site (app files only)
\
&#x20; run: |
\
&#x20; set -euo pipefail
\
&#x20; rm -rf \_site
\
&#x20; mkdir -p "\_site/system prompts"
\
&#x20; cp index.html \_site/
\
&#x20; cp -R css js resources \_site/
\
&#x20; cp "system prompts/"\*.md "\_site/system prompts/"
\
&#x20; rm -f "\_site/system prompts/README.md"
\
&#x20; find \_site \\( -name '\*:Zone.Identifier' -o -name '.DS_Store' \\) -type f -delete
\
&#x20; \# Guards: required files exist, private folders do not.
\
&#x20; test -s \_site/js/firebase-config.js
\
&#x20; test -s \_site/resources/pets/manifest.json
\
&#x20; for f in $(grep -o '"[A-Za-z0-9-]\*\\.md"' js/system-prompts.js | tr -d '"'); do
\
&#x20;           test -s "\_site/system prompts/$f" || { echo "Missing prompt file: $f"; exit 1; }
\
&#x20;         done
\
&#x20;         for p in investigate docs starting tests scripts private memory.md opencode.json REVIEW_FINDINGS.md; do
\
&#x20;           test ! -e "\_site/$p" || { echo "Private path in site: $p"; exit 1; }
\
&#x20; done
\

\
&#x20; \- uses: actions/upload-pages-artifact@v3
\
&#x20; with:
\
&#x20; path: \_site
\
\`\`\`
\

\
Notes:
\
\- \`cp "system prompts/"\*.md\` does not match \`narrator.md:Zone.Identifier\`, because that name does not end in \`.md\`.
\
\- The prompt-file loop fails the build if a prompt listed in \`system-prompts.js\` is missing. Without that guard, a missing prompt gives a blank page (see P0.4).
\
\- \`actions/deploy-pages\` does not run Jekyll, so \`.nojekyll\` is not needed.
\
\- For MAIN (out of this plan's scope, but the bug is the same), use the same step with \`cp index.html rewrite_default_prompt.md \_site/\` and no \`system prompts\` lines. MAIN's \`js/rewrite.js:9\` fetches \`./rewrite_default_prompt.md\`.
\
\- If the owner later ports the rewrite feature into FEATURE (P0.18), add \`rewrite_default_prompt.md\` to the FEATURE copy list.
\

\
\*\*Acceptance:\*\*
\
\- A workflow run uploads an artifact containing exactly: \`index.html\`, \`css/\`, \`js/\`, \`resources/\`, \`system prompts/\` (27 \`.md\` files).
\
\- The app loads, logs in, and shows pets.
\
\- \`https\://\<site>/investigate/chat-history.jsonl\` returns 404.
\

\
\*\*Tests:\*\* No unit test. Run the "Assemble site" script locally in a scratch copy (after creating a dummy \`js/firebase-config.js\`), then check: \`find \_site -type f | sort\`.
\

\
\---
\

\
\## P0.3 Stop logging the full request body
\

\
\*\*Findings covered:\*\* 5.11. Confirmed.
\

\
\*\*Problem:\*\* Every LLM call prints the whole request (the private story, lore and plan) to the browser console. That includes background memory updates and scene recovery.
\

\
\*\*Root cause:\*\* \`js/llm-client.js\` \`serializedRequestBody\` (\~51-58), line 56: \`console.log("[LLM request body]", serialized);\`. It is the only \`console.log\` in FEATURE \`js/\`. MAIN has no such log.
\

\
\*\*Fix:\*\*
\
1\. Delete line 56. Keep \`serializedRequestBody\`, because it still merges \`response_format\` and \`provider\`.
\
2\. Optional, only if the owner wants it for \`investigate/\` work: gate it behind a device-local flag. The default must be off.
\
&#x20; \`\`\`js
\
&#x20; if (globalThis.localStorage?.getItem('nera.debugRequests') === '1') console.log('[LLM request body]', serialized);
\
&#x20; \`\`\`
\
&#x20; Do not add a settings UI for it.
\

\
\*\*Acceptance:\*\* A normal send prints nothing to the console.
\

\
\*\*Tests:\*\* In \`tests/regressions.mjs\`, next to the existing \`chatCompletion\` tests (\~555-590), add a test that passes a \`console\` spy into the harness globals. Run one streamed and one non-streamed call, and assert \`log\` was never called.
\

\
\---
\

\
\## P0.4 Show an error screen instead of a blank page when startup fails
\

\
\*\*Findings covered:\*\* 0.3. Confirmed. Part of the review's fix is wrong; see below.
\

\
\*\*Problem:\*\* If any of the 27 prompt fetches fails (offline, flaky mobile network, a missing file after a bad deploy), the page stays blank and the login form never appears. The same thing happens today when a Firebase CDN import fails, in both FEATURE and MAIN.
\

\
\*\*Root cause:\*\*
\
\- \`js/system-prompts.js:41-43\`: \`export const prompts = Object.freeze(Object.fromEntries(await Promise.all(...loadPrompt...)))\`. This is a top-level \`await\`. One rejected \`loadPrompt\` (\~32-39) rejects the module.
\
\- Ten modules read \`prompts.\*\` at module load: settings.js:13 and 43-44, context-builder.js:22, continuity.js:3, memory-prompts.js:7-11, scene.js:3, and others.
\
\- \`index.html:271\` loads \`js/app.js\` as the entry, so the whole module graph fails before any code can show a message.
\

\
\*\*What is wrong in the review's fix:\*\*
\
\- "Fall back to built-in text" contradicts the project's own rule. \`system prompts/README.md\` says all built-in LLM text lives only in Markdown and that missing files must stop loading with an error.
\
\- \`tests/system-prompts.mjs\` asserts exactly that ("missing and empty Markdown prompts fail visibly without an inline fallback").
\
\- \`Promise.allSettled\` alone would just hand \`undefined\` prompts to every module.
\
\- "Normal caching with a version query" is optional. It is not the cause of the blank page. \`cache:'no-cache'\` costs 27 cheap 304 revalidations and is asserted by the test. Keep it.
\

\
\*\*Fix:\*\* Keep \`system-prompts.js\` unchanged. Add a tiny boot loader, so the failure becomes visible and recoverable.
\
1\. New file \`js/boot-core.js\`. It has no imports, so it cannot fail to load.
\
&#x20; \`\`\`js
\
&#x20; // Starts the app and turns any startup failure into a visible, recoverable screen.
\
&#x20; export async function startApp({ load, doc, reload }) {
\
&#x20; try {
\
&#x20; await load();
\
&#x20; return true;
\
&#x20; } catch (error) {
\
&#x20; console.error(error);
\
&#x20; const box = doc.createElement('div');
\
&#x20; box.id = 'boot-error'; box.className = 'boot-error'; box.setAttribute('role', 'alert');
\
&#x20; const title = doc.createElement('h1'); title.textContent = 'Nera Chat could not start';
\
&#x20; const detail = doc.createElement('p'); detail.textContent = error?.message || String(error);
\
&#x20; const hint = doc.createElement('p'); hint.textContent = 'Check your connection, then reload. Your stories are stored on the server and are not affected.';
\
&#x20; const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = 'Reload';
\
&#x20; button.addEventListener('click', () => reload());
\
&#x20; box.append(title, detail, hint, button);
\
&#x20; doc.body.prepend(box);
\
&#x20; return false;
\
&#x20; }
\
&#x20; }
\
&#x20; \`\`\`
\
2\. New file \`js/boot.js\`:
\
&#x20; \`\`\`js
\
&#x20; import { startApp } from './boot-core.js';
\
&#x20; startApp({ load: () => import('./app.js'), doc: document, reload: () => location.reload() });
\
&#x20; \`\`\`
\
3\. \`index.html:271\`: change \`src="js/app.js"\` to \`src="js/boot.js"\`.
\
4\. \`css/style.css\`: add
\
&#x20; \`.boot-error { position: fixed; inset: 0; z-index: 1000; display: grid; place-content: center; gap: 12px; padding: 24px; background: var(--bg, #111); color: var(--text, #eee); text-align: center; }\`.
\
&#x20; Before saving, check that these variable names exist in \`:root\`. If they do not, use the literal colours.
\
5\. The button must reload the page, not call \`import()\` again. A module whose evaluation failed stays failed in the browser's module map, so a second \`import('./app.js')\` rejects with the same error.
\
6\. No other file changes. \`app.js\` still runs its top-level code when it is imported dynamically.
\
7\. Optional, for MAIN: the same boot files fix a Firebase CDN failure there too.
\

\
\*\*Acceptance:\*\*
\
\- Use devtools to block \`system%20prompts/scene.md\`, then reload. An error screen appears that names the file and HTTP status, with a Reload button. Unblock it and press Reload: the app starts.
\
\- Block \`www\.gstatic.com\`: the error screen appears instead of a blank page.
\
\- A normal load looks and behaves exactly as before.
\

\
\*\*Tests:\*\*
\
\- New \`tests/boot.mjs\`, which loads \`js/boot-core.js\` with \`vm.SourceTextModule\`. It has no dependencies. Use a minimal fake \`doc\`: \`createElement\` returns an object with \`append\`, \`setAttribute\` and \`addEventListener\` that records the listener, plus \`textContent\`. \`doc.body.prepend\` records its argument.
\
\- Cases:
\
&#x20; \- \`load\` resolves: returns \`true\` and \`prepend\` is not called.
\
&#x20; \- \`load\` rejects with \`Error('Failed to load system prompt scene.md: HTTP 404')\`: returns \`false\`, \`prepend\` is called once, the text contains \`scene.md\`, and clicking the recorded listener calls \`reload\` once.
\
\- \`tests/system-prompts.mjs\` stays unchanged and must still pass.
\

\
\---
\

\
\## P0.5 Tokenizer: retry after failure, never cache fallback counts
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 9, review 5.2 (the retry part). Sibling plan E-U5 adds the user-visible warning on top of this.
\

\
\*\*Problem:\*\* One failed CDN import makes \`countTokens\` return byte counts for the whole session, about 4× too high for English. The budget then drops to about a quarter. Those inflated numbers are also cached in \`countSystemTokensCached\`.
\

\
\*\*Root cause:\*\*
\
\- \`js/tokenizer.js:9-26\`: \`modPromise\` keeps a rejected promise forever. FEATURE's file is identical to MAIN's pre-fix version.
\
\- \`js/context-builder.js\` \`countSystemTokensCached\` (\~35-43) caches whatever \`countTokens\` returned, including fallback byte counts. All counting in \`memory-context.js\` goes through this function (the \`count\` option), so FEATURE already recounts every candidate. The other half of Task 9 ("recount candidates instead of stored tokenCount") is already true in FEATURE.
\

\
\*\*Fix:\*\*
\
1\. Replace FEATURE \`js/tokenizer.js\` with MAIN \`js/tokenizer.js\`, verbatim:
\
&#x20; \- \`createTokenizer({ importer, now })\`
\
&#x20; \- a 30 s cooldown
\
&#x20; \- a \`?nera_retry=N\` URL so a cached failed import is bypassed
\
&#x20; \- the encoder shape check
\
&#x20; \- exports \`countTokens\`, \`tokenizerReady\` and \`createTokenizer\`
\
&#x20; Every existing import of \`countTokens\` keeps working.
\
2\. \`js/context-builder.js\`: import the module as a namespace, so the \~20 test stubs that only define \`countTokens\` still link. A named import of a missing export fails linking of the \`vm.SyntheticModule\` stubs in tests/memory.mjs, scene-\*.mjs, regressions.mjs and message-chunks.mjs.
\
&#x20; \`\`\`js
\
&#x20; import \* as tokenizer from "./tokenizer.js";
\
&#x20; const tokenizerIsReady = () => tokenizer.tokenizerReady?.() !== false;
\
&#x20; async function countSystemTokensCached(text) {
\
&#x20; let cached = systemTokenCache.get(text);
\
&#x20; if (cached === undefined) {
\
&#x20; cached = await tokenizer.countTokens(text);
\
&#x20; if (!tokenizerIsReady()) return cached; // never cache fallback byte counts
\
&#x20; if (systemTokenCache.size >= 5000) systemTokenCache.clear(); // interim only: C6 replaces this with one LRU of 3000 (= FIX_PLAN_MAIN M5)
\
&#x20; systemTokenCache.set(text, cached);
\
&#x20; }
\
&#x20; return cached;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Replace the other \`countTokens\` uses in this file with \`tokenizer.countTokens\`.
\
3\. Do not change \`messages.js\` (it stores \`tokenCount\` at save time). FEATURE's builder does not read the stored \`tokenCount\`.
\

\
\*\*Acceptance:\*\*
\
\- Block \`esm.sh\` and \`cdn.jsdelivr.net\` and load a story: the bar shows inflated numbers. Unblock them and wait 30 s; the next indicator refresh, or send, shows normal numbers without a page reload.
\
\- In the normal case, nothing changes.
\

\
\*\*Tests:\*\*
\
\- Copy MAIN \`tests/tokenizer.mjs\` into FEATURE \`tests/\`. It loads only \`js/tokenizer.js\` and should run unchanged; adjust the relative path if it differs.
\
\- Port MAIN regression "Tokenizer recovery recounts identical text and ignores old inflated stored counts" (MAIN tests/regressions.mjs \~1566) against FEATURE \`context-builder.js\`. Use a stub tokenizer module that exports \`countTokens\` plus a \`tokenizerReady\` that flips from \`false\` to \`true\`, and assert the second build's \`usedTokens\` is lower.
\

\
\---
\

\
\## P0.6 LLM client: return the finish reason, allow \`length\` only for the narrator
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 6 (client part), review 5.3 (client part), MAIN open item M2.
\

\
\*\*Problem:\*\* A reply that stops at the output limit throws, and the paid reply is lost. Every finish reason except \`stop\` throws, including harmless provider values.
\

\
\*\*Root cause:\*\*
\
\- \`js/llm-client.js\` \`checkFinishReason\` (\~42-49) throws on \`length\` and on every reason other than \`stop\`.
\
\- \`nonStreamedCompletion\` and \`streamedCompletion\` (\~85-89, \~163-167) do not return the reason.
\

\
\*\*Fix:\*\*
\
1\. Change the signature to \`chatCompletion({ settings, messages, onDelta, onReasoning, signal, responseFormat, provider, allowTruncated = false })\`. Pass \`allowTruncated\` through to both inner functions. Keep \`responseFormat\` and \`provider\` (conflict 1). The name \`allowTruncated\` matches sibling plan E-U5.
\
2\. Replace \`checkFinishReason\`. This is MAIN's current rule plus the opt-in. If MAIN plan task M2 (the denylist) is already done when you start, use M2's final list here instead.
\
&#x20; \`\`\`js
\
&#x20; const BAD_FINISH = new Set(['content_filter', 'error', 'tool_calls', 'function_call']);
\
&#x20; function finishKind(reason) {
\
&#x20; const r = String(reason ?? '').toLowerCase();
\
&#x20; return r === 'length' || r === 'max_tokens' ? 'length' : r;
\
&#x20; }
\
&#x20; function checkFinishReason(reason, allowTruncated) {
\
&#x20; const kind = finishKind(reason);
\
&#x20; if (kind === 'length') {
\
&#x20; if (allowTruncated) return;
\
&#x20; throw new Error("The model stopped at its output limit. The incomplete reply was not saved.");
\
&#x20; }
\
&#x20; if (BAD_FINISH.has(kind)) throw new Error(\`The model stopped with ${reason}; the incomplete reply was not saved.\`);
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Keep the strict-path message exactly as it is. memory-updater.js (\~96) and the existing test regressions.mjs:569 match on "output limit".
\
&#x20; \- Unknown reasons (\`stop\`, \`end_turn\`, \`STOP\`, \`eos\`, …) are accepted. That is M2's intent.
\
3\. Port MAIN's \`emptyReplyError(reason)\`. Use it for the two "returned no reply" throws (\~83 and \~161), so an empty \`length\` reply says "The output limit left no reply. Raise Max response tokens or lower the reasoning budget."
\
4\. Return \`finishReason: finishKind(...) || null\` from both paths. Return \`'length'\` for both \`length\` and \`max_tokens\`.
\
5\. Do \*\*not\*\* port MAIN's \`storyText\` mapping in \`buildRequestBody\`, or \`onRequest\` (conflict 1 and P0.18).
\
6\. Callers: only \`runAssistantTurn\` passes \`allowTruncated: true\` (P0.9). The summarizer, scene recovery, scene extraction, memory updater and reorganize stay strict without any code change.
\
7\. \`js/summarizer.js\` (\~120): to keep MAIN's clearer message, pass \`allowTruncated: true\` and right after the call add:
\
&#x20; \`\`\`js
\
&#x20; if (r.finishReason === 'length') throw new Error('The summary hit the output limit; the checkpoint was not changed. Raise Summarizer max tokens or use smaller summary chunks.');
\
&#x20; \`\`\`
\

\
\*\*Acceptance:\*\*
\
\- A narrator stream ending with \`finish_reason:"length"\` resolves with \`finishReason:'length'\`.
\
\- The same stream through any other caller still rejects with "output limit".
\
\- \`content_filter\` still rejects.
\
\- \`"STOP"\` and \`"end_turn"\` resolve.
\

\
\*\*Tests:\*\* In \`tests/regressions.mjs\`, next to \~555-590:
\
\- Keep the existing \`/output limit/\` reject test (no option).
\
\- Add \`allowTruncated:true\` cases for both the streamed and non-streamed paths, returning \`finishReason:'length'\`.
\
\- Add \`MAX_TOKENS\` mapping to \`'length'\`.
\
\- Add \`end_turn\` accepted.
\
\- Add \`tool_calls\` rejected.
\
\- Add an empty \`length\` reply giving the "output limit left no reply" message.
\
\- Port MAIN's "Truncated summaries cannot replace the checkpoint…" (MAIN \~1503) for the summarizer message.
\

\
\---
\

\
\## P0.7 Settings: the reasoning budget must be below the response budget
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 7, review 5.6 (the clamp part). Sibling plan E-U5 adds effort-value validation.
\

\
\*\*Problem:\*\* The defaults send \`max_tokens: 8192\` with \`reasoning.max_tokens: 20000\`. Reasoning counts toward the response limit, so the model can spend the whole budget thinking and return nothing.
\

\
\*\*Root cause:\*\*
\
\- \`js/settings.js\` \`DEFAULT_SETTINGS.reasoning.maxTokens: 20000\` (\~34).
\
\- \`js/ui/settings-view\.js\` \`validatedDraft\` (\~333-353) parses \`reasoning.maxTokens\` (\~346) without comparing it to \`maxResponseTokens\`.
\

\
\*\*Fix:\*\*
\
1\. \`js/settings.js\` \~34: \`maxTokens: 4096\` (as in MAIN). Existing users keep their stored value; this is not a migration.
\
2\. \`js/ui/settings-view\.js\` \`validatedDraft\`, right after line \~346, port MAIN's check verbatim:
\
&#x20; \`\`\`js
\
&#x20; if (profile.reasoning.maxTokens >= profile.maxResponseTokens) {
\
&#x20; throw new Error("Reasoning max tokens must be lower than Max response tokens (reasoning counts toward the response limit).");
\
&#x20; }
\
&#x20; \`\`\`
\
3\. Keep FEATURE's check at \~352 (\`maxResponseTokens >= maxContextTokens\`). MAIN removed it only because it changed what \`maxContextTokens\` means (conflict 4).
\
4\. Do not port MAIN's \`modelContextTokens\`, rewrite or vibration settings (P0.18).
\

\
\*\*Acceptance:\*\*
\
\- Saving max_tokens reasoning 9000 with max response 8192 shows the error and does not save.
\
\- 4096 / 8192 saves.
\
\- Effort mode is not affected.
\
\- An existing account with 20000 stored still loads. It gets the error only when it tries to save settings while max_tokens mode is on.
\

\
\*\*Tests:\*\* Port MAIN "Reasoning budget must leave output room while input and output limits remain independent" (MAIN \~1534). Keep only the reasoning part, and also assert that FEATURE's "Max context tokens must exceed max response tokens." still fires.
\

\
\---
\

\
\## P0.8 Plan rule: remove the legacy "plan is lost" rule at request time
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 11.
\

\
\*\*Problem:\*\* An account whose custom narrator prompt still contains MAIN's old \`PLAN_THREAD_RECOVERY_RULE\` tells the model to treat the plan as lost. FEATURE's plan text says the plan "stays active when history is trimmed", but never overrides that rule explicitly.
\

\
\*\*Root cause:\*\*
\
\- Already fixed for MAIN's untouched defaults. I hashed MAIN's default narrator prompt both with and without the rule; both SHA-256 values are in \`system prompts/legacy-narrator-default-hashes.md\`. So \`settings.js mergeDefaults\` (\~57-60) replaces them with \`narrator.md\`.
\
\- Not fixed for custom prompts. \`memory-context.js\` (\~30) sends \`settings.narratorSystemPrompt\` as is.
\
\- \`system prompts/fixed-author-plan.md\` has no "absence of tags" sentence.
\

\
\*\*Fix:\*\*
\
1\. \`js/plan-parser.js\`: add a matcher. It is detection data and is never sent, so it follows the README rule that "conflicting old prompt text is not retained":
\
&#x20; \`\`\`js
\
&#x20; // Matches MAIN's obsolete PLAN_THREAD_RECOVERY_RULE so custom prompts that still contain it are neutralised.
\
&#x20; export const LEGACY_PLAN_LOSS_RULE = /\s\*If, at the start of a turn, neither a \<plan> block nor a \<plan_thread> line appears[\s\S]\*?until the user sets a new one\\./g;
\
&#x20; \`\`\`
\
2\. \`js/memory-context.js\` \~30: \`let narrator = (settings.narratorSystemPrompt || '').replace(LEGACY_PLAN_LOSS_RULE, '');\`. The \`narrator === prompts.narrator\` comparison at \~31 still works, because the default does not contain the rule.
\
3\. \`system prompts/fixed-author-plan.md\`: add this as the last sentence of the first paragraph:
\
&#x20; \`Missing \<plan> or \<plan_thread> tags in the history never mean the plan was lost. The plan in this system message is always the current plan; ignore any instruction that says otherwise.\`
\
&#x20; Do \*\*not\*\* use MAIN's wording ("The app removes … tags"), because FEATURE re-appends \`\<plan_thread>\` (conflict 6).
\
4\. \`system prompts/fixed-author-plan-writing.md\`: add the same two sentences.
\
5\. Open owner question, copied from FIX_PLAN Task 11: should the model keep writing \`\<plan_thread>\` every turn? Leave it unchanged.
\

\
\*\*Acceptance:\*\*
\
\- With a custom narrator prompt ending in MAIN's rule, the built request's first system message contains neither "treat that plan as lost" nor "lost from context".
\
\- Default prompts are unchanged, except for the new plan sentence.
\

\
\*\*Tests:\*\*
\
\- Port MAIN "Request-time plan rules remove the legacy lost-plan instruction while preserving custom prompts" (MAIN \~1603) into \`tests/memory.mjs\` or \`regressions.mjs\`. Build with a custom prompt \`'Custom.' + \<MAIN rule text>\` and assert that \`'Custom.'\` stays and the rule is gone.
\
\- Extend \`tests/system-prompts.mjs\` with \`assert.match(api.prompts.plan, /never mean the plan was lost/)\`.
\

\
\---
\

\
\## P0.9 Save length-limited narrator replies and mark them "cut off"
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 6 (save and UI part), review 5.3 (save part). Owner decision 6 is assumed to be "save truncated", as MAIN does. If the owner picks "save as pending", change only step 3.
\

\
\*\*Problem:\*\* After P0.6, the narrator call can return \`finishReason:'length'\`, but \`runAssistantTurn\` ignores it, and the message model has no \`truncated\` flag.
\

\
\*\*Root cause:\*\*
\
\- \`js/ui/chat-view\.js runAssistantTurn\` (\~1066) destructures only \`{ content, thinking }\`.
\
\- \`js/messages.js\`: \`makeMessage\` (\~35) spreads \`...message\`, so a \`truncated\` field already persists on \`addMessage\`. But \`overwriteMessage\` (\~299) whitelists its fields, so the flag is dropped on regenerate. \`editMessage\` (\~292) spreads the old message, so a stale \`truncated:true\` would survive an edit.
\

\
\*\*Fix:\*\*
\
1\. \`messages.js\`:
\
&#x20; \- \`overwriteMessage\`: add \`truncated = false\` to the destructured parameter and to the replacement object.
\
&#x20; \- \`editMessage\`: add \`truncated: false\` to the replacement object, next to \`planThread: null\`.
\
&#x20; \- Old docs have no field, which reads as falsy. No migration.
\
2\. \`chat-view\.js runAssistantTurn\`:
\
&#x20; \- Call \`chatCompletion({ ..., allowTruncated: true })\` and destructure \`{ content, thinking, finishReason, usage }\`. \`usage\` is for P0.15.
\
&#x20; \- Then \`const truncated = finishReason === 'length';\`.
\
&#x20; \- Before the existing \`if (!clean) throw\` line, add: \`if (truncated && !clean) throw new Error('The output limit left no narrative reply. Raise Max response tokens or lower the reasoning budget.');\`.
\
3\. Truncated-turn rules. These match sibling E-U5 step 1.2 and add no LLM call. When \`truncated\`:
\
&#x20; \- Set \`reviewWarnings = []\` and \`pending = false\`. Lint on a cut-off text gives false alarms.
\
&#x20; \- Skip \`recoverScene\`. Add \`!truncated\` to both recovery conditions (\~1082 and \~1091).
\
&#x20; \- When Scene is on and not OOC, use \`acceptedScene = carryScene(prior)\`.
\
&#x20; \- Set \`sceneWarning = 'Reply cut off at the output limit; prior scene kept.'\`.
\
&#x20; \- Add \`truncated\` to the \`message\` object (\~1095).
\
&#x20; \- An unclosed trailing \`\<scene>\` or \`\<plan_thread>\` is already removed by \`stripPlan\` (plan-parser.js \~33).
\
4\. After the save, if \`truncated\`, show: \`showTransientError('Reply saved but cut off at the output limit. Raise Max response tokens or use Regenerate.')\`. Use this instead of the generic "Reply saved. " + sceneWarning text.
\
5\. \`renderMessage\` (\~685): after the "(edited)" line, add \`if (m.truncated) label.textContent += ' · cut off';\`.
\
6\. \`sameRenderedMessage\` (\~666): add \`&& Boolean(a.truncated) === Boolean(b.truncated)\`. Sibling E-U4 extends this comparison further later.
\

\
\*\*Acceptance:\*\*
\
\- With max response 50, a long reply is saved, shows "Assistant · cut off", makes exactly 1 LLM call (no recovery), and the composer is free.
\
\- Regenerate with a normal limit clears "cut off".
\
\- Editing the message clears "cut off".
\
\- Scene off: no scene fields change.
\

\
\*\*Tests:\*\*
\
\- Port MAIN "A non-streaming length-limited reply is saved and visibly marked" (MAIN \~1519) to FEATURE's chat-view harness (regressions.mjs \~82-130 builds it).
\
\- Add FEATURE-specific cases:
\
&#x20; \- with Scene on and \`sceneFallback:true\`, a \`length\` reply makes no second \`chatCompletion\` call, and the saved message has \`sceneMeta.kind === 'carried'\` and \`acceptance:'accepted'\`
\
&#x20; \- a \`message-chunks.mjs\` case (port MAIN \~399-402): \`truncated\` survives \`addMessage\` and is cleared by \`editMessage\` and by \`overwriteMessage\` without the flag
\

\
\---
\

\
\## P0.10 Keep the stream bubble until the saved message is rendered
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 1.
\

\
\*\*Problem:\*\* On iOS, a black gap appears between the last message and the composer after a reply. The live bubble is removed before the save, so the list shrinks. It grows back only when the saved message renders. In FEATURE the gap lasts longer than it did in MAIN, because a server read, scene processing and possibly a scene-recovery call sit between the stream end and the save.
\

\
\*\*Root cause:\*\* \`js/ui/chat-view\.js runAssistantTurn\` \~1067: \`streamState?.wrap.remove(); streamState = null; refreshPetPlacement();\` runs right after \`chatCompletion\`. \`renderMessages\` (\~613) has no swap logic.
\

\
\*\*Fix:\*\* Port MAIN's mechanism. MAIN chat-view\.js has \`renderMessages\` \~617-680, \`runAssistantTurn\` \~1225-1246, and the helpers \~1478-1505.
\
1\. Copy \`clampListScroll\`, \`captureListPosition\` and \`restoreListPosition\` from MAIN (\~1478-1505) next to \`scrollToEnd\` (\~1319).
\
2\. \`renderMessages\`: at the top, add MAIN's lines:
\
&#x20; \`\`\`js
\
&#x20; const savedStream = streamState?.savedId && msgs.some((m) => m.id === streamState.savedId) ? streamState : null;
\
&#x20; const position = savedStream ? captureListPosition() : null;
\
&#x20; \`\`\`
\
&#x20; At the end, replace \`if (sticky) scrollToEnd();\` with MAIN's block:
\
&#x20; \`\`\`js
\
&#x20; if (savedStream && renderedMessages.has(savedStream.savedId)) {
\
&#x20; if (savedStream.saveCompleted) {
\
&#x20; if (savedStream.frame) cancelAnimationFrame(savedStream.frame);
\
&#x20; savedStream.wrap.remove();
\
&#x20; streamState = null;
\
&#x20; }
\
&#x20; restoreListPosition(position, savedStream.saveCompleted ? savedStream.savedId : undefined);
\
&#x20; refreshPetPlacement();
\
&#x20; } else if (sticky) scrollToEnd();
\
&#x20; \`\`\`
\
&#x20; Check that FEATURE's \`streamState\` uses the same field names as MAIN (\`wrap\`, \`frame\`) by reading FEATURE \`startStreamUI\`. Adapt the names if they differ.
\
3\. \`runAssistantTurn\`:
\
&#x20; \- Delete the remove line at \~1067.
\
&#x20; \- Just before the save (\~1100), add \`if (streamState) streamState.savedId = opts.overwriteId ?? messagesApi.newMessageId();\`.
\
&#x20; \- Pass \`{ id: streamState?.savedId }\` as the third argument to \`messagesApi.addMessage(sid, message, …)\`. FEATURE \`addMessage\` already honours \`opts.id\` (messages.js \~118).
\
&#x20; \- After a successful save, and before \`renderMessages(...)\` (\~1111), add \`if (streamState) streamState.saveCompleted = true;\`.
\
&#x20; \- Keep the existing removal in the \`catch\` (\~1125) and add \`clampListScroll()\` after it.
\
4\. Add \`clampListScroll()\` at the end of \`setStatus\` (\~1348), \`showTransientError\`, and the \`done()\` of \`streamSummaryUI\`, as MAIN does.
\

\
\*\*Acceptance:\*\*
\
\- On an iPhone, a reply ends with no visible gap. The streamed text is replaced in place by the saved message.
\
\- Scrolling up during the stream keeps your position after the save.
\
\- On error, the bubble disappears and the list does not jump past its end.
\

\
\*\*Tests:\*\* Port MAIN "Stream bubble survives saving and is replaced once the saved message exists" (MAIN \~1391) and "A snapshot during regeneration cannot remove the stream before overwrite completes" (MAIN \~1684). Adapt them to FEATURE's harness and its extra \`getSessionFromServer\` stub.
\

\
\---
\

\
\## P0.11 Failed turn: keep the draft and offer "Retry reply"
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 5, review 5.4 (draft part), review 5.3 (Retry part). Sibling E-U1 later rewrites \`handleSend\` around a busy token; it keeps this behaviour.
\

\
\*\*Problem:\*\*
\
\- The composer is cleared before the user message is saved, so a failed save loses the text.
\
\- If the narrator call fails after the user message was saved, that message is left with no reply and no Retry button. Regenerate exists only on assistant messages. Sending again creates a duplicate user message.
\

\
\*\*Root cause:\*\*
\
\- \`js/ui/chat-view\.js handleSend\` \~1018-1019 clears the input before \`reconcileStory\`/\`addMessage\`.
\
\- \`runAssistantTurn\` catches its own errors (\~1124), so \`handleSend\` cannot tell whether the failure happened before or after the save.
\
\- \`renderMessage(m)\` (\~685) has no retry action.
\

\
\*\*Fix:\*\*
\
1\. Copy MAIN \`setComposerText(text)\` (MAIN \~1104-1109) into FEATURE chat-view\.js.
\
2\. \`handleSend\`:
\
&#x20; \- Capture \`const draft = el.input.value;\` before clearing, and add \`let saved = false;\`.
\
&#x20; \- Set \`saved = true;\` right after \`addMessage\` resolves.
\
&#x20; \- In \`catch\`: \`if (!saved && requestedSessionId === state.sessionId && !el.input.value) setComposerText(draft);\`, then show the error as today.
\
&#x20; \- Failures inside \`runAssistantTurn\` happen after the save, so the draft is not restored. That is correct, because the text is saved and Retry covers it.
\
3\. \`renderMessages\`:
\
&#x20; \- Compute \`const latestStory = msgs.filter((m) => m.role !== 'summary').at(-1);\`.
\
&#x20; \- In the loop: \`const retry = !busy && m.role === 'user' && m.id === latestStory?.id;\`.
\
&#x20; \- Re-render when \`entry.retry !== retry\`, store \`retry\` in the entry, and call \`renderMessage(m, retry)\`. This is MAIN \~649-655.
\
4\. \`renderMessage(m, retry = false)\`: after the Delete button, add \`if (retry) actions.appendChild(actionBtn('Retry reply', 'retry', () => retryReply(m)));\`.
\
5\. Add \`retryReply\`. It uses no extra Firestore read; the freshness read stays inside \`runAssistantTurn\`:
\
&#x20; \`\`\`js
\
&#x20; async function retryReply(message) {
\
&#x20; if (busy || editingState || !session) return;
\
&#x20; if (loreWritesPending()) await waitForLoreWrites();
\
&#x20; if (busy || !session) return;
\
&#x20; await runAssistantTurn({ expectLatestUserId: message.id });
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; In \`runAssistantTurn\`, right after \`await reconcileStory();\` (\~1051), add:
\
&#x20; \`\`\`js
\
&#x20; if (opts.expectLatestUserId) {
\
&#x20; const latest = (historyMessages ?? []).filter((m) => m.role !== 'summary').at(-1);
\
&#x20; if (latest?.role !== 'user' || latest.id !== opts.expectLatestUserId) throw new Error('The latest story turn changed. Review it before retrying.');
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Then pass \`{ ...opts, messages: sourceMessages }\` as today. \`runAssistantTurn\` already catches its errors and shows them.
\
6\. \`setBusy\` (\~1306): append \`if (!editingState) renderMessages(lastMessages);\`, so the Retry button hides during a turn and reappears after it. This is MAIN \~setBusy. \`renderMessages\` only rebuilds nodes that changed.
\

\
\*\*Reads:\*\* Retry costs the same as the narrator part of a normal send: 1 session read in \`reconcileStory\`, plus history only if \`historyRevision\` changed. No new listener.
\

\
\*\*Acceptance:\*\*
\
\- Go offline and press Send: the text is back in the composer and no user message exists.
\
\- Use a wrong API key so the narrator fails: the user message shows "Retry reply". Fix the key and press Retry: one assistant reply is saved and no duplicate user message exists.
\
\- With a summary checkpoint that folds that user turn (manual "Summarize full history"), Retry still includes the latest user message. FEATURE's \`required\` set already guarantees this.
\

\
\*\*Tests:\*\* Port MAIN "Failed user save restores the exact draft…" (MAIN \~1469), "A failed reply renders the saved user with Retry; retry reuses that turn" (MAIN \~1481) and "Retry context retains the latest user even after a manual summary folds that turn" (MAIN \~1733). Drop the catch-up/stale-send parts of those tests (conflict 2).
\

\
\---
\

\
\## P0.12 iOS viewport: ignore zoomed measurements, follow the keyboard offset, stop editor zoom
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 2, part of review 5.8. Sibling E-U6 covers the other zooming fields: untyped inputs, the scene-chip input and \`.settings-prompts textarea\`.
\

\
\*\*Problem:\*\* A dark band appears below the composer after editing a message or while the keyboard opens or closes.
\

\
\*\*Root cause:\*\*
\
\- \`js/app.js\` \~26-43 is the old inline \`visualViewport\` block. It sets \`--app-height\` even while zoomed, ignores \`offsetTop\`, and has no re-measure after \`focusout\`.
\
\- \`css/style.css:133\` \`.msg-editor { font: inherit }\` makes the editor 14px, so iOS zooms when it gets focus.
\
\- \`chat-view\.js\` has no list \`ResizeObserver\`.
\

\
\*\*Fix:\*\*
\
1\. Copy MAIN \`js/viewport.js\` into FEATURE verbatim (31 lines, exports \`viewportVars\` and \`initViewport\`).
\
2\. \`js/app.js\`: add \`import { initViewport } from "./viewport.js";\` and replace the whole \`if (window\.visualViewport) { … }\` block (\~26-43) with \`initViewport();\`. Keep the comment above it.
\
3\. \`css/style.css\`: inside the first \`@media (max-width: 720px)\` block (\~204), after the 16px input rule, add MAIN's two lines:
\
&#x20; \`\`\`css
\
&#x20; .msg-editor { font-size: 16px; }
\
&#x20; .app { transform: var(--app-viewport-transform, none); }
\
&#x20; \`\`\`
\
&#x20; \`#lorebook-overlay\` and \`#context-viewer\` sit outside \`.app\` in FEATURE's index.html, so the transform does not affect them. Check by hand that the mobile sidebar drawer still opens. If it breaks, apply the transform to \`.main\` instead (FIX_PLAN Task 2 step 3).
\
4\. \`js/ui/chat-view\.js\`:
\
&#x20; \- Add \`let wasNearBottom = true;\` at module level.
\
&#x20; \- In \`initChatView\`, after \`el.list\` is set, copy MAIN \~66-77: the passive \`scroll\` listener and the \`ResizeObserver\` that calls \`scrollToEnd()\` or \`clampListScroll()\`. \`clampListScroll\` comes from P0.10.
\
&#x20; \- In \`scrollToEnd\`, set \`wasNearBottom = true\`.
\
5\. MAIN open item "editor height" (FIX_PLAN_MAIN \*\*M4\*\*; the \`.msg-editor\` box is too small at 16px): after FIX_PLAN_MAIN M4 is done, port its fix into FEATURE \`startEdit\` (\~812-850), which has the same fixed-height code. Until then, check the editor height by hand on a phone.
\

\
\*\*Acceptance:\*\* As in FIX_PLAN Task 2:
\
\- On iOS Safari, Edit does not zoom.
\
\- No dark band appears when the keyboard opens or closes.
\
\- Pinch-zoom still works.
\
\- Android and desktop are unchanged.
\

\
\*\*Tests:\*\* Port MAIN "Viewport measurements ignore zoom and preserve keyboard offset at normal scale" (MAIN \~1408). It uses only \`viewport.js\`. Also do a manual iPhone check (Safari and the home-screen app).
\

\
\---
\

\
\## P0.13 Warn before changing already-summarized messages
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 12. Conflict 3 applies.
\

\
\*\*Problem:\*\* You can delete or edit a message that the summary already covers without any warning. In FEATURE the cost is higher than in MAIN: both the delete \*\*and\*\* the edit clear the whole summary checkpoint. Editing the active summary message also clears it.
\

\
\*\*Root cause:\*\*
\
\- \`js/messages.js changeMessage\` \~276: \`summaryReset\` is true for any change (edit, overwrite or delete) to a non-summary message with \`order <= breakpointOrder\`, or to the active summary itself.
\
\- \`chat-view\.js\` Delete (\~725-734) only asks "Delete this message permanently?".
\
\- The edit Save (\~846) asks nothing.
\

\
\*\*Fix (UI only):\*\*
\
1\. Add MAIN's helper next to \`startEdit\`:
\
&#x20; \`\`\`js
\
&#x20; function isFolded(m) {
\
&#x20; return m.role !== 'summary' && session?.activeSummaryMessageId && m.order <= (session.breakpointOrder ?? 0);
\
&#x20; }
\
&#x20; const isActiveSummary = (m) => m.role === 'summary' && m.id === session?.activeSummaryMessageId;
\
&#x20; \`\`\`
\
2\. Delete handler: before the existing confirm, add:
\
&#x20; \`\`\`js
\
&#x20; if ((isFolded(m) || isActiveSummary(m)) && !confirm('This message is already part of the story summary. Deleting it clears the summary, and the next summary must rebuild it from the full history. Continue?')) return;
\
&#x20; \`\`\`
\
&#x20; Keep the existing "Delete permanently?" confirm after it.
\
3\. Edit Save (\~846, before \`messagesApi.editMessage\`): under the same condition, add a \`confirm\` with this text. Return without saving when the user cancels, and keep the editor open.
\
&#x20; \- For a folded message: \`'This message is already part of the story summary. Saving the edit clears the summary, and the next summary must rebuild it from the full history. Continue?'\`.
\
&#x20; \- For the active summary: \`'Saving an edited summary currently deactivates it. Continue?'\`.
\
&#x20; This is not MAIN's \`setStatus\` text. MAIN's text would be false here, because MAIN keeps the checkpoint on edit.
\
4\. If Phase 3 changes the edit semantics, update these strings in the same change. The recommendation is that edits of the active summary keep it active and that toggles-off edits keep the checkpoint, as in the pre-memory app.
\

\
\*\*Acceptance:\*\*
\
\- Confirm dialogs appear only for folded messages and the active summary. Recent messages behave as before.
\
\- Cancelling changes nothing and makes no Firestore write.
\

\
\*\*Tests:\*\* Port MAIN "Folded deletes explain checkpoint loss…" (MAIN \~1613), with a stubbed \`confirm\`:
\
\- a folded delete asks twice
\
\- a recent delete asks once
\
\- a folded edit save asks once and does not call \`editMessage\` when \`confirm\` returns false
\

\
\---
\

\
\## P0.14 Say clearly when turns are not sent
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 14.
\

\
\*\*Problem:\*\* With auto-summary off, old turns silently drop out of the request. FEATURE shows "· N out of window" in all cases and gives no hint about what to do.
\

\
\*\*Root cause:\*\* \`js/ui/chat-view\.js updateIndicator\` \~970.
\

\
\*\*Fix:\*\*
\
1\. Replace the dropped-count fragment with MAIN's wording:
\
&#x20; \`\`\`js
\
&#x20; (usage.droppedCount > 0 ? \` · ${usage.droppedCount} ${state.settings.autoSummarizationEnabled === true ? 'out of window' : 'turns not sent'}\` : '')
\
&#x20; \`\`\`
\
2\. After setting the text, add:
\
&#x20; \`\`\`js
\
&#x20; el.contextLabel.title = usage.droppedCount > 0 && state.settings.autoSummarizationEnabled !== true
\
&#x20; ? 'Older turns no longer fit. Turn on auto-summary or run Summarize to keep them in memory.' : '';
\
&#x20; \`\`\`
\
3\. Do not change the default for \`autoSummarizationEnabled\`.
\

\
\*\*Acceptance:\*\* "turns not sent" and the tooltip appear only when messages are dropped and auto-summary is off.
\

\
\*\*Tests:\*\* Port MAIN "Dropped-turn warning explains recovery when automatic summarization is off" (MAIN \~1650).
\

\
\---
\

\
\## P0.15 Show the provider's prompt-token count in the context viewer
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 16 (nice to have).
\

\
\*\*Problem:\*\* The context bar uses the local cl100k estimate only. The provider's real count is thrown away.
\

\
\*\*Root cause:\*\* \`runAssistantTurn\` (\~1066) ignores \`usage\`. \`context-viewer.js render\` (\~20-40) has no place to show it.
\

\
\*\*Fix:\*\*
\
1\. \`chat-view\.js\`:
\
&#x20; \- Add a module variable \`let lastProviderUsage = null;\`.
\
&#x20; \- After the narrator call (P0.9 already destructures \`usage\`), set \`lastProviderUsage = usage?.prompt_tokens != null ? { sessionId: sid, promptTokens: usage.prompt_tokens, estimate: built.usedTokens } : null;\`.
\
&#x20; \- Clear it in \`setSession\` (\~359, next to \`lastMemoryReport = null\`).
\
&#x20; \- Add \`providerUsage: lastProviderUsage?.sessionId === sid ? lastProviderUsage : null\` to the object returned by \`memorySnapshot\` (\~57).
\
2\. \`context-viewer.js render\`: after the totals paragraph, add:
\
&#x20; \`\`\`js
\
&#x20; if (live.providerUsage) body.append(node('p', \`Last sent request: provider counted ${live.providerUsage.promptTokens.toLocaleString()} input tokens (local estimate ${live.providerUsage.estimate.toLocaleString()}).\`, 'muted'));
\
&#x20; \`\`\`
\
3\. Do not store it in Firestore. Background calls (memory, scene, summary) do not update it.
\

\
\*\*Acceptance:\*\* After a reply from a provider that returns \`usage\`, the viewer shows the line. It disappears after switching stories.
\

\
\*\*Tests:\*\* Port MAIN "Provider usage belongs only to its captured request and clears on story reset" (MAIN \~1666), adapted to \`memorySnapshot()\`.
\

\
\---
\

\
\## P0.16 Context order: opening, then summary, then an omitted-turns marker — FOLDED INTO C3
\

\
\> \*\*Do not implement P0.16 on its own.\*\* C3 rebuilds \`render()\` and owns this behaviour. C3 uses the three \`omitted-turns\*.md\` files and the acceptance/tests below. Kept here as the specification only.
\

\
\*\*Findings covered:\*\* FIX_PLAN Task 10, review 2.9, and part of 2.3. Do this last in Phase 0. Phase 3 (legacy parity, golden test against MAIN's builder) builds on it. Do not do it twice: if Phase 3 decides to send toggles-off requests through a port of MAIN's \`buildContextForRequest\`, apply only steps 2-4 to the memory path.
\

\
\*\*Problem:\*\*
\
\- The summary of the middle of the story is sent before the opening exchange.
\
\- Nothing marks the turns missing between the pinned opening and the recent window, so turn 2 reads as if it were followed directly by turn 200.
\

\
\*\*Root cause:\*\* \`js/memory-context.js\`:
\
\- \~43-46 puts the summary into \`head\` (right after the system message).
\
\- \`render()\` (\~66-88) returns \`[...head, ...books, ...history]\`. The anchors are just the first entries of \`history\`.
\
\- Gaps are only reported as warnings (\~159-161) and never sent.
\

\
\*\*Fix:\*\*
\
1\. Keep the summary content and its token block, but do not push it into \`head\`. Store it as \`summaryMsg = summary ? { role: 'system', content } : null\`.
\
2\. Add three prompt files (the README rule says all LLM text lives in Markdown), and register them in \`system-prompts.js files\`:
\
&#x20; \- \`omitted-turns-summary.md\`: \`Earlier turns are represented by the summary.\`
\
&#x20; \- \`omitted-turns.md\`: \`Earlier turns omitted.\`
\
&#x20; \- \`omitted-turns-uncovered.md\`: \`Later omitted turns are not covered by the summary.\`
\

\
&#x20; These are MAIN's exact strings (MAIN context-builder.js \~138-140). The deploy guard in P0.2 checks them automatically.
\
3\. In \`render()\`, after building \`history\` and before inserting memory, snapshot and contract:
\
&#x20; \`\`\`js
\
&#x20; const lastAnchorIdx = history.reduce((i, m, k) => anchorIds.has(m.id) && m.id !== latest?.id ? k : i, -1);
\
&#x20; const anchorOrder = Math.max(0, ...anchors.filter(a => a.id !== latest?.id).map(a => a.order));
\
&#x20; const coveredGap = !!summaryMsg && checkpoint > anchorOrder;
\
&#x20; const uncoveredGap = raw\.some(m => m.order > Math.max(anchorOrder, checkpoint) && !selected.has(m.id));
\
&#x20; const insert = [];
\
&#x20; if (summaryMsg) insert.push(summaryMsg);
\
&#x20; if (coveredGap || uncoveredGap) insert.push({ role: 'system', content: '[' + (coveredGap ? prompts.gapSummary : prompts.gapOmitted) + (uncoveredGap && summaryMsg ? ' ' + prompts.gapUncovered : '') + ']' });
\
&#x20; history.splice(lastAnchorIdx + 1, 0, ...insert);
\
&#x20; \`\`\`
\
&#x20; \- \`cost()\` already renders and counts the full request, so the marker's tokens are included automatically in every fit step. No separate reservation is needed.
\
&#x20; \- The memory, snapshot and contract insertions find their positions by \`latest.id\`, so they still land correctly.
\
4\. Report:
\
&#x20; \- Keep the \`summary\` block.
\
&#x20; \- Add \`blocks.push({ key: 'gap', label: 'Omitted turns marker', tokens: … })\` when the final render contains the marker.
\
&#x20; \- Keep \`usedTokens\`, \`droppedCount\` and \`windowedCount\` unchanged in meaning. \`computeContextUsage\` and \`shouldAutoSummarize\` depend on them.
\
5\. Do not change the summary's label text (\`historical-summary.md\`), the anchor label, or the role (\`system\`). Those are Phase 3 decisions (2.3).
\

\
\*\*Acceptance:\*\*
\
\- In the context viewer and in the request, the order is: system, lore books, opening exchange, summary, marker, recent window, latest user.
\
\- The marker appears only when messages are actually missing between the opening and the window, or when a summary covers them.
\
\- Totals match the request.
\

\
\*\*Tests:\*\*
\
\- Update the FEATURE tests that assert the old order. Search \`tests/memory.mjs\` and \`tests/regressions.mjs\` for \`historicalSummary\`/\`Historical summary\`.
\
\- Port MAIN "Gap markers count toward input and distinguish summary coverage from later omitted turns" (MAIN \~1579) and "Inspector keeps summaries and omission markers in their actual position among story turns" (MAIN \~1762).
\
\- Add three cases:
\
&#x20; \- no marker when everything fits
\
&#x20; \- marker with "represented by the summary" when there is a summary
\
&#x20; \- "Earlier turns omitted." when there is no summary and turns are dropped
\

\
\---
\

\
\## P0.17 MAIN open review items: port after the FIX_PLAN_MAIN tasks are done
\

\
ID map: review item M1 = FIX_PLAN_MAIN M1, M2 = MAIN M2, editor height = MAIN M4, token cache = MAIN M5, deploy = MAIN M3 (FEATURE does its own deploy in P0.2).
\

\
\| MAIN item | What it is | FEATURE action |
\
\|---|---|---|
\
\| M1 False "New messages arrived" error (\`checkTurnFreshness\`) | Bug in MAIN's catch-up code | \*\*Not applicable.\*\* FEATURE does not get that code (conflict 2). Nothing to port. |
\
\| M2 Finish reason too strict | Use a denylist instead of an allowlist | Built into P0.6 step 2. If MAIN's final M2 list differs, align \`BAD_FINISH\` with it after M2 is done. |
\
\| Editor height (MAIN M4): mobile \`.msg-editor\` too small at 16px | Set the textarea height from \`scrollHeight\` after insert | Port into FEATURE \`startEdit\` after FIX_PLAN_MAIN \*\*M4\*\* is done (P0.12 step 5). |
\
\| Token cache thrash (MAIN M5) | Size and eviction of \`countSystemTokensCached\` | FEATURE clears at 5000 entries (MAIN: 500). Owned by \*\*C6\*\*: one LRU of 3000 entries, same as FIX_PLAN_MAIN \*\*M5\*\*. Review 2.14 is the same item; do it once. |
\
\| 5 Zone.Identifier cleanup | Delete the files | Done in P0.1 for both trees. |
\

\
\---
\

\
\## P0.18 MAIN features that are not FIX_PLAN tasks: owner decisions
\

\
These exist in MAIN but not in FEATURE. None is required for Phase 0. List them for the owner, and port none until the owner says so.
\

\
\| MAIN feature | Files in MAIN | Note for FEATURE |
\
\|---|---|---|
\
\| Rewrite draft | \`js/rewrite.js\`, \`rewrite_default_prompt.md\`, settings and composer UI | It is a separate LLM call, made outside a narrator turn. If ported: add \`rewrite_default_prompt.md\` to the deploy copy list (P0.2), and decide whether its prompt moves into \`system prompts/\`. |
\
\| Stream vibration | \`js/stream-vibration.js\` | Task 3 was skipped by the owner. Do not port. |
\
\| LLM private note (latest \`planThread\` in "This story") | \`editPlanThread\`, settings-view | FEATURE stores \`planThread\` too, so this is a small UI-only port if wanted. |
\
\| "Sync latest data" menu item | \`syncChatData\`, \`clearChatCache\` | FEATURE's \`reconcileStory\` makes it mostly unnecessary. |
\
\| Clear the IndexedDB chat cache on logout | \`chat-cache.js clearChatCache(uid)\` | Recommended. Same item as \*\*U9i\*\*; implement it there only. |
\
\| Context inspector "Latest sent" mode | \`js/ui/context-view\.js\`, \`onRequest\` in llm-client | Conflict 5. FEATURE keeps \`context-viewer.js\`. |
\
\| \`stripThinking\` (\`\<think>\` removal) | \`js/story-text.js\` | Review 2.3 lists its removal as a legacy-parity gap. Decide in Phase 3. Apply it inside \`contentFor\`, never in \`buildRequestBody\` (conflict 1). |
\
\| \`modelContextTokens\` / input-only \`maxContextTokens\` | \`js/request-budget.js\`, settings | Conflict 4. Decide in Phase 3 (2.3/2.11). |
\
\| Full JSON backup | \`buildFullBackup\` | Task 17 is already done another way by the v2 JSONL export and import. Do not port. |
\

\

\
\---
\

\
\# Part B — Scene tag, acceptance, parser, turn flow (S1–S12)
\

\
Project root: \`/home/nguyennhp/projects/temp/Nera_chat-feature-story-memory/Nera_chat-feature-story-memory\`
\
Test command: \`node --experimental-vm-modules --test tests/\*.mjs\` (147 pass at the start).
\
Line numbers are approximate; each one was checked against the current branch.
\

\
\## Owner defaults (apply to every task below)
\

\
1\. \*\*Lint is warn-only.\*\* A lint warning never sets \`acceptance:'pending'\` and never discards the parsed scene. It is stored in \`reviewWarnings\` and shown as a muted info note.
\
2\. \*\*Existing \`acceptance:'pending'\` docs\*\* are treated as accepted as soon as a later user message exists. They are resolved when read, and nothing is written. The Accept button stays for a pending reply that is still the latest.
\
3\. \*\*The scene-extraction mode (1.25) is deleted.\*\* Scene recovery stays as the only optional maintenance call.
\
4\. \*\*A missing \`acceptance\` field means accepted.\*\*
\

\
House rules that every task must keep:
\
\- At most 2 LLM calls per user turn, counting the narrator.
\
\- The narrator never outputs JSON.
\
\- With all memory toggles off, behaviour equals the pre-memory app.
\
\- No data migration. New fields are optional.
\
\- Count Firestore reads. \*\*No task in this section adds a Firestore read.\*\* Every change works on the \`messages\` array that is already loaded. S10 adds no new writes either: it only changes the content of writes that already happen.
\

\
\## Corrections to the findings
\

\
\- \*\*1.24 points to the wrong file.\*\* The \`\<OCC>\`-only strip is \`js/memory-context.js\` \`stripOcc\` (\~11-13), not \`plan-parser.js\`. The fix is in S3.
\
\- \*\*1.4, trailing period.\*\* The finding says a trailing \`.\` is rejected. It is not. \`inspectSceneOutput\` accepts it and stores the period inside the last name (\`present: Mira, Kael.\` gives the name \`Kael.\`). The result is still wrong, just in a different way. The fix is in S3.
\
\- \*\*1.3\*\* is right, with one more detail: \`lintUnestablishedTime\` flags "It is evening now", yet \`validateSceneValues\` accepts \`time: evening\` for the same reply. The two checks disagree. Fixed in S5 and S6.
\
\- \*\*1.7\*\* is right and slightly worse than stated. "Day 2" followed by "The third day dawns" stores both date and time as unknown, because \`dawn\` does not match \`dawns\`, and the prior values are lost.
\
\- All the other findings in scope were reproduced on a scratch copy: 1.1, 1.2, 1.5, 1.6, 1.8 (all 8 cases), 1.9-1.23, 1.25 and 2.6. None of them is fixed yet.
\

\
\## New problems found during the review (not in REVIEW_FINDINGS)
\

\
\- \*\*B-N1.\*\* \`memory-settings.js\` \`normalizeMemory\` (\~17) runs the strict \`inspectSceneOutput\` on \`startingScene\` and silently sets it to null when the check fails. A user-typed starting scene such as \`Day 1 | dawn | Gate | present: Mira\` is dropped without a message. Fixed in S3, step 9.
\
\- \*\*B-N2.\*\* \`memory-prompts.js:13\` has a second gate on \`isAcceptedTurn\` that the findings do not mention. It is redundant, because \`dueRange\` already blocks, and it has the same bug as 1.1. Fixed in S1.
\
\- \*\*B-N3.\*\* \`validateSceneValues\` pairs quotes with the same broken regex as the lint (\`["“][\s\S]\*?["”]\`). An apostrophe or an unclosed quote shifts the pairing, so narration gets treated as dialogue and dialogue as narration. Fixed in S6 with one shared helper.
\
\- \*\*B-N4.\*\* A new carried reply stores a \*copy\* of the prior scene in \`m.scene\`. Code that reads \`m.scene\` directly (\`memory-prompts.js:27\`, \`turns.js:41\`, the chip in \`chat-view\.js\` \~765) treats that copy as the reply's own scene. Fixed in S4 and S5: carried replies store \`scene:null\` plus a reference.
\
\- \*\*B-N5.\*\* Parser design detail: a generic \`word:\` label is only allowed right after a field separator. Without this rule, \`place: Old Inn: upstairs\` cuts the value at \`Old Inn\`. This is covered by fixtures 37 and 38.
\

\
\## Task order and dependencies
\

\
\| Task | Findings | Depends on |
\
\|---|---|---|
\
\| S1 Acceptance semantics | 1.1, 1.9, 1.15 (part), 1.6 (prefix), B-N2 | none |
\
\| S2 Delete scene-extraction mode | 1.25 | none |
\
\| S3 Tolerant scene parser | 1.4, 1.12, 1.13, 1.19, 1.20, 1.24, B-N1, B-N5 | S2 (fewer callers to update) |
\
\| S4 Scene timeline and history replay | 1.5, 1.10, 1.17, 1.22, B-N4 | S1, S3 |
\
\| S5 Warn-only turn flow | 1.2, 1.18, 1.23, 1.20 (reasoning salvage) | S1, S3, S4 |
\
\| S6 Lint precision | 1.3, B-N3 | S5 (lint is warn-only first) |
\
\| S7 OOC classifier | 1.8 | S5 |
\
\| S8 validateSceneValues | 1.7, 1.21 | S3, S6 (shared quote helper) |
\
\| S9 Bracket labels in narrator context | 1.6 (rest) | S1; coordinate with 2.9 and 2a.12 |
\
\| S10 Edit, chip and pending UI | 1.11, 1.15, 1.16 | S3, S4, S5; U4 (\`sameRenderedMessage\`) |
\
\| S11 Recovery hardening | 1.14 | S3, S5 |
\
\| S12 Card selection uses recent narration | 2.6 | S4 |
\

\
Cross-plan links:
\
\- \*\*2.1 end reminder and 2.2 contract order.\*\* The scene-tag instruction text lives there. S3 makes the parser tolerant, but does not change the prompt.
\
\- \*\*2a (prompts).\*\* \`prompts/scene.md\` says "never put a colon or ' · ' inside a value". S3 allows \`14:30\`, so 2a must relax that sentence to "no colon except in a clock time". \`reply-contract.md\` negatives belong to 2a.
\
\- \*\*2.3 legacy parity.\*\* S4 makes sure that with Scene off, no \`\<scene>\` or \`\<plan_thread>\` is replayed.
\
\- \*\*3.2 invalidation.\*\* Accept, edit and scene-edit write through \`changeMessage\`, which sets \`memoryInvalidations\` and pauses memory. S10 must not make that worse. The rule itself belongs to 3.2.
\
\- \*\*3.3 summarizer.\*\* S1 only changes the acceptance gate at \`summarizer.js:67\`.
\
\- \*\*5.1\*\* \`sameRenderedMessage\` must compare \`acceptance\`, \`reviewWarnings\`, \`sceneMeta\` and \`sceneCandidate\`, or S10's UI will not refresh.
\
\- \*\*5.10, 5.12, 5.13\*\* (UI/concurrency). S5's new \`showTransientInfo\` should use the same helper style as those tasks.
\

\
\---
\

\
\## S1. Acceptance semantics: a later user message accepts the reply
\

\
\*\*Findings covered:\*\* 1.1, 1.9, the \`'rejected'\` part of 1.15, the "unaccepted prefix" part of 1.6, B-N2.
\

\
\*\*Problem.\*\* A reply marked \`acceptance:'pending'\` stays unaccepted forever, even after the user has moved on. Because of that:
\
\- the reply's scene never counts (\`latestScene\` skips it);
\
\- extraction is blocked for good (\`dueRange\` returns blocked);
\
\- summarisation stops (\`summarizer.js:67\`);
\
\- the narrator sees an "unaccepted" prefix in history.
\

\
Separately, the Accept and Regenerate review box shows even when Scene memory is off (1.9). Finally, the pre-narration summary sets \`maintenanceUsed\` even when it did nothing, which wastes the turn's second call slot.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/turn-review\.js\` \`isAcceptedTurn\` \~2-7 looks only at the stored field. When the field is missing it runs \`lintPlayerAgency\` again on old text, so old replies flip to unaccepted whenever the lint changes.
\
\- Callers:
\
&#x20; \- \`js/ui/chat-view\.js\` review box \~752-763;
\
&#x20; \- \`js/memory-context.js\` \`contentFor\` \~49-50 (adds the prefix);
\
&#x20; \- \`js/summarizer.js\` \~67;
\
&#x20; \- \`js/turns.js\` \`dueRange\` \~27;
\
&#x20; \- \`js/memory-prompts.js\` \~13.
\
\- \`js/ui/chat-view\.js\` \`runAssistantTurn\` \~1055-1056 sets \`maintenanceUsed = true\` after \`maybeSummarizeBeforeTurn\` whether or not it ran.
\
\- \`js/scene.js\` \`latestScene\` \~72-85 skips \`'pending'\` and \`'rejected'\`. \`'rejected'\` is never written anywhere.
\

\
\*\*Fix.\*\*
\
1\. Rewrite \`isAcceptedTurn\` in \`js/turn-review\.js\`:
\
&#x20; \`\`\`js
\
&#x20; // A reply is unaccepted only while it is pending/rejected AND no user message came after it.
\
&#x20; export function isAcceptedTurn(message, { lastUserOrder = -Infinity, sceneOn = true } = {}) {
\
&#x20; if (message?.role !== 'assistant') return true;
\
&#x20; if (!sceneOn) return true; // memory off: legacy app has no acceptance
\
&#x20; const a = message.acceptance;
\
&#x20; if (a !== 'pending' && a !== 'rejected') return true; // missing = accepted (owner default 4)
\
&#x20; return !(Number(message.order) < Number(lastUserOrder)); // superseded by a later user turn
\
&#x20; }
\
&#x20; export function lastUserOrderOf(messages, upToOrder = Infinity) {
\
&#x20; let max = -Infinity;
\
&#x20; for (const m of messages) if (m.role === 'user' && m.order < upToOrder && m.order > max) max = m.order;
\
&#x20; return max;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Remove the \`lintPlayerAgency\` call from inside \`isAcceptedTurn\`. The lint only runs at generation time (S5).
\
2\. Every caller computes \`lastUserOrder\` once per pass with \`lastUserOrderOf(messages, upTo)\` and passes it in:
\
&#x20; \- \`chat-view\.js\` review box \~752: show the box only when all three hold:
\
&#x20; \- \`memory.scene\` is on;
\
&#x20; \- the reply is the latest assistant message;
\
&#x20; \- \`!isAcceptedTurn(m, { lastUserOrder, sceneOn: true })\`.
\

\
&#x20; That fixes 1.9: with memory off, there is no box.
\
&#x20; \- \`memory-context.js\` \`contentFor\` \~49: use the new signature. \*\*Delete the unaccepted prefix at \~50.\*\* Under S4 the narrator never sees an unsuperseded pending reply anyway, because a narrator request always follows a new user message.
\
&#x20; \- \`summarizer.js\` \~67: use the new signature with \`lastUserOrder\` of the fold range.
\
&#x20; \- \`turns.js\` \`dueRange\` \~27: same.
\
&#x20; \- \`memory-prompts.js\` \~13: remove the gate (B-N2). \`dueRange\` already decides.
\
3\. In \`latestScene\`, stop skipping \`'rejected'\` by name. Use \`isAcceptedTurn\` with \`lastUserOrder\` instead. S4 replaces this function, so keep this change minimal.
\
4\. In \`chat-view\.js\` \~1056, set \`maintenanceUsed = Boolean(result && !result.skipped)\`. Check that \`maybeSummarizeBeforeTurn\` returns \`{ skipped: true }\` on every early exit, and add the return where it is missing.
\
5\. Do not write any Firestore field. Old pending docs are resolved when read (owner default 2).
\

\
\*\*Acceptance.\*\*
\
\- With a pending reply followed by a user message:
\
&#x20; \- \`latestScene\` returns that reply's candidate scene (after S4) or scene;
\
&#x20; \- \`dueRange\` is not blocked;
\
&#x20; \- the summary fold runs;
\
&#x20; \- no "unaccepted" text appears in the narrator request.
\
\- The Accept button shows only on the latest reply, only while it is pending, and only with Scene on.
\
\- With every memory toggle off, no review box appears for any doc.
\
\- When the pre-turn summary skipped, scene recovery can still run in the same turn.
\

\
\*\*Tests.\*\*
\
\- Edit \`tests/scene-resilience.mjs\` 53-67 and 80-88: keep the current asserts (they have no later user message), and add a case with a later user message where the expected result flips.
\
\- New unit test for \`isAcceptedTurn\`. Cases:
\
&#x20; \- missing acceptance;
\
&#x20; \- accepted;
\
&#x20; \- pending with a later user message;
\
&#x20; \- pending without one;
\
&#x20; \- \`rejected\`;
\
&#x20; \- \`sceneOn:false\`.
\
\- Harness test (\`tests/app-harness.mjs\`): memory off plus a pending doc renders no \`.review\` box.
\

\
\*\*Depends on:\*\* none.
\

\
\---
\

\
\## S2. Delete the scene-extraction mode
\

\
\*\*Findings covered:\*\* 1.25.
\

\
\*\*Problem.\*\* \`js/scene-extraction.js\` is dead code. It has a hard-coded model (\~113) and a broken equality test (\`scene === prior?.raw\` \~102). It still drags in three prompt files, two settings keys and a \`separate\` mode branch through the context builder. Any change to the scene format has to keep this dead path working too.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/scene-extraction.js\` (whole file).
\
\- \`js/system-prompts.js\` entries \`sceneExtraction\`, \`writingContract\`, \`writingPlan\`.
\
\- \`prompts/scene-extraction.md\`, \`prompts/writing-contract.md\`, \`prompts/fixed-author-plan-writing.md\`.
\
\- \`js/memory-settings.js\`: \`DEFAULT_MEMORY.sceneMode\` and \`sceneExtractionModel\`, normalised at \~19-20.
\
\- \`js/memory-context.js\`: \`separate\` branches at \~19, 31-37, 58, 60-64 and 78-84.
\
\- \`tests/scene-extraction.mjs\`: 4 tests, all in extract mode.
\

\
\*\*Fix.\*\*
\
1\. Before deleting anything, \`grep -rn "scene-extraction\\|sceneExtraction\\|sceneMode\\|writingContract\\|writingPlan\\|separate" js prompts tests index.html\`. Every hit must be removed or justified.
\
2\. Delete \`js/scene-extraction.js\` and the three prompt files.
\
3\. Remove the three entries from the \`files\` map in \`js/system-prompts.js\`. \`tests/prompt-files.mjs:26\` counts keys dynamically, so it needs no edit. Run it to confirm.
\
4\. In \`js/memory-settings.js\`, remove \`sceneMode\` and \`sceneExtractionModel\` from \`DEFAULT_MEMORY\` and from \`normalizeMemory\`. \`normalizeMemory\` already drops unknown keys, so old saved settings that contain them load fine. No migration is needed.
\
5\. In \`js/memory-context.js\`, delete every \`separate\` branch and keep the inline path. Do the same for any settings UI control (look for \`sceneMode\` in \`js/ui/\`).
\
6\. Delete \`tests/scene-extraction.mjs\`.
\

\
\*\*Acceptance.\*\*
\
\- The grep in step 1 returns nothing.
\
\- Settings saved with \`sceneMode:'separate'\` load without error and behave as the inline mode.
\
\- The test suite passes; the count drops by the 4 deleted tests.
\

\
\*\*Tests.\*\* Add one assert to the memory-settings tests: \`normalizeMemory({ sceneMode:'separate', sceneExtractionModel:'x' })\` has neither key.
\

\
\*\*Depends on:\*\* none. Do it before S3 so the parser change has fewer callers.
\

\
\---
\

\
\## S3. Tolerant scene parser with one canonical form
\

\
\*\*Findings covered:\*\* 1.4, 1.12, 1.13, 1.19, 1.20, 1.24, B-N1, B-N5.
\

\
\*\*Problem.\*\* The scene reader only accepts one exact byte pattern. Common model variants are thrown away:
\
\- capitalised labels;
\
\- \`•\` or \`|\` separators;
\
\- no spaces around \`·\`;
\
\- \`14:30\`;
\
\- a multi-line tag;
\
\- a code fence;
\
\- a duplicate tag;
\
\- a tag on the same line as prose;
\
\- \`\<scene_state>\`.
\

\
When that happens the reply is marked pending or gets a carried copy (1.4, 1.13). Some of the variant markup also leaks into the visible story (1.12, 1.19): an unclosed \`\<scene>\` in the middle of the text deletes the rest of the reply when the text is finalised. A draft tag inside \`\<think>\` beats the real one (1.20). \`sceneLine\` throws on a clock colon, so recovery fails on \`10:30\`. \`stripOcc\` misses \`\<OOC>\` vs \`\<OCC>\` spellings (1.24, real location \`memory-context.js\`).
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/scene.js\`:
\
&#x20; \- \`inspectSceneOutput\` \~31-49 uses the strict regex \`^date: [^:\r\n·]+ · time: … $\` and demands the tag on the final line, outside a fence.
\
&#x20; \- \`extractScene\` \~24-28.
\
&#x20; \- \`sceneLine\` \~87-93 validates its own output through \`inspectSceneOutput\`, so it throws on a colon.
\
\- \`js/plan-parser.js\` \`stripPlan\` \~28-37: line \~33 strips an unclosed \`\<scene>\` to the end of the text. The same function serves the final text (\`chat-view\.js\` \~1070) and streaming (\~1297).
\
\- \`js/memory-context.js\` \`stripOcc\` \~11-13 matches only \`\<OCC>\`.
\
\- \`js/memory-settings.js\` \~17 uses the strict check for \`startingScene\` (B-N1).
\
\- The feature branch has no \`stripThinking\`. The main repo has one at \`/home/nguyennhp/projects/temp/Nera_chat-main/Nera_chat-main/js/story-text.js\`.
\

\
\*\*Fix.\*\*
\
1\. \*\*Port \`stripThinking\`\*\* (a depth-tracking remover for \`\<think>\` and \`\<thinking>\`, which also drops a trailing open block and a partial opener) into \`js/plan-parser.js\`, or into a new \`js/story-text.js\` copied from main. Use the main-repo code as is.
\
2\. \*\*Add to \`js/scene.js\`:\*\*
\
&#x20; \- \`parseSceneFields(body)\` returns \`{date, time, place, present[]}\` or null.
\
&#x20; \- \`canonicalFromFields(fields)\` returns the canonical string.
\
&#x20; \- \`canonicalScene(raw)\` = \`canonicalFromFields(parseSceneFields(raw))\`, or null.
\
&#x20; \- \`readSceneOutput(content)\` returns \`{ scene, planThread, clean, count, warning }\`.
\

\
&#x20; A working prototype that passes all 39 fixtures is at \`/tmp/claude-1000/-home-nguyennhp-projects-temp/36a5aa0b-f3d0-4f28-9984-1a983cca60be/scratchpad/sceneB/proto.mjs\`. The coding agent may copy it. It is about 100 lines.
\
3\. \*\*Normalisation rules in \`readSceneOutput\`, in this order:\*\*
\
&#x20; 1\. Run \`stripThinking\` on the full output. A tag inside reasoning never counts.
\
&#x20; 2\. Unwrap a code fence (any language tag) only if its body contains \`\<scene\`, \`\<plan_thread\` or \`scene:\`. Leave other fences alone.
\
&#x20; 3\. Collect every \`\<plan_thread>…\</plan_thread>\`. The \*\*last\*\* one wins.
\
&#x20; 4\. Find scene candidates. Each match is removed from the text whether or not it parses. Candidate forms:
\
&#x20; \- \`\<scene …>…\</scene>\`, any case, may span lines;
\
&#x20; \- \`\<scene_state>\`, \`\<scene-info>\`, \`\<scene tag>\`, \`\<scene data>\`, \`\<state>\` with a matching close tag;
\
&#x20; \- \`\<!-- scene … -->\`;
\
&#x20; \- a whole line \`[Scene: …]\`;
\
&#x20; \- a whole line \`\*\*Scene:\*\* …\`;
\
&#x20; \- an unclosed \`\<scene>\` up to the end of its line. If the rest of the line is not scene-like (\`parseSceneFields\` returns null), only the \`\<scene>\` token is removed and the words stay. \*\*Never strip to the end of the text.\*\*
\
&#x20; 5\. Clean up:
\
&#x20; \- remove leftover \`\<plan_thread>…\</plan_thread>\` and \`\<plan>…\</plan>\`;
\
&#x20; \- remove lone \`\</div>\`, \`\<span>\`, \`\<p>\`, \`\<section>\` lines and HTML comments;
\
&#x20; \- drop empty fences;
\
&#x20; \- trim trailing spaces, collapse double spaces, collapse 3+ newlines to 2.
\
&#x20; 6\. \*\*The last parseable candidate by position wins.\*\* \`count\` is the number of parseable candidates. If it is above 1, a note is added, but the reply is not rejected.
\
4\. \*\*Field rules in \`parseSceneFields\`:\*\*
\
&#x20; \- Drop a leading \`scene:\` or \`scene state:\`, and surrounding quotes or backticks.
\
&#x20; \- Label aliases are case-insensitive and may be wrapped in \`\*\*\`:
\

\
&#x20; \| Field | Aliases |
\
&#x20; \|---|---|
\
&#x20; \| date | date, day, calendar |
\
&#x20; \| time | time, time of day, hour |
\
&#x20; \| place | place, location, setting, where |
\
&#x20; \| present | present, characters, characters present, people present, people, attendees, who |
\

\
&#x20; \- Separator after a label: \`:\` or \`=\`.
\
&#x20; \- Other \`word:\` labels (for example \`active event:\`) count as a field boundary \*\*only right after a separator\*\* (start, newline, \`·\`, \`•\`, \`|\`, \`;\`, or \`. \`). Their values are discarded (B-N5).
\
&#x20; \- With no known labels, read the fields by position:
\
&#x20; \- split on \`·\`, \`•\`, \`|\`, \`;\`, or \` - \` (with spaces);
\
&#x20; \- at least 3 parts are needed;
\
&#x20; \- the order is date, time, then place (the remaining parts joined with \`, \`).
\
&#x20; \- With only a \`present:\` label, read the prefix before it by position (fixture 22, 26).
\
&#x20; \- Values:
\
&#x20; \- Trim quotes, \`\*\*\`, backticks, separators and a trailing \`.\`.
\
&#x20; \- \`unknown\`, \`n/a\`, \`none\`, \`-\`, \`?\`, \`unclear\` and \`unspecified\` become unknown.
\
&#x20; \- Template placeholders (\`DATE\`, \`TIME\`, \`TIME OF DAY\`, \`PLACE\`, \`FULL NAME\`, \`TBD\`, \`...\`): if every field present is a placeholder, return null (fixture 27).
\
&#x20; \- Sanitise: \`·\`, \`•\` and \`|\` inside a value become \`, \`. A clock time \`\d{1,2}:\d{2}\` is kept. Any other \`:\` becomes \`,\`.
\
&#x20; \- \`present\`:
\
&#x20; \- split on \`,\`, \`;\`, \`&\`, the word \`and\`, and newline;
\
&#x20; \- remove \`(you)\`, \`(pc)\`, \`(player)\` and any other parenthetical;
\
&#x20; \- drop \`none\`, \`nobody\`, \`no one\`, \`unknown\`, \`full name\`, \`everyone\` and \`...\`;
\
&#x20; \- remove case-insensitive duplicates, keeping the first spelling.
\
5\. \*\*Canonical output\*\* is always \`date: X · time: Y · place: Z · present: A, B\`:
\
&#x20; \- lowercase labels;
\
&#x20; \- \`unknown\` for a missing field;
\
&#x20; \- names joined by \`, \`;
\
&#x20; \- at most \`MAX_SCENE_LENGTH\` (2000).
\

\
&#x20; It is the only form ever stored or replayed.
\
6\. \*\*Rewrite the old functions as thin wrappers so callers keep working:\*\*
\
&#x20; \- \`inspectSceneOutput(content)\`: \`{ scene: readSceneOutput(content).scene, error: scene ? null : warning }\`.
\
&#x20; \- \`extractScene(content)\`: \`readSceneOutput(content).scene\`.
\
&#x20; \- \`sceneLine(fields)\`: \`canonicalFromFields(fields)\`. It no longer validates through the strict check, so it never throws on \`10:30\`. It still throws on overlength.
\
&#x20; \- \`parseScene(raw)\` stays lenient for stored data (a single part becomes place), so every old Firestore doc still parses. Internally it may call \`parseSceneFields\` first and fall back to the old split.
\
7\. \*\*Split \`stripPlan\` into two modes:\*\* \`stripPlan(text, { final = false } = {})\`.
\
&#x20; \- Streaming (default, used at \~1297) keeps today's behaviour: hide everything after an opening \`\<scene\` or \`\<plan_thread\` that is still streaming.
\
&#x20; \- Final (\`{ final:true }\`, used at \~1070) is replaced by \`readSceneOutput(text).clean\`. The unclosed-to-end-of-text strip at \~33 must not run in final mode.
\
8\. \*\*Fix \`stripOcc\`\*\* in \`js/memory-context.js\` \~11: match \`/<\s\*O[OC]C\s\*>[\s\S]\*?<\s\*\\/\s\*O[OC]C\s\*>/gi\`. If the result is empty after stripping, keep the original text, so a user message never becomes empty.
\
9\. \*\*B-N1:\*\* in \`normalizeMemory\` (\~17), store \`canonicalScene(startingScene)\`. If that is null and the input is not empty, keep the raw text in an optional \`startingSceneRaw\` and let the settings UI show "Could not read this starting scene". Never drop it silently.
\

\
\*\*Fixture table.\*\* B = \`date: Day 2 · time: night · place: Inn · present: Mira, Kael\`. "Visible" is the expected \`clean\`; when the cell is blank, \`clean\` is \`Prose.\` or the prose part of the input with all hidden markup removed.
\

\
\| # | Input (shortened) | Expected \`scene\` | Visible text |
\
\|---|---|---|---|
\
\| 1 | \`Prose.\n\<scene>date: Day 2 · time: night · place: Inn · present: Mira, Kael\</scene>\` | B | \`Prose.\` |
\
\| 2 | \`Prose. \<scene>…B…\</scene>\` (same line) | B | |
\
\| 3 | \`Prose.\n\<scene>B\</scene>\n\<plan_thread>x\</plan_thread>\` | B, planThread \`x\` | |
\
\| 4 | \`\<SCENE>B\</SCENE>\` | B | |
\
\| 5 | \`Date: Day 2 · Time: night · Place: Inn · Present: Mira, Kael\` | B | |
\
\| 6 | \`•\` separators | B | |
\
\| 7 | \`\\|\` separators | B | |
\
\| 8 | \`date: Day 2·time: night·place: Inn·present: Mira, Kael\` | B | |
\
\| 9 | \`time: 14:30\` | B with \`time: 14:30\` | |
\
\| 10 | tag body split over 4 lines | B | |
\
\| 11 | \`present: Mira, Kael.\` | B (no \`Kael.\`) | |
\
\| 12 | tag inside a plain fence | B | no fence left |
\
\| 13 | tag inside a \`\`\`\` \`\`\`xml \`\`\`\` fence | B | no fence left |
\
\| 14 | two tags, the second with \`place: Hall\` | B with \`place: Hall\` (last wins) | |
\
\| 15 | \`\<think>…\<scene>draft\</scene>…\</think>Prose.\n\<scene>B\</scene>\` | B | \`Prose.\` |
\
\| 16 | \`Prose.\n\<scene>B\` (unclosed at end) | B | \`Prose.\` |
\
\| 17 | \`Prose \<scene> explanation… more prose\n\nNext paragraph.\` | null | \`Prose explanation… more prose\n\nNext paragraph.\` |
\
\| 18 | \`Prose.\n\<scene>B\n\nMore prose.\` (unclosed with fields) | B | \`Prose.\n\nMore prose.\` |
\
\| 19 | \`\<scene_state>B\</scene_state>\` | B | |
\
\| 20 | \`\<scene_state>Date: Day 2. Active event: the hearing. Present: Mira\</scene_state>\` | \`date: Day 2 · time: unknown · place: unknown · present: Mira\` | |
\
\| 21 | line \`[Scene: Inn]\` | null | line stripped |
\
\| 22 | line \`[Scene: Day 2 · night · Inn · present: Mira, Kael]\` | B | line stripped |
\
\| 23 | line \`\*\*Scene:\*\* date: Day 2 · …\` | B | line stripped |
\
\| 24 | \`\<!-- scene: B -->\` | B | |
\
\| 25 | \`\<!-- scene -->\` and a lone \`\</div>\` line | null | both stripped |
\
\| 26 | \`\<scene>Day 2 · night · Inn · present: Mira, Kael\</scene>\` (legacy positional) | B | |
\
\| 27 | \`\<scene>date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME\</scene>\` | null | |
\
\| 28 | \`present: Nera Veyrath (you), none, Mira\` | \`present: Nera Veyrath, Mira\` | |
\
\| 29 | \`\<scene>"date: Day 2 · … Kael"\</scene>\` | B | |
\
\| 30 | \`\<scene>\</scene>\` | null | |
\
\| 31 | \`day: Day 2 · hour: night · location: Inn · characters: Mira, Kael\` | B | |
\
\| 32 | \`date: unknown · time: unknown · place: Inn · present: unknown\` | the same string | |
\
\| 33 | prose with no tag | null | unchanged |
\
\| 34 | \`place: West Wing - Reception Room, Palace\` | place kept whole | |
\
\| 35 | \`\<plan_thread>x\</plan_thread> \<scene>B\</scene>\` on one line | B, planThread \`x\` | |
\
\| 36 | \`\*\*date:\*\* Day 2 · \*\*time:\*\* night · …\` | B | |
\
\| 37 | \`place: Inn: upstairs room\` | \`place: Inn, upstairs room\` | |
\
\| 38 | \`place: Old Inn: upstairs\` | \`place: Old Inn, upstairs\` | |
\
\| 39 | B plus \` · active event: the hearing\` | B | |
\

\
\`canonicalScene\` unit cases:
\
\- \`"Tavern, night"\` gives null.
\
\- \`"Inn"\` gives null.
\
\- \`"Day 9 | night | Inn | present: A, a, B"\` gives \`date: Day 9 · time: night · place: Inn · present: A, B\`.
\
\- Every canonical string must round-trip unchanged.
\

\
\*\*Acceptance.\*\*
\
\- All 39 fixtures pass.
\
\- Streaming display is unchanged: the \`tests/memory.mjs\` 41-44 asserts still pass with the default mode.
\
\- A final reply never loses text after a stray \`\<scene>\`.
\
\- \`sceneLine({ time: '10:30', … })\` does not throw.
\
\- Old stored scenes all still parse through \`parseScene\`.
\

\
\*\*Tests.\*\*
\
\- New \`tests/scene-parser.mjs\` holds the fixture table as data and a loop.
\
\- Replace \`tests/scene-contract.mjs\` 45-59 ("fresh scene output requires one final labeled tag") with a pointer to the new file. Keep the null cases at 41-42.
\
\- Change \`tests/memory.mjs:36\`: \`extractScene('\<scene>one\</scene>\n\<SCENE>two\nthree\</SCENE>')\` must now return \`null\`, because neither \`one\` nor \`two three\` has 3 positional parts or a label. Add a positive multi-tag case next to it.
\
\- Add \`stripOcc\` cases: \`\<OOC>\`, \`\<OCC>\`, \`< ooc >\`, and a message that is only an OOC block.
\

\
\*\*Depends on:\*\* S2.
\

\
\---
\

\
\## S4. Scene timeline by reference, and the history replay rule
\

\
\*\*Findings covered:\*\* 1.5, 1.10, 1.17, 1.22, B-N4.
\

\
\*\*Problem.\*\*
\
\- History replay is inconsistent (1.5). Accepted replies replay their \`\<scene>\`. Carried, pending, edited and pre-feature replies replay nothing. So the narrator sees scene tags only on some turns and learns that the tag is optional.
\
\- A carried copy is stored as if it were the reply's own scene. Readers then mislabel turns (1.10 in \`formatTurnsTranscript\`, B-N4 elsewhere).
\
\- When a chat started before the feature has no scenes, the seed \`startingScene\` from turn 0 is used as the current scene, even many turns later (1.17).
\
\- \`missingStreak\` counts the wrong replies (1.22).
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/memory-context.js\` \`contentFor\` \~47-56: line \~51 replays \`\<plan_thread>\` when accepted, and \`\<scene>\` only if all four hold: \`mem.scene\`, \`m.scene\`, not carried, and accepted.
\
\- \`js/scene.js\`:
\
&#x20; \- \`latestScene\` \~72-85 returns the seed with \`fromOrder 0\` (\~83) no matter how many legacy replies exist.
\
&#x20; \- \`carryScene\` \~95-98 copies \`prior.scene.raw\` into the new message.
\
\- \`js/turns.js\` \`formatTurnsTranscript\` \~41 labels each turn with \`assistant.scene\`, including carried copies.
\

\
\*\*Fix.\*\*
\
1\. \*\*Add \`sceneTimeline(messages, { startingScene, upToOrder = Infinity, lastUserOrder })\` to \`js/scene.js\`.\*\* It does one forward pass over the sorted messages and returns a \`Map(id -> { own, effective, fromId, fromOrder, missingStreak })\`.
\
2\. \*\*Own scene per assistant message, in this order:\*\*
\

\
&#x20; \| Message kind | How to recognise it | Own scene |
\
&#x20; \|---|---|---|
\
&#x20; \| OOC | \`m.ooc === true\` | none, and the streak is not touched |
\
&#x20; \| Unsuperseded pending | pending, no later user message | none |
\
&#x20; \| Superseded pending with candidate | pending, later user message, \`sceneCandidate\` set | \`canonicalScene(sceneCandidate)\` |
\
&#x20; \| Superseded pending without candidate | as above, no candidate | none |
\
&#x20; \| Carried (new or old) | \`sceneMeta.kind === 'carried'\` | none (any stored copy is ignored) |
\
&#x20; \| Declared, inferred, manual | \`m.scene\` set, not carried | \`canonicalScene(m.scene)\`, falling back to \`m.scene\` when it does not parse (old lenient data) |
\
&#x20; \| Edited with no scene | \`editedAt\` set and \`m.scene\` null | none |
\
&#x20; \| Parse failed | \`m.scene\` null, \`sceneMeta\` set | none |
\
&#x20; \| Pre-feature | \`sceneMeta == null\`, \`acceptance == null\`, \`m.scene\` null | none |
\

\
3\. \*\*Effective scene\*\* = own scene if set, otherwise the previous effective scene.
\
&#x20; \- \*\*Seed rule (1.17):\*\* the seed counts as the starting effective scene only if no pre-feature reply comes before the first message with an own scene. If a legacy reply is found first, the effective scene stays null until a real scene appears, because the seed describes turn 0, not turn 40.
\
&#x20; \- \`missingStreak\` counts non-OOC replies with no own scene since the last own scene (1.22). It resets on an own scene.
\
4\. \*\*\`latestScene(messages, opts)\`\*\* keeps its current return shape and is derived from \`sceneTimeline\` (the effective scene of the last message before \`upToOrder\`). Callers do not change.
\
5\. \*\*Replay rule in \`contentFor\`.\*\* The \`\<plan_thread>\` line is added only when all three hold:
\
&#x20; \- a fixed plan is active now;
\
&#x20; \- Scene memory is on;
\
&#x20; \- the message has a \`planThread\`.
\

\
&#x20; \| Message kind | Replayed content (text is always \`stripOcc\`'d and final-stripped) |
\
&#x20; \|---|---|
\
&#x20; \| Accepted with own scene (declared, inferred, manual) | text + optional \`\n\<plan_thread>…\</plan_thread>\` + \`\n\<scene>OWN\</scene>\` |
\
&#x20; \| Carried, parse failed, edited with no scene, superseded pending without candidate | text + \`\n\<scene>EFFECTIVE\</scene>\` (omit the tag if the effective scene is null) |
\
&#x20; \| Superseded pending with candidate | text + \`\n\<scene>CANDIDATE\</scene>\` |
\
&#x20; \| Unsuperseded pending | text + \`\n\<scene>EFFECTIVE\</scene>\`, \*\*no prefix\*\*. This cannot happen in a narrator request, because a request always follows a new user message; it only matters for previews. |
\
&#x20; \| Pre-feature | text + \`\n\<scene>EFFECTIVE\</scene>\` if an effective scene exists, otherwise text alone |
\
&#x20; \| OOC reply | text only, no tag |
\
&#x20; \| Scene memory off | text only, with no \`\<scene>\` and no \`\<plan_thread>\` for any kind (legacy parity, 2.3) |
\

\
&#x20; Every replayed scene is the canonical form from S3, so history shows the model one consistent format.
\
6\. \*\*\`formatTurnsTranscript\`\*\* (\`turns.js\` \~41) labels a turn only with its \*\*own\*\* scene from the timeline. A turn without one gets no label (1.10). Pass the timeline in or compute it once per call.
\
7\. \*\*\`memory-prompts.js:27\`\*\* uses the own scene from the timeline, not raw \`m.scene\` (B-N4).
\
8\. \*\*No data change.\*\* Old carried docs with a stored copy are read through \`sceneMeta.kind\`. New carried docs store \`scene:null\` (S5).
\

\
\*\*Acceptance.\*\*
\
\- In a narrator request with Scene on, every non-OOC assistant turn after the first scene ends with exactly one \`\<scene>\` line in canonical form.
\
\- With Scene off, no request contains \`\<scene>\` or \`\<plan_thread>\`, and the request bytes equal the pre-memory app for the same history.
\
\- A 40-turn legacy chat plus a seed shows no current scene until the first tagged reply.
\
\- The transcript never shows a carried scene as a turn's own scene.
\
\- No extra Firestore reads: the timeline uses the loaded array.
\

\
\*\*Tests.\*\*
\
\- Rewrite \`tests/scene-resilience.mjs\` 19-29 (carried copies) to assert on \`sceneTimeline\`.
\
\- New table test with one message per row of the replay table, asserting the exact \`contentFor\` output.
\
\- Legacy-plus-seed case for 1.17.
\
\- \`missingStreak\` case with OOC turns in between.
\
\- Scene-off parity case: build the request with all toggles off and compare it with the pre-memory builder output (coordinate with plan 2.3, which owns the parity harness).
\

\
\*\*Depends on:\*\* S1, S3.
\

\
\---
\

\
\## S5. Warn-only turn flow
\

\
\*\*Findings covered:\*\* 1.2, 1.18, 1.23, and the reasoning-salvage part of 1.20.
\

\
\*\*Problem.\*\*
\
\- A lint warning makes the reply pending, and the parsed scene is then replaced by a carried copy (1.2). So a good scene is thrown away because of a style hint.
\
\- \`planThread\` is saved even when no plan is active.
\
\- When recovery fails, the user sees a red \`⚠ null Scene recovery failed…\` error that cannot be acted on (1.18, 1.23).
\
\- \`\<think>\` drafts can win over the real tag (1.20).
\

\
\*\*Root cause (verified).\*\* \`js/ui/chat-view\.js\` \`runAssistantTurn\` \~1045-1129:
\
\- \~1070: \`extractPlanThread\` with no plan-active check.
\
\- \~1074: \`inspectSceneOutput\` when Scene is on, else \`extractScene\`.
\
\- \~1077-1078: lint warnings set pending.
\
\- \~1084-1095: recovery runs only if not pending; \~1092 builds the "null …" text.
\
\- \~1096: \`selectedScene = pending ? carryScene(prior) : acceptedScene\`.
\
\- \~1099-1100: writes \`acceptance\` and \`sceneCandidate\`.
\
\- \~1116: \`showTransientError\`.
\

\
\`showTransientError\` \~1362 always renders \`msg error\` with \`⚠\`.
\

\
\*\*Fix.\*\* Replace the block \~1070-1116 with this order:
\
1\. \`const out = readSceneOutput(rawContent)\` (S3). This runs \`stripThinking\` first, which fixes 1.20. \`const text = out.clean\`.
\
2\. \`planThread = (planActive && memory.scene) ? out.planThread : null\`. \`planActive\` is the same check the context builder uses to include the fixed plan.
\
3\. \`ooc = classifyUserInput(lastUserText)\`:
\
&#x20; \- \`'ooc'\` means an OOC reply;
\
&#x20; \- \`'question'\` means OOC only if \`out.scene == null\` (the output decides);
\
&#x20; \- \`'narrative'\` means not OOC.
\

\
&#x20; Until S7 lands, use \`isPureOoc(lastUserText) && !out.scene\`.
\
4\. When Scene is on and the reply is not OOC:
\
&#x20; \- a. If \`out.scene\` is set, run \`validateSceneValues(out.scene, { prior, text })\` (S8 makes it keep prior values). Store the result with \`sceneMeta.kind = 'declared'\`.
\
&#x20; \- b. Otherwise, if \`memory.sceneFallback\` is on and \`!maintenanceUsed\`, call \`recoverScene\` (one call, no retry, S11). On success, store it with \`kind:'inferred'\` and \`maintenanceUsed = true\`.
\
&#x20; \- c. Otherwise store \`scene:null\` and \`sceneMeta: { kind:'carried', stale:true, fromId, fromOrder }\`, where \`fromId\` and \`fromOrder\` come from the effective scene in \`sceneTimeline\` (S4). \*\*Do not copy the scene text\*\* (B-N4).
\
5\. Lint: \`warnings = lintPlayerAgency(text, names)\`. Run \`lintUnestablishedTime\` only when the stored time \*\*and\*\* the prior time are both unknown (1.3 note). Add \`out.count > 1 ? 'Several scene tags; the last one was used.' : null\` and the recovery outcome text.
\
6\. Write \`acceptance: 'accepted'\`, \`reviewWarnings: warnings\` (an array of short strings, empty becomes the field omitted). \*\*Never write \`sceneCandidate\` or \`'pending'\` again.\*\* \`carryScene\` is no longer called. Delete it once nothing uses it.
\
7\. \*\*User feedback.\*\*
\
&#x20; \- Add \`showTransientInfo(text)\` next to \`showTransientError\`. It renders a \`msg info\` element with no \`⚠\`, muted styling, and is auto-dismissed like the error.
\
&#x20; \- Call it only when the turn ended with step 4c and Scene is on: "No scene tag in this reply; the previous scene was kept."
\
&#x20; \- Never show the text "null". Build every message from strings that exist; \`String(err?.message ?? 'unknown error')\`.
\
8\. Render \`reviewWarnings\` under the reply as a muted \`Note: …\` line. Do not show buttons for it.
\
9\. Post-turn maintenance (\~1120-1125) is unchanged, apart from the \`maintenanceUsed\` fix in S1.
\

\
\*\*LLM call count:\*\* narrator (1) plus at most one of {pre-turn summary, recovery, post-turn extraction}. This is the same as today; the cap holds.
\

\
\*\*Acceptance.\*\*
\
\- A reply with a valid scene and a lint hit stores the scene with \`kind:'declared'\`, \`acceptance:'accepted'\` and one warning note. No Accept button appears.
\
\- A reply with no tag and recovery off stores \`scene:null\` plus a carried reference, and shows one info line, not an error.
\
\- \`planThread\` is null whenever no fixed plan is active.
\
\- No new reply ever has \`acceptance:'pending'\`.
\
\- With Scene off: no scene, no warnings, no notes, no info line (legacy).
\

\
\*\*Tests.\*\*
\
\- Rewrite \`tests/regressions.mjs\` 796-822: an invalid \`\<scene_state>Kael left.\</scene_state>\` now gives \`scene:null\`, \`sceneMeta.kind:'carried'\` and no copied text. Assert the info line, not "The model omitted".
\
\- Rewrite \`tests/regressions.mjs\` 824-848: the \`'flagged'\` mode expects \`acceptance:'accepted'\` plus \`reviewWarnings\`, not pending.
\
\- New harness cases:
\
&#x20; \- valid scene plus lint hit gives a stored scene and a note;
\
&#x20; \- recovery throws, so an info line is shown, it contains no "null", and nothing is red;
\
&#x20; \- no plan active means \`planThread\` null.
\

\
\*\*Depends on:\*\* S1, S3, S4.
\

\
\---
\

\
\## S6. Lint precision
\

\
\*\*Findings covered:\*\* 1.3, B-N3.
\

\
\*\*Problem.\*\* \`lintPlayerAgency\` flags normal narration:
\
\- "You take the letter", "You nod once", "You reach the door";
\
\- "Krail watches you turn";
\
\- "Nera nods once" (when Nera is an NPC);
\
\- any text after a multi-paragraph quote.
\

\
The quote pairing breaks on apostrophes and unclosed quotes. \`validateSceneValues\` uses the same broken pairing (B-N3).
\

\
\*\*Root cause (verified).\*\* \`js/turn-review\.js\`:
\
\- \`lintPlayerAgency\` \~8-19 uses a bare verb list (includes nod, reach, take, turn, glance, smile, shrug, sign) and matches anywhere.
\
\- Quote strip is \`["“][\s\S]\*?["”]\`.
\
\- \`lintUnestablishedTime\` \~21-26.
\

\
\*\*Fix.\*\*
\
1\. Add a shared helper \`stripDialogue(text)\` (in \`turn-review\.js\`, exported):
\
&#x20; \- work per paragraph (split on blank lines);
\
&#x20; \- remove \`“…”\` and \`"…"\` spans;
\
&#x20; \- an unclosed quote runs only to the paragraph end;
\
&#x20; \- ignore \`'\` entirely (apostrophes).
\

\
&#x20; \`validateSceneValues\` uses it too (S8).
\
2\. Match only subject-position speech or decision verbs for the protagonist:
\
&#x20; \`\`\`js
\
&#x20; const START = String.raw\`(?:^|[.!?]\s+|\n|,\s\*|\band\s+|\bthen\s+)\`;
\
&#x20; const VERBS = 'say|says|said|reply|replies|replied|ask|asks|asked|whisper|whispers|whispered|shout|shouts|shouted|tell|tells|told|decide|decides|decided|agree|agrees|agreed|choose|chooses|chose|refuse|refuses|refused|realize|realizes|realized|think|thinks|thought|feel|feels|felt|want|wants|wanted|promise|promises|promised';
\
&#x20; const re = new RegExp(\`${START}(you|${escape(protagonistName)})\\\s+(?:${VERBS})\\\b\`, 'i');
\
&#x20; \`\`\`
\
&#x20; Drop the physical action verbs (nod, reach, take, turn, glance, smile, shrug, sign). "Watches you turn" no longer matches, because \`you\` is not in subject position.
\
3\. Use only the protagonist name and \`you\`, never NPC names. Today the names list can contain NPCs, which is how "Nera nods once" got flagged.
\
4\. Lint output is a note only (S5). It never changes acceptance.
\

\
\*\*Acceptance.\*\*
\
\- None of these is flagged:
\
&#x20; \- "You take the letter";
\
&#x20; \- "You nod once";
\
&#x20; \- "Krail watches you turn";
\
&#x20; \- "You reach the door";
\
&#x20; \- "Nera nods once" (NPC);
\
&#x20; \- text after a two-paragraph quote.
\
\- All of these are flagged:
\
&#x20; \- "You say, 'fine.'";
\
&#x20; \- "Then you decide to stay.";
\
&#x20; \- "Nera Veyrath agrees." (protagonist).
\

\
\*\*Tests.\*\* A table test in \`tests/scene-resilience.mjs\` or a new \`tests/turn-review\.mjs\` with the cases above, plus \`stripDialogue\` cases: an apostrophe, an unclosed quote, and a quote across paragraphs.
\

\
\*\*Depends on:\*\* S5.
\

\
\---
\

\
\## S7. OOC classifier
\

\
\*\*Findings covered:\*\* 1.8.
\

\
\*\*Problem.\*\* \`isPureOoc\` treats ordinary \`\<ad>\` directions as OOC, so a narrative reply is stored as OOC and its scene is dropped. The 8 confirmed cases:
\
\- \`\<ad>When they reach the gate…\</ad>\`;
\
\- \`\<ad>Have Bastian Krail leave the room.\</ad>\`;
\
\- \`\<ad>Summarize…, then continue…\</ad>\`;
\
\- and similar.
\

\
It also misses explicit forms: \`(OOC: …)\`, \`[OOC: …]\`, \`((…))\`, \`OOC - …\`.
\

\
\*\*Root cause (verified).\*\* \`js/scene.js\` \`isPureOoc\` \~9-23.
\

\
\*\*Fix.\*\*
\
1\. Add \`classifyUserInput(text)\` to \`js/scene.js\`. It returns \`'ooc' | 'question' | 'narrative'\`:
\
&#x20; \- \*\*Explicit \`'ooc'\`:\*\*
\
&#x20; \- the whole message is \`\<ooc>…\</ooc>\`;
\
&#x20; \- or a whole \`((…))\`;
\
&#x20; \- or a whole \`(OOC…)\` or \`[OOC…]\`.
\
&#x20; \- \*\*Prefix\*\* \`OOC:\`, \`OOC -\`, \`[OOC]\`, \`(OOC)\` gives \`'ooc'\`, unless the rest contains a continue cue. A continue cue is "then continue", "then advance", "anyway", "back to the story" and similar; with one, the result is \`'narrative'\`.
\
&#x20; \- \*\*\`\<ad>…\</ad>\` as the whole message:\*\*
\
&#x20; \- a continue cue gives \`'narrative'\`;
\
&#x20; \- starts with \`OOC\` or contains "answer OOC" gives \`'ooc'\`;
\
&#x20; \- a single question that starts with a question word and ends in \`?\`, with nothing after it, gives \`'question'\`;
\
&#x20; \- a summary or recap request with no continue cue gives \`'question'\`;
\
&#x20; \- anything else gives \`'narrative'\`.
\
&#x20; \- Any text outside the \`\<ad>\` block gives \`'narrative'\`.
\
2\. Keep \`isPureOoc(text) = classifyUserInput(text) !== 'narrative'\` for old callers. S5 uses the three-way result: \`'question'\` counts as OOC only when the reply has no scene.
\
3\. Prototype: \`/tmp/claude-1000/-home-nguyennhp-projects-temp/36a5aa0b-f3d0-4f28-9984-1a983cca60be/scratchpad/sceneB/ooc.mjs\` passes all 25 cases below.
\

\
\*\*Fixture table.\*\*
\

\
\| Input | Expected |
\
\|---|---|
\
\| \`\<ad>When they reach the gate, have the guard stop them.\</ad>\` | narrative |
\
\| \`\<ad>How about a time skip to evening.\</ad>\` | narrative |
\
\| \`\<ad>Which path does she take? Write it.\</ad>\` | narrative |
\
\| \`OOC: nice! Anyway I draw my sword.\` | narrative |
\
\| \`(OOC: who is here?)\` | ooc |
\
\| \`[OOC: who is here?]\` | ooc |
\
\| \`((who is here?))\` | ooc |
\
\| \`OOC - who is here?\` | ooc |
\
\| \`\<ad>Continue the hearing. Have Krail leave the room.\</ad>\` | narrative |
\
\| \`\<ad>Have Bastian Krail leave the room.\</ad>\` | narrative |
\
\| \`\<ad>The door opens and Magerrett enters.\</ad>\` | narrative |
\
\| \`\<ad>Summarize what happened, then continue the hearing.\</ad>\` | narrative |
\
\| \`\<ad>Answer OOC, then continue the hearing.\</ad>\` | narrative |
\
\| \`\<ad>What does Krail think?\</ad> I ask him to leave.\` | narrative |
\
\| \`\<ad>Who is physically present?\</ad>\` | question |
\
\| \`\<ad>What does Mira believe?\</ad>\` | question |
\
\| \`\<ad>Can you summarize the hearing?\</ad>\` | question |
\
\| \`\<ad>Summarize the scene.\</ad>\` | question |
\
\| \`\<ad>Answer OOC without advancing events.\</ad>\` | ooc |
\
\| \`\<ooc>Explain the scene.\</ooc>\` | ooc |
\
\| \`OOC: Who is present?\` | ooc |
\
\| \`[OOC] Who is present?\` | ooc |
\
\| \`I draw my sword.\` | narrative |
\
\| \`(I nod.)\` | narrative |
\
\| \`\<ad>What does Krail do when she enters?\</ad>\` | question |
\

\
\*\*Acceptance.\*\* All 25 rows pass. A \`'question'\` turn whose reply carries a scene tag is stored as a normal turn with its scene.
\

\
\*\*Tests.\*\*
\
\- New table test.
\
\- Update \`tests/regressions.mjs\` 862-872: \`\<ad>What does Liora believe?\<ad>\` (note the missing slash; it is not a closed \`\<ad>\` block) now classifies as narrative. Change that test's input to \`\<ooc>What does Liora believe?\</ooc>\` so it still checks the OOC path, and add one case where a \`'question'\` reply with a tag is stored as narrative.
\

\
\*\*Depends on:\*\* S5.
\

\
\---
\

\
\## S8. validateSceneValues keeps prior values and reads progression
\

\
\*\*Findings covered:\*\* 1.7, 1.21.
\

\
\*\*Problem.\*\*
\
\- When a date or time is not found word for word in the reply, it is set to null and stored as unknown. The prior known value is lost (1.7: "Day 2" followed by "The third day dawns" becomes unknown/unknown).
\
\- A time word inside "last night", "next morning" or "yesterday evening" is taken as the current time (1.21).
\

\
\*\*Root cause (verified).\*\* \`js/scene.js\` \`validateSceneValues\` \~102-121: an unsupported value becomes null with provenance \`'unknown'\`. Needle matching is exact substring on text that was stripped with the broken quote regex (B-N3).
\

\
\*\*Fix.\*\*
\
1\. Use \`stripDialogue\` from S6 for the narration text.
\
2\. \*\*Matching.\*\*
\
&#x20; \- Match on word stems: the needle plus optional \`s\`, \`ed\` or \`ing\`, so \`dawn\` matches \`dawns\`.
\
&#x20; \- Add a small synonym map: \`dawn: daybreak, sunrise, first light\`; \`dusk: sunset, twilight\`; \`night: midnight, nightfall\`; \`noon: midday\`; \`evening: nightfall\`.
\
3\. \*\*Date progression.\*\* If the prior date is \`Day N\` and the reply has a day-change cue, accept \`Day N+1\`:
\
&#x20; \- cues: "next day", "next morning", "the following day", "dawn of the", or an ordinal day word that equals N+1 ("third day").
\
&#x20; \- Otherwise, a date that differs from prior and has no support keeps the \*\*prior\*\* value with provenance \`'kept'\`.
\
4\. \*\*Time.\*\* Reject a time needle that is directly preceded by \`last\`, \`next\`, \`yesterday\`, \`tomorrow\`, \`previous\`, \`that\` or \`every\` (1.21).
\
5\. \*\*Unsupported value.\*\* Keep the \*\*prior\*\* value if one exists (provenance \`'kept'\`). Use unknown only when there is no prior value. Never replace a known value with null just because support is missing.
\
6\. Clock times (\`14:30\`) count as supported when the same clock string, or the hour plus "o'clock", appears in narration.
\

\
\*\*Acceptance.\*\*
\
\- \`Day 2\` followed by "The third day dawns" stores \`date: Day 3\`, \`time: dawn\`.
\
\- "He remembered last night" leaves the time as prior.
\
\- A declared \`time: evening\` with no support and prior \`afternoon\` stores \`afternoon\` (\`'kept'\`).
\

\
\*\*Tests.\*\* A table test with 1.7 and 1.21 cases, plus a no-prior case that still gives unknown.
\

\
\*\*Depends on:\*\* S3, S6.
\

\
\---
\

\
\## S9. Remove bracket metadata from the narrator context
\

\
\*\*Findings covered:\*\* 1.6 (the part not handled in S1).
\

\
\*\*Problem.\*\* The narrator context carries bookkeeping that reads like story text:
\
\- \`[kind; origin; cutoff]\` lines on every lore card;
\
\- an "Opening exchange: historical background…" wrapper on anchor messages even when they sit right next to the recent window.
\

\
The model copies the brackets and gets the wrong time sense.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/lore-select.js\`:
\
&#x20; \- \`renderEntry\` \~77-89 (line \~84 adds the bracket line);
\
&#x20; \- \`renderEventsBlock\` \~129 does the same.
\
\- \`js/memory-context.js\` \~54 wraps anchors with \`prompts/opening-exchange.md\`.
\

\
\*\*Fix.\*\*
\
1\. \`renderEntry(entry, { provenance = false } = {})\`:
\
&#x20; \- The narrator path (\`memory-context.js\` \~110 via \`renderMemoryBlock\`) uses the default \`false\`: no bracket line. At most a short suffix on the label: \`Label (as of T12):\`, and only for events.
\
&#x20; \- \`memory-prompts.js:38\` (extraction and reorganise) passes \`{ provenance: true }\` and keeps today's output.
\
2\. Same option for \`renderEventsBlock\`.
\
3\. Wrap anchors with the opening-exchange label only when at least one turn was left out between the anchor and the start of the recent window. Coordinate the wording with plans 2.9 and 2a.12, which own the prompt text.
\

\
\*\*Acceptance.\*\*
\
\- With memory on, the narrator request contains no \`[\`…\`; \`…\`; \`…\`]\` metadata lines.
\
\- The extraction prompt output is byte-identical to today.
\
\- A short chat (anchor adjacent to the window) has no "Opening exchange" label.
\

\
\*\*Tests.\*\* A snapshot of \`renderMemoryBlock\` with two cards, in both modes. An anchor-adjacency case in the context-builder tests.
\

\
\*\*Depends on:\*\* S1. Coordinate with 2.9 and 2a.12.
\

\
\---
\

\
\## S10. Edit, scene chip and pending UI
\

\
\*\*Findings covered:\*\* 1.11, 1.15, 1.16.
\

\
\*\*Problem.\*\*
\
\- Editing a reply's text wipes its scene, \`sceneMeta\` and \`planThread\`, so a typo fix loses the scene (1.11).
\
\- The scene chip shows a carried copy as if it were the reply's own scene, and shows nothing when the reply has no scene. So the user cannot add one (1.16).
\
\- The manual scene edit stores any text without parsing it.
\
\- The review box offers no view of the candidate. \`'rejected'\` is referenced but never written (1.15).
\

\
\*\*Root cause (verified).\*\* \`js/messages.js\`:
\
\- \`editMessage\` \~292-297 sets \`planThread\`, \`scene\`, \`sceneMeta\` and \`sceneCandidate\` to null and sets \`acceptance:'accepted'\`.
\
\- \`updateMessageScene\` \~311-314 only calls \`normalizeSceneLine\`.
\
\- \`acceptMessage\` \~316-322 applies \`sceneCandidate\`.
\

\
\`js/ui/chat-view\.js\`:
\
\- chip \~765-784 is rendered only if \`m.scene\` is set;
\
\- review box \~752-763.
\

\
\*\*Fix.\*\*
\
1\. \*\*\`editMessage\`.\*\*
\
&#x20; \- Keep \`scene\`, \`sceneMeta\` and \`planThread\`.
\
&#x20; \- If the message is pending, apply \`sceneCandidate\` as \`scene\` (\`kind:'declared'\`), set \`acceptance:'accepted'\` and clear \`sceneCandidate\`.
\
&#x20; \- Otherwise do not touch \`acceptance\`.
\
&#x20; \- Still set \`editedAt\` and bump \`revision\` as today.
\
2\. \*\*\`updateMessageScene(id, raw)\`.\*\*
\
&#x20; \- Empty or blank input clears the scene (\`scene:null\`, \`sceneMeta:{ kind:'carried', stale:true, … }\`, filled from the timeline).
\
&#x20; \- Otherwise \`canonicalScene(raw)\`. If that is null, throw \`Could not read that scene. Use: date: … · time: … · place: … · present: …\`. Example: \`"Tavern, night"\` is rejected.
\
&#x20; \- On success, store the canonical text with \`sceneMeta.kind:'manual'\`.
\
3\. \*\*Chip.\*\*
\
&#x20; \- Read the effective scene from \`sceneTimeline\` (S4), not \`m.scene\`.
\
&#x20; \- Own scene: show it as today.
\
&#x20; \- Carried: show the effective scene with a muted \`(carried)\` suffix.
\
&#x20; \- No effective scene (and Scene on, not OOC): show a \`+ Add scene\` button that opens the same editor.
\
4\. \*\*Review box.\*\*
\
&#x20; \- Shown only under the S1 rule.
\
&#x20; \- Shows the \`sceneCandidate\` canonical text read-only, plus the Accept and Regenerate buttons.
\
&#x20; \- Remove every \`'rejected'\` branch (\`latestScene\`, \`isAcceptedTurn\` already handled in S1, any UI string).
\
5\. Every write goes through \`changeMessage\` as today, so 3.2 invalidation applies. No new write paths and no new reads.
\

\
\*\*Acceptance.\*\*
\
\- Editing the text of a reply keeps its chip.
\
\- Editing a pending reply accepts it with its candidate scene.
\
\- A carried reply shows \`(carried)\`.
\
\- A reply in a chat with no scenes shows \`+ Add scene\`.
\
\- \`"Tavern, night"\` in the editor shows the error and stores nothing.
\
\- \`Day 3 | dusk | Gate | present: Mira\` is stored canonically.
\

\
\*\*Tests.\*\*
\
\- \`tests/messages\*.mjs\` or the harness:
\
&#x20; \- edit keeps the scene;
\
&#x20; \- edit of a pending reply applies the candidate;
\
&#x20; \- an invalid manual scene throws;
\
&#x20; \- blank input clears.
\
\- Chip render cases need plan 5.1's \`sameRenderedMessage\` fix to refresh.
\

\
\*\*Depends on:\*\* S3, S4, S5, and U4.
\

\
\---
\

\
\## S11. Scene recovery hardening
\

\
\*\*Findings covered:\*\* 1.14.
\

\
\*\*Problem.\*\* Recovery fails on common, harmless model output:
\
\- JSON in a fence;
\
\- a name in different case;
\
\- a name not in the known list;
\
\- a \`10:30\` time (because \`sceneLine\` threw).
\

\
It also sends \`require_parameters:true\`, which makes OpenRouter refuse models that ignore an optional parameter. And it relies on omitting \`reasoning\` to disable reasoning, which some providers ignore, so the 1500-token budget can be used up by reasoning.
\

\
\*\*Root cause (verified).\*\* \`js/scene-recovery.js\`:
\
\- \`parseRecovery\` \~15-26 runs raw \`JSON.parse\`, throws on any name not in \`names\`, and uses \`sceneLine\`.
\
\- \`recoverScene\` \~27-36 sets \`maxResponseTokens 1500\`, \`reasoning enabled:false\` (which \`llm-client\` drops), and \`require_parameters:true\`.
\

\
\*\*Fix.\*\*
\
1\. Before parsing:
\
&#x20; \- remove fences (\`\`\`\` \`\`\`json \`\`\`\`);
\
&#x20; \- take the substring from the first \`{\` to the last \`}\`;
\
&#x20; \- on failure, return null (not throw).
\
2\. Names:
\
&#x20; \- map names case-insensitively to the known list;
\
&#x20; \- keep the protagonist;
\
&#x20; \- keep unknown names only if they appear literally in the narration or user text;
\
&#x20; \- drop the rest silently.
\
3\. Build the line with \`canonicalFromFields\` (S3), so \`10:30\` is fine.
\
4\. Request:
\
&#x20; \- On OpenRouter, send \`reasoning: { enabled: false }\` explicitly. Check how \`llm-client\` builds the body and make it pass the object through for OpenRouter only. [S] Confirm the exact OpenRouter field name against current docs before merging.
\
&#x20; \- Remove \`require_parameters:true\`.
\
5\. One attempt only, no retry (2-call cap). On failure, S5 step 4c applies.
\
6\. The pending-candidate branch of recovery is gone, because S5 never makes a reply pending.
\

\
\*\*Acceptance.\*\*
\
\- Fenced JSON, \`"mira"\` versus \`Mira\`, an extra name not in the text (dropped) and \`time: "10:30"\` all give a canonical scene.
\
\- Garbage input returns null with no exception.
\
\- The request body has no \`require_parameters\`.
\

\
\*\*Tests.\*\* Unit tests for \`parseRecovery\` with those inputs. A request-body assert through a stubbed \`llm-client\` in the harness.
\

\
\*\*Depends on:\*\* S3, S5.
\

\
\---
\

\
\## S12. Card selection also uses recent narration
\

\
\*\*Findings covered:\*\* 2.6.
\

\
\*\*Problem.\*\* Lore cards are picked only from:
\
\- always-load;
\
\- the current scene's place and present names;
\
\- names in the \*\*user's\*\* latest message.
\

\
A character or place that the narrator brought up in the last reply is not loaded on the next turn unless the user repeats the name.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/lore-select.js\` \`selectEntries\` \~50-74.
\
\- \`js/memory-context.js\` \~107 passes only the latest user content and \`current.scene\`. \`resolveScene\` \~34-49 uses the raw carried copy.
\

\
\*\*Fix.\*\*
\
1\. Add an option \`selectEntries(entries, { userText, scene, recentText = '' })\`. \`recentText\` is the final-stripped text of the last 1-2 assistant replies before the latest user message (skip OOC replies).
\
2\. Match order and priority:
\
&#x20; 1\. always-load;
\
&#x20; 2\. scene place and present;
\
&#x20; 3\. mentions in user text;
\
&#x20; 4\. mentions in \`recentText\`, with reason \`'recent mention'\`.
\

\
&#x20; Recent mentions come last, so they are the first to drop when the card budget is full.
\
3\. \`scene\` is the effective scene from \`sceneTimeline\` (S4), so a carried turn still loads the right place cards.
\
4\. Built from the loaded \`messages\` array: no Firestore reads.
\

\
\*\*Acceptance.\*\*
\
\- A name that appears only in the previous narrator reply loads its card on the next turn.
\
\- With the budget full, recent-mention cards are dropped before user-mention cards.
\
\- With memory off, nothing changes.
\

\
\*\*Tests.\*\* A \`selectEntries\` unit test with \`recentText\`. A budget-overflow ordering test.
\

\
\*\*Depends on:\*\* S4.
\

\

\
\---
\

\
\# Part C — Context assembly and prompt text (C1–C9)
\

\
FEATURE = \`Nera_chat-feature-story-memory/Nera_chat-feature-story-memory\` (all paths below are relative to it unless they say MAIN).
\
MAIN = \`Nera_chat-main/Nera_chat-main\`. The parity target is MAIN's current \`js/context-builder.js\` (217 lines).
\
Finding 2.6 is not covered here. Plan B owns it (task S12).
\

\
\## Owner defaults (apply to every task below)
\

\
1\. \*\*Legacy parity (2.3).\*\* When every memory toggle is off (\`memoryActive(mem) === false\`), the request must be byte-identical to what MAIN's \`buildContextForRequest\` returns for the same session, settings and messages. A golden test enforces this (task C2).
\
2\. \*\*Word range.\*\* Decided by the owner: \*\*200-600 words\*\*. Write it literally \*\*in the file\*\* at every site in C4 step 1. Never use a runtime placeholder here: the legacy route sends \`narrator.md\` unrendered, so the placeholder would leak to the model. Every site is listed in C4, step 1.
\
3\. \*\*End reminder.\*\* When Scene is on, the very end of the final user message always gets a short reminder containing the literal tag template, whatever \`replyContract\` is set to (task C3).
\

\
House rules every task keeps:
\
\- At most 2 LLM calls per user turn. \*\*No task in this plan adds an LLM call.\*\*
\
\- The narrator never outputs JSON.
\
\- No data migration. Old Firestore documents keep working unchanged.
\
\- Firestore reads: \*\*no task in this plan adds a read.\*\* Every change works on data that is already in memory (cached history, cached lore entries, \`state.settings\`).
\

\
\## Corrections to the findings
\

\
\- \*\*2.15 is mostly wrong.\*\* Turn numbers come from \`narratorTurn\`, which is stored on each message and does not change when a message is deleted (\`js/turns.js\` \`computeTurns\`). So there is no drift after deletes. The real bug is smaller: the code only offers a block start if a message with exactly that turn number is still among the candidates. If the boundary turn (for example T11 with batch 10) was deleted, that block is never offered. Fixed in C8.
\
\- \*\*2.3 is incomplete.\*\* It lists 9 differences. There are at least 9 more (see "New problems" C-N1). The golden test in C2 catches all of them, so the fix does not depend on the list being complete.
\
\- \*\*2.3 wording.\*\* The finding says "the limit is \`max − resp\`". In MAIN the limit is \`requestInputLimit(settings)\` = \`min(maxContextTokens, modelContextTokens − maxResponseTokens)\` when the model size is set, otherwise just \`maxContextTokens\`. The feature has no \`modelContextTokens\` field at all until 0.1 (the merge of main) brings it back.
\
\- \*\*§2a item 14 points to 5.11.\*\* It should point to \*\*5.7\*\* (settings and prompt copies). 5.11 is the console log.
\
\- \*\*§2a item 2 is not applied as written.\*\* Putting the literal scene template in \`narrator.md\` would also send it to legacy users with Scene off, and the existing test \`tests/system-prompts.mjs:32\` requires the narrator to contain no "plan" word. The end reminder (C3) already puts the template at the very end of the request, which is closer than the narrator could ever be. The narrator gets a pointer only (C4, items 2 and 3).
\
\- \*\*§2a item 13 is applied with "the PC", not \`{{PROTAGONIST}}\`.\*\* The legacy route sends the narrator unrendered and has no protagonist value, so a placeholder would leak. See C4, step 13 and owner question Q2.
\
\- \*\*§2a item 12 is applied with one change.\*\* With no gap there is no label at all (not a softer label). Plan B task S9 step 3 asks for the same condition. C3 owns it.
\

\
\## New problems found during the review (not in REVIEW_FINDINGS)
\

\
\- \*\*C-N1. More legacy differences than 2.3 lists.\*\* Verified against MAIN \`js/context-builder.js\`:
\
&#x20; \- the AD rule text differs (MAIN has an inline \`AD_DIRECTIVE_RULE\`; FEATURE uses \`author-direction.md\`);
\
&#x20; \- the plan block text differs (MAIN: "Current long-term plan (set by the user; …)" plus two extra sentences about removed plan tags and the fixed plan);
\
&#x20; \- MAIN strips \`PLAN_THREAD_RECOVERY_RULE\` from the narrator; FEATURE does not;
\
&#x20; \- FEATURE runs \`stripOcc\` on non-latest messages; MAIN does not;
\
&#x20; \- FEATURE drops a summary that has \`needsReview\` or stale evidence; MAIN does not;
\
&#x20; \- MAIN runs \`storyText\` on the summary; FEATURE does not;
\
&#x20; \- the selection model differs (MAIN: fixed costs, one greedy pass, two-pass gap marker; FEATURE: full re-render per step, lore before older fill);
\
&#x20; \- error behaviour differs (MAIN throws only with \`requireLatestUser\`, otherwise returns \`exceedsInputLimit\`; FEATURE always throws);
\
&#x20; \- threshold semantics differ (MAIN \`used >= threshold\` with max = input limit; FEATURE \`used + maxResponse >= max\*pct\`).
\
\- \*\*C-N2. The narrator hash migration changes what legacy users get.\*\* \`js/settings.js\` \`mergeDefaults\` (\~46-63) swaps MAIN's default narrator (both hashes in \`legacy-narrator-default-hashes.md\`, with and without the recovery rule) for FEATURE's \`narrator.md\`. So a legacy user's request is byte-identical to MAIN's builder \*given the settings\*, but the narrator text itself is the new Nera-specific, scene- and memory-aware one. Owner question Q1.
\
\- \*\*C-N3. The legacy summarizer request differs from MAIN.\*\* \`js/summarizer.js:88\` appends \`CONTINUITY_RULE\` to the summarizer prompt, and \`:67\` gates on \`isAcceptedTurn\`. MAIN does neither. Owned by Part L (see conflict resolution R12).
\
\- \*\*C-N4. The summarizer probe needs a required-window build in legacy mode too.\*\* \`js/summarizer.js:78\` calls the builder with \`onlyRequiredWindow:true\` and reads \`report.warnings\` at \`:81\` and \`:141\`. MAIN's builder has neither. C2 handles this in the wrapper.
\
\- \*\*C-N5. Separate-mode \`.replace()\` calls break silently after the prompt edits.\*\* \`js/memory-context.js:31-36\` edits exact narrator sentences. C4 changes all five of them. Plan B task S2 deletes the separate mode; if S2 does not land first, these strings must be updated in the same commit as C4.
\
\- \*\*C-N6. Stale fixture.\*\* \`tests/fixtures/context-builder-before-memory.txt\` is an old builder that no test reads. It is not MAIN's current builder. Delete it in C2.
\
\- \*\*C-N7. \`memory-prompts.js\` also uses total-context semantics\*\* (\`:15\`, \`:23\` message text, \`:39\`). Must move to input semantics with C5 or the updater and narrator disagree on what "Max context tokens" means.
\
\- \*\*C-N8. Plan-parser signatures conflict after the merge.\*\* FEATURE \`planInjectionBlock(plan)\` vs MAIN \`planInjectionBlock(plan, allowUpdates)\`, and the two \`stripPlan\` bodies differ. The legacy module must not import either; it keeps private copies (C2, step 1).
\

\
\## Owner questions (do not block C1-C3; block the marked steps)
\

\
\- \*\*Q1 (C-N2).\*\* Keep the narrator hash migration for legacy users (recommended: MAIN's default narrator contains plan-update and plan-recovery rules that do not fit a fixed-plan app), or skip it when memory is off?
\
\- \*\*Q2 (§2a-13).\*\* Accept "the PC" and genre-neutral wording in \`narrator.md\` (recommended), or add a per-story \`setting\` field rendered as \`{{SETTING}}\` in memory mode only? The genre and the PC's name can already go into the story plan.
\
\- \*\*Q3.\*\* Decided: 200-600 words.
\
\- \*\*Q4 (2.1 "soft cap on history turns").\*\* Recommended: do not add a cap now. Ship the end reminder, then measure the tag rate again with the eval in \`investigate/\`.
\
\- \*\*Q5 (2.4).\*\* The owner must move the "CONTINUITY TO PRESERVE IN UPDATED STORY SUMMARIES… active event ID…" section out of the story plan by hand and paste it into the summarizer prompt. No code can do this safely (it is user data).
\

\
\## Task order
\

\
\| Task | Findings | Depends on |
\
\|---|---|---|
\
\| C1 Prompt delivery to existing users | §2a-14 (with 5.7) | Plan E U7 (or do its prompt part here) |
\
\| C2 Legacy route + golden test | 2.3, 2.11 (legacy part), 2.18 (frame constants), C-N1, C-N4, C-N6, C-N8 | 0.1 merge of main |
\
\| C3 Memory-mode request layout | 2.1, 2.2, 2.4, 2.7, 2.8, 2.9, §2a-12 | C2, Plan B S1, S2 |
\
\| C4 Prompt text edits | 2.5, §2a 1-13 | C1, C3 |
\
\| C5 Budget semantics, indicator, auto-summary | 2.10, 2.11, 2.18 (indicator), C-N7 | C2, C3 |
\
\| C6 Cost performance and token cache | 2.13, 2.14 | C3 |
\
\| C7 Lore render and selection | 2.16, 2.17 | Plan B S9, S12 (same functions) |
\
\| C8 Block window | 2.15 | C6 |
\
\| C9 Known names cap | 2.12 | none |
\

\
\---
\

\
\## C1. Prompt delivery to existing users
\

\
\*\*Findings covered:\*\* §2a item 14 (same problem as the prompt part of 5.7).
\

\
\*\*Problem.\*\* Default prompt texts are copied into every user's settings document. A new default (for example the C4 edits) never reaches a user who never touched the prompt. Only the narrator has a migration, and only from MAIN's two old defaults.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/settings.js\` \`DEFAULT_SETTINGS\` (\~15-44) holds \`narratorSystemPrompt: prompts.narrator\`, \`summarizerSystemPrompt: prompts.summarizer\`, \`memoryExtractionPrompt\`, \`memoryReorganizePrompt\` (via \`memory-prompts.js\`).
\
\- \`loadSettings\` (\~184-186) seeds new accounts with \`structuredClone(DEFAULT_SETTINGS)\`, so the full texts go to Firestore.
\
\- \`saveSettings\` writes the full texts back on every save.
\
\- \`mergeDefaults\` (\~46-63) migrates only \`narratorSystemPrompt\`, and only when its SHA-256 is in \`system prompts/legacy-narrator-default-hashes.md\` (the two MAIN hashes \`74afde…\` and \`35194b…\`).
\
\- Other prompts (scene, reply contract, plan, AD, continuity, opening, headers) are read from \`prompts.\*\` at request time, so their edits already reach everyone. Only the four keys above have the problem.
\

\
\*\*Fix.\*\* Plan E task U7, step 3 already stores "not overridden" prompts as absent keys (seed and save drop keys equal to the current default; \`mergeDefaults\` fills them back). C1 adds the part U7 leaves out: a hash list so that copies of \*older\* defaults (already in Firestore and in localStorage caches) follow the new default. If U7 has not landed, do its step 3 here first.
\

\
1\. \*\*Capture the current default hashes before any prompt edit (before C4).\*\* Verified values today:
\
&#x20; \`\`\`
\
&#x20; narratorSystemPrompt efbe611f48b6579fa779bf5207ee1bdb2a6c8dbee2e1c547d49bee93a8c59b51
\
&#x20; summarizerSystemPrompt 0b86d7339ace3a633b0bd880443394dba436929ff53f819a92b5a3ab6e5a6eec
\
&#x20; memoryExtractionPrompt f5986e981a3f20e86a3c94b7fe0a9f5a8777cdebe13dce986b23558e82c6b635
\
&#x20; memoryReorganizePrompt 492ee0b2a07cd5c205bf332e231bd03a69b06b95af64f2a29242997ba0a5a686
\
&#x20; \`\`\`
\
&#x20; Re-check them with \`sha256sum\` on the exact string the app loads (CRLF→LF, one trailing newline removed, as \`loadPrompt\` does). If any differs, use the recomputed value.
\
2\. Rename \`system prompts/legacy-narrator-default-hashes.md\` to \`legacy-prompt-default-hashes.md\`. Format: one \`key hash\` pair per line.
\
&#x20; \`\`\`
\
&#x20; narratorSystemPrompt 74afde5c9d7a70813dfe76d660d2d5087413f73601cdff639035077dd5169d1b
\
&#x20; narratorSystemPrompt 35194b3e04c9611a0830cbc69d278e0a9ded312d6b3d3905b223b1ebdc6c4f59
\
&#x20; narratorSystemPrompt efbe611f… (the 4 lines from step 1)
\
&#x20; \`\`\`
\
&#x20; Update \`js/system-prompts.js\` \`files\` (\`legacyNarratorHashes\` → \`legacyPromptHashes\`).
\
3\. \`js/settings.js\`:
\
&#x20; \`\`\`js
\
&#x20; export const PROMPT_KEYS = ['narratorSystemPrompt','summarizerSystemPrompt','memoryExtractionPrompt','memoryReorganizePrompt'];
\
&#x20; const legacyHashes = new Map(); // key -> Set(hash)
\
&#x20; for (const line of prompts.legacyPromptHashes.split('\n')) {
\
&#x20; const [key, hash] = line.trim().split(/\s+/); if (key && hash) (legacyHashes.get(key) ?? legacyHashes.set(key,new Set()).get(key)).add(hash);
\
&#x20; }
\
&#x20; async function mergeDefaults(data) {
\
&#x20; const merged = { ...existing merge... };
\
&#x20; for (const key of PROMPT_KEYS) {
\
&#x20; const saved = data?.[key];
\
&#x20; if (typeof saved !== 'string' || saved === DEFAULT_SETTINGS[key]) { merged[key] = DEFAULT_SETTINGS[key]; continue; }
\
&#x20; if (legacyHashes.get(key)?.has(await sha256Hex(saved))) merged[key] = DEFAULT_SETTINGS[key];
\
&#x20; }
\
&#x20; return merged;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \`state.settings\` always holds the effective text, so no call site changes.
\
4\. Every later default edit must append the \*outgoing\* default's hash to this file in the same commit. Add that rule as one line at the top of \`system prompts/README.md\` (it is not sent to the model).
\

\
\*\*Acceptance.\*\*
\
\- A settings doc holding today's default narrator (or summarizer, extraction, reorganize) text loads with the post-C4 default.
\
\- A doc holding an edited prompt loads it unchanged.
\
\- A doc with the key missing loads the current default.
\
\- No new Firestore read or write (the merge is local).
\

\
\*\*Tests.\*\* In \`tests/regressions.mjs\` (settings harness): for each key, \`mergeDefaults({key: oldDefault})\` returns the new default; an edited text survives; a missing key gives the default. A test that every line of \`legacy-prompt-default-hashes.md\` parses into a known key.
\

\
\*\*Depends on:\*\* Plan E U7 step 3 (or do it here). Must land \*\*before\*\* C4.
\

\
\---
\

\
\## C2. Legacy route and golden test
\

\
\*\*Findings covered:\*\* 2.3, the legacy part of 2.11, the frame-constant part of 2.18, C-N1, C-N4, C-N6, C-N8.
\

\
\*\*Problem.\*\* With every toggle off, the request is not MAIN's request. The differences are in the head message, labels, summary placement, limit, tag stripping, empty-message filtering, marker text and errors (2.3 and C-N1). \`tests/memory.mjs:109-117\` only compares the all-off modes with each other, so nothing catches this.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/context-builder.js\` \`buildContextForRequest\` (\~45-50) always calls \`buildMemoryContext\`. There is no legacy path.
\
\- \`js/memory-context.js\` \`buildMemoryContext\` applies memory-mode behaviour unconditionally: head at \`:38\` (adds \`CONTINUITY_RULE\`, FEATURE plan block), summary in head with label \`:40-46\`, \`contentFor\` labels and re-appends \`:47-56\`, limit \`:16\` (\`max − resp\`), throws \`:90,151\`, no gap marker \`:146-149\`.
\
\- \`computeContextUsage\` (\~53-59) uses \`max = maxContextTokens\` and \`used + maxResponse >= threshold\`.
\

\
\*\*Fix.\*\* Copy MAIN's builder into its own module and route to it. Do not try to make \`buildMemoryContext\` reproduce MAIN byte for byte.
\

\
1\. \*\*New file \`js/legacy-context.js\`.\*\* A verbatim copy of MAIN \`js/context-builder.js\` \`buildContextForRequest\`, \`computeContextUsage\`, \`openingExchange\`, \`normalizeAdDirective\`, \`AD_DIRECTIVE_RULE\`, \`countSystemTokensCached\`, plus private copies of MAIN's \`planInjectionBlock\`, \`stripPlanThread\`, \`stripPlan\`, \`stripThinking\`, \`storyText\` and the \`PLAN_THREAD_RECOVERY_RULE\` string (C-N8: do not import the FEATURE versions; their text differs).
\
&#x20; \- Rename the exports to \`buildLegacyContext\` and \`computeLegacyUsage\`.
\
&#x20; \- Keep imports to: \`getMessages\` (messages.js), \`countTokens\`, \`tokenizerReady\` (tokenizer.js), \`requestInputLimit\`, \`MESSAGE_FRAME_TOKENS\`, \`REQUEST_FRAME_TOKENS\` (request-budget.js, see step 5).
\
&#x20; \- Put a header comment: "Copy of MAIN js/context-builder.js @ \<sha256>. Do not edit; tests/legacy-golden.mjs compares it with tests/fixtures/main-context-builder/."
\
2\. \*\*Dispatch in \`js/context-builder.js\`.\*\*
\
&#x20; \`\`\`js
\
&#x20; export async function buildContextForRequest(session, settings, opts = {}) {
\
&#x20; const messages = opts.messages ?? await getMessages(session.id);
\
&#x20; if (!memoryActive(normalizeMemory(session.memory))) return buildLegacy(session, settings, { ...opts, messages });
\
&#x20; return buildMemoryContext(session, settings, { ...opts, messages }, { count: countSystemTokensCached, adRule: AD_DIRECTIVE_RULE, normalizeAd: normalizeAdDirective });
\
&#x20; }
\
&#x20; \`\`\`
\
3\. \*\*\`buildLegacy\` wrapper\*\* (in \`context-builder.js\`). It only normalises inputs and adds the \`report\` the FEATURE UI and summarizer read. It never changes \`apiMessages\`.
\
&#x20; \- Inputs:
\
&#x20; \- \`session = { ...session, allowLlmPlanUpdates: false }\` and delete \`opts.planOverride\` (FEATURE has no LLM plan updates; MAIN's chat-view passes \`planOverride: planBefore\`, FEATURE's does not).
\
&#x20; \- \`opts.draftText?.trim()\` (indicator and viewer only; send paths never pass it): append \`{ id:'\_\_legacy_draft', order:last+1, role:'user', content:draftText }\` to \`messages\`.
\
&#x20; \- \`opts.onlyRequiredWindow\` (summarizer probe, C-N4): reduce \`messages\` to the first user message, the first assistant message after it, and the last \`keepRecentMessagesAfterSummary ?? 10\` user/assistant messages with \`order < upToOrder\` (always including the latest user message). The probe session already has no summary (\`summarizer.js:78\`).
\
&#x20; \- Ignore \`loreEntries\` (lore is off by definition).
\
&#x20; \- Output: everything MAIN returns (\`apiMessages, entries, contributions, omitted, exceedsInputLimit, usedTokens, windowedCount, droppedCount\`) plus:
\
&#x20; \`\`\`js
\
&#x20; report: {
\
&#x20; mode: 'legacy',
\
&#x20; totals: { input: usedTokens, reserved: settings.maxResponseTokens, max: requestInputLimit(settings) },
\
&#x20; blocks: contributions.map(c => ({ key: slug(c.source), label: c.source, tokens: c.tokens })),
\
&#x20; loaded: [], skipped: [], scene: null, gap: null, gaps: [],
\
&#x20; warnings, // see below
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- \`warnings\`:
\
&#x20; \- \`Recent window reduced from ${target} to ${retained} messages to fit the request budget.\` when fewer than the target recent messages are in \`entries\`. Target = the last \`keepRecentMessagesAfterSummary ?? 10\` non-empty user/assistant messages after \`breakpointOrder\` (or after 0 when no summary), excluding anchors. The summarizer matches this prefix (\`summarizer.js:81,141\`), so keep the wording exactly.
\
&#x20; \- \`Memory updates paused. …\` when \`session.memoryState?.paused\` (same as memory mode \`:162\`).
\
&#x20; \- \`The request exceeds the input limit.\` when \`exceedsInputLimit\` (MAIN shows this in its context view).
\
4\. \*\*\`computeContextUsage\`\*\* routes the same way. Legacy: \`computeLegacyUsage\` result (\`max = requestInputLimit\`, \`overThreshold = used >= threshold\`) plus \`report\`. Memory mode is changed in C5.
\
5\. \*\*Frame constants (2.18).\*\* Move \`MESSAGE_FRAME_TOKENS = 8\` and \`REQUEST_FRAME_TOKENS = 8\` into \`js/request-budget.js\` (comes with 0.1). \`context-builder.js\` re-exports them (summarizer imports them from there). \`memory-context.js:10\` replaces \`const FRAME = 8\` with \`import { MESSAGE_FRAME_TOKENS as FRAME } from './request-budget.js'\`.
\
6\. \*\*Golden fixture.\*\* New folder \`tests/fixtures/main-context-builder/\`:
\
&#x20; \- verbatim MAIN files: \`context-builder.js\`, \`plan-parser.js\`, \`story-text.js\`, \`request-budget.js\`;
\
&#x20; \- \`recovery-rule.json\`: MAIN's \`PLAN_THREAD_RECOVERY_RULE\` as one JSON string (it starts with a space, so a .txt file is risky);
\
&#x20; \- \`SOURCE.txt\`: the MAIN path, the date copied, and \`sha256 filename\` for each file.
\
&#x20; Delete \`tests/fixtures/context-builder-before-memory.txt\` (C-N6).
\
7\. \*\*Golden test \`tests/legacy-golden.mjs\`.\*\*
\
&#x20; \`\`\`js
\
&#x20; import { appHarness } from './app-harness.mjs';
\
&#x20; const fx = p => readFile(new URL('./fixtures/main-context-builder/'+p, import.meta.url), 'utf8');
\
&#x20; const tok = { countTokens: async t => Math.ceil(String(t).length / 4), tokenizerReady: () => true };
\
&#x20; async function mainApi(all) {
\
&#x20; const use = appHarness({
\
&#x20; sources: { 'context-builder.js': await fx('context-builder.js'), 'plan-parser.js': await fx('plan-parser.js'),
\
&#x20; 'story-text.js': await fx('story-text.js'), 'request-budget.js': await fx('request-budget.js') },
\
&#x20; stubs: { 'messages.js': { getMessages: async () => all }, 'tokenizer.js': tok,
\
&#x20; 'settings.js': { PLAN_THREAD_RECOVERY_RULE: JSON.parse(await fx('recovery-rule.json')) } },
\
&#x20; });
\
&#x20; return use('context-builder.js');
\
&#x20; }
\
&#x20; async function featureApi(all) {
\
&#x20; const use = appHarness({ stubs: { 'messages.js': { getMessages: async () => all }, 'tokenizer.js': tok } });
\
&#x20; return use('context-builder.js');
\
&#x20; }
\
&#x20; const pick = r => JSON.stringify({ m: r.apiMessages, u: r.usedTokens, w: r.windowedCount, d: r.droppedCount, x: r.exceedsInputLimit });
\
&#x20; \`\`\`
\
&#x20; (If FEATURE's \`context-builder.js\` pulls in Firebase via another import, stub that module too, as other tests do.)
\
&#x20; \- Fresh harness per scenario (the token caches are module state).
\
&#x20; \- For each scenario, call both builders with the same \`session\`, \`settings\`, \`opts\` (MAIN gets \`allowLlmPlanUpdates:false\`, no \`planOverride\`) and assert \`pick(main) === pick(feature)\`. For error cases, assert the same error message. For \`computeContextUsage\`, assert equal \`usedTokens, max, threshold, overThreshold\`.
\
&#x20; \- First assertion: the sha256 of each fixture file equals \`SOURCE.txt\`, so nobody edits the fixture by accident.
\
&#x20; \- Scenario matrix (each one a separate \`test()\`):
\
&#x20; 1\. no summary, short chat (everything fits);
\
&#x20; 2\. active summary that covers a gap after the anchors;
\
&#x20; 3\. tight \`maxContextTokens\` with an uncovered gap and a summary (two-pass marker: "… Later omitted turns are not covered by the summary.");
\
&#x20; 4\. tight budget, no summary ("[Earlier turns omitted.]");
\
&#x20; 5\. \`upToOrder\` (regenerate);
\
&#x20; 6\. assistant text with \`\<think>…\</think>\`, \`\<plan>…\</plan>\`, \`\<plan_thread>…\</plan_thread>\`, an unclosed \`\<think\`, and one message that is empty after stripping;
\
&#x20; 7\. user text with an unclosed \`\<ad>\`, and \`\<ad>…\<ad>\`;
\
&#x20; 8\. \`modelContextTokens\` unset vs set (limit from the model);
\
&#x20; 9\. narrator that contains the recovery rule;
\
&#x20; 10\. empty plan vs a set plan;
\
&#x20; 11\. \`memory\` = \`undefined\`, \`{}\`, \`{ autoUpdate:true }\`, \`{ protagonist:'Nera', replyContract:'user' }\` (all toggles off);
\
&#x20; 12\. \`requireLatestUser\` with no user message, and with anchors + latest over budget (both MAIN error texts);
\
&#x20; 13\. a summary message with \`needsReview:true\` (MAIN still uses it).
\
8\. \*\*Update existing tests\*\* that assumed the memory builder in all-off mode:
\
&#x20; \- \`tests/memory.mjs:109-117\`: keep the all-off equality between modes, and add "equals legacy builder output".
\
&#x20; \- \`tests/regressions.mjs\` \~467, \~484, \~492-505: in all-off mode the summary is now \`"Story so far:\n…"\` after the anchors, not a "Historical summary" head message, and anchors have no label. Rewrite the expectations to MAIN's layout. The planOverride regen test: FEATURE drops \`planOverride\`; assert the stored plan is used.
\
&#x20; \- Any test asserting FEATURE's over-budget error text in all-off mode: switch to MAIN's texts.
\

\
\*\*Acceptance.\*\*
\
\- All 13 golden scenarios pass.
\
\- With all toggles off, \`apiMessages\` contains no \`CONTINUITY_RULE\`, no \`[Opening exchange\`, no \`[Historical summary\`, no \`[Unaccepted\`.
\
\- The summarizer still runs in legacy mode (probe and candidate checks read \`report.warnings\`).
\
\- The context viewer opens in legacy mode and shows the MAIN contributions as blocks.
\
\- No Firestore read added (the wrapper reuses \`opts.messages\`).
\

\
\*\*Tests.\*\* Steps 7 and 8. Plus: the summarizer probe in legacy mode reports 'Recent window reduced' when the recent target does not fit.
\

\
\*\*Depends on:\*\* 0.1 (merge of main brings \`request-budget.js\`, \`story-text.js\`, \`modelContextTokens\`, \`tokenizerReady\`).
\

\
\---
\

\
\## C3. Memory-mode request layout
\

\
\*\*Findings covered:\*\* 2.1, 2.2, 2.4, 2.7, 2.8, 2.9, §2a item 12. Also brings these MAIN behaviours into memory mode: \`requestInputLimit\`, \`storyText\` on assistant text, dropping messages that are empty after stripping.
\

\
\*\*Problem.\*\*
\
\- 2.1: the scene rule is the tail of a \~33KB head message, about 100k tokens before the point where the model writes. With \`replyContract:'off'\` (the default) nothing repeats it near the end. Eval: off 0/4, system 1/4, user 19/20.
\
\- 2.2: in 'user' contract mode the final user message is contract → \`[Current user input]\` → \`\<memory>\` → input, and the narrator says "Read only what follows any \</memory> tag", so the contract is skipped. The label also calls memory "user input".
\
\- 2.4: the head is rules → plan_thread rule → \~17KB plan → scene rule, so the tag rules are split around the plan.
\
\- 2.7: the memory system message can land between a user message and its reply.
\
\- 2.8: up to 4 leading system messages (head, summary, facts, events).
\
\- 2.9: no marker between the pinned opening and the window.
\

\
\*\*Root cause (verified).\*\* All in \`js/memory-context.js\` \`buildMemoryContext\`:
\
\- \`:38\` builds one system string with \`SCENE_RULE\` last, after \`planBlock\` (\`:37\`). \`fixed-author-plan.md\` puts the plan_thread rule \*before\* the plan.
\
\- \`:44-45\` pushes the summary as a second system message; \`:122\` pushes facts/events as more system messages; \`:87\` returns \`[...head, ...books, ...history]\`.
\
\- \`:58\` contract only when \`mem.scene && replyContract !== 'off'\`; default is \`'off'\` (\`js/memory-settings.js:7\`).
\
\- \`:69-71\` prefixes \`\<memory>\` to the latest user message; \`:84\` then prefixes \`contract + '\n\n[Current user input]\n'\`, giving contract → label → memory → input.
\
\- \`:73-75\` splices the system memory at \`min(max(0, len − blockDepth), latestIndex)\` with no role check.
\
\- \`:146-149\` fills older messages with no marker. \`:54\` labels anchors whether or not a gap follows.
\

\
\*\*Fix.\*\*
\

\
\*\*Target layout (memory mode, Scene on, plan active, blockRole 'user', replyContract 'user').\*\* Rows marked "only when" are omitted otherwise.
\

\
\`\`\`
\
[0] system — ONE message (2.8). Parts joined with "\n\n", in this order:
\
&#x20; a. narrator settings.narratorSystemPrompt
\
&#x20; b. author directives author-direction.md
\
&#x20; c. continuity continuity.md (CONTINUITY_RULE)
\
&#x20; d. plan data fixed-author-plan.md with {{PLAN}} | plan set
\
&#x20; no-plan.md | plan empty
\
&#x20; e. tag contract, together (2.4):
\
&#x20; plan-thread.md | only when plan set
\
&#x20; scene.md (SCENE_RULE) | only when Scene on
\
&#x20; f. historical summary historical-summary.md | only when a usable summary
\
&#x20; g. world facts renderFactsBlock(...) | only when facts fit
\
&#x20; h. story memory renderEventsBlock(...) | only when events fit
\
[1] user first user message | anchors
\
&#x20; prefixed "[First exchange of the story (T1); not current conditions]\n" only when a gap follows
\
[2] assistant first assistant reply, same label rule
\
[3] system gap marker (2.9), MAIN's exact text | only when a gap exists
\
&#x20; "[Earlier turns are represented by the summary.]" or "[Earlier turns omitted.]"
\
&#x20; \+ " Later omitted turns are not covered by the summary." when both apply
\
[4..n-1] window, oldest → newest, user/assistant alternating
\
&#x20; (blockRole 'system' only: the memory system message goes directly before a USER message, 2.7)
\
[n] user final user message:
\
&#x20; \<memory> | blockRole 'user' and memory non-empty
\
&#x20; {memory text}
\
&#x20; \</memory>
\
&#x20; (blank line)
\
&#x20; {latest user text} | normalizeAdDirective
\
&#x20; (blank line)
\
&#x20; {reply contract, starting "[Reply format — current reply contract]"} | replyContract 'user'
\
&#x20; (blank line)
\
&#x20; {scene reminder} | Scene on — ALWAYS, ALWAYS LAST
\
\`\`\`
\

\
Notes on the layout:
\
\- The role comes first, not the plan. The finding asked for "plan first". Static parts first is better for provider prefix caching, and the tag rules end up after the plan, which is what 2.4 needs. The scene reminder at the end does the real work for 2.1.
\
\- \`replyContract:'system'\`: the contract is a system message inserted directly before \`[n]\` (as today, \`:85\`). The reminder still goes at the end of \`[n]\`.
\
\- \`replyContract:'off'\` (default): no contract. The reminder still goes at the end of \`[n]\`.
\
\- The facts/events headers (\`world-facts-header.md\`, \`story-memory-header.md\`) stay as the first line of g and h, so the narrator can still tell the blocks apart.
\

\
\*\*Steps.\*\*
\

\
1\. \*\*New prompt files.\*\*
\
&#x20; \- \`system prompts/plan-thread.md\`:
\
&#x20; \`\`\`
\
&#x20; \# PLAN THREAD
\

\
&#x20; On every narrative turn while the plan above is active, add one short hidden line after the prose:
\
&#x20; \<plan_thread>IMMEDIATE PLAN TARGET\</plan_thread>
\
&#x20; Name only the immediate pending target. If a SCENE TAG OUTPUT CONTRACT section is present, this line goes directly before the scene tag. Omit it for pure OOC answers, clarifications and requested summaries. A \<plan_thread> in history is a record, not a new order.
\
&#x20; \`\`\`
\
&#x20; \- \`system prompts/no-plan.md\`:
\
&#x20; \`\`\`
\
&#x20; \# LONG-TERM PLAN
\

\
&#x20; No fixed author plan is active. Never output \<plan> or \<plan_thread>.
\
&#x20; \`\`\`
\
&#x20; \- \`system prompts/scene-reminder.md\`:
\
&#x20; \`\`\`
\
&#x20; [Reply format reminder: after the prose, end a narrative reply with this hidden tag as the final line. Omit it only for a pure OOC answer.]
\
&#x20; \<scene>date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME, FULL NAME\</scene>
\
&#x20; \`\`\`
\
&#x20; \- \`system prompts/scene-reminder-plan.md\`:
\
&#x20; \`\`\`
\
&#x20; [Reply format reminder: after the prose, end a narrative reply with these two hidden lines, the scene tag last. Omit both only for a pure OOC answer.]
\
&#x20; \<plan_thread>IMMEDIATE PLAN TARGET\</plan_thread>
\
&#x20; \<scene>date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME, FULL NAME\</scene>
\
&#x20; \`\`\`
\
&#x20; \- Add all four to \`js/system-prompts.js\` \`files\` (\`planThread\`, \`noPlan\`, \`sceneReminder\`, \`sceneReminderPlan\`).
\
&#x20; \- Rewrite \`fixed-author-plan.md\` (text in C4, item 11). Delete \`empty-plan.md\` only if nothing else uses it (\`fixed-author-plan-writing.md\` does; it goes away with Plan B S2).
\
2\. \*\*\`planInjectionBlock(plan)\`\*\* in \`js/plan-parser.js\`: \`plan?.trim() ? renderPrompt(prompts.plan, { PLAN: plan }) : prompts.noPlan\`. (MAIN's two-argument version lives only inside \`legacy-context.js\`, C2.)
\
3\. \*\*Build the static system text once\*\* (replaces \`:37-38\`):
\
&#x20; \`\`\`js
\
&#x20; const planOn = Boolean(session.longTermPlan?.trim());
\
&#x20; const staticSystem = [narrator, adRule, CONTINUITY_RULE, planInjectionBlock(session.longTermPlan),
\
&#x20; planOn ? prompts.planThread : '', mem.scene ? SCENE_RULE(mem.protagonist) : ''].filter(Boolean).join('\n\n');
\
&#x20; const reminder = mem.scene ? (planOn ? prompts.sceneReminderPlan : prompts.sceneReminder) : '';
\
&#x20; \`\`\`
\
&#x20; With Plan B S2 landed, the \`separate\` branches at \`:19\`, \`:31-37\`, \`:58\`, \`:63-64\`, \`:78-81\` are gone. If S2 has not landed, keep them unchanged and do not apply the reminder when \`separate\`.
\
4\. \*\*Summary text\*\* (replaces \`:43-46\`): keep it as a string \`summaryText\` (same \`historical-summary.md\` render), not a message. Keep the \`needsReview\`/evidence checks (\`:40-41\`); they are memory-mode behaviour.
\
5\. \*\*Books\*\* (\`:112-134\`): push facts/events text into a \`bookTexts\` array instead of \`books\` messages. Characters/locations already go into \`memory\`.
\
6\. \*\*\`contentFor(m, { gap })\`\*\* (replaces \`:47-56\`):
\
&#x20; \`\`\`js
\
&#x20; let text = m.role === 'user' ? normalizeAd(m.content) : storyText(m.content); // storyText from story-text.js (0.1)
\
&#x20; ... unaccepted prefix (Plan B S1 removes it) ...
\
&#x20; if (m.role === 'assistant') text += (m.planThread && accepted ? '\n\<plan_thread>'+m.planThread+'\</plan_thread>' : '')
\
&#x20; \+ (mem.scene && m.scene && m.sceneMeta?.kind !== 'carried' && accepted ? '\n\<scene>'+m.scene+'\</scene>' : '');
\
&#x20; if (m.id !== latest?.id) text = stripOcc(text);
\
&#x20; if (gap && anchorIds.has(m.id) && m.id !== latest?.id) text = renderPrompt(prompts.openingExchange, { TURN: turns.turnById.get(m.id), CONTENT: text });
\
&#x20; return text;
\
&#x20; \`\`\`
\
&#x20; Drop messages whose \`contentFor\` is empty from \`raw\` up front (as MAIN does), except the latest user message and the indicator placeholder (C5).
\
7\. \*\*Gap marker (2.9) and gap condition.\*\* Compute from the current \`selected\` inside \`render()\`, so \`cost()\` always includes it:
\
&#x20; \`\`\`js
\
&#x20; const gapInfo = () => {
\
&#x20; const missing = raw\.filter(m => !selected.has(m.id) && !anchorIds.has(m.id));
\
&#x20; if (!missing.length) return null;
\
&#x20; const covered = Boolean(summaryText) && checkpoint > (anchors.at(-1)?.order ?? 0);
\
&#x20; const uncovered = missing.some(m => m.order > checkpoint);
\
&#x20; return '[' + (covered ? 'Earlier turns are represented by the summary.' : 'Earlier turns omitted.')
\
&#x20; \+ (uncovered && summaryText ? ' Later omitted turns are not covered by the summary.' : '') + ']';
\
&#x20; };
\
&#x20; \`\`\`
\
8\. \*\*\`render()\`\*\* (replaces \`:66-88\`):
\
&#x20; \`\`\`js
\
&#x20; const render = () => {
\
&#x20; const gap = gapInfo();
\
&#x20; const history = raw\.filter(m => selected.has(m.id)).map(m => ({ id:m.id, role:m.role, content:contentFor(m, { gap: Boolean(gap) }) }));
\
&#x20; if (gap) history.splice(history.filter(h => anchorIds.has(h.id) && h.id !== latest?.id).length, 0, { role:'system', content:gap });
\
&#x20; const userMemory = memory && mem.memoryBlock && mem.blockRole === 'user' && latest;
\
&#x20; if (memory && !userMemory) {
\
&#x20; const li = history.findIndex(h => h.id === latest?.id);
\
&#x20; let at = Math.min(Math.max(0, history.length - mem.blockDepth), li < 0 ? history.length : li);
\
&#x20; while (at < history.length && history[at].role !== 'user') at++; // 2.7: only before a user message
\
&#x20; history.splice(at, 0, { role:'system', content:memory });
\
&#x20; }
\
&#x20; if (latest) {
\
&#x20; const i = history.findIndex(h => h.id === latest.id);
\
&#x20; let c = history[i].content;
\
&#x20; if (userMemory) c = '\<memory>\n'+memory+'\n\</memory>\n\n'+c;
\
&#x20; if (contract && mem.replyContract === 'user') c += '\n\n'+contract;
\
&#x20; if (reminder) c += '\n\n'+reminder;
\
&#x20; history[i].content = c;
\
&#x20; if (contract && mem.replyContract === 'system') history.splice(i, 0, { role:'system', content:contract });
\
&#x20; }
\
&#x20; const system = [staticSystem, summaryText, ...bookTexts].filter(Boolean).join('\n\n');
\
&#x20; return [{ role:'system', content:system }, ...history].map(({ role, content }) => ({ role, content }));
\
&#x20; };
\
&#x20; \`\`\`
\
&#x20; The \`[Current user input]\` label is removed.
\
9\. \*\*Contract\*\* (\`:58\`): unchanged condition (\`mem.scene && replyContract !== 'off'\`). The text changes in C4.
\
10\. \*\*Limit\*\* (\`:16\`): \`const limit = requestInputLimit(settings)\` (from \`request-budget.js\`). Error texts at \`:90\` and \`:151\` stay as they are (memory mode only).
\
11\. \*\*Report blocks.\*\* Keep the keys the viewer uses. Add \`{ key:'reminder', label:'Scene reminder', tokens }\` and \`{ key:'gap', label:'Omitted turns marker', tokens }\`. The \`system\` block now covers a-e only; \`summary\`, \`facts\`, \`events\` keep their own keys and token counts (counted on their text, framing counted once under \`system\`).
\
12\. \*\*Do not change\*\* the selection order (target window → memory → books → block window → older fill) here. C6 changes only how cost is computed.
\

\
\*\*Acceptance.\*\*
\
\- Memory mode, Scene on: the last characters of the last message equal the reminder file text, for \`replyContract\` = \`off\`, \`system\` and \`user\`.
\
\- \`replyContract:'user'\`: the final user message order is \`\<memory>\` → user text → contract → reminder. No \`[Current user input]\`.
\
\- Exactly one leading system message. The gap marker and memory (system role) are the only other system messages in history.
\
\- No system message sits directly between a user message and the assistant reply to it, for every \`blockDepth\` 0-10.
\
\- A short chat (no gap) has no opening label and no gap marker. A long chat has both, and the marker text matches MAIN's.
\
\- With Scene off the request has no reminder and no \`scene.md\`; with no plan it has \`no-plan.md\` and no \`plan-thread.md\`.
\
\- \`cost()\` of the final render equals \`usedTokens\` (the reminder and marker are counted).
\

\
\*\*Tests.\*\*
\
\- New \`tests/context-layout.mjs\`: one snapshot of the role sequence and section order for each of: Scene off/on × plan on/off × replyContract off/system/user × blockRole user/system.
\
\- 2.7: for depths 0-10 on an alternating history, assert no \`user, system, assistant\` triple.
\
\- Update \`tests/scene-resilience.mjs:43-47\` (contract now after the user text, not before) and \`tests/memory.mjs\` cases that expect the summary or books as separate system messages.
\
\- Update \`tests/regressions.mjs\` \~484/\~505 opening-label regex to \`/^\\[First exchange of the story[^\n]\*\\]\n/\` and only where a gap exists.
\

\
\*\*Depends on:\*\* C2 (routing, request-budget, story-text). Plan B S1 (unaccepted label) and S2 (separate mode deleted) should land first; if not, see step 3. Plan B S9 step 3 is done here.
\

\
\---
\

\
\## C4. Prompt text edits
\

\
\*\*Findings covered:\*\* 2.5 and §2a items 1-13.
\

\
\*\*Problem.\*\* The prompt files contradict each other and the new layout: two word ranges, a "required" plan_thread even when no plan is active, \`TIME\` vs \`TIME OF DAY\`, a "latest scene snapshot" that does not exist in tag-only mode, negative examples that plant the bad formats, fixture-specific sentences, and hard-coded "Nera", "dark fantasy" and "original game".
\

\
\*\*Root cause (verified).\*\* Line numbers are in the current files under \`system prompts/\`.
\

\
\*\*Fix.\*\* Apply each before → after exactly. Lines not listed stay as they are. Do C1 first so existing users receive the new narrator and other defaults.
\

\
\*\*Item 1 — word range (200-600, decided).\*\* Write \`200-600\` literally in all four places. Keep the 800-word cap.
\
\- \`narrator.md:59\`
\
&#x20; \- before: \`Aim for 200-600 words of visible narration and NPC dialogue per ordinary reply. Never exceed 800 words of visible text; hidden tags do not count. Use fewer than 200 words when the scene reaches a player decision sooner or needs only a brief response.\`
\
&#x20; \- after: \`Aim for 200-600 words of visible narration and NPC dialogue per ordinary reply. Never exceed 800 words of visible text; hidden tags do not count. Use fewer words when the scene reaches a player decision sooner or needs only a brief response.\`
\
\- \`narrator.md:86\`
\
&#x20; \- before: \` - Length fits: usually 200-600 words, never over 800.\`
\
&#x20; \- after: \` - Length fits: usually 200-600 words, never over 800.\` (already correct; no change needed)
\
\- \`writing-contract.md:7\` (only if Plan B S2 keeps the file; S2 deletes it with separate mode)
\
&#x20; \- before: \`Aim for 500–700 visible words for a developed scene, always below 800.\`
\
&#x20; \- after: \`Aim for 200-600 visible words for a developed scene, always below 800.\`
\
\- \`reply-contract.md:7\` — see item 9 (the new text uses \`200-600\`).
\
\- Check: \`grep -rn "WORD_RANGE\\|500–700\\|500-700" "system prompts"\` returns nothing, and \`grep -rln "200-600" "system prompts"\` lists the files of all four sites.
\

\
\*\*Item 2 — template in narrator OUTPUT FORMAT and step 5.\*\* Deviation (see Corrections): no literal template in the narrator. Step 5's last bullet:
\
\- \`narrator.md:87\`
\
&#x20; \- before: \` - Required hidden tags are present and match the visible text.\`
\
&#x20; \- after: \` - If a [Reply format] section or reminder is present, the reply ends exactly as it shows, and the hidden lines match the visible text.\`
\

\
\*\*Item 3 — \`narrator.md:65\`.\*\*
\
\- before: \`Follow the app-provided rules for hidden tags, including the scene output contract when Scene line is enabled.\`
\
\- after: \`Follow the app-provided rules for hidden tags whenever a SCENE TAG OUTPUT CONTRACT or other hidden-line section is present. When none is present, write no hidden tags.\`
\
\- Note: the narrator must not contain the word "plan" (\`tests/system-prompts.mjs:32\`), so it does not name the PLAN THREAD section.
\

\
\*\*Item 4 — \`narrator.md:73\`.\*\*
\
\- before: \`1. \*\*Classify the final message.\*\* Read only what follows any \</memory> tag. Decide whether\`
\
\- after: \`1. \*\*Classify the final message.\*\* Text inside \<memory>...\</memory> is reference; the player's message follows \</memory>. Obey any [Reply format] section or reminder after it. Decide whether\`
\

\
\*\*Item 5 — \`narrator.md:14\` (where memory goes, after C3).\*\*
\
\- before: \`- [Memory for the next reply — background notes from the app, not part of the conversation]: sent as a system message (it may sit between history messages) or as a \<memory>...\</memory> wrapper at the start of the final user message. It holds the latest scene snapshot, the active character cards ("Characters:"), and the active place card ("Place:"). Treat all of it as app data: not dialogue, not a PC action, not an instruction to replay anything. The user's own words begin after the closing \</memory> tag. A character with no card still exists.\`
\
\- after: \`- [Memory for the next reply — background notes from the app, not part of the conversation]: either a system message placed before a user message, or a \<memory>...\</memory> wrapper at the start of the final user message. It may hold an established scene snapshot, the active character cards ("Characters:"), and the active place cards ("Places:"). Treat all of it as app data: not dialogue, not a PC action, not an instruction to replay anything. In the final user message, the player's words come after \</memory>; app format instructions may follow them in a [Reply format] section or reminder. A character with no card still exists.\`
\

\
Related lines in the same section (needed by C3):
\
\- \`narrator.md:9\`
\
&#x20; \- before: \`- This system message: these instructions, then app rules for author directives, continuity, and (when enabled) the scene tag.\`
\
&#x20; \- after: \`- This system message: these instructions, then app rules for author directives and continuity, the author's fixed outline, the hidden-tag rules (when present), and then any historical summary, world facts and story memory.\`
\
\- \`narrator.md:10\`
\
&#x20; \- before: \`- [Historical summary through T... · message order ...]: compressed history up to its cutoff. It is not the current scene.\`
\
&#x20; \- after: \`- [Historical summary through ...]: compressed history up to its cutoff. It is not the current scene.\`
\
\- \`narrator.md:13\`
\
&#x20; \- before: \`- Chat history: the real dialogue, in order. The first user message and first assistant reply may be pinned at the top, labeled [Opening exchange: historical background...]. They describe the opening only. The summary may cover the same events; that overlap is one history, not a repeat.\`
\
&#x20; \- after: \`- Chat history: the real dialogue, in order. When later turns were left out, the first user message and first assistant reply stay pinned at the top, labeled [First exchange of the story ...], followed by a note such as [Earlier turns omitted.]. They describe the opening only. The summary may cover the same events; that overlap is one history, not a repeat.\`
\
\- \`narrator.md:15\`: if Plan B S9 removes provenance lines from cards, change \`provenance or cutoff metadata, and dated, turn-stamped update bullets\` → \`and dated, turn-stamped update bullets\`. Otherwise leave it.
\

\
\*\*Item 6 — \`narrator.md:19\`.\*\*
\
\- before: \`The app tracks no stats, inventory, or quest values. The scene tag is its only structured state.\`
\
\- after: \`The app tracks no stats, inventory, or quest values. The scene tag is the only state you output.\`
\

\
\*\*Item 7 — \`narrator.md:71\` (OOC and tags).\*\*
\
\- before: \`If the final message is an OOC question or needs a clarification, do step 1, then go straight to step 5.\`
\
\- after: \`If the final message is an OOC question or needs a clarification, do step 1, then go straight to step 5, and write no hidden tags.\`
\

\
\*\*\`narrator.md:75\`\*\* (snapshot that may not exist; part of 2.5):
\
\- before: \`2. \*\*Rebuild the current state.\*\* Start from the latest scene snapshot, then apply the recent chat on top of it. When chat conflicts with a snapshot, card or summary, the chat wins.\`
\
\- after: \`2. \*\*Rebuild the current state.\*\* Start from the most recent scene record (the memory block's scene snapshot, or the last \<scene> tag in history), then apply the later chat on top of it. When chat conflicts with a scene record, card or summary, the chat wins.\`
\

\
\*\*Item 8 — delete negative examples.\*\*
\
\- \`scene.md:19\`
\
&#x20; \- before: \`Put scene state only in the final hidden tag. Do not write a visible [Scene: ...] header, a prose "Date: ... Location: ... Active event: ... Present: ..." report, or app input labels in the narration. Visible narration comes first; hidden tags alone are not a reply.\`
\
&#x20; \- after: \`Put scene state only in the final hidden tag, written exactly as the structure above. Visible narration comes first; hidden tags alone are not a reply.\`
\
\- \`reply-contract.md:10\` negatives: removed in the item 9/10 rewrite.
\

\
\*\*Item 9 + 10 — rewrite \`reply-contract.md\` (whole file).\*\*
\
\- before: the current 12 lines.
\
\- after:
\
&#x20; \`\`\`
\
&#x20; [Reply format — current reply contract]
\

\
&#x20; Narrate in second person, present tense. Only the user writes {{PROTAGONIST}}'s voluntary actions, speech, decisions and inner thoughts. Never put words in the player's mouth, even a single name. Show NPC actions and external observations; end on an open beat before the player's choice. Do not append a menu or "What do you do?".
\

\
&#x20; {{PLAN_STATUS}}
\

\
&#x20; For narrative turns, aim for 200-600 visible words and stay below 800. Order: prose, then the \<plan_thread> line only if the plan status above says a plan is active, then exactly one scene tag as the final line:
\
&#x20; \<scene>date: DATE · time: TIME OF DAY · place: PLACE · present: FULL NAME, FULL NAME\</scene>
\

\
&#x20; Use these exact lowercase labels and separators. Use unknown for any date or time of day not established in the story or the prior scene. Do not invent a clock value to fill the tag. Take place and the physically present named characters from the end of the visible events.
\

\
&#x20; For a pure OOC question, clarification or requested summary, answer briefly without advancing events and without either hidden line. Narrative author directives still require them. Check player agency, unknown values, word count and the final lines before ending the reply.
\
&#x20; \`\`\`
\
\- \`js/reply-contract.js\` \`PLAN_STATUS\` strings (\~4):
\
&#x20; \- active, before: \`The fixed author plan IS ACTIVE. Its future and pending items remain pending until established events or the user resolve them. Include one short \<plan_thread> naming the immediate pending target; never output or revise \<plan>.\`
\
&#x20; \- active, after: \`The fixed author plan IS ACTIVE. Its future and pending items remain pending until established events or the user resolve them. Write one short \<plan_thread> naming the immediate pending target; never output or revise \<plan>.\`
\
&#x20; \- inactive, before: \`No fixed author plan is active. Omit \<plan_thread>.\`
\
&#x20; \- inactive, after: \`No fixed author plan is active. Do not write \<plan_thread>.\`
\

\
Also \`scene.md\`:
\
\- \`scene.md:3\`
\
&#x20; \- before: \`…ends with exactly one hidden scene tag on its own line, after visible narration and any plan thread required by the fixed-plan rules.\`
\
&#x20; \- after: \`…ends with exactly one hidden scene tag on its own final line, after visible narration and after the \<plan_thread> line when a PLAN THREAD section is present.\`
\
\- \`scene.md:17\`
\
&#x20; \- before: \`Apply the shared continuity rules to the latest scene snapshot and subsequent confirmed events;\`
\
&#x20; \- after: \`Apply the shared continuity rules to the most recent scene record and the confirmed events after it;\`
\

\
\*\*Item 11 — \`fixed-author-plan.md\` (whole file).\*\* Used only when a plan is set (C3 step 2); the plan_thread rule moves to \`plan-thread.md\`.
\
\- before: the current 10 lines.
\
\- after:
\
&#x20; \`\`\`
\
&#x20; \# LONG-TERM PLAN
\

\
&#x20; The plan below is the fixed, authoritative outline. It stays active when history is trimmed. It offers opportunities, not predetermined results or completed events. Pursue it through believable circumstances and NPC behavior, without controlling the PC or reversing the PC's choices. Parts of the plan that describe summaries, trackers or event IDs are notes for the app, not output.
\

\
&#x20; Never output \<plan>. You cannot revise the plan; only the user can.
\

\
&#x20; Current long-term plan (fixed author instructions):
\
&#x20; BEGIN FIXED AUTHOR PLAN — future opportunities and pending items
\
&#x20; {{PLAN}}
\
&#x20; END FIXED AUTHOR PLAN
\
&#x20; \`\`\`
\
\- Update \`tests/system-prompts.mjs:34\` (\`/Omit it for pure OOC/\` now lives in \`prompts.planThread\`).
\

\
\*\*Item 12 — \`opening-exchange.md\`.\*\* Used only when a gap exists (C3 step 6).
\
\- before: \`[Opening exchange: historical background at T{{TURN}}; not current conditions]\`
\
\- after: \`[First exchange of the story (T{{TURN}}); not current conditions]\`
\
\- Line 2 \`{{CONTENT}}\` unchanged.
\

\
\*\*Item 13 — name, genre, source material.\*\*
\
\- \`narrator.md:3\`
\
&#x20; \- before: \`You are the narrator and game master of a dark fantasy roleplay. You control the world and every NPC. The user alone controls Nera, the player character (PC).\`
\
&#x20; \- after: \`You are the narrator and game master of an interactive roleplay story. You control the world and every NPC. The user alone controls the player character (PC).\`
\
\- \`narrator.md:55\`
\
&#x20; \- before: \`Write dark fantasy with concrete stakes, fair consequences, and room for ordinary life.\`
\
&#x20; \- after: \`Write with concrete stakes, fair consequences, and room for ordinary life, in the genre and tone the story has established.\`
\
\- \`narrator.md:37\`
\
&#x20; \- before: \`Route memories from the original game are possibilities, not completed events or guaranteed futures.\`
\
&#x20; \- after: \`Knowledge of any source material the story draws on is a possibility, not a completed event or a guaranteed future.\`
\
\- \`narrator.md\` — every other "Nera": replace \`Nera's\` with \`the PC's\` and \`Nera\` with \`the PC\` on lines 23 (×2), 25, 33, 37, 47, 57 (×2), 73, 79 (×2), 82. Fix capitalisation at sentence start ("The PC"). Check line 23: \`A personality card does not authorize acting for the PC.\`
\
\- \`continuity.md:11\`
\
&#x20; \- before: \`Your own hypotheses, repeated assumptions, and familiarity with the original game are not evidence.\`
\
&#x20; \- after: \`Your own hypotheses, repeated assumptions, and familiarity with any source material are not evidence.\`
\
\- \`continuity.md:9\`
\
&#x20; \- before: \`3. Summary, timeline, cards, and scene snapshot, which are true through their cutoffs.\`
\
&#x20; \- after: \`3. Summary, timeline, cards, and scene records, which are true through their cutoffs.\`
\
\- \`author-direction.md:7\`
\
&#x20; \- before: \`If it states Nera's own action, that is the user's choice;\`
\
&#x20; \- after: \`If it states the PC's own action, that is the user's choice;\`
\
\- \`system prompts/README.md:7\`: change "dark fantasy narration, Nera's player control" to "genre-neutral narration, player control". Add the four new files from C3 to its list.
\

\
\*\*Code and tests that pin old text (update in the same commit):\*\*
\
\- \`tests/regressions.mjs:248\` \`/dark fantasy roleplay/\` → \`/interactive roleplay story/\`.
\
\- \`tests/memory.mjs:244\` \`/acting for Nera/\` → \`/acting for the PC/\`.
\
\- \`tests/system-prompts.mjs:32\` stays: none of the new narrator texts above contains "plan". Re-run it after every narrator edit.
\
\- \`js/memory-context.js:31-36\` separate-mode \`.replace()\` strings (C-N5): deleted by Plan B S2. If S2 is not in, update them to the new sentences in items 1, 3, 5 (\`:9\`), 6 and 2.
\
\- Append the outgoing default hashes (C1 step 4) for \`narratorSystemPrompt\` in the same commit.
\

\
\*\*Acceptance.\*\*
\
\- \`grep -rn "Nera\\|dark fantasy\\|original game" "system prompts"\` returns only \`lorebook-conversion-\*.md\` (app name "Nera Chat").
\
\- \`grep -rn "latest scene snapshot\\|\\[Scene:\\|scene_state\\|Waking earlier\\|outside the room\\|first-person background" "system prompts"\` returns nothing.
\
\- \`TIME OF DAY\` is the only time placeholder (\`grep -rn "time: TIME\b" "system prompts"\` returns nothing).
\
\- The word range appears identically at all four sites.
\
\- An existing user with a default narrator gets the new one (C1).
\

\
\*\*Tests.\*\* The tests listed above, plus a new test in \`tests/system-prompts.mjs\`: each of the four word-range sites contains the same range string, and no prompt contains \`WORD_RANGE\`, \`500-700\` or \`500–700\`.
\

\
\*\*Depends on:\*\* C1 (delivery), C3 (layout that the text describes), owner Q2 and Q3 (items 1 and 13).
\

\
\---
\

\
\## C5. Budget semantics, indicator and auto-summary
\

\
\*\*Findings covered:\*\* 2.10, 2.11, the indicator part of 2.18, C-N7.
\

\
\*\*Problem.\*\*
\
\- 2.11: the comment says the response is "reserved on top" of \`maxContextTokens\`, but the code subtracts it. MAIN treats \`maxContextTokens\` as the input limit, which C2 now uses in legacy mode. The two modes must mean the same thing.
\
\- 2.10: \`shouldAutoSummarize\` builds without \`loreEntries\`, so its token count ignores the lore that real requests carry.
\
\- 2.18: with no draft, the indicator attaches memory, contract and reminder to the last user message, which already has a reply.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/context-builder.js:3-5\` comment; \`js/memory-context.js:16\` \`limit = max − resp\`; \`computeContextUsage\` (\~53-59) \`max = maxContextTokens\`, \`overThreshold = used + maxResponse >= threshold\`.
\
\- \`js/summarizer.js:155-158\` \`shouldAutoSummarize(session, settings, messages)\` calls \`computeContextUsage\` without opts; call site \`js/ui/chat-view\.js:1121\`.
\
\- \`js/summarizer.js:80\` and \`:83\` compute capacity and input limit as \`maxContextTokens − maxResponseTokens\`.
\
\- \`js/memory-prompts.js:15\`, \`:39\` use \`maxContextTokens − updateMaxTokens\`; \`:23\` says "Raise Max context tokens".
\
\- \`js/ui/settings-view\.js:352\` requires max context > max response; \`:422\` compares book budgets with \`.9\*(max − resp)\`.
\
\- \`index.html:218\` label "Max context tokens (total budget)".
\
\- \`js/memory-context.js:23\` adds a draft user message only when \`draftText\` is non-empty.
\

\
\*\*Fix.\*\*
\
1\. Input semantics everywhere (MAIN's): \`maxContextTokens\` = max input tokens; the response is separate; \`modelContextTokens\` (from 0.1) caps input + response.
\
&#x20; \- \`js/context-builder.js:3-5\` comment: "maxContextTokens is the input limit. maxResponseTokens is separate. When modelContextTokens is set, input is capped at modelContextTokens − maxResponseTokens (request-budget.js)."
\
&#x20; \- Memory mode limit: done in C3 step 10.
\
&#x20; \- \`computeContextUsage\` memory branch: \`max = requestInputLimit(settings)\`, \`threshold = max\*pct/100\`, \`overThreshold = usedTokens >= threshold\`; \`report.totals.max = requestInputLimit(settings)\`.
\
&#x20; \- \`js/summarizer.js:80\`: \`capacity = Math.floor(requestInputLimit(settings) − probe.usedTokens − summaryHeaderCost)\`. \`:83\`: \`inputLimit = requestInputLimit(requestSettings)\`.
\
&#x20; \- \`js/memory-prompts.js\`: \`const updateLimit = requestInputLimit({ ...settings, maxResponseTokens: mem.updateMaxTokens })\`; use it at \`:15\` and \`:39\`. \`:23\` text: "One turn is too long for a memory update. Raise Max input context tokens."
\
&#x20; \- \`js/ui/settings-view\.js:352\`: take MAIN's validation after the merge (0.1). \`:422\`: \`.9\*requestInputLimit(state.settings)\`.
\
&#x20; \- \`index.html:218\` label: \`Max input context tokens\` (MAIN's wording). Indicator text (\`chat-view\.js\` \~971): \`X input / max tokens\` (already MAIN's form; check after merge).
\
&#x20; \- Release note for the owner: with the default 120000 and response 8192, a request can now be 128192 tokens in total. Set "Model context tokens" to the provider's window if that matters.
\
2\. \`shouldAutoSummarize(session, settings, messages = null, opts = {})\` → \`computeContextUsage(session, settings, messages, { loreEntries: opts.loreEntries })\`. \`chat-view\.js:1121\`: pass \`{ loreEntries }\` (the same in-memory array the indicator uses at \`:957\`; no read).
\
3\. Indicator placeholder (2.18). \`computeContextUsage(..., opts)\` in memory mode, when \`!opts.draftText?.trim()\` and the last user/assistant message in \`opts.messages\` is an assistant message: build with \`opts.placeholderLatest = true\`. In \`buildMemoryContext\`, \`placeholderLatest\` pushes \`{ id:'\_\_memory_draft', order:last+1, role:'user', content:'' }\` (exempt from the empty filter, C3 step 6). Legacy mode keeps MAIN's behaviour (no placeholder).
\

\
\*\*Acceptance.\*\*
\
\- With the same settings, legacy and memory modes report the same \`max\` and the same threshold rule.
\
\- No code path computes \`maxContextTokens − maxResponseTokens\` any more (\`grep -rn "maxContextTokens \*- \*\\|maxContextTokens-" js\` returns nothing).
\
\- \`shouldAutoSummarize\` with lore entries returns true at a lower history size than without them.
\
\- With no draft, the indicator's memory block is attached to the placeholder, and the answered user message is unchanged.
\

\
\*\*Tests.\*\* \`computeContextUsage\` threshold test in both modes; \`shouldAutoSummarize\` with and without lore; indicator placeholder (last message assistant, no draft) → the final user message content is the memory + reminder only.
\

\
\*\*Depends on:\*\* C2, C3.
\

\
\---
\

\
\## C6. Cost performance and token cache
\

\
\*\*Findings covered:\*\* 2.13, 2.14.
\

\
\*\*Problem.\*\*
\
\- 2.13: every fit step re-renders and re-tokenises the whole request (O(n²)); the lint runs on every render (32-107 ms per build in Node with a stub tokenizer, far more with the real tokenizer).
\
\- 2.14: the token cache keeps up to 5000 full strings and clears completely when full.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/memory-context.js:89\` \`cost()\` = \`render()\` then \`count()\` on every message. Called at \`:90, :101, :111, :116, :123, :141, :148, :150\`.
\
\- \`contentFor\` (\`:47\`) calls \`isAcceptedTurn\` (lint) per message per render.
\
\- \`js/context-builder.js:35-43\` \`countSystemTokensCached\`: \`if (size >= 5000) clear()\`; caches even when the tokenizer is still the byte fallback.
\

\
\*\*Fix.\*\*
\
1\. Memoise per message: \`const contentCache = new Map()\` keyed \`id + '|' + (gap ? 1 : 0)\`; \`contentFor\` reads/writes it. Memoise \`isAcceptedTurn(m)\` per id for the build.
\
2\. Additive cost:
\
&#x20; \`\`\`js
\
&#x20; const msgCost = new Map(); // key -> tokens + FRAME
\
&#x20; async function costOf(m, gap) { const k = m.id+'|'+(gap?1:0); if (!msgCost.has(k)) msgCost.set(k, await count(contentFor(m,{gap})) + FRAME); return msgCost.get(k); }
\
&#x20; async function cost() {
\
&#x20; // fixed parts: system text, gap marker, memory (system or wrapper delta), contract, reminder, latest user message
\
&#x20; // + sum of costOf(m) for selected non-latest messages
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Count the system text and the final user message as whole strings (they change when books/memory change), each through the shared cache. Everything else adds per message. When the gap flag flips (first omitted message appears), recompute the anchor costs once.
\
3\. Keep \`render()\` for the final \`apiMessages\` and one final \`count\` check (\`:150-151\`). In tests, assert the additive \`cost()\` equals the full count of the final render.
\
4\. Token cache (2.14), \`js/context-builder.js\`: LRU of 1000 entries, evict the oldest on insert (\`Map\` keeps insertion order; on hit, delete and re-set). Do not store counts when \`!tokenizerReady()\` (MAIN's rule, comes with 0.1). \`js/legacy-context.js\` keeps MAIN's own cache unchanged (parity).
\

\
\*\*Acceptance.\*\*
\
\- \`count()\` is called at most once per distinct message text per build (spy in test), and \`render()\` at most 10 times per build.
\
\- Build time on the 200-message fixture drops by at least 5× in Node with the stub tokenizer.
\
\- Final \`usedTokens\` is unchanged against C3's output on all \`context-layout.mjs\` snapshots.
\
\- The cache never holds more than 1000 entries and never empties all at once.
\

\
\*\*Tests.\*\* Spy test on \`count\`; equality of additive cost and full count; LRU eviction order; no caching while \`tokenizerReady()\` is false.
\

\
\*\*Depends on:\*\* C3.
\

\
\---
\

\
\## C7. Lore render and selection
\

\
\*\*Findings covered:\*\* 2.16, 2.17.
\

\
\*\*Problem.\*\*
\
\- 2.16: \`renderEventsBlock\` crashes when a timeline entry has no \`sections.text\`; the "Place:" label is singular but can hold two places; facts are fitted in list order, not by relevance.
\
\- 2.17: the first word of every character name is indexed as a term, so "Lord", "Sir" or a shared first name cause false mentions; the protagonist's card uses one of the \`maxCards\` slots.
\

\
\*\*Root cause (verified).\*\* \`js/lore-select.js\`:
\
\- \`renderEventsBlock\` \~124-132 reads \`timeline.entry.sections.text.text\` and \`.lines\` without \`?.\`.
\
\- \`renderMemoryBlock\` \~139 pushes \`'Place:'\`.
\
\- \`selectEntries\` \~56: \`if (book === 'facts') for (const e of list) add(e.id,'always')\` (list order; \`fitBook\` then cuts the tail).
\
\- \`buildLoreIndex\` \~11: \`terms.push(normalizeName(e.name).split(' ')[0])\` for every character, case-insensitive match later.
\
\- \`selectEntries\` \~63-66: the protagonist comes in via \`resolved.characters\` ('in scene') and counts toward \`cap = always + maxCards\`.
\

\
\*\*Fix.\*\*
\
1\. \`renderEventsBlock\`: \`const t = timeline.entry.sections.text ?? { text:'', lines:[] }\` and use \`t.text\`, \`t.lines ?? []\`.
\
2\. \`renderMemoryBlock\`: \`out.push(locations.included?.length > 1 ? 'Places:' : 'Place:', …)\`. (C4 item 5 already says "place cards ("Places:")"; keep both labels described.)
\
3\. Facts order: sort before adding: \`alwaysLoad\` first, then entries whose name or alias is mentioned in the latest user text or the scene (use \`findMentions\`), then by most recent line \`at\`, newest first. Reason strings: \`'always'\`, \`'mentioned'\`, \`'recent'\`.
\
4\. First-name terms: add the first word only when (a) it has at least 3 letters, (b) it is not in \`STOPLIST\` and not a title (add \`lord, lady, sir, dame, king, queen, prince, princess, master, mistress, captain, father, mother, brother, sister\` to the stoplist), (c) no other character shares it. Mark it \`{ firstName:true }\` and match it case-sensitively against the original text with a capital first letter.
\
5\. Protagonist: when \`mem.protagonist\` resolves to a card (\`exact(mem.protagonist)\`), add it with reason \`'protagonist'\` before the cap, and compute \`cap = always + (protagonistAdded ? 1 : 0) + maxCards\`.
\

\
\*\*Acceptance.\*\*
\
\- A timeline entry with no \`text\` section renders without throwing.
\
\- Two place cards render under "Places:".
\
\- With a facts budget that fits two of five facts, the always-load and mentioned facts are kept.
\
\- "Lord Kael" and "Lord Mira" do not cross-match on "Lord"; "mira" in lower case inside a word does not match "Mira".
\
\- With \`maxCards: 2\`, two non-protagonist cards load in addition to the protagonist.
\

\
\*\*Tests.\*\* One unit test per acceptance line in \`tests/memory.mjs\` (lore section).
\

\
\*\*Depends on:\*\* Plan B S9 (renderEntry option) and S12 (2.6, adds assistant-text scanning to \`selectEntries\`). Same functions: land after them or merge carefully.
\

\
\---
\

\
\## C8. Block window alignment
\

\
\*\*Findings covered:\*\* 2.15 (partly wrong; see Corrections).
\

\
\*\*Problem.\*\* If the turn at a block boundary was deleted, that block is never offered, so the window falls back to a smaller block or to newest-first, and the prefix cache misses more often than needed. There is no drift.
\

\
\*\*Root cause (verified).\*\* \`js/memory-context.js:136\`: \`starts = [...new Set(candidates.map(m => turn(m)))].filter(t => (t-1) % batchTurns === 0)\`. Only turn numbers that still exist can be starts. \`narratorTurn\` is stable (\`js/turns.js\` \`computeTurns\`), so the boundaries themselves do not move.
\

\
\*\*Fix.\*\*
\
\`\`\`js
\
const ts = candidates.map(m => turns.turnById.get(m.id)).filter(Number.isFinite);
\
const lo = Math.min(...ts), hi = Math.max(...ts), b = mem.batchTurns;
\
const thresholds = [];
\
for (let k = Math.floor((lo-1)/b); k\*b+1 <= hi; k++) thresholds.push(k\*b+1);
\
const seen = new Set();
\
for (const start of thresholds) { // oldest first = largest block, as today
\
&#x20; const aligned = candidates.filter(m => turns.turnById.get(m.id) >= start);
\
&#x20; const key = aligned.map(m => m.id).join(','); if (!aligned.length || seen.has(key)) continue; seen.add(key);
\
&#x20; ... same coverage check and cost check as :139-142 ...
\
}
\
\`\`\`
\

\
\*\*Acceptance.\*\* Delete the T11 messages in a 30-turn chat with batch 10: the window still starts at the T11 boundary (first remaining turn ≥ 11) when it fits. With no deletes, the chosen window is unchanged.
\

\
\*\*Tests.\*\* The deleted-boundary case and the no-delete case in \`tests/memory.mjs\`.
\

\
\*\*Depends on:\*\* C6 (cost function).
\

\
\---
\

\
\## C9. Known-names cap in the extraction prompt
\

\
\*\*Findings covered:\*\* 2.12.
\

\
\*\*Problem.\*\* The known-names list in the memory-update prompt lists every card and open thread. It grows without limit, and when it no longer fits, the update throws "Known names and turns exceed the memory update input budget", which stalls memory.
\

\
\*\*Root cause (verified).\*\* \`js/memory-prompts.js:32-36\` builds one line per book from all entries; \`:36\` throws if \`fixed\` exceeds \`inputBudget\`.
\

\
\*\*Fix.\*\*
\
1\. Order entries per book: first those in \`ids\` (mentioned in the transcript or the scene, already computed at \`:26-31\`), then the rest by most recent line \`at\`, newest first.
\
2\. Add names until the known-names text reaches \`Math.floor(inputBudget \* 0.15)\` tokens (count once per line, not per name: build the line, then trim from the end). Always keep every mentioned name, even past the cap.
\
3\. If names were left out, end the line with \`; … and N more\`.
\
4\. Keep the throw at \`:36\` only for the case where the transcript alone does not fit.
\

\
\*\*Acceptance.\*\* With 500 character cards, the prompt builds, the known-names part stays under 15% of the input budget (plus mentioned names), and every name in the transcript is listed.
\

\
\*\*Tests.\*\* 500-card fixture in \`tests/memory.mjs\`; mentioned names present; "and N more" suffix present.
\

\
\*\*Depends on:\*\* none. Coordinate with Part L (L3 changes the same extraction prompt) because it touches the extraction request.
\

\
\---
\

\
\## Coordination notes
\

\
\- \*\*Plan B S1\*\* removes the unaccepted label from \`contentFor\`; C3 step 6 assumes it.
\
\- \*\*Plan B S2\*\* deletes the separate extraction mode. C3 and C4 assume it; otherwise see C3 step 3 and C-N5.
\
\- \*\*Plan B S9\*\* removes card provenance and asks for a conditional opening label; C3 does the label, C4 item 5 (\`narrator.md:15\`) follows S9.
\
\- \*\*Plan B S12 (2.6)\*\* edits \`selectEntries\`; C7 edits the same function.
\
\- \*\*Plan E U7 (5.7)\*\* stores prompt overrides only when edited; C1 adds the legacy-hash list for all four prompt keys and must land before C4.
\
\- \*\*Part L:\*\* C-N3 (legacy summarizer request differs from MAIN: \`CONTINUITY_RULE\` appended at \`summarizer.js:88\`, accepted-turn gate at \`:67\`), and C9 touches the extraction request.
\
\- \*\*0.1 merge owner:\*\* C2 needs \`request-budget.js\`, \`story-text.js\`, \`modelContextTokens\`, \`tokenizerReady\` from MAIN, and must not take MAIN's two-argument \`planInjectionBlock\` into \`plan-parser.js\` (C-N8).
\

\

\
\---
\

\
\# Part L — Memory updater, lore, summary (L1–L9)
\

\
Project root: \`Nera_chat-feature-story-memory/Nera_chat-feature-story-memory\` (all paths below are relative to it).
\
Line numbers are approximate (\`\~\`) and refer to the current feature branch.
\
Run tests with \`node --experimental-vm-modules --test tests/\*.mjs\`. Today 147 pass.
\

\
\## Assumed owner defaults (apply these unless the owner says otherwise)
\

\
1\. \*\*The automatic summary runs AFTER narration.\*\* It can never block the narrator call or make it fail.
\
2\. \*\*At most ONE summarizer chunk per automatic run.\*\* Leftover chunks are handled on later turns. Manual "Summarize" and "Full summarize" keep their multi-chunk behaviour.
\
3\. \*\*At most 2 LLM calls per user turn, counting the narrator.\*\* Each turn gets the narrator call plus at most one maintenance call: scene recovery, summary, OR memory extraction. The priority order is defined in L4.
\
4\. \*\*Extraction output is accepted partially.\*\* Valid lines are kept and bad lines are dropped and reported. A run counts as a failure only when zero lines parse and the answer was not "NONE".
\

\
House rules that apply to every task:
\
\- \*\*No data migration.\*\* Old Firestore docs must keep working. New optional fields are allowed, and every reader must treat a missing field as the old behaviour.
\
\- \*\*Count Firestore reads.\*\* Each task states its read cost.
\
\- \*\*All memory toggles off means pre-memory behaviour.\*\* That covers autoUpdate, scene, the books and sceneFallback. The only deliberate difference is the one-chunk cap on the automatic summary (default 2). With the default \`summarizerChunkTokens\` of 250000, one chunk almost always covers the whole fold anyway.
\

\
\## Verdict on the findings
\

\
\| Finding | Verdict |
\
\|---|---|
\
\| 3.1 to 3.16, 3.18 to 3.20 | Confirmed in code. |
\
\| 3.3 (marked [S], suspected) | \*\*Confirmed.\*\* The pre-narration \`runSummarization\` sits inside try/finally with no catch (\`chat-view\.js \~1055-1063\`). A throw aborts the turn before the narrator call. |
\
\| 3.16 createdAt part | \*\*Probably fine.\*\* \`Timestamp.toJSON\` gives \`{seconds,nanoseconds}\` and \`clean()\` restores it. Add a test rather than a fix. The aliases/kind part is confirmed. |
\
\| 3.17 | \*\*Mostly wrong.\*\* \`sessions.js duplicateSession \~145-163\` writes chunks and lore first and the session doc last. On failure it calls \`deleteSession(id)\`, which removes the lore and loreBackups subcollections. Orphans only remain if the tab closes mid-copy or the cleanup itself fails. They are invisible and only cost storage. |
\

\
\*\*New problems found during verification:\*\*
\
\- \*\*L-N1.\*\* Editing the text of the active summary resets the summary checkpoint (\`messages.js \~276\`, \`current.id === activeSummaryMessageId\`). Only deleting it should reset.
\
\- \*\*L-N2.\*\* Stale errors thrown inside the commit transaction (\`assertSource\` in \`commitExtractionImpl \~104\`) fall into the updater's catch block and count toward the failure streak. Three in a row pause memory. The client-side stale path returns false without counting. The two paths disagree.
\
\- \*\*L-N3.\*\* Every summary stores \`evidence = prior.evidence ∪ evidenceFor(toFold)\` (\`summarizer.js \~139\`). This grows with the whole history and eventually exceeds \`MAX_SINGLE_MESSAGE_BYTES\` (850KB, at roughly 14k messages). After that, auto-summary fails forever.
\
\- \*\*L-N4.\*\* \`noteNeedsReview\` (\`continuity.js \~19\`) uses \`line.src ?? Infinity\`. Lines with no \`src\` (some reorganize output) are therefore flagged stale by ANY edit anywhere in the story.
\
\- \*\*L-N5.\*\* \`sortLines\` (\`lore-select.js \~5\`) sorts \`turn ?? 0\`. User lines with a null turn count as the oldest, so \`fitBook\` drops user canon FIRST when a book is over budget. This is worse than the ordering issue described in 3.18.
\
\- \*\*L-N6.\*\* \`replaceLinesImpl\` reads the whole lore collection (\`getDocsFromServer(root(sid,'lore'))\`) just to back up 1 to k cards.
\
\- \*\*L-N7.\*\* The memory status text says "first update runs after turn X" even though \`dueRange\` returns null while the pointer is null, so that update never runs (part of 3.14).
\
\- \*\*L-N8.\*\* After a regenerate, \`chat-view\.js \~1105\` patches the local session to \`paused:true, needsRebuild:true\`. Memory then stops on the client even after a server-side fix.
\
\- \*\*L-N9.\*\* The memory prompts are copied into user settings (\`settings.js \~16-17\`, \`memoryExtractionPrompt\` and \`memoryReorganizePrompt\`). Edits to the prompt files therefore never reach existing users (see 3.5).
\
\- \*\*L-N10.\*\* Old sessions are already stuck with \`memoryState.paused:true\` and \`lastError:'History changed; …Rebuild explicitly.'\`, written by the old \`changeMessage\`. They stay paused unless a read-time rule ignores this state (L1 step 6).
\

\
\---
\

\
\## Task order
\

\
\| Task | Covers | Why this position |
\
\|---|---|---|
\
\| L1 | 3.2, 3.8, L-N1, L-N8, L-N10 | This is the main cause of "memory pauses": any edit or accept pauses memory. |
\
\| L2 | 3.1, 3.9, 3.12 (commit part), L-N2 | This is the main cause of "memory stalls": updates are discarded for unrelated changes. |
\
\| L3 | 3.4, 3.5, 3.11, 3.12 (parse part), 3.19, 3.20, L-N9 | One bad line currently fails the whole batch. |
\
\| L4 | 3.3, plus the owner decisions on arbitration and the one-chunk summary | A summary failure blocks narration, and memory and summary starve each other. |
\
\| L5 | 3.10, L-N3 | Summaries are dropped wrongly and grow without bound. |
\
\| L6 | 3.6, 3.7, L-N6 | Reorganize does not replace lines and fails on T0. |
\
\| L7 | 3.13, 3.14, L-N7 | The user cannot see why nothing happens. |
\
\| L8 | 3.15, 3.16, 3.18, L-N4, L-N5 | Import/export and ordering correctness. |
\
\| L9 | 3.17 | Mostly wrong. One optional small guard. |
\

\
\---
\

\
\## L1. Edits stop pausing memory; summary checkpoint survives edits
\

\
\*\*Findings covered:\*\* 3.2, 3.8, L-N1, L-N8, L-N10.
\

\
\*\*Problem.\*\* Every call to \`changeMessage\` pauses memory and demands an explicit rebuild. That includes accepting a reply, editing a scene chip, regenerating the last reply, and deleting the last message. Content edits inside the summarised range throw the whole summary away instead of falling back to the previous one. Editing the summary's own text also throws it away.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/messages.js changeMessage \~261-290\`:
\
&#x20; \- \`\~272\`: \`revision: revisionOf(current)+1\` runs on every change, including acceptance and scene metadata.
\
&#x20; \- \`\~279-284\`: for any non-summary message it always pushes to \`memoryInvalidations\` and sets \`needsRebuild=true\`, \`paused=true\` and \`lastError='History changed…'\`. There is no check that the content changed and none against \`extractedThroughOrder\`.
\
&#x20; \- \`\~276\`: \`summaryReset\` is true for any change to a message with \`order <= breakpointOrder\`, or for any change to the active summary itself.
\
\- Callers that do not change content: \`acceptMessage \~316\` and \`updateMessageScene \~311\`.
\
\- \`js/memory-updater.js maybeStartAfterTurn \~26\` refuses to start when \`needsRebuild\` or \`paused\` is set. \`updateNow\` with retry clears only \`paused\`.
\
\- \`js/ui/chat-view\.js \~1105\`: after an overwrite, it forces local \`paused:true, needsRebuild:true\`.
\
\- \`js/continuity.js noteNeedsReview \~19\`: the invalidation clause flags every later line (cascade).
\

\
\*\*Fix.\*\*
\
1\. In \`changeMessage\`, compute whether the content changed:
\
&#x20; \`\`\`js
\
&#x20; const changed = await change(current);
\
&#x20; const deleted = !changed;
\
&#x20; const contentChanged = deleted || changed.content !== current.content;
\
&#x20; const replacement = changed ? { ...changed, revision: contentChanged ? revisionOf(current)+1 : revisionOf(current) } : null;
\
&#x20; \`\`\`
\
&#x20; \- Accept and scene edits keep the revision. \`acceptMessage\`'s \`expectedRevision\` check still guards against a concurrent content edit, because content edits still bump.
\
&#x20; \- \`historyRevision\` is still bumped on every change. L2 removes it from the staleness check.
\
2\. Invalidation rule. Write this only when every condition holds:
\
&#x20; \`\`\`js
\
&#x20; const pointer = data.memoryState?.extractedThroughOrder; // null = memory never started
\
&#x20; const affectsNotes = contentChanged && current.role !== 'summary' && pointer != null && order <= pointer;
\
&#x20; if (affectsNotes) {
\
&#x20; patch.memoryInvalidations = trimInvalidations([...(data.memoryInvalidations ?? []), { fromOrder: order, revision: historyRevision }]);
\
&#x20; patch['memoryState.needsRebuild'] = true;
\
&#x20; patch['memoryState.rebuildFromOrder'] = Math.min(data.memoryState?.rebuildFromOrder ?? Infinity, order);
\
&#x20; // do NOT touch paused or lastError
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Never write for acceptance or scene metadata, for summaries, or for messages after the pointer. Edits after the pointer are covered by the L2 range check.
\
&#x20; \- Legacy mode (memory never enabled, pointer null) never writes invalidations, which keeps the session doc identical to the pre-memory app.
\
3\. Content-edit log, used by L2. For every \`contentChanged\` on a non-summary message, also write:
\
&#x20; \`\`\`js
\
&#x20; const edits = [...(data.contentEdits ?? []), { order, revision: historyRevision }];
\
&#x20; patch.contentEdits = edits.slice(-20);
\
&#x20; if (edits.length > 20) patch.contentEditsFloor = Math.max(data.contentEditsFloor ?? 0, ...edits.slice(0, -20).map(e => e.revision));
\
&#x20; \`\`\`
\
&#x20; Write this only when \`pointer != null\`, so legacy sessions stay untouched.
\
4\. Trimming \`memoryInvalidations\`:
\
&#x20; \`\`\`js
\
&#x20; function trimInvalidations(list, cap = 50) {
\
&#x20; if (list.length <= cap) return list;
\
&#x20; const old = list.slice(0, list.length - cap + 1);
\
&#x20; return [{ fromOrder: Math.min(...old.map(i => i.fromOrder)), revision: Math.max(...old.map(i => i.revision)) }, ...list.slice(-(cap - 1))];
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Collapsing old entries into one is conservative: it may flag more lines, never fewer. Put the helper in \`continuity.js\` so it can be tested.
\
5\. Summary checkpoint (3.8 and L-N1). Add an option \`summaryFallback\` ({id, toOrder} or null) to \`changeMessage\` and its callers (\`editMessage\`, \`deleteMessage\`, \`overwriteMessage\`):
\
&#x20; \`\`\`js
\
&#x20; const isActiveSummary = current.id === data.activeSummaryMessageId;
\
&#x20; const hitsFold = current.role !== 'summary' && contentChanged && order <= (data.breakpointOrder ?? 0);
\
&#x20; const summaryReset = !!data.activeSummaryMessageId && (hitsFold || (isActiveSummary && deleted));
\
&#x20; if (summaryReset) {
\
&#x20; const fb = opts.summaryFallback;
\
&#x20; Object.assign(patch, fb && fb.toOrder < order && fb.id !== current.id
\
&#x20; ? { activeSummaryMessageId: fb.id, breakpointOrder: fb.toOrder }
\
&#x20; : { activeSummaryMessageId: null, breakpointOrder: 0 });
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Apply \`summaryReset\` BEFORE spreading \`sessionUpdate\` (as today), so explicit caller updates still win.
\
&#x20; \- Accept and scene edits no longer reset the summary (\`contentChanged\` is false).
\
&#x20; \- Editing the active summary's text keeps it active, which fixes L-N1.
\
&#x20; \- Client side (\`chat-view\.js\` edit \~846, delete \~725-734, regenerate): compute the fallback from \`historyMessages\`:
\
&#x20; \`\`\`js
\
&#x20; const summaryFallback = historyMessages.filter(m => m.role === 'summary' && m.id !== editedId && m.coveredRange?.toOrder != null && m.coveredRange.toOrder < editedOrder).at(-1) ?? null;
\
&#x20; // pass { id, toOrder: s.coveredRange.toOrder }
\
&#x20; \`\`\`
\
&#x20; \- Legacy summaries without \`coveredRange\` cannot serve as a fallback. In that case the reset happens as today.
\
6\. Unstick old sessions (L-N10, no migration). Add a read-time helper in \`memory-updater.js\`:
\
&#x20; \`\`\`js
\
&#x20; const effectivelyPaused = ms => !!ms?.paused && !(String(ms.lastError ?? '').startsWith('History changed') && (ms.failureStreak ?? 0) < 3);
\
&#x20; \`\`\`
\
&#x20; \- Use it in \`maybeStartAfterTurn\`, the chip and the status text instead of \`ms.paused\`.
\
&#x20; \- Remove \`needsRebuild\` from the start condition at \`\~26\`. Auto-update continues after an edit. Notes from edited turns drop out of context through the evidence check until the user re-extracts.
\
&#x20; \- The next successful commit writes \`paused:false\`, which cleans the doc naturally.
\
7\. "Re-extract from T{n}" (partial rebuild). Add \`rebuildFrom(sid, fromOrder)\` to \`memory-updater.js\`:
\
&#x20; \- \`markGeneratedForReview(sid, { fromOrder })\`: extend \`markGeneratedForReviewImpl\` (\`lore-store.js \~150\`) to flag only auto lines with \`src >= fromOrder\`. With no argument it flags everything, as today. It backs up all cards, as today.
\
&#x20; \- Set the pointer to the order of the last assistant whose turn ends before \`fromOrder\` (0 if none). Then remove invalidations with \`fromOrder >= fromOrder\`. Set \`rebuildFromOrder\` to the minimum of the remaining entries, and set \`needsRebuild = remaining.length > 0\`. Write all of this in ONE \`updateSession\` call.
\
&#x20; \- Run \`catchUp(sid)\`.
\
&#x20; \- The full \`rebuild()\` keeps its behaviour and also clears \`memoryInvalidations: []\` and \`rebuildFromOrder\`.
\
&#x20; \- UI: when \`needsRebuild\` is set, the memory chip and lorebook view show "History edited at T{turn of rebuildFromOrder}. Re-extract from there". The existing full-rebuild button stays.
\
8\. Remove the forced local pause at \`chat-view\.js \~1105\`. Copy \`memoryState\` from the transaction result instead. \`changeMessage\` should return \`memoryStatePatch\` so the client can mirror exactly what was written.
\
9\. Cascade (recommended default). In \`noteNeedsReview\`, drop the \`memoryInvalidations\` clause so a line is stale only when its own evidence changed (message missing or revision mismatch). If the owner wants to keep the cascade, at least change \`line.src ?? Infinity\` to \`line.src ?? -Infinity\` so null-src lines are not cascaded (L-N4). Apply the same choice in \`snapshotNeedsReview\`.
\

\
\*\*Acceptance.\*\*
\
\- Accept a reply, edit a scene chip, regenerate the last reply, or delete the last message. Memory is not paused, \`needsRebuild\` stays false, and no invalidation is written.
\
\- Edit the content of a message at order ≤ pointer. \`needsRebuild\` becomes true, \`paused\` stays false, auto-update keeps running on later turns, and the chip offers "Re-extract from T{n}".
\
\- With the memory pointer null (legacy), no edit writes \`memoryInvalidations\` or \`contentEdits\`.
\
\- Edit message X ≤ breakpointOrder when an older summary with \`toOrder < X\` exists. The older summary becomes active and \`breakpointOrder\` equals its \`toOrder\`.
\
\- Edit the active summary's text. It stays active with the new text.
\
\- An old doc with \`paused:true\` and \`lastError:'History changed…'\` resumes auto-update without any write.
\
\- Firestore reads: unchanged, still 1 session plus 1 chunk per edit.
\

\
\*\*Tests.\*\* \`tests/memory.mjs\` (vm harness) and \`tests/regressions.mjs\`.
\
\- \`changeMessage\` with an accept-only change: revision is unchanged, no invalidation, no pause.
\
\- Scene-only change: same as accept-only.
\
\- Content edit with order > pointer: no invalidation; \`contentEdits\` gets one entry.
\
\- Content edit with order ≤ pointer: one invalidation, \`needsRebuild\` true, \`paused\` untouched.
\
\- Pointer null: nothing memory-related written.
\
\- \`trimInvalidations\` with 60 entries returns 50 entries, and the first entry is {min fromOrder, max revision}.
\
\- \`contentEdits\` keeps the last 20 and sets \`contentEditsFloor\`.
\
\- Summary fallback: valid fallback, fallback with toOrder ≥ X (resets), legacy summary without coveredRange (resets), editing the active summary's text (no reset), deleting the active summary (fallback).
\
\- \`effectivelyPaused\` truth table.
\
\- \`rebuildFrom\` flags only lines with src ≥ fromOrder and leaves earlier invalidations.
\
\- Update the existing tests that expect pause or rebuild after an edit: \`memory.mjs \~167\` 'source edits discard updates…' and \`\~264\` 'stale notes…'.
\

\
\*\*Depends on:\*\* nothing. Do this first.
\

\
\---
\

\
\## L2. Staleness check only looks at the extracted range; commit rebases onto fresh lore
\

\
\*\*Findings covered:\*\* 3.1, 3.9, 3.12 (commit part), L-N2.
\

\
\*\*Problem.\*\*
\
\- An extraction result is thrown away if ANYTHING changed while the model was answering: a new message (every turn bumps \`historyRevision\`), any lore edit, the long-term plan, memory settings, or the summary pointer. In an active story the background update almost never survives.
\
\- Commit-time stale errors count as failures, so three of them pause memory.
\
\- Rebuilds create duplicate lines.
\
\- Alias ops are never written.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/memory-updater.js start \~75\`: \`expectedSource = requestSource(live.session)\`. \`requestSource\` (\`continuity.js\`) holds historyRevision, longTermPlan, memory JSON, loreRevision, activeSummaryMessageId and breakpointOrder.
\
\- \`\~83\`: any difference means \`return false\`. This is the client-side stale path and is not counted.
\
\- \`\~20\`: \`stamp\` includes \`editedAt\` and \`scene\`, so a scene edit or accept inside the range discards the result.
\
\- \`\~86\`: \`if (changes.skipped.length) throw\`, so any applyOps skip fails the batch.
\
\- \`js/lore-store.js commitExtractionImpl \~101-123\`: \`assertSource(sessionSnap.data(), range.expectedSource)\` with the same over-wide source. The throw is caught at \`memory-updater \~91-98\` and counted as a failure (L-N2). It throws if a target card is missing. It uses \`arrayUnion\` with no rebase or dedupe against fresh lines.
\
\- \`js/lore-lines.js applyOps \~101\`: dedupe skips lines where \`noteNeedsReview\` is true. After \`rebuild()\` flags every auto line, re-extraction appends a second copy of each (3.9).
\
\- \`applyOps\`: an alias op becomes a notes line "Known alias: X" and \`changes.aliases\` is never filled, so the alias code in commitExtraction is dead (3.12).
\

\
\*\*Fix.\*\*
\
1\. Stale-error classes. Add these to \`continuity.js\`:
\
&#x20; \`\`\`js
\
&#x20; export class StaleSourceError extends Error { constructor(m){ super(m); this.name='StaleSourceError'; } }
\
&#x20; export class SupersededError extends Error { constructor(m){ super(m); this.name='SupersededError'; } }
\
&#x20; \`\`\`
\
2\. Capture at start (\`start \~75\`), replacing \`expectedSource\`:
\
&#x20; \`\`\`js
\
&#x20; const ms = live.session.memoryState ?? {};
\
&#x20; const guard = {
\
&#x20; startPointer: ms.extractedThroughOrder ?? 0,
\
&#x20; startRevision: live.session.historyRevision ?? 0,
\
&#x20; fromOrder: range.messages[0].order,
\
&#x20; endOrder: range.endOrder,
\
&#x20; owner,
\
&#x20; };
\
&#x20; \`\`\`
\
3\. The new stale rule. A result is stale ONLY if one of these holds:
\
&#x20; \- (a) a message inside \`[guard.fromOrder, guard.endOrder]\` had its content changed or was deleted. This is a StaleSourceError.
\
&#x20; \- (b) \`memoryState.extractedThroughOrder !== guard.startPointer\`, meaning another run or a rebuild moved the pointer. This is a SupersededError.
\
&#x20; \- (c) the story is gone or the account changed. Return false silently, as today.
\

\
&#x20; Remove historyRevision, loreRevision, longTermPlan, the memory JSON, activeSummaryMessageId and breakpointOrder from the check. New messages after the range, lore edits, plan edits and summaries no longer discard work.
\
4\. Client check after \`waitIdle\` (\`\~83\`):
\
&#x20; \`\`\`js
\
&#x20; const stamp = msgs => JSON.stringify(msgs.map(m => ({ id:m.id, order:m.order, role:m.role, content:m.content })));
\
&#x20; if (!latest) return false;
\
&#x20; if ((latest.session.memoryState?.extractedThroughOrder ?? 0) !== guard.startPointer) throw new SupersededError('Another update already covered these turns.');
\
&#x20; if (!rangeUnchanged(range, latest.messages, snapshot)) throw new StaleSourceError('Messages in this range were edited during the update.');
\
&#x20; \`\`\`
\
&#x20; Drop \`editedAt\` and \`scene\` from \`stamp\`. Acceptance and scene edits are not content.
\
&#x20; Also re-check against the LATEST memory settings: if \`autoUpdate\` was turned off (automatic runs only) or a book was disabled, drop ops for disabled books. Report them as skipped (info), not as an error.
\
5\. Server check inside the \`commitExtractionImpl\` transaction, replacing \`assertSource\`:
\
&#x20; \`\`\`js
\
&#x20; const s = sessionSnap.data();
\
&#x20; if (!sessionSnap.exists()) throw new SupersededError('Story deleted.');
\
&#x20; if ((s.memoryState?.extractedThroughOrder ?? 0) !== guard.startPointer) throw new SupersededError('Another update already covered these turns.');
\
&#x20; if ((s.contentEditsFloor ?? 0) > guard.startRevision) throw new StaleSourceError('Too many edits during the update.');
\
&#x20; if ((s.contentEdits ?? []).some(e => e.revision > guard.startRevision && e.order >= guard.fromOrder && e.order <= guard.endOrder)) throw new StaleSourceError('Messages in this range were edited during the update.');
\
&#x20; \`\`\`
\
&#x20; \- Old docs have no \`contentEdits\` field, so the check passes. The client check in step 4 still covers them.
\
&#x20; \- Zero extra reads: the session doc is already read.
\
6\. Rebase inside the transaction, replacing the \`arrayUnion\` writes:
\
&#x20; \- Read every existing target card (\`appends\`, \`aliases\`, \`statusChanges\`). This is the same read count as today.
\
&#x20; \- A missing card skips its ops (info "card deleted"). Do not throw.
\
&#x20; \- For each card, start from the FRESH \`snap.data()\` and re-apply:
\
&#x20; \`\`\`js
\
&#x20; for (const a of appendsFor(id)) {
\
&#x20; const lines = data.sections[a.section]?.lines; if (!lines) { skipped.push(...); continue; }
\
&#x20; const key = normText(a.line.text);
\
&#x20; const twin = lines.find(l => normText(l.text) === key);
\
&#x20; if (twin && !twin.needsReview) continue; // already there
\
&#x20; if (twin && twin.needsReview && twin.by === 'auto') { // 3.9: refresh instead of duplicating
\
&#x20; Object.assign(twin, { needsReview: false, evidence: a.line.evidence, sourceRevision: a.line.sourceRevision, src: a.line.src, turn: a.line.turn });
\
&#x20; continue;
\
&#x20; }
\
&#x20; lines.push(a.line);
\
&#x20; }
\
&#x20; for (const al of aliasesFor(id)) if (!data.aliases?.some(x => normalizeName(x) === normalizeName(al.alias))) (data.aliases ??= []).push(al.alias);
\
&#x20; for (const st of statusFor(id)) { data.status = st.status; if (st.source) data.statusSource = st.source; }
\
&#x20; \`\`\`
\
&#x20; Here \`normText\` = lowercase, collapsed whitespace, trailing punctuation removed.
\
&#x20; \- Write the full arrays: \`tx.update(ref, { ['sections.'+key+'.lines']: data.sections[key].lines, aliases: data.aliases, status, statusSource, updatedAt })\`.
\
&#x20; \- Run \`guardSize(data)\` per card. If a card is too big, skip that card's new lines (info "card full; reorganize it") instead of failing the whole commit.
\
&#x20; \- Creates: plan them on the client against the latest entries right before commit, as today. Optional: give auto-created cards a deterministic id \`auto\_${book}\_${slug(normalizeName(name))}\` and \`tx.get\` it. If it exists (a concurrent create), append instead of creating. Cost: 1 read per create. Old random ids keep working.
\
&#x20; \- The session update stays as today: loreRevision+1, pointer=endOrder, lastUpdateAt, lastUpdateTurns, failureStreak 0, lastError null, paused false.
\
&#x20; \- Return the written cards. The client then calls \`runtime.patch\` with the rebased cards, not with \`changes.entries\`.
\
7\. Partial acceptance in \`start\`. Remove the throw at \`\~86\`. If \`changes\` contains zero appends, creates, aliases and status changes AND \`parsed.sawNone\` is false, throw a normal error (this counts as a failure). Otherwise commit and report the skipped lines in the success event. L3 removes the throw at \`\~79\`.
\
8\. Error classification in the catch block (\`\~91-98\`):
\
&#x20; \`\`\`js
\
&#x20; if (error instanceof StaleSourceError || error instanceof SupersededError) {
\
&#x20; emit({ sessionId:sid, status:'info', message:error.message, manual }); // no streak change
\
&#x20; return false; // the range is retried on the next turn
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Only model, format, network and size errors increment \`failureStreak\`. Do the same in \`catchUp\`: on a stale error, re-read and continue once, then stop.
\
9\. 3.9, the remaining duplicates. After \`rebuild()\` or \`rebuildFrom()\` finishes \`catchUp\`, count auto lines that are still \`needsReview\` in the rebuilt turn range. Show "N old notes were not reproduced by the rebuild. Remove them?" with one backup plus one batch write. Never delete silently.
\

\
\*\*Acceptance.\*\*
\
\- Start an update, send two more turns, edit the long-term plan, add a lore line by hand, and let a summary run. The update still commits, and the hand-added line is kept.
\
\- Edit the content of a message inside the range during the update. The result is discarded, \`failureStreak\` is unchanged, and the next turn retries the range.
\
\- Two runs over the same range (manual plus auto). The second gets SupersededError and the streak is unchanged.
\
\- Rebuild a story with 10 extracted turns. No line text appears twice in any section.
\
\- Alias ops land in \`entry.aliases\`, not in notes.
\
\- Firestore reads per commit: 1 session plus k target cards (plus c if deterministic create ids are used). Same as today.
\

\
\*\*Tests.\*\* \`tests/memory.mjs\` with \`updaterHarness \~145\`.
\
\- A new message after the range during flight: commit succeeds.
\
\- A lore edit during flight: commit succeeds and the manual line is kept.
\
\- Content edit inside the range (client path): no streak change.
\
\- Content edit inside the range (server path, via \`contentEdits\`): no streak change.
\
\- \`contentEditsFloor > startRevision\`: stale.
\
\- Pointer moved: superseded, no streak change.
\
\- Missing card: commit succeeds with info.
\
\- Oversized card: other cards still commit.
\
\- A needsReview twin is refreshed, not duplicated.
\
\- An alias is written to \`aliases\`.
\
\- Update \`\~167\` 'source edits discard updates…' to the new rule.
\

\
\*\*Depends on:\*\* L1 (writes \`contentEdits\` and stops writing pauses).
\

\
\---
\

\
\## L3. Lenient extraction grammar with partial acceptance
\

\
\*\*Findings covered:\*\* 3.4, 3.5, 3.11, 3.12 (parse part), 3.19, 3.20, L-N9.
\

\
\*\*Problem.\*\* Medium models produce small format variations: bullets, bold text, a missing \`T\`, plural tags, fullwidth pipes, \`\<think>\` blocks. One such line makes \`valid=false\` and the whole batch fails. Three batches in a row pause memory. The prompt itself does not show the \`T\` prefix that the parser requires.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/lore-lines.js parseMemoryLines \~20-74\`:
\
&#x20; \- Cleanup strips only \`- \`, \`\* \`, \`1.\`, \`1)\` and backticks.
\
&#x20; \- Only \`/^NONE$/i\` counts as none.
\
&#x20; \- The regex \`^(?:T(\d+)\s+)?\\[([a-z]+)\\]\s\*(.\*)$\` is lowercase-only with a singular tag.
\
&#x20; \- A missing or invalid turn is a skip ("a valid source turn is required").
\
&#x20; \- The separator must be \`|\`.
\
&#x20; \- \`[event]\` sets name='Timeline' and value = the whole remainder (3.19: the "Timeline | x" text stays inside the value).
\
&#x20; \- The name only gets quote-stripping (3.20).
\
&#x20; \- \`\~73\`: \`valid: skipped.length===0 && …\`.
\
\- \`sectionKey \~13\`: \`bond with X\` maps to \`bond\` and drops X (3.11).
\
\- \`applyOps\`:
\
&#x20; \- Aliases become a notes line (3.12).
\
&#x20; \- \`op.tag==='open'\` sets status on whatever entry matched, including the Timeline (3.19).
\
\- \`js/memory-updater.js \~79\`: \`if (!parsed.valid) throw\`.
\
\- \`system prompts/memory-extraction.md\` lines 3-9 list the forms without \`T\`. Only the example has \`T41\`. \`memory-extraction-output.md\` demands \`T\<number>\` (3.5).
\
\- \`js/settings.js \~16-17\` copies the prompts into settings, so file edits do not reach existing users (L-N9).
\

\
\*\*Fix.\*\*
\
1\. Line pre-processing, in order:
\
&#x20; \`\`\`js
\
&#x20; text = text.replace(/\<think>[\s\S]\*?<\\/think>/gi, '').replace(/<\\/?think>/gi, '');
\
&#x20; for (let raw of text.split(/\r?\n/)) {
\
&#x20; let s = raw\.trim().replace(/^(?:[-\*+•]|\d+[.)])\s+/, '').replace(/\`/g, '');
\
&#x20; s = s.replace(/\\\*\\\*|\_\_/g, '');
\
&#x20; s = s.replace(/[｜│∣]/g, '|');
\
&#x20; if (!s) continue;
\
&#x20; \`\`\`
\
2\. NONE detection: \`/^(none|no new notes?|nothing new)\\.?$/i\`.
\
&#x20; \- If NONE appears together with valid ops, ignore the NONE and report it as info.
\
&#x20; \- A line that is NONE alone still counts as \`sawNone\`.
\
3\. Turn prefix:
\
&#x20; \`\`\`js
\
&#x20; const TURN = /^(?:\\[?\s\*(?:T|Turn\s\*)(\d+)(?:\s\*[-–]\s\*(\d+))?\s\*\\]?\s\*:?\s\*)?/i;
\
&#x20; \`\`\`
\
&#x20; \- \`T2\`, \`[T2]\`, \`T2:\`, \`Turn 2\` all give turn 2.
\
&#x20; \- \`T2-3\` and \`T2–3\` give turn 3, with evidence covering turns 2 and 3.
\
&#x20; \- A missing T gives turn = \`range.toTurn\` and evidence = the whole range. Report it as info "turn missing; stamped T{toTurn}".
\
&#x20; \- A T outside \`[range.fromTurn, range.toTurn]\` is restamped to \`range.toTurn\` with info "turn out of range". Lines are never dropped for the turn alone.
\
4\. Tag: \`\\[\s\*([A-Za-z ]+?)\s\*\\]\`, lowercased. Synonym map:
\
&#x20; \`\`\`js
\
&#x20; const TAGS = { char:'char', character:'char', characters:'char', chars:'char', chr:'char',
\
&#x20; loc:'loc', location:'loc', locations:'loc', place:'loc', places:'loc',
\
&#x20; fact:'fact', facts:'fact', world:'fact',
\
&#x20; event:'event', events:'event',
\
&#x20; open:'open', thread:'open', threads:'open', opened:'open',
\
&#x20; closed:'closed', close:'closed', resolved:'closed' };
\
&#x20; \`\`\`
\
&#x20; An unknown tag is a skip for that line only.
\
5\. Body for char and loc: \`NAME | SECTION: note\`.
\
&#x20; \- Separator \`|\` first. If there is no pipe, try \`NAME: SECTION: note\` when SECTION is a known section label.
\
&#x20; \- The section separator may be \`:\`, \` - \` or \` — \`, but only when the left side is a known section label. Otherwise the whole text is a note.
\
&#x20; \- No section: the line goes to \`notes\`.
\
&#x20; \- The name gets \`\*\*\`, quotes and surrounding brackets stripped (3.20), then \`normalizeName\` for matching.
\
&#x20; \- Name longer than 60 characters, or a pronoun or stoplist word: skip that line.
\
&#x20; \- \`personality:\`: skip that line (personality is user-only).
\
&#x20; \- Value longer than 400 characters: skip that line.
\
6\. 3.11, bond and relation targets.
\
&#x20; \- \`bond with X: note\`, \`relationship with X: note\` and \`relation with X: note\` all parse a target X.
\
&#x20; \- If \`normalizeName(X) === normalizeName(protagonist)\`, the result is section \`bond\` with value \`note\`.
\
&#x20; \- Otherwise the result is section \`relations\` with value \`X: note\`.
\
&#x20; \- \`sectionKey\` must stop mapping \`bond with X\` to \`bond\` blindly. Move the target parse before \`sectionKey\`.
\
7\. 3.12, alias ops. The \`alias\` / \`aliases\` / \`also known as\` section produces \`{ op:'alias', name, alias }\`. \`applyOps\` pushes the alias into \`changes.aliases\` and \`entry.aliases\`, never into notes. An alias clash with another card skips that line only.
\
8\. Event and thread bodies (3.19).
\
&#x20; \- \`[event] Timeline | x\`, \`[event] | x\` and \`[event] x\` all give a timeline line "x".
\
&#x20; \- For \`[open]\` and \`[closed]\`: title = text before \`|\`, or before \`:\` / \` - \` when there is no pipe. If there is no separator, the whole text is the title when it is 60 characters or less; otherwise skip.
\
&#x20; \- \`[open] Timeline | x\` is treated as a timeline event "x" with no status change. \`applyOps\` must never set \`status\` on the Timeline card.
\
9\. Caps. Keep the first 80 ops. Report the rest as info "too many notes; first 80 kept".
\
10\. Book disabled: skip that line only.
\
11\. Return value:
\
&#x20; \`\`\`js
\
&#x20; return { ops, skipped, info, sawNone, valid: ops.length > 0 || (sawNone && skipped.length === 0) };
\
&#x20; \`\`\`
\
&#x20; In \`memory-updater.js \~79\`, throw only when \`!parsed.valid\`. That now means zero ops and no clean NONE. Optionally store \`memoryState.lastSkipped\` (the first 5 raw lines, each 120 characters or less) so the UI can show what was dropped.
\
12\. Reorganize mode keeps the stricter turn binding. Its changes are in L6.
\
13\. 3.5 prompt.
\
&#x20; \- Rewrite every listed form in \`system prompts/memory-extraction.md\` with a \`T\<turn>\` prefix, for example \`T12 [char] Name | appearance: …\`.
\
&#x20; \- Keep \`memory-extraction-output.md\` (code always appends it) as the single source of the format rules. Make it list all the forms with T. Existing users get the rules from code even though their copied prompt is old (L-N9).
\
&#x20; \- Optional: on load, if \`settings.memoryExtractionPrompt\` equals a known older default text (keep a hash list), replace it with the new default. This is not a migration: a customised prompt is never touched.
\

\
\*\*Fixture table.\*\* Assume range T10–T12, protagonist "Nera", all books on, an existing card "Kael", and no card for anything else. "skip" means the line is dropped and the rest of the batch is still accepted.
\

\
\| # | Input line | Result |
\
\|---|---|---|
\
\| 1 | \`T11 [char] Kael \\| appearance: scar on left cheek\` | char Kael, appearance "scar on left cheek", T11 |
\
\| 2 | \`- T11 [char] Kael \\| appearance: scar\` | same as #1 (bullet stripped) |
\
\| 3 | \`• T11 [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 4 | \`+ T11 [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 5 | \`1) T11 [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 6 | \`\*\*T11 [char] Kael \\| appearance: scar\*\*\` | same as #1 (bold stripped) |
\
\| 7 | \`T11 [char] \*\*Kael\*\* \\| appearance: scar\` | same as #1, name "Kael" (3.20) |
\
\| 8 | \`[T11] [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 9 | \`T11: [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 10 | \`Turn 11 [char] Kael \\| appearance: scar\` | same as #1 |
\
\| 11 | \`T10-11 [char] Kael \\| appearance: scar\` | T11, evidence turns 10–11 |
\
\| 12 | \`T10–11 [char] Kael \\| appearance: scar\` (en dash) | same as #11 |
\
\| 13 | \`[char] Kael \\| appearance: scar\` | T12 (range end), evidence = whole range, info "turn missing" |
\
\| 14 | \`T99 [char] Kael \\| appearance: scar\` | T12, info "turn out of range" |
\
\| 15 | \`T11 [Character] Kael \\| appearance: scar\` | same as #1 |
\
\| 16 | \`T11 [characters] Kael \\| appearance: scar\` | same as #1 |
\
\| 17 | \`T11 [chars] Kael \\| appearance: scar\` | same as #1 |
\
\| 18 | \`T11 [char] Kael ｜ appearance: scar\` (fullwidth pipe) | same as #1 |
\
\| 19 | \`T11 [char] Kael │ appearance: scar\` (box pipe) | same as #1 |
\
\| 20 | \`T11 [char] Kael \\| appearance - scar\` | same as #1 |
\
\| 21 | \`T11 [char] Kael \\| appearance — scar\` | same as #1 |
\
\| 22 | \`T11 [char] Kael \\| limps since the fight\` | char Kael, notes "limps since the fight" |
\
\| 23 | \`T11 [char] Kael: appearance: scar\` | same as #1 (no pipe, known section) |
\
\| 24 | \`T11 [char] Kael: limps badly\` | skip "missing separator" (unknown label, so the name is ambiguous) |
\
\| 25 | \`T11 [char] Kael \\| bond with Nera: trusts her\` | char Kael, section bond, "trusts her" (3.11) |
\
\| 26 | \`T11 [char] Kael \\| bond with Mira: owes her a debt\` | char Kael, section relations, "Mira: owes her a debt" (3.11) |
\
\| 27 | \`T11 [char] Kael \\| relation with Mira: rival\` | char Kael, relations, "Mira: rival" |
\
\| 28 | \`T11 [char] Kael \\| alias: The Grey Wolf\` | alias op, Kael.aliases += "The Grey Wolf" (3.12) |
\
\| 29 | \`T11 [char] Kael \\| alias: Mira\` (Mira is another card's name) | skip "alias clash" (that line only) |
\
\| 30 | \`T11 [char] Kael \\| personality: brooding\` | skip "personality is user-only" |
\
\| 31 | \`T11 [char] He \\| appearance: tall\` | skip "pronoun name" |
\
\| 32 | \`T11 [char] \<name longer than 60 chars> \\| notes: x\` | skip "name too long" |
\
\| 33 | \`T11 [char] Kael \\| notes: \<more than 400 chars>\` | skip "note too long" |
\
\| 34 | \`T11 [loc] Old Mill \\| layout: two floors\` | loc "Old Mill", layout |
\
\| 35 | \`T11 [places] Old Mill \\| two floors\` | loc "Old Mill", notes "two floors" |
\
\| 36 | \`T11 [fact] Magic needs blood\` | fact "Magic needs blood" |
\
\| 37 | \`T11 [facts] Magic needs blood\` | same as #36 |
\
\| 38 | \`T11 [event] Kael fought the guard\` | Timeline "Kael fought the guard" |
\
\| 39 | \`T11 [event] Timeline \\| Kael fought the guard\` | Timeline "Kael fought the guard" (3.19) |
\
\| 40 | \`T11 [event] \\| Kael fought the guard\` | Timeline "Kael fought the guard" (3.19) |
\
\| 41 | \`T11 [events] Kael fought the guard\` | same as #38 |
\
\| 42 | \`T11 [open] Missing ledger \\| who took it?\` | thread "Missing ledger", status open, note "who took it?" |
\
\| 43 | \`T11 [thread] Missing ledger: who took it?\` | same as #42 (no pipe, \`:\` splits) |
\
\| 44 | \`T11 [open] Missing ledger - who took it?\` | same as #42 |
\
\| 45 | \`T11 [open] Missing ledger\` | thread "Missing ledger", status open, no note |
\
\| 46 | \`T11 [open] \<more than 60 chars with no separator>\` | skip "thread title missing" |
\
\| 47 | \`T11 [open] Timeline \\| guard alarm raised\` | Timeline "guard alarm raised", NO status change (3.19) |
\
\| 48 | \`T12 [closed] Missing ledger \\| found in the mill\` | thread status closed, note added |
\
\| 49 | \`T12 [resolved] Missing ledger\` | thread status closed |
\
\| 50 | \`T11 [weather] rain\` | skip "unknown tag" |
\
\| 51 | \`T11 [loc] Old Mill \\| x\` with the locations book off | skip "book disabled" |
\
\| 52 | \`NONE\` | sawNone, valid, no ops |
\
\| 53 | \`NONE.\` / \`\*\*NONE\*\*\` / \`None\` / \`No new notes\` | same as #52 |
\
\| 54 | \`NONE\` plus valid line #1 | op #1 kept, NONE ignored (info) |
\
\| 55 | \`\<think>…\</think>\` followed by line #1 | op #1 |
\
\| 56 | \`Here are the notes:\` / \`### Characters\` | ignored (info), not a failure |
\
\| 57 | Line #1 plus \`invalid line\` | op #1 kept, one skip, valid |
\
\| 58 | Only \`invalid line\` | zero ops and no NONE, so invalid (counts as a failure) |
\
\| 59 | 85 valid lines | first 80 kept, info "too many" |
\

\
\*\*Acceptance.\*\*
\
\- Every row of the fixture table behaves as stated.
\
\- A batch with one bad line commits the good lines and reports the bad one.
\
\- No Timeline card ever gets a status.
\
\- No extra Firestore reads (pure parsing).
\

\
\*\*Tests.\*\* \`tests/memory.mjs\`:
\
\- A table-driven test over the fixture rows (input → expected op or skip reason).
\
\- Update \`\~253\` '[event] unstamped' valid:false: it becomes valid with info.
\
\- Update \`\~257\` 'invalid extraction batches leave notes and checkpoints unchanged':
\
&#x20; \- \`'T1 [event] good\ninvalid line'\` now commits one line.
\
&#x20; \- \`'T999…'\` is restamped.
\
&#x20; \- \`'NONE\nT1…'\` commits.
\
&#x20; \- Keep one case of only invalid lines, which still fails and leaves notes unchanged.
\

\
\*\*Depends on:\*\* L2 (the commit no longer throws on skips).
\

\
\---
\

\
\## L4. Maintenance arbitration after narration; one-chunk automatic summary
\

\
\*\*Findings covered:\*\* 3.3, plus owner decisions 1–3.
\

\
\*\*Problem.\*\*
\
\- The automatic summary runs BEFORE the narrator call when context overflows. If it throws, the user's turn fails.
\
\- After narration, memory extraction and summary block each other through \`maintenanceUsed\`, \`isRunning\` and \`shouldSkipAutoSummary\`, so one of them can starve indefinitely.
\
\- An automatic summary can make many LLM calls (one per chunk).
\

\
\*\*Root cause (verified).\*\* \`js/ui/chat-view\.js runAssistantTurn \~1046-1130\`:
\
\- \`\~1055-1063\`: pre-narration \`runSummarization\` when \`droppedCount>0\`. It sets \`maintenanceUsed=true\` before knowing whether a call happens. It has no catch and no isRunning gate.
\
\- \`\~1084\`: scene recovery requires \`!maintenanceUsed && !memoryUpdater.isRunning(sid)\`, so a background extraction from an EARLIER turn blocks recovery.
\
\- \`\~1120\`: \`maybeStartAfterTurn\` wins whenever memory is due.
\
\- \`\~1121\`: the summary runs only if memory did not start and is not running (\`shouldSkipAutoSummary\` in \`memory-updater.js\` has the same rule), so the summary starves while memory keeps being due.
\

\
\`js/summarizer.js runSummarization \~36-152\`:
\
\- \`\~67\`: skips everything if any assistant in the fold is not accepted.
\
\- \`\~94-136\`: one LLM call per chunk with no limit; chunks split at message granularity.
\

\
The pre-memory app (\`Nera_chat-main/js/ui/chat-view\.js \~1252-1266\`) summarised only after narration, so removing the pre-narration call restores legacy behaviour.
\

\
\*\*Fix.\*\*
\
1\. Delete the pre-narration summary block (\`\~1055-1063\`). The narrator runs on the built context even when \`droppedCount > 0\`, exactly as the pre-memory app did.
\
2\. Split the summarizer (\`js/summarizer.js\`):
\
&#x20; \`\`\`js
\
&#x20; export function planSummary(session, settings, messages, { maxChunks = Infinity, force = false } = {}) // pure, no LLM
\
&#x20; // -> { skip: 'not-needed'|'pending-reply'|'nothing-to-fold'|'running' } | { toFold, chunks, newBreakpointOrder, urgent }
\
&#x20; export async function runSummarization(session, settings, opts) // existing signature; gains opts.maxChunks
\
&#x20; \`\`\`
\
&#x20; \- The fold stops before the first non-accepted assistant's turn instead of skipping everything. If nothing is left to fold, the skip reason is \`pending-reply\`.
\
&#x20; \- Chunks split on turn boundaries: a user message plus the replies after it. A single turn larger than the chunk size forms its own chunk.
\
&#x20; \- With \`maxChunks: 1\`, the fold is cut to the first chunk. \`breakpointOrder\` and \`coveredRange.toOrder\` are set to the last order of that chunk. The next run continues from there.
\
&#x20; \- \`urgent = droppedCount > 0\`. Otherwise the plan exists only when \`shouldAutoSummarize\` is true (over the threshold).
\
3\. Add a pure picker in a new file \`js/maintenance.js\` so it can be tested:
\
&#x20; \`\`\`js
\
&#x20; export function pickMaintenance({ overwrite, needsRecovery, summary /\* plan or null \*/, memoryDue, memoryRunning, summaryRunning, memoryDeferrals }) {
\
&#x20; if (needsRecovery) return 'recovery'; // only possible in this turn
\
&#x20; if (overwrite) return null; // regenerate: recovery only
\
&#x20; const canMemory = memoryDue && !memoryRunning;
\
&#x20; const canSummary = !!summary && !summaryRunning;
\
&#x20; if (canSummary && summary.urgent && !(canMemory && memoryDeferrals >= 2)) return 'summary';
\
&#x20; if (canMemory) return 'memory';
\
&#x20; if (canSummary) return 'summary';
\
&#x20; return null;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; Priority: (1) scene recovery, (2) urgent summary, (3) memory extraction, (4) threshold summary. Fairness: if memory was due but deferred on 2 or more turns, it beats an urgent summary. Keep \`memoryDeferrals\` in a per-session in-memory \`Map\`. Increment it when memory was due but not picked, and reset it when memory starts.
\
4\. Rewrite the tail of \`runAssistantTurn\`:
\
&#x20; \- Stay busy after the narrator until the choice is made.
\
&#x20; \- \`needsRecovery\` = today's condition at \`\~1084\` without \`!memoryUpdater.isRunning(sid)\`. A call in flight from an earlier turn does not count against this turn's budget.
\
&#x20; \- \`memoryDue\` = \`!!memoryUpdater.dueRangeFor(sid)\`, a new export that wraps \`dueRange\` with the same conditions as \`maybeStartAfterTurn\` (autoUpdate on, not effectively paused).
\
&#x20; \- \`summary\` = \`settings.autoSummarizationEnabled ? planSummary(..., { maxChunks: 1 }) : null\`, skipped while summary backoff is active.
\
&#x20; \- Then:
\
&#x20; \`\`\`js
\
&#x20; const pick = pickMaintenance({...});
\
&#x20; if (pick === 'recovery') { /\* existing recovery code \*/ }
\
&#x20; else if (pick === 'memory') memoryUpdater.maybeStartAfterTurn(sid); // background, no busy
\
&#x20; else if (pick === 'summary') {
\
&#x20; try { applySummaryResult(await runSummarization(..., { maxChunks: 1, loreEntries })); }
\
&#x20; catch (e) { summaryBackoff.set(sid, 3); toast('Summary skipped: '+e.message); } // never fails the turn
\
&#x20; finally { ui.done(); }
\
&#x20; }
\
&#x20; setBusy(false);
\
&#x20; \`\`\`
\
&#x20; \- Set \`maintenanceUsed\` only when an LLM call actually started.
\
&#x20; \- Decrement \`summaryBackoff\` once per completed turn.
\
&#x20; \- Never start a second summary while one runs (module-level \`summaryRunning\` set) or a second extraction (\`memoryUpdater.isRunning\`).
\
&#x20; \- Keep the info note at \`\~1093\` ("scene not recovered; maintenance slot used") for the case where recovery was needed but not possible.
\
5\. Remove \`shouldSkipAutoSummary\` from \`memory-updater.js\` (its rule now lives in \`pickMaintenance\`). Update its imports.
\
6\. Manual "Summarize" and "Full summarize" (\`chat-view \~1181\`, \`\~1214\`) are outside the per-turn budget. They keep multi-chunk behaviour (\`maxChunks: Infinity\`) and stay gated on \`isRunning\`.
\
7\. Legacy check. With all memory toggles off: \`needsRecovery\` is false and \`memoryDue\` is false, so the only candidate is the threshold or urgent summary. That matches the pre-memory app, apart from the one-chunk cap.
\

\
\*\*Acceptance.\*\*
\
\- A summarizer error never prevents the narrator reply. The user sees a non-blocking toast, and auto-summary pauses for 3 turns.
\
\- Each turn makes at most 2 LLM calls (count the requests in the harness).
\
\- Memory due on every turn plus an urgent summary: the summary runs, then memory runs at the latest on the third turn.
\
\- An automatic summary makes exactly 1 request. \`breakpointOrder\` moves to the end of the chunk, which is a turn boundary.
\
\- A pending (unaccepted) last reply no longer blocks folding older turns.
\
\- Firestore reads: unchanged. The summary still does 1 \`addMessage\` transaction.
\

\
\*\*Tests.\*\*
\
\- New \`tests/maintenance.mjs\` (pure): the \`pickMaintenance\` truth table covering each priority, overwrite, both running, and the deferral flip at 2.
\
\- \`tests/regressions.mjs\`:
\
&#x20; \- \`\~536\` 'Summarizer bounds each request': the auto path makes 1 request; the manual path still makes more than 1.
\
&#x20; \- \`\~748\` 'chat turn ledger…': expect narrator + 1 maintenance; no pre-narration summary.
\
&#x20; \- \`\~787\` 'multi-call summary rejects source changes': keep it for the manual path only.
\
&#x20; \- \`\~820\` 'scene recovery … uses the maintenance slot': recovery runs even while an older extraction is in flight.
\
&#x20; \- New: a summarizer throw after narration still saves the reply.
\
\- \`tests/memory.mjs \~175\` 'ledger … skips auto-summary while due or running': replace with the fairness case.
\

\
\*\*Depends on:\*\* L5 is not required, but do L5 in the same release (it removes \`evidence\` from the summary message that this task writes).
\

\
\---
\

\
\## L5. Summary coverage as an order range; drop summary evidence
\

\
\*\*Findings covered:\*\* 3.10, L-N3.
\

\
\*\*Problem.\*\*
\
\- A summary is thrown out of the context when any message it covers has a different revision. Today every accept and scene edit bumps the revision, so valid summaries are dropped.
\
\- The evidence list grows with the whole history and will eventually exceed the single-message size limit.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/summarizer.js \~139\`: the summary gets \`coveredRange {fromOrder: prior.coveredRange?.fromOrder ?? 1, toOrder}\`, \`sourceRevision\`, and \`evidence = [...prior.evidence, ...evidenceFor(toFold)]\`.
\
\- \`js/memory-context.js \~41\`: the summary is dropped if any evidence id is missing or its revision differs, OR if any \`memoryInvalidations\` entry has \`revision > summary.sourceRevision && fromOrder <= coveredRange.toOrder\`.
\

\
\*\*Fix.\*\*
\
1\. \`summarizer.js\`: stop writing \`evidence\`. Keep \`coveredRange {fromOrder, toOrder}\`, \`sourceRevision\` and \`cutoffTurn\`. For the prior range, use \`prior.coveredRange?.fromOrder ?? 1\`. For a legacy prior without \`coveredRange\`, use \`fromOrder: 1\`.
\
2\. \`memory-context.js \~40-41\`: keep only the existence check and the \`breakpointOrder < upTo\` check:
\
&#x20; \`\`\`js
\
&#x20; let summary = session.activeSummaryMessageId && (session.breakpointOrder ?? 0) < upTo
\
&#x20; ? all.find(m => m.id === session.activeSummaryMessageId && !m.needsReview) : null;
\
&#x20; const checkpoint = summary ? (summary.coveredRange?.toOrder ?? session.breakpointOrder ?? 0) : 0;
\
&#x20; \`\`\`
\
&#x20; Delete the evidence clause and the \`memoryInvalidations\` clause. After L1, \`changeMessage\` keeps summary validity: any content change or delete at order ≤ breakpointOrder resets or rolls back the pointer in the same transaction.
\
3\. Old docs need no migration:
\
&#x20; \- Old summaries that have \`evidence\`: the field is ignored. Summaries wrongly dropped because of old accept or scene bumps become valid again.
\
&#x20; \- Old content edits inside a summary's range already reset \`activeSummaryMessageId\` at the time they happened (the old \`changeMessage\` did that), so no invalid summary can be active.
\
&#x20; \- Old summaries without \`coveredRange\` use \`session.breakpointOrder\`, as today.
\
4\. Optional cleanup: the "Edit summary" UI may strip \`evidence\` when it saves the summary (this shrinks old docs). It is not required.
\

\
\*\*Acceptance.\*\*
\
\- Accepting or scene-editing a covered message keeps the summary in context.
\
\- A content edit inside the covered range rolls back or resets the summary (from L1), and the context builder then shows the fallback or no summary.
\
\- A new summary message has no \`evidence\` field, and its size no longer grows with history length.
\
\- Reads: unchanged.
\

\
\*\*Tests.\*\* \`tests/memory.mjs\` or \`tests/regressions.mjs\`:
\
\- A context build with an old summary carrying stale evidence revisions still includes the summary.
\
\- A context build with a summary whose id is missing excludes it.
\
\- The summary written by \`runSummarization\` has no \`evidence\` and has a correct \`coveredRange\`.
\
\- Legacy summary without \`coveredRange\`: the checkpoint equals \`breakpointOrder\`.
\

\
\*\*Depends on:\*\* L1 (the rule that \`changeMessage\` keeps summaries valid).
\

\
\---
\

\
\## L6. Reorganize: real replace with backup; lenient turn binding
\

\
\*\*Findings covered:\*\* 3.6, 3.7, L-N6.
\

\
\*\*Problem.\*\*
\
\- "Reorganize" adds the model's rewritten lines but never removes the originals, so cards grow instead of shrinking.
\
\- Lines with no turn are sent as \`T0\` and then rejected on the way back.
\
\- Model output that merges lines under another turn fails the whole batch.
\
\- Save reads every lore card just to back up one.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/lore-store.js replaceLinesImpl \~124-139\`:
\
&#x20; \- \`getDocsFromServer(root(sid,'lore'))\` reads all cards (L-N6).
\
&#x20; \- Then \`fields = [...keep, ...newLines not in keep]\` with \`keep = data.sections[key].lines\`. This is additive by design, as the comment says.
\
\- \`js/memory-prompts.js buildReorganizeMessages \~54\` renders \`T${ln.turn ?? 0}\`.
\
\- \`js/lore-lines.js parseMemoryLines\`, reorganize branch: candidates come from an entry found by exact name only (no aliases), and the line must satisfy \`l.turn === turn\`. A null turn compared with 0 fails, giving 'invalid source turn'.
\
\- \`js/memory-reorganize.js runReorganizeBatch\`: \`!parsed.valid\` means throw.
\
\- \`js/ui/lorebook-view\.js reorganize \~298-372\` builds preview sections from untouched lines plus new lines, and shows counts as before → after.
\

\
\*\*Fix.\*\*
\
1\. The preview carries what was sent. In \`lorebook-view\.js reorganize\` and \`memory-reorganize.js\`, each preview gets:
\
&#x20; \- \`sent[key]\`: the ids and texts of lines sent to the model;
\
&#x20; \- \`snapshot[key]\`: all line ids in that section at preview time;
\
&#x20; \- \`sections[key]\`: the final non-user lines, i.e. untouched non-sent lines plus new lines (as today).
\
2\. Rewrite \`replaceLinesImpl\`:
\
&#x20; \`\`\`js
\
&#x20; async function replaceLinesImpl(sid, previews) {
\
&#x20; const cards = await Promise.all(previews.map(p => getDocFromServer(ref(sid, p.entry.id)))); // k reads, not the whole collection
\
&#x20; const backup = await writeBackup(sid, 'reorganize', label, cards.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() })));
\
&#x20; for (const p of previews) await runTransaction(db, async tx => {
\
&#x20; const snap = await tx.get(ref(sid, p.entry.id)); if (!snap.exists()) throw new Error('Card was deleted.');
\
&#x20; const data = snap.data(), fields = { updatedAt: serverTimestamp() };
\
&#x20; for (const [key, newLines] of Object.entries(p.sections)) {
\
&#x20; const current = data.sections[key]?.lines ?? [];
\
&#x20; const byId = new Map(current.map(l => [l.id, l]));
\
&#x20; for (const s of p.sent[key] ?? []) { const now = byId.get(s.id); if (!now || now\.text !== s.text) throw new Error('This card changed since the preview. Reorganize again.'); }
\
&#x20; const snapIds = new Set(p.snapshot[key] ?? []);
\
&#x20; const user = current.filter(l => l.by === 'user'); // user canon is never touched
\
&#x20; const fresh = current.filter(l => l.by !== 'user' && !snapIds.has(l.id)); // arrived after the preview, kept below
\
&#x20; const lines = [...user, ...newLines.filter(l => l.by !== 'user'), ...fresh];
\
&#x20; fields['sections.' + key + '.lines'] = lines; data.sections[key].lines = lines;
\
&#x20; }
\
&#x20; guardSize(data); tx.update(snap.ref, fields);
\
&#x20; });
\
&#x20; return backup;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Non-user snapshot lines that are missing from \`newLines\` are dropped. That is the replace. They remain in the backup and can be restored.
\
&#x20; \- Firestore reads: k cards (backup) + k cards (transactions) + the backup prune. Today it is N cards + k + prune.
\
&#x20; \- Optional: in \`writeBackupImpl\`, prune with \`getCountFromServer\` (1 read) and then fetch only the oldest overflow docs, instead of reading all backups.
\
3\. Turn binding in reorganize mode (3.7):
\
&#x20; \- The entry lookup resolves aliases: match on name or any alias, normalised.
\
&#x20; \- Turn resolution, in order:
\
&#x20; 1\. a candidate with \`(l.turn ?? 0) === T\`;
\
&#x20; 2\. the newest candidate with \`turn ≤ T\`;
\
&#x20; 3\. the newest candidate overall.
\

\
&#x20; The resulting line inherits \`turn\`, \`src\`, \`when\`, \`evidence\` and \`sourceRevision\` from the matched candidate, as \`runReorganizeBatch\` does today.
\
&#x20; \- A missing T is treated as no match, so case 3 applies.
\
&#x20; \- Partial acceptance: the batch is valid when it has at least one op. Show the skipped raw lines in the preview under "Not used".
\
4\. Data-loss guard in the preview: list sent lines that have no counterpart in the output (no new line inherited their id or src) as "Will be removed", each with a checkbox "Keep". Ticked lines go back into \`sections[key]\` unchanged.
\
5\. Counts: "before" = the current total of non-user lines in the section; "after" = \`newLines.length + fresh.length\`. User lines are shown separately as "kept (yours)".
\
6\. Update the "fresh notes arrived" message to match the behaviour: new notes are kept below the reorganized lines.
\

\
\*\*Acceptance.\*\*
\
\- Reorganize a card with 30 auto lines into 12. After save the card holds 12 auto lines plus all user lines, and the backup holds the 30.
\
\- Lines with a null turn round-trip.
\
\- A model line under a T that no candidate has still binds to the newest candidate.
\
\- An alias name in the output finds the card.
\
\- An edit to a sent line between preview and save produces the "Reorganize again" error, and nothing is written.
\
\- A new extraction during the preview: its lines survive the save.
\
\- Reads: 2k plus the prune, no full collection read.
\

\
\*\*Tests.\*\* \`tests/memory.mjs\`, updating the reorganize tests at \`\~182\` and \`\~296\`:
\
\- replace drops omitted sent lines;
\
\- user lines are kept;
\
\- fresh lines are kept;
\
\- a changed sent line throws;
\
\- T0 with a null turn binds;
\
\- an unknown T binds to the newest candidate;
\
\- an alias resolves;
\
\- a partial batch is valid;
\
\- the "Keep" checkbox restores a line.
\

\
\*\*Depends on:\*\* L3 (shared parser changes).
\

\
\---
\

\
\## L7. Explain why memory is idle; set the start pointer for imported and duplicated stories
\

\
\*\*Findings covered:\*\* 3.13, 3.14, L-N7.
\

\
\*\*Problem.\*\*
\
\- When \`dueRange\` returns null, nobody can tell why: pointer not set, waiting for more turns, or blocked by an unaccepted reply.
\
\- Imported or duplicated stories with autoUpdate already on never get a pointer, so memory never runs. The status text still promises an update after turn X.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/turns.js dueRange\` returns null on: a null pointer, a cut at the first non-accepted turn, or fewer than \`batchTurns\` eligible turns after the lag. No reason is returned.
\
\- \`js/ui/memory-settings-view\.js chooseMemoryStart \~80\` returns null when \`previous.autoUpdate\` was already true, so the pointer is never set for stories that arrive with autoUpdate on (\`import-export.js \~48\` imports \`memoryState\` from metadata; \`sessions.js \~142\` copies it).
\
\- The status text promises "first update runs after turn X" even when the pointer is null.
\

\
\*\*Fix.\*\*
\
1\. Add \`dueRangeStatus(messages, memoryState, mem, opts)\` to \`turns.js\`, and have \`dueRange\` call it:
\
&#x20; \`\`\`js
\
&#x20; // -> { range } | { reason: 'pointer-unset' } | { reason: 'pending', turn } | { reason: 'waiting', have, need, lag }
\
&#x20; \`\`\`
\
2\. Show the reason in the memory chip tooltip and the memory status line (\`chat-view updateMemoryChip \~106\`, \`memory-settings-view\`):
\
&#x20; \- "Memory start not set. Choose a start turn."
\
&#x20; \- "Waiting for you to accept the reply at T{turn}."
\
&#x20; \- "{have} of {need} turns ready (the last {lag} turns wait)."
\
3\. Pointer repair on story open. In \`reconcileStory\` (or the memory runtime's \`prepare\`), when \`mem.autoUpdate && memoryState?.extractedThroughOrder == null\`:
\
&#x20; \- if \`lastTurn <= lag\`, write \`memoryState.extractedThroughOrder = 0\` (1 write, 0 extra reads; the session is already loaded);
\
&#x20; \- otherwise the chip shows "Choose start" and opens \`chooseMemoryStart\` in forced mode, which no longer returns null just because autoUpdate was already on.
\
4\. Import (\`import-export.js \~48\`): if metadata turns autoUpdate on and the pointer is null:
\
&#x20; \- when lore was imported in the same file, set the pointer to the last assistant order ("start from now");
\
&#x20; \- otherwise set it to 0.
\
5\. Duplicate keeps today's \`min(pointer, lastAssistant)\`. A null pointer stays null and is handled by step 3.
\
6\. Status text: only promise "first update runs after turn X" when the pointer is set.
\

\
\*\*Acceptance.\*\*
\
\- An imported story with autoUpdate on and a null pointer runs memory after enough turns, or asks for a start once.
\
\- The chip always states a reason when idle.
\
\- No extra reads.
\

\
\*\*Tests.\*\*
\
\- \`tests/memory.mjs\`: \`dueRangeStatus\` returns each reason;
\
\- the pointer-repair rule (short story gets 0; long story gets the prompt);
\
\- import sets the pointer as described.
\

\
\*\*Depends on:\*\* none (can run in parallel with L3–L6).
\

\
\---
\

\
\## L8. Lore export escaping, v2 JSON import normalisation, user line ordering
\

\
\*\*Findings covered:\*\* 3.15, 3.16, 3.18, L-N4 (if not done in L1 step 9), L-N5.
\

\
\*\*Problem.\*\*
\
\- User text that starts with \`#\`, \`Updates:\` or \`\<!-- nera-\` breaks the Markdown round trip.
\
\- v2 JSON imports with no \`aliases\` or \`kind\` crash or fail to merge.
\
\- User lines with no turn sort as the oldest and are dropped first by the budget fitter.
\

\
\*\*Root cause (verified).\*\*
\
\- \`js/lore-format.js toMarkdown\` writes line text raw. \`fromMarkdown\` treats lines that start with \`#\`, \`##\`, \`###\`, \`####\`, \`Updates:\` or \`\<!-- nera-\` as structure (3.15).
\
\- \`fromJson\`, v2 path: returns \`data.entries\` as they are. \`planImport\` iterates \`source.aliases\` (TypeError when missing) and matches \`e.kind === source.kind\` (no merge when missing) (3.16).
\
\- \`js/lore-select.js sortLines \~5\`: \`(a.turn ?? 0)\`. \`fitBook\` drops from the oldest end, so user lines with a null turn go first (3.18, L-N5).
\

\
\*\*Fix.\*\*
\
1\. Escape on export, unescape on import:
\
&#x20; \`\`\`js
\
&#x20; const NEEDS_ESC = /^(\\\\|#|Updates:|\<!-- nera-)/;
\
&#x20; const esc = t => t.split('\n').map(l => NEEDS_ESC.test(l) ? '\\\\' + l : l).join('\n');
\
&#x20; const unesc = l => l.startsWith('\\\\') ? l.slice(1) : l; // apply only to content lines, after structure detection
\
&#x20; \`\`\`
\
&#x20; Old exports have no escapes. A content line that starts with \`\\\` is rare, and unescaping it only drops one backslash.
\
2\. Normalise v2 entries in \`fromJson\`:
\
&#x20; \`\`\`js
\
&#x20; entries = data.entries.map(e => ({ ...e, aliases: Array.isArray(e.aliases) ? e.aliases : [], kind: e.kind ?? kindFor(e.book, e.name), sections: normalizeSections(e.sections, e.book) }));
\
&#x20; \`\`\`
\
&#x20; Reuse the v1 path's \`kindFor\` and \`normalizeSections\` helpers, or add them next to it.
\
3\. Sorting:
\
&#x20; \`\`\`js
\
&#x20; const key = l => l.turn ?? (l.by === 'user' ? Infinity : 0);
\
&#x20; export function sortLines(lines) { return [...lines].sort((a,b) => key(a)-key(b) || (a.at ?? 0)-(b.at ?? 0)); }
\
&#x20; \`\`\`
\
&#x20; Also make \`fitBook\` drop non-user lines first and user lines only as a last resort, with a warning in the context usage panel.
\
4\. Optional: when "+ Add line" or a line edit sets \`turn = null\` (\`lorebook-view \~214\`, \`\~228\`), keep \`at\` so the order stays stable.
\

\
\*\*Acceptance.\*\*
\
\- A user line \`# Not a header\` survives export and import as text.
\
\- A v2 JSON file with no aliases or kind imports and merges with existing cards.
\
\- Over budget, user lines are dropped last.
\
\- No extra reads.
\

\
\*\*Tests.\*\* \`tests/memory.mjs\` (or the lore-format tests if they exist):
\
\- Markdown round trip for each escaped prefix;
\
\- an old export with no escapes still parses;
\
\- v2 import with missing aliases/kind;
\
\- \`createdAt\` survives a v2 round trip (closes the 3.16 doubt);
\
\- \`sortLines\` with a null-turn user line;
\
\- \`fitBook\` keeps user lines.
\

\
\*\*Depends on:\*\* none.
\

\
\---
\

\
\## L9. Duplicate-story orphans (3.17): mostly wrong
\

\
\*\*Findings covered:\*\* 3.17.
\

\
\*\*Verdict.\*\* Mostly wrong.
\
\- \`js/sessions.js duplicateSession \~145-163\` writes the chunks and copies the lore BEFORE the session doc, then writes the session doc last.
\
\- On any error it calls \`deleteSession(id)\`, which removes the chunks, lore and loreBackups.
\
\- The only leak is a tab closed mid-copy or a failed cleanup. That leaves subcollections under a session id with no session doc. They are invisible, never read, and only use storage.
\

\
\*\*Optional fix (low priority).\*\* None is required. If the owner wants one: before copying, write a tiny marker doc \`users/{uid}/pendingCopies/{id}\`, delete it after \`setDoc\`, and on app start clean up any marker older than 1 hour by calling \`deleteSession(id)\`. Cost: 1 list read at start, and usually 0 docs.
\

\
\*\*Acceptance / Tests.\*\* None required. With the optional fix: a test that a stale marker triggers cleanup.
\

\
\*\*Depends on:\*\* none.
\

\
\---
\

\
\## Firestore read summary after the fixes
\

\
\| Operation | Today | After |
\
\|---|---|---|
\
\| Message edit, accept or scene save | 1 session + 1 chunk | same |
\
\| Extraction commit | 1 session + k cards | same (+c with deterministic create ids) |
\
\| Reorganize save | all N cards + k + backup prune (up to 21) | 2k + prune (optionally 1 count + overflow) |
\
\| Re-extract from T{n} | n/a | same as today's rebuild (backup of all cards) |
\
\| Story open, pointer repair | n/a | 0 reads, at most 1 write |
\
\| Summary (auto) | 1 transaction per run, many LLM calls | 1 transaction, 1 LLM call |
\

\

\
\---
\

\
\# Part U — Send path, concurrency, UI, small fixes (U1–U9)
\

\
Scope: 4.1-4.4 and 5.1-5.13, except 5.11 (console log, owned elsewhere).
\
Repo: \`Nera_chat-feature-story-memory\` (called FEATURE below). MAIN = \`Nera_chat-main\`.
\
Assumed owner decision: a \`length\` finish saves the truncated reply with a visible "cut off" mark, as MAIN does.
\
House rules applied to every task:
\
\- at most 2 LLM calls per user turn
\
\- no data migration; old docs must keep working
\
\- Firestore reads are counted
\
\- with all memory toggles off, behaviour equals the pre-memory app
\

\
"Port task" means the other agent's task that ports these MAIN fixes:
\
\- saving on a \`length\` finish
\
\- tokenizer retry
\
\- retry for an orphan user message
\
\- keeping the draft on failure
\
\- reasoning budget clamp
\
\- iOS 16px inputs
\

\
Line numbers are approximate and refer to FEATURE as reviewed.
\

\
\## Verdict on the findings
\

\
\| Finding | Verdict |
\
\|---|---|
\
\| 4.1 busy released early | Confirmed. \`runAssistantTurn\` calls \`setBusy(false)\` at \~1119, before memory and summary maintenance. Its \`finally\` (\~1128) and \`handleSend\`'s \`finally\` (\~1041) can then clear the busy flag of a newer turn. |
\
\| 4.2 too many reads | Confirmed overall. Three details are wrong; see the notes below. |
\
\| 4.3 lore listener dies | Confirmed. The error callback in \`syncLore\` (\~70-86) never re-subscribes. \`loreSessionId\` stays set, so \`syncLore\` returns early at \~73 until the user switches story. |
\
\| 4.4 two session-doc sources | Confirmed. \`subscribeChat\` (\~444) and \`syncActiveSession\` (\~508, fed by sidebar.js:39) both write \`session\`. The sidebar path does not filter \`fromCache\` or \`hasPendingWrites\`. |
\
\| 5.1 render cache too coarse | Confirmed. \`sameRenderedMessage\` (\~666) does not compare these fields: acceptance, reviewWarnings, sceneMeta, sceneCandidate, revision, ooc, truncated. |
\
\| 5.2 tokenizer silent fallback | Confirmed. In tokenizer.js, a rejected \`modPromise\` is cached forever, and \`countTokens\` falls back to byte counts without telling anyone. |
\
\| 5.3 length finish discards reply | Confirmed. \`checkFinishReason\` (llm-client.js \~42) throws on \`length\`. |
\
\| 5.4 draft lost | Confirmed. \`el.input.value = ""\` runs at \~1018, before the user message is saved. |
\
\| 5.5 no stop or timeout | Confirmed. The client accepts a \`signal\`, but chat-view never passes one. There is no Stop button, and the stream reader is never cancelled. |
\
\| 5.6 reasoning budget | Confirmed. Defaults are maxResponseTokens 8192 and reasoning.maxTokens 20000, with no clamp. |
\
\| 5.7 settings | Confirmed. Device-local choices are overwritten by the server copy. A failed load followed by a save writes defaults over the server copy. The seed copies every prompt text. |
\
\| 5.8 iOS zoom | Partly wrong. FEATURE already has the 16px rule for typed inputs, select, textarea, and the composer (css/style.css:205, 232). The gaps are untyped inputs, the scene-chip input, \`.msg-editor\`, and \`.settings-prompts textarea\`. |
\
\| 5.9 message handlers | Confirmed. Delete, Accept, scene Save, and edit Save have no busy token and no session check after their awaits. Delete has no try/catch. Unused \`maxOrder\` and \`pointer\` in \`reconcileDeletedMemory\` (\~1375). |
\
\| 5.10 O(n²) turns | Confirmed. \`renderMessage\` (\~694) calls \`computeTurns\` once per message. The same pattern is in lorebook-view\.js:28-30. |
\
\| 5.12 overwrite keeps editedAt | Confirmed. \`overwriteMessage\` (messages.js \~299) keeps \`editedAt\` and defaults \`acceptance:'accepted'\` even when Scene is off. |
\
\| 5.13 misc | Mostly confirmed; split into U9 a-m. "copy() has no fallback" is true only for \`memory-ui.js copy\`. \`chat-view copyText\` (\~916) already has an execCommand fallback. |
\

\
Wrong or partly wrong details in 4.2:
\
\- "updateIndicator reads every chunk on every keystroke" is wrong as stated. \`ensureHistory()\` returns the cache while the revision matches. A full read happens only once per history invalidation, triggered by whatever calls next (often a keystroke). The per-keystroke CPU cost is real: the whole context is rebuilt and the draft tokenized on every \`input\` event, with no debounce.
\
\- "ensureContinuityMetadata costs an extra read per edit" is wrong. The result is cached in \`metadataReady\` after the first call per story per page load. The real cost of an edit, delete, accept, or scene save is 3 reads: the \`findChunk\` query plus the session and chunk reads inside the transaction.
\
\- The path \`js/context-viewer.js:143-158\` does not exist. The code is in \`js/ui/context-viewer.js:19-27\`.
\
\- The \`chat-cache getAll\` cost is IndexedDB, not Firestore. It is worth fixing for CPU and memory, but it does not count as a read.
\

\
NEW problems found while verifying (not in REVIEW_FINDINGS):
\
\- U-N1. History truncation race in \`handleSend\` (\~1033). This is the most serious one.
\
&#x20; \- The user message's commit bumps \`historyRevision\`.
\
&#x20; \- If the session snapshot from either source arrives before line \~1031 runs, the listener sets \`historyMessages = null\` (\~454 or \~514).
\
&#x20; \- Line \~1033 then runs \`historyMessages = mergeMessages(historyMessages ?? [], [userMsg])\`, which produces \`[userMsg]\` with a matching revision.
\
&#x20; \- \`reconcileStory\` and \`ensureHistory(true)\` trust that cache.
\
&#x20; \- Result: the narrator gets no prior history for this turn, and later turns keep the truncated cache until something else invalidates it.
\
\- U-N2. \`runAssistantTurn\` assigns the global \`session = {...fresh, ...}\` (\~1105, \~1108) without checking that \`sid\` is still the active story. Today this is reachable only through the 4.1 busy bug, but it writes the old story's doc into the new story's state.
\
\- U-N3. The memory-updater \`patch\` in \`initChatView\` (\~128-134) does not update \`verifiedLoreRevision\` or \`session.loreRevision\` after its own \`commitExtraction\`.
\
&#x20; \- The next \`reconcileStory\` therefore re-reads every lore card (N reads) after every memory update.
\
&#x20; \- This overlaps with the memory/lore plan.
\
\- U-N4. Lore writes are gated twice.
\
&#x20; \- \`gateWrite\` (lore-store.js \~17) runs a separate transaction (1 read + 1 write) to bump \`loreRevision\`.
\
&#x20; \- Gated actions that call the gated \`writeBackup\` go through the gate a second time.
\
&#x20; \- \`writeBackupImpl\` reads every backup doc (each up to 800 KB) to prune.
\
\- U-N5. \`handleResetSummary\` (\~1237) never sets busy while it awaits \`updateSession\`, so a send can start mid-reset.
\
\- U-N6. \`regenerateMessage\` (\~985) never takes busy before its awaits. It checks \`busy\` only after \`reconcileStory\`, \`ensureHistory\`, and \`waitForLoreWrites\`, so two quick clicks can both pass.
\
\- U-N7. If the narrator stream finishes with a non-stop reason, \`sceneWarning += ...\` (\~1092, \~1095) can produce the text "null Scene recovery failed". This is listed under U9a.
\

\
\## Reads per send (finding 4.2)
\

\
Counting rules:
\
\- a document read or transaction \`get\` = 1 read
\
\- a listener = 1 read per changed doc
\
\- \`increment()\` writes cost no read
\

\
Steady state means:
\
\- the story is already open
\
\- memory is off
\
\- no summary is due
\
\- this is not the first call on this page load (\`ensureContinuityMetadata\` and \`ensureChunked\` are cached)
\

\
\### Before (current FEATURE)
\

\
\| # | Call site | Reads |
\
\|---|---|---|
\
\| 1 | \`handleSend\` → \`reconcileStory()\` (\~1022) → \`getSessionFromServer\` | 1 |
\
\| 2 | \`messagesApi.addMessage\` (user) transaction \`tx.get(session)\` (messages.js \~120) | 1 |
\
\| 3 | \`runAssistantTurn\` → \`reconcileStory()\` (\~1051), a duplicate of #1 | 1 |
\
\| 4 | \`runAssistantTurn\` → \`getSessionFromServer(sid)\` after the stream (\~1068) | 1 |
\
\| 5 | \`messagesApi.addMessage\` (assistant) transaction | 1 |
\
\| Listener 1 | chat-view session doc listener (\~444): 2 doc changes | 2 |
\
\| Listener 2 | sidebar \`subscribeSessions\` query (sessions.js \~84): the same 2 changes | 2 |
\
\| Listener 3 | \`subscribeLatestMessages\` chunk listener: 2 chunk changes | 2 |
\
\| | \*\*Total, memory off\*\* | \*\*about 11\*\* (5 direct + 6 listener) |
\

\
Additional costs:
\
\- Lorebooks or auto-update on, after any memory commit or lore edit: +N card reads (\`getLore\` inside \`reconcileStory\`). Because of U-N3, this happens after every memory update, not only after edits made elsewhere.
\
\- Regenerate: overwrite through \`changeMessage\` costs \`findChunk\` 1 + transaction 2, instead of the 1 read for \`addMessage\`.
\
\- First send after a page load: +1 for \`ensureContinuityMetadata\` and +1 for \`ensureChunked\`.
\
\- After an Accept: the next \`reconcileStory\` sees a revision mismatch and does a full \`getMessages\` (C chunk reads).
\
&#x20; \- Cause: \`acceptMessage\` does not update the local \`historyRevision\`.
\
\- Turn with a memory update:
\
&#x20; \- \`start\` → \`prepare\` → \`reconcileStory\`: 1 read, +N because of U-N3
\
&#x20; \- \`commitExtraction\` transaction: 1 + K reads
\
&#x20; \- listener updates
\
\- Pre-narration summary turn: \`validateSource\` reads the session once per summary chunk, plus 1 more \`reconcileStory\` (\~1062).
\

\
\### After (U2 + U3 + U8)
\

\
\| # | Call site | Reads |
\
\|---|---|---|
\
\| 1 | \`handleSend\` → \`reconcileStory()\`, the only freshness read; it also checks \`loreRevision\` | 1 |
\
\| 2 | \`addMessage\` (user) transaction | 1 |
\
\| 3 | \`runAssistantTurn\` called with \`{ reconciled:true }\`: no read | 0 |
\
\| 4 | Post-stream \`getSessionFromServer\` removed; the assistant \`addMessage\` transaction returns the session data it read | 0 |
\
\| 5 | \`addMessage\` (assistant) transaction | 1 |
\
\| Listener 1 | chat-view session doc listener removed; the sidebar feed is the only session source | 0 |
\
\| Listener 2 | sidebar query: 2 changes | 2 |
\
\| Listener 3 | chunk listener: 2 changes | 2 |
\
\| | \*\*Total, memory off\*\* | \*\*about 7\*\* (3 direct + 4 listener) |
\

\
Additional costs after the fixes:
\
\- Lorebooks on: +0 after the app's own memory commits and own lore edits; +N only when another device changed lore.
\
\- After Accept, Delete, Edit, or scene Save: no full history read, because local history is patched when its base revision matches.
\
\- Memory-update turn:
\
&#x20; \- \`prepare\` reuses the session data from the assistant save (0 reads)
\
&#x20; \- commit transaction: 1 + K
\
&#x20; \- lore gate: 0 extra reads (an \`increment\` write)
\
\- Backups: 1 read of the index doc instead of reading every backup doc.
\

\
\---
\

\
\## U1. Busy token, stale-turn checks, and safe message handlers
\

\
\*\*Findings covered:\*\* 4.1, 5.9, U-N1, U-N2, U-N5, U-N6.
\

\
\*\*Problem:\*\*
\
\- One boolean, \`busy\`, is set and cleared by several overlapping flows.
\
\- Turn A clears it early (\~1119), then clears it again in two \`finally\` blocks.
\
\- If turn B started in the gap, B loses its busy flag mid-stream. This allows:
\
&#x20; \- a third send
\
&#x20; \- a story switch (\`setSession\` checks \`busy\`)
\
&#x20; \- lore writes and memory commits during B, because \`waitIdle\` and \`configureLoreWrites\` resolve on \`turn-finished\`
\
\- \`turn-finished\` fires several times per turn.
\
\- The message handlers and regenerate write history with no busy flag and do not check that the story is still open after their awaits.
\

\
\*\*Root cause (verified):\*\*
\
\- \`chat-view\.js setBusy\` (\~1306) is a plain boolean, and every \`setBusy(false)\` dispatches \`turn-finished\`.
\
\- \`runAssistantTurn\` (\~1045-1129):
\
&#x20; \- \`setBusy(true)\` at \~1048
\
&#x20; \- \`setBusy(false)\` at \~1119
\
&#x20; \- \`await shouldAutoSummarize\` at \~1121, then \`setBusy(true)\`
\
&#x20; \- \`finally setBusy(false)\` at \~1128
\
\- \`handleSend\` (\~1005-1043) has its own \`finally setBusy(false)\` at \~1041.
\
\- \`regenerateMessage\` (\~985-1003) checks \`busy\` only after three awaits (U-N6).
\
\- \`handleResetSummary\` (\~1237) has no busy at all (U-N5).
\
\- Handlers inside \`renderMessage\`:
\
&#x20; \- Delete (\~725-734): only \`if (busy) return\`, no try/catch, no session check.
\
&#x20; \- Accept (\~755-761): no busy, no session check.
\
&#x20; \- Scene Save (\~771-781): no session check.
\
&#x20; \- \`startEdit\` Save (\~841-862): writes \`session = {...session, ...}\` after the await without checking the story.
\
\- \`handleSend\` \~1031-1033 bridges history onto whatever \`historyMessages\` is at that moment (U-N1).
\
\- \`runAssistantTurn\` \~1105/\~1108 writes the global \`session\` without a \`sid\` check (U-N2).
\

\
\*\*Fix:\*\*
\

\
1\. Replace the boolean with a token. Add this to the module globals (\~29-55):
\
&#x20; \`\`\`js
\
&#x20; let busyToken = null, busySeq = 0;
\
&#x20; const isBusy = () => busyToken !== null;
\
&#x20; function acquireBusy(kind) {
\
&#x20; if (busyToken || !state.sessionId) return null;
\
&#x20; busyToken = { id: ++busySeq, kind, sid: state.sessionId, epoch: historyEpoch, owner: currentUid() };
\
&#x20; applyBusyUi(true);
\
&#x20; return busyToken;
\
&#x20; }
\
&#x20; function releaseBusy(token) {
\
&#x20; if (!token || busyToken !== token) return; // a stale release is a no-op
\
&#x20; busyToken = null;
\
&#x20; applyBusyUi(false);
\
&#x20; document.dispatchEvent(new CustomEvent('turn-finished')); // exactly once per token
\
&#x20; }
\
&#x20; function stillActive(token) {
\
&#x20; return !!token && busyToken === token && state.sessionId === token.sid &&
\
&#x20; historyEpoch === token.epoch && currentUid() === token.owner;
\
&#x20; }
\
&#x20; class StaleTurn extends Error {}
\
&#x20; function assertActive(token) { if (!stillActive(token)) throw new StaleTurn('Story changed; this action was cancelled.'); }
\
&#x20; function applyBusyUi(b) { // body of today's setBusy, minus the event
\
&#x20; state.busy = b; updateMemoryChip(); el.sendBtn.disabled = b; el.summarizeBtn.disabled = b;
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Delete \`setBusy\` and the \`busy\` variable.
\
&#x20; \- Replace every read of \`busy\` in chat-view\.js with \`isBusy()\`. Today these are \`initChatView\` (\~118-140), \`setSession\` (\~346), \`updateWelcome\`/composer (\~680), \~702, the handlers, and \`handleSend\`.
\
&#x20; \- \`state.busy\` stays as a mirror, so sidebar.js, lorebook-view\.js, pet-view\.js, settings-view\.js, memory-settings-view\.js, and context-viewer.js need no change.
\
&#x20; \- \`historyEpoch\` is the existing per-switch counter (\~44, bumped in \`setSession\` \~383). It plays the role of MAIN's \`sessionEpoch\`.
\
2\. \`turn-finished\` waiters. \`configureLoreWrites\` (\~118) and \`waitIdle\` (\~135) keep their shape, but test \`!isBusy()\`. Because \`releaseBusy\` runs once per token, a waiter can no longer wake up in the gap inside a turn.
\
3\. Lore-write ordering, to avoid a deadlock.
\
&#x20; \- \`gateWrite\` waits for "narrator idle", so a flow must never wait for lore writes while it holds a token.
\
&#x20; \- Every flow that waits for lore writes first waits, then acquires the token synchronously (no await between them):
\
&#x20; \`\`\`js
\
&#x20; while (loreWritesPending()) { await waitForLoreWrites(); if (state.sessionId !== requestedSessionId) return; }
\
&#x20; const token = acquireBusy('send'); if (!token) return;
\
&#x20; \`\`\`
\
&#x20; \- Use this in \`handleSend\`, \`regenerateMessage\`, and the port task's retry handler.
\
4\. \`handleSend\` (\~1005). The port task already keeps the draft (5.4); see U6. Rewrite the body as follows:
\
&#x20; \`\`\`js
\
&#x20; // after the lore-write loop above:
\
&#x20; const token = acquireBusy('send'); if (!token) return;
\
&#x20; const draft = el.input.value; let saved = false;
\
&#x20; try {
\
&#x20; await reconcileStory(); assertActive(token);
\
&#x20; const baseHistory = historyMessages, baseRevision = historyRevision; // captured with no await in between
\
&#x20; const userMsg = await messagesApi.addMessage(token.sid, { role:'user', content:text });
\
&#x20; saved = true; assertActive(token);
\
&#x20; clearComposer(); // U6
\
&#x20; /\* bridge lastMessages exactly as today \*/
\
&#x20; session = { ...session, historyRevision:userMsg.historyRevision };
\
&#x20; if (baseHistory && baseRevision === userMsg.historyRevision - 1) { // U-N1 fix
\
&#x20; historyMessages = mergeMessages(baseHistory, [userMsg]); historyRevision = userMsg.historyRevision;
\
&#x20; } else { historyMessages = null; await ensureHistory(true); assertActive(token); }
\
&#x20; await runAssistantTurn(token, { messages: historyMessages, reconciled: true });
\
&#x20; } catch (err) { if (!(err instanceof StaleTurn)) showTransientError(err.message || String(err)); }
\
&#x20; finally { releaseBusy(token); if (!saved && stillCurrentStory(token)) restoreDraft(draft); }
\
&#x20; \`\`\`
\
&#x20; \- The U-N1 fix uses a local copy taken right after \`reconcileStory\`. Listeners may still set the global to \`null\`; that no longer matters.
\
&#x20; \- If another device wrote in between (the revision jumped by more than 1), the cache is dropped and reloaded once.
\
5\. \`runAssistantTurn(token, opts)\` (\~1045). Signature change: it never acquires or releases busy.
\
&#x20; \- Remove \`setBusy(true)\` at \~1048, \`setBusy(false)\` at \~1119, \`setBusy(true)\` at \~1122, and the \`finally setBusy(false)\` at \~1128.
\
&#x20; \- Keep \`finishPetTurn\` in its current places.
\
&#x20; \- Add an \`assertActive(token)\` after each await. The required checkpoints, in order:
\
&#x20; 1\. \`reconcileStory()\` at \~1051 (only when \`!opts.reconciled\`; see U2)
\
&#x20; 2\. \`buildContextForRequest\` at \~1054
\
&#x20; 3\. pre-narration \`runSummarization\` at \~1059, the following \`reconcileStory\` at \~1062, and the second \`buildContextForRequest\` at \~1063
\
&#x20; 4\. \`chatCompletion\` at \~1066. A story switch is blocked while the token is held, but an account change still cancels here, before anything is saved.
\
&#x20; 5\. \`recoverScene\` at \~1086
\
&#x20; 6\. \`overwriteMessage\` or \`addMessage\` at \~1104/\~1107. The save itself has already happened. On \`StaleTurn\`, skip the global updates (\`session\`, \`historyMessages\`, \`historyRevision\`, \`renderMessages\`, \`queueCacheSave\`) and return. This is the U-N2 fix.
\
&#x20; 7\. \`shouldAutoSummarize\` at \~1121
\
&#x20; 8\. post-turn \`runSummarization\` at \~1124
\
&#x20; \- Post-turn maintenance runs inside the same token:
\
&#x20; \- \`memoryUpdater.maybeStartAfterTurn(sid)\` stays fire-and-forget. Its \`start\` already calls \`waitIdle\` before it commits, so it commits after \`releaseBusy\`.
\
&#x20; \- \`await shouldAutoSummarize\` and the summary also stay inside the token.
\
&#x20; \- Show "Summarizing…" (the existing \`streamSummaryUI\`) so the user knows why Send is disabled.
\
&#x20; \- \`catch\`: swallow \`StaleTurn\` and show every other error as today.
\
6\. \`regenerateMessage\` (\~985). Use the lore-write loop, then \`acquireBusy('regenerate')\` before \`reconcileStory\`. Call \`assertActive\` after \`reconcileStory\` and after \`ensureHistory\`. Call \`runAssistantTurn(token, {...opts, reconciled:true})\` and release in \`finally\`. This is the U-N6 fix.
\
7\. Summaries:
\
&#x20; \- \`handleSummarize\` (\~1173) and \`handleFullSummarize\` (\~1200) replace \`setBusy\` with acquire and release, and call \`assertActive\` after each await.
\
&#x20; \- \`handleResetSummary\` (\~1237): \`acquireBusy('reset')\` after the confirm, release in \`finally\`, and check \`stillActive\` before writing \`session\`. This is the U-N5 fix.
\
8\. Message handlers in \`renderMessage\` and \`startEdit\` (5.9). Use one helper for all four:
\
&#x20; \`\`\`js
\
&#x20; async function historyAction(kind, run) {
\
&#x20; const token = acquireBusy(kind); if (!token) { showTransientError('Wait for the current reply or summary.'); return false; }
\
&#x20; try { await run(token); return true; }
\
&#x20; catch (e) { if (!(e instanceof StaleTurn)) showTransientError(e.message || String(e)); return false; }
\
&#x20; finally { releaseBusy(token); }
\
&#x20; }
\
&#x20; function applyLocalChange(token, result, mutate) {
\
&#x20; assertActive(token);
\
&#x20; if (result.summaryReset) clearLocalSummary();
\
&#x20; const base = historyRevision;
\
&#x20; session = { ...session, historyRevision: result.historyRevision, memoryInvalidations: result.memoryInvalidations ?? session.memoryInvalidations };
\
&#x20; lastMessages = mutate(lastMessages);
\
&#x20; if (historyMessages && base === result.historyRevision - 1) { historyMessages = mutate(historyMessages); historyRevision = result.historyRevision; }
\
&#x20; else { historyMessages = null; } // another writer slipped in; reload lazily
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- Delete: \`confirm\` first (outside the token), then
\
&#x20; \`\`\`js
\
&#x20; historyAction('delete', async t => {
\
&#x20; const r = await deleteMessage(t.sid, m.id, m.order);
\
&#x20; applyLocalChange(t, r, list => list.filter(x => x.id !== m.id));
\
&#x20; renderMessages(lastMessages);
\
&#x20; await reconcileDeletedMemory();
\
&#x20; })
\
&#x20; \`\`\`
\
&#x20; \`reconcileDeletedMemory\` only reads history and dispatches a toast. It does not write lore, so holding the token cannot deadlock against \`gateWrite\`.
\
&#x20; \- Accept:
\
&#x20; \`\`\`js
\
&#x20; historyAction('accept', async t => {
\
&#x20; const r = await acceptMessage(t.sid, ...);
\
&#x20; applyLocalChange(t, r, list => list.map(x => x.id === m.id ? r.replacement : x));
\
&#x20; renderMessages(lastMessages);
\
&#x20; void updateIndicator();
\
&#x20; })
\
&#x20; \`\`\`
\
&#x20; \- Drop the \`reconcileStory()\` call and the \`renderMessages(historyMessages)\` call (\~758).
\
&#x20; \- The \`reconcileStory\` call caused the full \`getMessages\` (4.2).
\
&#x20; \- \`renderMessages(historyMessages)\` rendered the whole history instead of the visible page.
\
&#x20; \- Scene Save (\~774): same pattern. Re-enable the button in \`finally\`.
\
&#x20; \- Edit Save (\~844): same pattern. Keep the existing \`finally\` that re-enables Save and Cancel.
\
&#x20; \- Remove the unused \`maxOrder\` and \`pointer\` in \`reconcileDeletedMemory\` (\~1375).
\
9\. \`queueCacheSave\` (\~419) captures \`const sid = state.sessionId, uid = currentUid()\` when it is called. The timer then saves only if both are still current. Today it reads \`state.sessionId\` when it fires; \`setSession\` clears the timer, but an account change does not.
\
10\. Disable the Edit and Delete action buttons while busy. Re-render the action state in \`applyBusyUi\`, or have the click handler show "Wait for the current reply or summary." through \`historyAction\`.
\

\
\*\*Acceptance:\*\*
\
\- Send turn A. After A's reply is saved, while A's post-turn auto-summary runs, Send stays disabled. The Summarize button shows the summary is running.
\
\- No code path can clear a newer turn's busy state: \`releaseBusy(oldToken)\` is a no-op.
\
\- \`turn-finished\` fires exactly once per acquired token.
\
\- A memory update started by turn A commits only after A's token is released, and never while turn B streams.
\
\- Rapid double-clicks on Regenerate start one request.
\
\- Delete, Accept, scene Save, and edit Save:
\
&#x20; \- never produce an unhandled rejection
\
&#x20; \- do nothing to the globals if the story changed during the await
\
\- Accept does not trigger a full history read.
\
\- U-N1: if a session snapshot arrives before the user message's transaction resolves, the narrator request still contains the full history.
\
\- With all memory toggles off, the visible behaviour is the same as before (Send is disabled during a reply and a summary).
\

\
\*\*Tests\*\* (new file \`tests/busy-token.test.mjs\`):
\
\- Extract \`acquireBusy\`, \`releaseBusy\`, \`stillActive\`, \`historyAction\`, and \`applyLocalChange\` into \`js/ui/busy-token.js\`. They must take their state as parameters so Node can import them without the DOM; chat-view\.js imports them.
\
\- Test that a second acquire returns \`null\`.
\
\- Test that a stale release is ignored and the event fires once.
\
\- Test that \`stillActive\` is false after a sid change, an epoch change, or an owner change.
\
\- Test \`applyLocalChange\`: it patches history when \`base === rev - 1\` and sets it to \`null\` otherwise.
\
\- Test the U-N1 bridging rule as a pure function: \`bridgeHistory(baseHistory, baseRevision, userMsg)\` returns merged history or \`null\`.
\
\- Manual check: throttle the network in devtools; send; press Enter again while the reply saves; confirm the second send is rejected until the summary finishes.
\

\
\*\*Depends on:\*\* the port task, for the draft and retry handler shapes. U1 should land first among the E tasks, because U2, U5, and U6 change code inside \`handleSend\` and \`runAssistantTurn\`.
\

\
\---
\

\
\## U2. Send-path reads and a single session-doc source
\

\
\*\*Findings covered:\*\* 4.2 (send path), 4.4.
\

\
\*\*Problem:\*\*
\
\- A send costs about 11 reads with memory off; see the table above. Two direct reads are pure duplicates, and one listener duplicates another.
\
\- Two sources write \`session\`:
\
&#x20; \- the chat-view session doc listener (\~444), which filters cache and pending snapshots
\
&#x20; \- \`syncActiveSession\` (\~508), fed by the sidebar query, which filters neither
\
\- So a cached or pending sidebar snapshot can roll \`session\` fields back, or null \`historyMessages\` early. That early null is one trigger of U-N1.
\

\
\*\*Root cause (verified):\*\*
\
\- \`runAssistantTurn\` \~1051 repeats \`handleSend\`'s \`reconcileStory\` from \~1022. Regenerate repeats it too (\~988, then \~1051).
\
\- \`runAssistantTurn\` \~1068 reads the session again only to build \`session = {...fresh, ...}\`. Yet \`addMessage\`'s transaction (messages.js \~120) and \`changeMessage\`'s transaction (\~265) have already read that doc.
\
\- \`subscribeChat\` (\~444) adds a second listener on the same doc that the sidebar's \`subscribeSessions\` (sessions.js \~84, no limit) already watches. Both are billed.
\
\- \`syncActiveSession\` (\~508) has no metadata to filter on, because sidebar.js:39 passes only plain objects.
\

\
\*\*Fix:\*\*
\

\
1\. Skip the second reconcile. In \`runAssistantTurn\`, change \~1051 to
\
&#x20; \`if (!opts.reconciled) { await reconcileStory(); assertActive(token); }\`.
\
&#x20; \`handleSend\` and \`regenerateMessage\` pass \`reconciled:true\` (U1 steps 4 and 6). They have just run \`reconcileStory\` while holding the token, so nothing else can have changed the history in between.
\
2\. Return the session data from the save transactions (messages.js). No data change is involved:
\
&#x20; \`\`\`js
\
&#x20; // addMessage, inside runTransaction, before return:
\
&#x20; const after = { id: sessionId, ...data, nextOrder: order, historyRevision: rev,
\
&#x20; nextNarratorTurn: ..., activeChunkId: activeId, activeChunkBytes: bytes, activeChunkCount: count, ...(opts.sessionUpdate ?? {}) };
\
&#x20; delete after.updatedAt; // serverTimestamp sentinel; keep the old value or drop it
\
&#x20; return { ...item, historyRevision: rev, session: after };
\
&#x20; // changeMessage: likewise, return { ..., session: { id: sessionId, ...data, ...patchWithoutSentinels } }
\
&#x20; \`\`\`
\
&#x20; Callers that ignore the new \`session\` field keep working.
\
3\. Remove the post-stream read (\~1068).
\
&#x20; \- Delete \`const fresh = await getSessionFromServer(sid)\` and the check \`if (!fresh)\`. The transaction already throws "Session not found." if the story was deleted.
\
&#x20; \- At \~1105, change the code to use the session returned by the save:
\
&#x20; \`\`\`js
\
&#x20; session = { ...result.session, memoryState: { ...result.session.memoryState, paused: true, needsRebuild: true } }
\
&#x20; \`\`\`
\
&#x20; \- At \~1108, change the code to:
\
&#x20; \`\`\`js
\
&#x20; session = saved.session
\
&#x20; \`\`\`
\
&#x20; \- Both are guarded by \`assertActive\` (U1).
\
&#x20; \- Use \`requestSource(sourceSession)\` as the \`expectedSource\` for both saves. That keeps the "inputs changed during generation" signal inside the transaction, instead of in a separate read.
\
&#x20; \- Owner decision (keep): the reply is saved even if the inputs changed. Today's comment at \~1110 says so, and the \`historyChanged\` check at \~1111 already handles it. So call \`assertSource\` only for the hard case of a deleted story, and keep the \`historyChanged\` logic exactly as today.
\
4\. Use one session-doc source: the sidebar feed. This follows MAIN's pattern; MAIN's \`restoreCachedChat\` does not subscribe to the session doc.
\
&#x20; \- sessions.js \`subscribeSessions\` passes per-doc metadata to its callback:
\
&#x20; \`\`\`js
\
&#x20; (snap) => callback(snap.docs.map(d => ({ id: d.id, ...d.data() })),
\
&#x20; { fromCache: snap.metadata.fromCache,
\
&#x20; pending: new Set(snap.docs.filter(d => d.metadata.hasPendingWrites).map(d => d.id)) })
\
&#x20; \`\`\`
\
&#x20; \- sidebar.js:39: \`syncActiveSession(sessions.find(s => s.id === state.sessionId), meta)\`. Also keep a \`Map\` of the latest metadata in \`state.sessionMeta\`, so \`setSession\` can seed \`session\` with no read.
\
&#x20; \- chat-view \`syncActiveSession(metadata, meta)\`:
\
&#x20; \- Return early when \`meta?.fromCache\` or \`meta?.pending.has(metadata.id)\`. This is the same filter as today's \~450.
\
&#x20; \- Merge in the body of today's session listener (\~452-470):
\
&#x20; \- the downgrade guard
\
&#x20; \- the \`historyMessages\` null on a revision mismatch
\
&#x20; \- \`updateIndicator\` on plan, summary, or memory changes
\
&#x20; \- \`session-changed\` when the title, plan, memory, or memoryState changes. Today's \`syncActiveSession\` misses memoryState.
\
&#x20; \- \`syncLore\`
\
&#x20; \- \`rememberMemoryStory\`
\
&#x20; \- \`memory-refresh\` (only when memory, memoryState, or loreRevision changed, not on every snapshot; see U8)
\
&#x20; \- re-render on a memory change
\
&#x20; \- \`queueCacheSave\`
\
&#x20; \- If \`session\` is \`null\` (first load of a story that is not cached), accept the metadata as the initial session.
\
&#x20; \- If the active id is missing from a non-cache snapshot, the story was deleted. Call \`setSession(null)\` with a toast.
\
&#x20; \- \`subscribeChat\` (\~441): delete the \`sessUnsub = onSnapshot(doc(...))\` block. Keep \`msgUnsub\` (the chunk listener) unchanged. \`sessUnsub\` stays as a variable for the lore and chunk teardown symmetry, or is removed.
\
&#x20; \- \`setSession\` (\~343): after the reset, set \`session = state.sessionMeta?.get(sessionId) ?? null\` (0 reads). If the story is not in the map yet (right after a create or import), call \`getSessionFromServer\` once, guarded by \`historyEpoch\`.
\
&#x20; \- Fallback: if any problem shows up with this step, the minimal option is to keep the chat-view listener and make sidebar.js skip \`syncActiveSession\`. That fixes the correctness part of 4.4 but saves 0 reads, because the sidebar query is billed anyway. Option B, above, is recommended.
\
5\. Offline: when \`meta.fromCache\` is true, do not apply the snapshot. Instead set \`el.contextLabel\` to add " · offline" until the next server snapshot arrives. This replaces today's silent ignore.
\

\
\*\*Acceptance:\*\*
\
\- With memory off, a normal send makes exactly 3 direct reads, and listener reads total 4 (2 session changes on the sidebar query and 2 chunk changes). Measure with the Firestore usage tab, or by counting \`getDocFromServer\` and \`runTransaction\` calls with a temporary wrapper.
\
\- Regenerate makes 1 reconcile read plus the overwrite cost (\`findChunk\` 1 + transaction 2).
\
\- There is only one \`onSnapshot\` on \`users/{uid}/sessions/{sid}\` per page (the sidebar query).
\
\- Editing the plan in another tab still updates this tab's indicator and settings panel.
\
\- Deleting the open story in another tab returns this tab to the empty state.
\
\- A cached or pending sidebar snapshot never rolls back \`session.historyRevision\` or nulls history.
\
\- Old session docs without new fields still load, because no field was added.
\

\
\*\*Tests:\*\*
\
\- tests/messages\*.mjs: \`addMessage\` and \`changeMessage\` return \`session\` with the incremented \`historyRevision\` and \`nextOrder\` (fake transaction).
\
\- New \`tests/session-feed.test.mjs\`. Extract the merge logic of \`syncActiveSession\` into a pure \`mergeSessionFeed(prev, metadata, meta)\` that returns \`{ session, invalidateHistory, events }\`. Test that it:
\
&#x20; \- ignores \`fromCache\` and pending snapshots
\
&#x20; \- ignores revision downgrades
\
&#x20; \- emits \`session-changed\` on a memoryState change
\
&#x20; \- accepts the first snapshot when \`prev\` is \`null\`
\
\- The existing 147 tests stay green.
\

\
\*\*Depends on:\*\* U1 (\`token\`, \`assertActive\`, \`reconciled\` flag).
\

\
\---
\

\
\## U3. Lore listener recovery and lore write cost
\

\
\*\*Findings covered:\*\* 4.3, 4.2 (lore part), U-N3, U-N4.
\
The gate and backup items overlap with the memory/lore plan. If that plan already changes \`gateWrite\`, keep only steps 1-3 here.
\

\
\*\*Problem:\*\*
\
\- A lore listener error (network, permission during a token refresh) kills the listener until the user switches story. Generation readiness also stays rejected, because \`loreReady\` was rejected.
\
\- Every gated lore write pays an extra transaction (1 read).
\
\- Every backup reads all backup docs.
\
\- After every memory commit, the next send re-reads every card (U-N3).
\

\
\*\*Root cause (verified):\*\*
\
\- \`chat-view\.js syncLore\` (\~70-86): the error callback calls \`fail(error)\` and shows an error, but leaves \`loreSessionId === sid\`, so the next \`syncLore()\` returns at \~73.
\
\- \`initChatView\` \`patch\` (\~128-134) updates \`memoryState\` and \`entries\` but not \`verifiedLoreRevision\`.
\
\- \`lore-store.js commitExtractionImpl\` (\~106-128) bumps \`loreRevision\` inside its transaction but returns nothing.
\
\- \`gateWrite\` (\~13-22) runs \`runTransaction\` that reads the session only to add 1 to \`loreRevision\`.
\
\- \`writeBackupImpl\` (\~66-74) calls \`listBackups\` (\`getDocsFromServer\` of the whole \`loreBackups\` collection) to prune to 20 groups. \`restoreBackupImpl\` and lorebook-view \`renderBackups\` do the same.
\

\
\*\*Fix:\*\*
\

\
1\. Re-subscribe with backoff in \`syncLore\`:
\
&#x20; \`\`\`js
\
&#x20; let loreRetry = { sid: null, attempt: 0, timer: null };
\
&#x20; const LORE_BACKOFF = [2000, 5000, 15000, 60000];
\
&#x20; // in the error callback:
\
&#x20; error => {
\
&#x20; if (currentUid() !== owner || state.sessionId !== sid || loreSessionId !== sid) return;
\
&#x20; fail(error); loreUnsub?.(); loreUnsub = null; loreSessionId = null; // allow syncLore() to re-enter
\
&#x20; loreStatus = 'error'; updateMemoryChip();
\
&#x20; const delay = LORE_BACKOFF[Math.min(loreRetry.attempt++, LORE_BACKOFF.length - 1)];
\
&#x20; clearTimeout(loreRetry.timer);
\
&#x20; loreRetry.timer = setTimeout(() => { if (state.sessionId === sid && currentUid() === owner) syncLore(); }, delay);
\
&#x20; if (loreRetry.attempt === 1) showTransientError('Could not load lorebooks: '+error.message+' Retrying…');
\
&#x20; }
\
&#x20; // in the success callback: loreRetry.attempt = 0; loreStatus = 'ok';
\
&#x20; \`\`\`
\
&#x20; \- \`setSession\` and the \`!wanted\` branch clear \`loreRetry.timer\`.
\
&#x20; \- The memory chip shows "Lorebooks offline, retrying" while \`loreStatus === 'error'\`.
\
&#x20; \- \`reconcileStory\` already awaits \`loreReady\`. After a failure it should call \`syncLore()\` once and await the new promise before it throws. That way a send right after a reconnect does not fail on the old rejected promise.
\
2\. Keep \`verifiedLoreRevision\` correct after the app's own commits (U-N3).
\
&#x20; \- \`commitExtractionImpl\` returns \`{ loreRevision: newRevision }\` from its transaction.
\
&#x20; \- In memory-updater \`start\`, change the commit call to:
\
&#x20; \`\`\`js
\
&#x20; const { loreRevision } = await commitExtraction(...)
\
&#x20; \`\`\`
\
&#x20; \- Then call \`runtime.patch(sid, {...}, changes.entries, loreRevision)\`.
\
&#x20; \- The \`patch\` in \`initChatView\` adds:
\
&#x20; \`\`\`js
\
&#x20; if (loreRevision != null && sid === state.sessionId) {
\
&#x20; verifiedLoreRevision = loreRevision;
\
&#x20; session = { ...session, loreRevision };
\
&#x20; }
\
&#x20; \`\`\`
\
3\. Do the same for gated manual lore writes, once step 4 below removes the read.
\
&#x20; \- The app no longer knows the new number. Instead record \`localLoreBumps++\` per gated write.
\
&#x20; \- In \`reconcileStory\`, treat \`fresh.loreRevision === verifiedLoreRevision + localLoreBumps\` as verified, but only if the lore listener has delivered a server (non-cache) snapshot since the last write.
\
&#x20; \- If that is too fragile, accept 1 \`getLore\` after a manual lore edit. Manual edits are rare. This is the simpler default.
\
4\. \`gateWrite\` without a read (U-N4):
\
&#x20; \`\`\`js
\
&#x20; await updateDoc(sessionRef({ id:sid, uid:owner }), { loreRevision: increment(1) }).catch(e => { if (e.code !== 'not-found') throw e; });
\
&#x20; \`\`\`
\
&#x20; \- This costs 0 reads and 1 write. Import \`updateDoc\` and \`increment\`.
\
&#x20; \- Make the impls call \`writeBackupImpl\` directly, instead of the gated export, so nested calls are not gated twice. Check \`deleteEntryImpl\`, \`restoreBackupImpl\`, \`replaceLinesImpl\`, \`importImpl\`, and \`reorganizeImpl\` for calls to \`writeBackup(\`.
\
5\. Backup index (no migration):
\
&#x20; \- Add a small doc \`users/{uid}/sessions/{sid}/loreMeta/backups\` with the field \`groups: [{ id, parts, createdMs, reason, label, count }]\`, newest first.
\
&#x20; \- The existing rules (\`users/{uid}/{document=\*\*}\`) already allow this path.
\
&#x20; \- \`writeBackupImpl\`:
\
&#x20; \- After writing the parts, run a transaction on the index doc (1 read): unshift the new group and cut it to 20.
\
&#x20; \- Delete the docs of the dropped groups by id (\`id\`, \`id_1\`, …), with no listing.
\
&#x20; \- \`listBackups\` (used by \`renderBackups\`) reads the index doc (1 read).
\
&#x20; \- \`restoreBackupImpl\` reads only the parts of the chosen group with \`getDocFromServer\` (one read per part).
\
&#x20; \- Old stories have no index doc. The first \`listBackups\` falls back to today's full listing, then writes the index from it. Old backup docs stay as they are, so nothing is migrated.
\

\
\*\*Acceptance:\*\*
\
\- Simulate a listener error (devtools offline, then online). Lore reloads within 60 s without a story switch, and a send after reconnecting works.
\
\- After a memory update, the next send makes no \`getLore\` call.
\
\- A manual card edit costs 1 write for the gate and 0 reads.
\
\- Writing a backup costs 1 read (the index) plus the part writes. Opening the backups screen costs 1 read.
\
\- Stories created before this change still list and restore their backups.
\

\
\*\*Tests:\*\*
\
\- tests/lore-store\*.mjs: \`gateWrite\` calls \`updateDoc\` with \`increment\`, not \`runTransaction\` (mock the firestore module the same way the existing tests do).
\
\- \`commitExtraction\` returns \`loreRevision\`.
\
\- Backup pruning keeps 20 groups from the index and deletes the expected ids.
\
\- \`listBackups\` falls back to the full listing and writes the index when the index doc is missing.
\
\- Memory-updater test: \`patch\` receives \`loreRevision\`.
\

\
\*\*Depends on:\*\* U1 (\`waitIdle\` semantics). Coordinate with the memory/lore plan, which may own commitExtraction.
\

\
\---
\

\
\## U4. Render correctness and cost
\

\
\*\*Findings covered:\*\* 5.1, 5.10, 5.12.
\

\
\*\*Problem:\*\*
\
\- The render cache reuses a message node when only review or scene state changed. For example, after Accept the "Needs review" box stays visible.
\
\- Turn labels are O(n²) for long stories.
\
\- Regenerating a message that was edited earlier keeps the "edited" mark.
\
\- With Scene off, a regenerated reply gets an \`acceptance\` field.
\

\
\*\*Root cause (verified):\*\*
\
\- \`chat-view\.js sameRenderedMessage\` (\~666-669) compares only role, content, thinking, scene, and the truthiness of \`editedAt\`.
\
\- \`renderMessage\` (\~694) calls \`computeTurns(historyMessages ?? lastMessages)\` once per rendered message. \`updateIndicator\` (\~972) and \~109 call it again.
\
\- lorebook-view\.js:28-30: \`deletedLine\` builds \`deletedOrders()\` (a Set over all messages) per line, and \`editedSource\` runs \`computeTurns(all)\` per line.
\
\- messages.js \`overwriteMessage\` (\~299) spreads \`...message\` (keeping \`editedAt\`) and defaults \`acceptance='accepted'\`.
\

\
\*\*Fix:\*\*
\

\
1\. \`sameRenderedMessage\`:
\
&#x20; \`\`\`js
\
&#x20; function sameRenderedMessage(a, b) {
\
&#x20; return a.role === b.role && a.content === b.content && a.thinking === b.thinking &&
\
&#x20; a.scene === b.scene && Boolean(a.editedAt) === Boolean(b.editedAt) &&
\
&#x20; (a.revision ?? 0) === (b.revision ?? 0) && a.acceptance === b.acceptance &&
\
&#x20; (a.reviewWarnings ?? []).join('\n') === (b.reviewWarnings ?? []).join('\n') &&
\
&#x20; a.sceneMeta?.kind === b.sceneMeta?.kind && Boolean(a.sceneCandidate) === Boolean(b.sceneCandidate) &&
\
&#x20; Boolean(a.ooc) === Boolean(b.ooc) && Boolean(a.truncated) === Boolean(b.truncated);
\
&#x20; }
\
&#x20; \`\`\`
\
&#x20; \- The turn label (\`· T12\`) also depends on neighbours, so store the label string in the \`renderedMessages\` entry and compare it too (step 2).
\
&#x20; \- \`truncated\` is added here because the port task introduces it; MAIN's version includes \`truncated\`.
\
2\. Memoize turns:
\
&#x20; \`\`\`js
\
&#x20; let turnsMemo = { src: null, value: null };
\
&#x20; function turnsFor(list) { if (turnsMemo.src !== list) turnsMemo = { src: list, value: computeTurns(list) }; return turnsMemo.value; }
\
&#x20; \`\`\`
\
&#x20; \- Use it at \~109, \~694, and \~972.
\
&#x20; \- \`historyMessages\` and \`lastMessages\` are replaced (never mutated in place) on every change, so identity is a safe key. Check this with \`grep -n "historyMessages\\.\\(push\\|splice\\)\\|lastMessages\\.\\(push\\|splice\\)"\`; it should print nothing.
\
3\. lorebook-view\.js. Compute both values once per render of the line list:
\
&#x20; \`\`\`js
\
&#x20; const ctx = lineContext(live()?.messages ?? []);
\
&#x20; // lineContext returns { orders: Set, turns: computeTurns(all), editedAtByTurn: Map(turn -> max edit ms) }
\
&#x20; \`\`\`
\
&#x20; \- Pass \`ctx\` to \`deletedLine(l, ctx)\` and \`editedSource(l, ctx)\`.
\
&#x20; \- Memoize it on the \`messages\` array identity, as in step 2.
\
4\. \`overwriteMessage\` (messages.js \~299). Clear the edit mark, and write \`acceptance\` only when the caller sends it:
\
&#x20; \`\`\`js
\
&#x20; export async function overwriteMessage(sessionId, messageId, { content, thinking, ..., acceptance, reviewWarnings, truncated = false }, ...) {
\
&#x20; ... changeMessage(..., (message) => {
\
&#x20; const { editedAt, acceptance: \_a, reviewWarnings: \_r, sceneCandidate: \_c, ...rest } = message;
\
&#x20; return { ...rest, content, thinking: thinking ?? null, planThread, planBefore, scene, ooc, tokenCount, sceneMeta,
\
&#x20; ...(acceptance !== undefined ? { acceptance, reviewWarnings: reviewWarnings ?? [], sceneCandidate } : {}),
\
&#x20; ...(truncated ? { truncated: true } : {}) };
\
&#x20; })
\
&#x20; \`\`\`
\
&#x20; \- \`runAssistantTurn\` already omits these fields when Scene is off (\~1101). So with Scene off, a regenerated message has no \`acceptance\`, as before the memory feature.
\
&#x20; \- Old messages with \`acceptance\` keep it until they are regenerated. Reading code treats a missing field as accepted (\`isAcceptedTurn\`), so no migration is needed.
\
&#x20; \- \`editMessage\` (\~292) also writes \`acceptance:'accepted'\` unconditionally. Leave it; it is harmless, because missing and accepted mean the same. Or apply the same conditional for symmetry.
\

\
\*\*Acceptance:\*\*
\
\- Accepting a reply removes the review box and updates the scene chip without a reload.
\
\- Regenerating an edited reply removes the "edited" mark.
\
\- With Scene off, a regenerated reply has no \`acceptance\`, \`reviewWarnings\`, or \`sceneCandidate\` fields in Firestore.
\
\- Rendering 2,000 messages calls \`computeTurns\` once per history change. Check by adding a counter in a test, or a temporary log in devtools.
\

\
\*\*Tests:\*\*
\
\- Export \`sameRenderedMessage\` (or move it to a small module). Table test: changing each listed field makes it return false.
\
\- \`turnsFor\` returns the same object for the same array and a new one for a new array.
\
\- tests/messages\*.mjs: \`overwriteMessage\` drops \`editedAt\`, and omits \`acceptance\` when it is undefined.
\

\
\*\*Depends on:\*\* the port task (the \`truncated\` field). Otherwise independent.
\

\
\---
\

\
\## U5. LLM client: truncated replies, Stop and timeout, reasoning clamp, tokenizer warning
\

\
\*\*Findings covered:\*\* 5.3, 5.5, 5.6, 5.2.
\

\
\*\*Problem:\*\*
\
\- A reply that hits the token limit is thrown away (5.3).
\
\- A hung stream cannot be stopped, and has no timeout (5.5).
\
\- The reasoning budget can exceed the response budget (5.6).
\
\- When the tokenizer fails, the context bar silently uses byte counts (5.2).
\

\
\*\*Root cause (verified):\*\*
\
\- llm-client.js \`checkFinishReason\` (\~42-49) throws on \`length\` and on any reason other than \`stop\`. \`chatCompletion\` returns no \`finishReason\`.
\
\- \`streamedCompletion\` (\~90+) never calls \`reader.cancel()\` and has no idle timer. chat-view \`runAssistantTurn\` (\~1066) passes no \`signal\`.
\
\- settings.js defaults: \`maxResponseTokens\` 8192 (\~24) and \`reasoning.maxTokens\` 20000 (\~34), with no clamp.
\
\- tokenizer.js keeps a rejected \`modPromise\` forever. \`countTokens\` catches the error and returns a byte estimate silently.
\

\
\*\*Fix:\*\*
\

\
1\. 5.3 is covered by the port task, which saves a \`length\` finish as \`truncated:true\` and shows " · cut off". Additionally:
\
&#x20; 1\. Keep failing for every caller except the narrator. Add the option \`allowTruncated = false\` to \`chatCompletion\`, used only by \`runAssistantTurn\`.
\
&#x20; \- memory-updater (\`start\`) relies on the "output limit / cut off" error text (memory-updater.js \~96).
\
&#x20; \- The summary and \`recoverScene\` must also never save half an answer.
\
&#x20; \- So \`checkFinishReason(reason, allowTruncated)\` throws as today unless \`allowTruncated && reason === 'length'\`. Other non-stop reasons (\`content_filter\`, \`error\`) still throw.
\
&#x20; 2\. In \`runAssistantTurn\`, when \`finishReason === 'length'\`:
\
&#x20; \- Save with \`truncated:true\`.
\
&#x20; \- Skip \`lintPlayerAgency\`/\`lintUnestablishedTime\` (set \`reviewWarnings = []\` and \`pending = false\`).
\
&#x20; \- Skip \`recoverScene\`. This keeps the turn at 1 LLM call plus nothing; a cut reply rarely contains the trailing scene tag anyway.
\
&#x20; \- Use \`carryScene(prior)\` with \`sceneMeta.kind = 'carried'\`.
\
&#x20; \- Show: "Reply saved but cut off at the output limit. Raise 'Max response tokens' or use Regenerate."
\
&#x20; 3\. Leave memory and summary maintenance as they are. A truncated reply is still a real turn.
\
&#x20; 4\. \`sameRenderedMessage\` compares \`truncated\` (U4).
\
2\. 5.5 Stop and idle timeout.
\
&#x20; 1\. index.html composer: add \`\<button id="btn-stop" type="button" class="btn hidden" aria-label="Stop generating">Stop\</button>\` next to \`#btn-send\`.
\
&#x20; 2\. \`runAssistantTurn\` creates the controller and wires the Stop button:
\
&#x20; \`\`\`js
\
&#x20; const controller = new AbortController();
\
&#x20; token.abort = () => controller.abort('user');
\
&#x20; el.stopBtn.hidden = false; el.sendBtn.hidden = true;
\
&#x20; \`\`\`
\
&#x20; \`applyBusyUi(false)\` swaps the buttons back. The Stop click calls \`busyToken?.abort?.()\`.
\
&#x20; 3\. Pass \`signal: controller.signal\` and \`allowTruncated: true\` to \`chatCompletion\`.
\
&#x20; 4\. llm-client.js \`streamedCompletion\`:
\
&#x20; \- Idle timeout of 90 s (a module constant), reset on every received chunk, including \`:\` keep-alive lines:
\
&#x20; \`\`\`js
\
&#x20; let idle; const kick = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort('timeout'), IDLE_MS); };
\
&#x20; \`\`\`
\
&#x20; Combine it with the caller's signal through an internal \`AbortController\` that is aborted when \`signal\` aborts.
\
&#x20; \- In \`finally\`, call \`clearTimeout(idle)\` and \`reader.cancel().catch(() => {})\`.
\
&#x20; \- On abort, throw \`Object.assign(new Error(reason === 'timeout' ? 'The model stopped responding (90 s).' : 'Stopped.'), { partial: { content, thinking }, aborted: reason })\`.
\
&#x20; \- \`nonStreamedCompletion\`: the same 90 s total timeout through the same internal controller.
\
&#x20; 5\. In \`runAssistantTurn\`'s catch, if \`err.partial?.content?.trim()\` is non-empty, ask: \`confirm('Keep the partial reply? It will be marked as cut off.')\`.
\
&#x20; \- Yes: run the normal save path with \`content = err.partial.content\` and \`truncated:true\`, using the same skip rules as step 1.2.
\
&#x20; \- No: discard it, as today.
\
&#x20; \- This needs no extra LLM call.
\
&#x20; 6\. The user message stays saved. The port task's orphan-user retry offers "Retry".
\
3\. 5.6 is covered by the port task (reasoning budget clamp). Additionally:
\
&#x20; \- Validate \`reasoning.effort\` against the known list \`['minimal','low','medium','high','xhigh','max','none']\` (settings.js \~33). Fall back to \`medium\` in \`normalizeSettings\`, so a stale value from an old device does not reach the API.
\
&#x20; \- Show the clamped value in settings-view next to the field: "Reasoning budget capped at N (must be below max response tokens)."
\
4\. 5.2 is covered by the port task (the tokenizer retry, which resets \`modPromise\` on rejection). Additionally:
\
&#x20; \- Export \`tokenizerStatus()\`, returning \`'ok' | 'loading' | 'fallback'\`, from tokenizer.js.
\
&#x20; \- \`updateIndicator\` adds " · estimate (tokenizer unavailable)" to the label when it returns \`fallback\`.
\
&#x20; \- Show one toast per page load: "Token counts are estimates; the tokenizer failed to load."
\

\
\*\*Acceptance:\*\*
\
\- A reply that stops at \`length\` is saved, shows "cut off", and costs exactly 1 LLM call (no scene recovery).
\
\- Memory updates and summaries that hit \`length\` still fail with today's messages.
\
\- Stop during streaming ends the request within 1 s, and the network tab shows the request cancelled. The user can keep or discard the partial text.
\
\- A stream that is silent for 90 s ends with a timeout message, and Send becomes enabled.
\
\- An unknown \`effort\` value is replaced with \`medium\` on load.
\
\- With the tokenizer blocked (devtools request blocking), the context label says it is an estimate.
\

\
\*\*Tests:\*\*
\
\- llm-client tests with a fake \`fetch\` and a \`ReadableStream\`:
\
&#x20; \- \`allowTruncated\` returns \`finishReason:'length'\`
\
&#x20; \- without the option, the old error is thrown
\
&#x20; \- the idle timeout aborts and the thrown error has \`partial\`
\
&#x20; \- \`reader.cancel\` is called in \`finally\`
\
\- settings tests: an unknown effort is normalized to \`medium\`.
\
\- tokenizer test: \`tokenizerStatus()\` is \`fallback\` after a failed import (mock the import).
\

\
\*\*Depends on:\*\* the port task (truncated save, tokenizer retry, clamp); U1 (token used for Stop); U4 (\`truncated\` in the render comparison).
\

\
\---
\

\
\## U6. Composer draft and iOS zoom
\

\
\*\*Findings covered:\*\* 5.4, 5.8.
\

\
\*\*Problem:\*\*
\
\- The draft is cleared before the user message is saved, so a failed save loses the text (5.4).
\
\- iOS zooms the page when focusing any field whose font size is below 16px (5.8).
\

\
\*\*Root cause (verified):\*\*
\
\- \`chat-view\.js handleSend\` \~1018 runs \`el.input.value = ""\` before \`addMessage\`.
\
\- css/style.css:
\
&#x20; \- \`@media (max-width:720px)\` at \~204-205 sets 16px only on typed inputs, \`select\`, and plain \`textarea\`; \~232 sets \`.composer textarea\` to 16px.
\
&#x20; \- Rules with higher specificity win over the plain \`textarea\` rule: \`.msg-editor { font: inherit }\` (\~133, 14px) and \`.settings-prompts textarea\` (\~171, 13px).
\
&#x20; \- Inputs with no \`type\` attribute are not matched:
\
&#x20; \- \`#mem-protagonist\`, \`#mem-starting-date\`, \`#mem-starting-time\`, \`#mem-starting-place\`, \`#mem-starting-present\`, and \`#mem-sceneFallbackModel\` (index.html \~248)
\
&#x20; \- the scene-chip editor \`input\` created at chat-view\.js \~770
\
&#x20; \- Inputs inside \`.memory-content\` are already 16px (\~424).
\

\
\*\*Fix:\*\*
\

\
1\. 5.4 is covered by the port task (keeping the draft on failure). Additionally, it must use the U1 shape:
\
&#x20; \- capture \`draft\`
\
&#x20; \- clear the composer only after \`addMessage\` resolves (\`clearComposer()\` in U1 step 4)
\
&#x20; \- restore the draft in \`finally\` when \`!saved\`, the same story is still open, and the composer is empty
\
&#x20; \- also restore it when \`acquireBusy\` or the lore-write loop returns early (the text was never cleared in that case, so this is a no-op)
\
2\. 5.8 is covered by the port task (16px mobile inputs). Additionally, add this inside the existing \`@media (max-width: 720px)\` block at \~204:
\
&#x20; \`\`\`css
\
&#x20; input:not([type]), input[type="search"], input[type="tel"],
\
&#x20; .msg-editor, .settings-prompts textarea, .full-label textarea,
\
&#x20; .scene-chip + input, .msg input { font-size: 16px; }
\
&#x20; \`\`\`
\
&#x20; \- Simpler and more robust: give the scene editor field a class (\`field.className = 'scene-edit'\` at \~770) and list \`.scene-edit\`.
\
&#x20; \- Check that the \`.msg-editor\` height still fits in the bubble at 16px. The auto-grow at \~827 sets the height from \`scrollHeight\`, so it adapts.
\
&#x20; \- Do not touch desktop sizes.
\

\
\*\*Acceptance:\*\*
\
\- A send that fails before the save (offline, rules error) leaves the text in the composer.
\
\- A send that fails after the save leaves the composer empty, and offers the port task's Retry.
\
\- On an iPhone, or Safari responsive mode with a touch user agent, focusing each of these causes no zoom:
\
&#x20; \- the memory panel text fields
\
&#x20; \- the scene chip editor
\
&#x20; \- the message editor
\
&#x20; \- the prompt textareas
\

\
\*\*Tests:\*\* Manual iOS check. Add a CSS assertion in an existing settings or markup test only if such tests exist (none found). Unit-test the U1 \`handleSend\` draft rule through the extracted helper, if U1 extracts it.
\

\
\*\*Depends on:\*\* U1, port task.
\

\
\---
\

\
\## U7. Settings: device-local overrides, failed-load guard, prompt defaults
\

\
\*\*Findings covered:\*\* 5.7.
\

\
\*\*Problem:\*\*
\
\- Quick choices (profile, thinking) made on one device are overwritten by the next server snapshot.
\
\- If the first settings load fails, the app runs on defaults, and the next save writes those defaults over the real server settings.
\
\- Every user's settings doc stores full copies of the default prompts, so changes to the default prompts never reach existing users. Only the narrator has a legacy-hash migration.
\

\
\*\*Root cause (verified):\*\*
\
\- settings.js:
\
&#x20; \- \`useLocalSettings\` (\~212-219) writes quick choices only to localStorage.
\
&#x20; \- \`watchSettings\` (\~194-209) replaces \`state.settings\` with the server copy on any difference.
\
&#x20; \- \`loadSettings\` (\~166-189) uses the cache only on error, and seeds the doc with every prompt text through \`setDoc(ref, seed)\` at \~186.
\
\- app.js \`enterApp\` (\~233-251): on a load failure it alerts and uses defaults, with nothing preventing a later save.
\
\- DEFAULT_SETTINGS copies the prompts (\~16-17, \~42-43). Only the narrator prompt has hash migration (\~57-61).
\

\
\*\*Fix:\*\*
\

\
1\. Device-local overrides.
\
&#x20; \- Keep a separate key \`nera.settings.local.\<uid>\` holding only \`{ profileId, reasoning: { enabled, effort } }\` (whatever \`useLocalSettings\` sets today).
\
&#x20; \- Apply them in one function, \`withLocal(serverSettings)\`. Use it in \`loadSettings\`, in \`watchSettings\` (\`state.settings = withLocal(normalize(server))\`), and after \`saveSettings\`.
\
&#x20; \- An explicit Save in the Settings dialog writes those values to the server and clears the matching local keys.
\
2\. Failed-load guard.
\
&#x20; \- \`loadSettings\` sets \`state.settingsSource = 'server' | 'cache' | 'defaults'\`.
\
&#x20; \- \`saveSettings\` throws "Settings did not load from the server; reload before saving." unless the source is \`'server'\`.
\
&#x20; \- \`watchSettings\` sets the source to \`'server'\` on the first non-cache snapshot. After that, saving is allowed and the alert banner is removed.
\
&#x20; \- settings-view \`handleSaveSettings\` (\~355) shows the error through its existing \`feedback\`.
\
&#x20; \- app.js \`enterApp\` alert text: "Using saved or default settings. Changes cannot be saved until the server copy loads."
\
3\. Prompt defaults are stored as "not overridden". No migration: old docs that contain copies keep working.
\
&#x20; \- On seed (\~186), write the doc without prompt keys whose value equals the current default.
\
&#x20; \- On \`saveSettings\`, delete prompt keys equal to the current default (\`deleteField()\`), so they follow future default changes.
\
&#x20; \- \`normalizeSettings\` already fills missing prompt keys from the defaults (check \~42-43). Leave that as is.
\
&#x20; \- Settings-view prompts panel: add a "Reset to default" link per prompt. It fills the default text; the save then removes the key.
\
&#x20; \- Old docs whose copy equals an older default stay pinned until the user resets. That is acceptable under the no-migration rule. A legacy-hash list like the narrator's can be added per prompt later.
\

\
\*\*Acceptance:\*\*
\
\- Choosing a profile on phone A does not change the choice on phone B, and is not reverted on A by B's server snapshot.
\
\- Saving in the dialog makes it the server value and clears A's override.
\
\- Simulate a failed load (block firestore.googleapis.com once at startup). Saving shows the error, and the server doc is unchanged. After the connection returns, saving works.
\
\- A new account's settings doc contains no prompt text unless the user edited a prompt.
\

\
\*\*Tests:\*\* settings tests for:
\
\- \`withLocal\` merging
\
\- \`saveSettings\` rejecting when \`settingsSource !== 'server'\`
\
\- seed and save stripping prompt keys equal to the defaults
\
\- \`normalizeSettings\` filling them back
\

\
\*\*Depends on:\*\* none (independent of U1-U6).
\

\
\---
\

\
\## U8. Indicator, context viewer, and chat cache cost
\

\
\*\*Findings covered:\*\* 4.2 (non-send part).
\

\
\*\*Problem:\*\*
\
\- Every keystroke rebuilds the whole context and re-tokenizes the draft: the indicator in \`autoGrow\` (\~219-226) and the context viewer (debounced 400 ms).
\
\- Every render of the context viewer calls \`prepareMemorySnapshot\` → \`reconcileStory\`. That costs 1 session read, plus possibly N lore reads and C history reads. Renders happen on each \`memory-refresh\`, which fires on every session snapshot (\~467).
\
\- \`saveChatCache\` loads every cached history from IndexedDB on each save, just to prune.
\

\
\*\*Root cause (verified):\*\*
\
\- chat-view \`initChatView\` \`autoGrow\` (\~219-226) calls \`updateIndicator()\` per input event.
\
\- \`updateIndicator\` (\~953) runs \`computeContextUsage\` with \`draftText\`.
\
\- context-viewer.js \`render\` (\~19-27) calls \`prepareMemorySnapshot()\` every time.
\
\- context-viewer.js:10-11 re-renders on \`memory-refresh\`, which \`subscribeChat\` dispatches unconditionally at \~467.
\
\- chat-cache.js \`saveChatCache\` calls \`getAll()\` after each \`put\`.
\

\
\*\*Fix:\*\*
\

\
1\. Debounce the indicator.
\
&#x20; \- In \`autoGrow\`, replace the direct call with \`scheduleIndicator()\`:
\
&#x20; \`\`\`js
\
&#x20; clearTimeout(t); t = setTimeout(updateIndicator, 300)
\
&#x20; \`\`\`
\
&#x20; \- Other callers keep calling it directly.
\
&#x20; \- In \`updateIndicator\`, while \`!historyMessages && hasEarlier\` and memory is off, compute from \`lastMessages\` (the label already says "recent history estimate", \~970), instead of \`ensureHistory()\`. A full read then happens only when a send needs it.
\
&#x20; \- With memory on, keep \`ensureHistory()\`. The memory chip needs whole-history turn numbers.
\
2\. Context viewer.
\
&#x20; \- Call \`prepareMemorySnapshot()\` only when the sheet opens, and when the user presses a new "Refresh" button.
\
&#x20; \- On draft input and on \`lore-changed\`, \`memory-refresh\`, \`session-changed\`, or \`settings-changed\`, re-render from \`memorySnapshot()\`, which needs no read.
\
&#x20; \- Dispatch \`memory-refresh\` only when \`memory\`, \`memoryState\`, or \`loreRevision\` changed. This is in U2 step 4.
\
3\. chat-cache.js. Keep a small record per user, \`{ key: 'meta:'+uid, order: [sessionId…] }\`, in the same store.
\
&#x20; \- \`saveChatCache\`:
\
&#x20; \- get \`meta\`
\
&#x20; \- if \`order[0] === sessionId\`, stop: no prune needed (this is the common case)
\
&#x20; \- otherwise move \`sessionId\` to the front, write \`meta\`, and delete the keys for \`order.slice(3)\`
\
&#x20; \- If \`meta\` is missing (old cache), run today's \`getAll\` once, build \`meta\`, then continue.
\
&#x20; \- \`loadChatCache\` is unchanged. \`uid:sid\` and \`meta:uid\` keys never collide.
\
&#x20; \- Add \`clearChatCache(uid)\` for U9i; MAIN has the same function.
\

\
\*\*Acceptance:\*\*
\
\- Typing 100 characters runs the context build at most a few times (once per 300 ms pause).
\
\- With the context viewer open, typing causes no Firestore reads. Each remote session snapshot causes no read from the viewer.
\
\- With memory off, after another device edits history, no full \`getMessages\` runs until the next send.
\
\- Saving the cache for the already-current story does a \`get\` and a \`put\` only, with no \`getAll\`.
\

\
\*\*Tests:\*\*
\
\- chat-cache tests with \`fake-indexeddb\`, if it is already a dev dependency; otherwise test the pure \`nextOrder(order, sid)\` helper:
\
&#x20; \- meta is updated
\
&#x20; \- pruning happens only when the order changes
\
&#x20; \- the old-cache fallback works
\
\- Context-viewer: none (UI). Manual check that the Refresh button reloads.
\

\
\*\*Depends on:\*\* U2 (the \`memory-refresh\` filter).
\

\
\---
\

\
\## U9. Small UI fixes (5.13 split)
\

\
\*\*Findings covered:\*\* 5.13 a-m, U-N7. Each sub-item is independent. Do them in the order listed.
\

\
\*\*a. "null" in status text (U-N7, 5.13).\*\*
\
\- Root cause:
\
&#x20; \- memory-settings-view\.js \~78 builds \`'Paused. '+live.session.memoryState.lastError\`.
\
&#x20; \- chat-view \`runAssistantTurn\` \~1092 and \~1095 use \`sceneWarning += …\` when \`sceneWarning\` can be \`null\`.
\
\- Fix: in memory-settings-view, use \`['Paused.', lastError].filter(Boolean).join(' ')\`. In chat-view, use \`sceneWarning = [sceneWarning, '…'].filter(Boolean).join(' ')\`.
\
\- Acceptance: no "null" text appears.
\
\- Test: a unit test on a small \`joinWarnings\` helper.
\

\
\*\*b. Catch-up dialog and manual update feedback.\*\*
\
\- Root cause (memory-settings-view\.js \~96-105):
\
&#x20; \- \`extractedThroughOrder ?? Infinity\` counts 0 turns when the pointer is \`null\` (never started). It should count all eligible turns.
\
&#x20; \- The Start button stays disabled after an error or after finishing.
\
&#x20; \- \`manualUpdate\` (\~56) shows nothing when \`updateNow\` returns \`false\`. The \`idle\` status event carries a message, but chat-view's \`memory-status\` handler only toasts on success or failure.
\
\- Fix:
\
&#x20; \- Use \`extractedThroughOrder ?? 0\`.
\
&#x20; \- Wrap the run in \`try/finally\`, re-enable the button there, and change its label to "Done" or "Retry".
\
&#x20; \- In the chat-view \`memory-status\` handler, also toast \`detail.message\` when \`status === 'idle' && detail.manual && detail.message\`.
\
&#x20; \- In \`manualUpdate\`, if the result is \`false\` and no event fired (busy or running), toast "A reply or memory update is running; try again when it finishes."
\
\- Acceptance: each path gives visible feedback.
\

\
\*\*c. Rebuild confirmation.\*\*
\
\- Root cause: lorebook-view\.js \~124 starts \`rebuild\` with no confirm. Rebuild re-extracts the whole story, which costs one LLM call per due range.
\
\- Fix: before running, compute the ranges from \`dueRange\` on a pointer-0 copy (pure, no LLM call). Then \`confirm(\\\`Rebuild will re-read ${turns} turns in about ${calls} model calls and mark generated notes for review. Continue?\\\`)\`.
\
\- Acceptance: cancelling makes no writes.
\

\
\*\*d. Buttons left disabled after errors.\*\*
\
\- Root cause: lorebook-view\.js new-card Save (\~152), Import (\~274), and reorganize Save (\~371) set \`b.disabled = true\`. The \`button()\` wrapper in memory-ui.js catches and toasts but never re-enables.
\
\- Fix: in memory-ui \`button()\`, re-enable in \`finally\` when the action threw:
\
&#x20; \`\`\`js
\
&#x20; try { await fn(b) } catch (e) { toast(e.message); b.disabled = false; }
\
&#x20; \`\`\`
\
&#x20; Successful actions usually re-render anyway.
\
\- Acceptance: after a failed Import, the Import button can be clicked again.
\

\
\*\*e. Paste size cap.\*\*
\
\- Root cause: lorebook-view\.js \~259. Pasted text has no limit, while the file picker caps at 2 MB.
\
\- Fix: apply the same 2 MB check (\`new TextEncoder().encode(text).length > 2\*1024\*1024\`) and show the same message.
\
\- Acceptance: a 3 MB paste is rejected with that message.
\

\
\*\*f. O(n²) in lorebook-view.\*\* Done in U4 step 3. Listed here so 5.13 is fully covered.
\

\
\*\*g. Rebuild runs prepare repeatedly.\*\*
\
\- Root cause: lorebook-view calls \`prepareMemorySnapshot()\`, then memory-updater \`rebuild\` calls \`prepare\` twice, then \`catchUp\` and every \`start\` call it again. That is 1 session read per call, plus \`getLore\` after each commit before the U3 fix.
\
\- Fix: after U3 step 2, remaining calls cost 1 read each. Additionally, drop the lorebook-view call before \`rebuild\` (rebuild prepares itself), and drop the second \`prepare\` in \`rebuild\` (\~45), because \`markGeneratedForReview\` returns the updated entries; patch them instead.
\
\- This overlaps with the memory/lore plan; whichever plan lands first owns it.
\

\
\*\*h. False "unsaved" state in story memory settings.\*\*
\
\- Root cause: settings-view\.js \`handleSaveSession\` (\~400-433) does not call \`fillMemory(partial.memory)\` after saving. The raw field values differ from the normalized ones, so \`memoryDirty\` stays true.
\
\- Fix: after a successful save, call \`fillMemory(normalizeMemory(saved.memory))\` and reset the dirty baseline.
\
\- Acceptance: Save, then close; no "discard changes?" prompt.
\

\
\*\*i. Clear device caches on logout.\*\*
\
\- Root cause: app.js \`initAuth\` calls \`stopAll\` and reloads on an auth change, but leaves IndexedDB \`roleplay-chat-cache\` and the localStorage keys in place:
\
&#x20; \- \`nera.settings.\*\`
\
&#x20; \- \`nera.lore.seen.\*\`
\
&#x20; \- \`nera.memory.\*\`
\
&#x20; \- the U7 local overrides
\
\- Fix: in the logout path (sidebar logout button → \`logout()\`, and in \`initAuth\` when the user changes from A to null), before the reload:
\
&#x20; \- \`await clearChatCache(previousUid)\` (U8)
\
&#x20; \- remove the localStorage keys with the prefixes \`nera.settings.\`, \`nera.lore.seen.\`, and \`nera.settings.local.\<uid>\`
\
\- Keep purely device UI keys, such as \`nera.memory.showScene\`.
\
\- Acceptance: after logout, IndexedDB has no entries for the old uid.
\

\
\*\*j. Clipboard fallback and a sheet listener leak.\*\*
\
\- \`memory-ui.js copy()\`: reuse the \`copyText\` fallback logic from chat-view (\~916-940). Move it to a shared \`js/ui/clipboard.js\` and import it in both files.
\
\- \`memory-ui.js sheet()\` adds a \`keydown\` listener and removes it only in \`hide\`. In \`sheet()\`, also remove it when the root leaves the DOM:
\
&#x20; \`\`\`js
\
&#x20; const mo = new MutationObserver(() => { if (!root.isConnected) { cleanup(); mo.disconnect(); } }); mo.observe(document.body, { childList: true, subtree: true });
\
&#x20; \`\`\`
\
&#x20; Or make sub-sheet removal always go through \`hide\`, which is simpler. Find the places that call \`.remove()\` on a sheet root and replace them with \`hide()\`.
\
\- Acceptance: copy works on HTTP and older iOS. Opening and closing sub-sheets 20 times leaves one \`keydown\` listener.
\

\
\*\*k. aria-expanded on toggles.\*\*
\
\- Settings-view already sets it on the reasoning and advanced checkboxes (\~257-258).
\
\- Add \`aria-expanded\` (and \`aria-controls\`) to:
\
&#x20; \- the memory chip popover trigger
\
&#x20; \- the lorebook book toggles
\
&#x20; \- the context-viewer \`details\`-like toggles
\
\- Update the value when the state changes.
\
\- Acceptance: a screen reader announces expanded and collapsed.
\

\
\*\*l. Context-viewer "Update now" feedback.\*\*
\
\- Root cause: context-viewer.js \~44 ignores the result of \`updateNow\`, and the button does not re-render.
\
\- Fix:
\
&#x20; \`\`\`js
\
&#x20; button(..., async b => { b.disabled = true; const ok = await updateNow(...); if (ok === false) toast('Nothing to update yet, or an update is already running.'); void render(); })
\
&#x20; \`\`\`
\
\- Acceptance: each click gives visible feedback.
\

\
\*\*m. Misleading .gitignore comment.\*\*
\
\- Root cause: \`.gitignore\` says "Real Firebase config — never commit (injected by CI from repo secrets)" above \`js/firebase-config.js\`. But that file is in the repo and is used by GitHub Pages. Firebase web config is public by design; security comes from the rules and Auth.
\
\- Fix: replace the comment with "Firebase web config is public by design (security is in firestore.rules). Keep this file committed for GitHub Pages." and remove the ignore line. Alternatively, keep the ignore line only if CI really injects the file; check \`.github/workflows\`. If no workflow writes it, remove the line.
\
\- Acceptance: the comment matches what the deploy actually does.
\

\
\*\*Tests for U9:\*\*
\
\- Unit tests for a (\`joinWarnings\`), b (the turn count with a \`null\` pointer, as a pure helper), e (the size check helper), and i (the list of key prefixes, as a pure function).
\
\- Manual checks for the rest.
\

\
\*\*Depends on:\*\*
\
\- f depends on U4.
\
\- g depends on U3.
\
\- i depends on U8 (\`clearChatCache\`) and U7 (the local key name).
\
\- The others are independent.
\

\
\---
\

\
\## Implementation order summary
\

\
1\. \*\*U1\*\* busy token and stale checks (4.1, 5.9, U-N1, U-N2, U-N5, U-N6). This is the highest risk, and the other tasks build on it.
\
2\. \*\*U2\*\* send-path reads and a single session source (4.2, 4.4). About 11 reads per send become about 7.
\
3\. \*\*U3\*\* lore listener recovery and lore write cost (4.3, U-N3, U-N4).
\
4\. \*\*U4\*\* render cache, turns memo, and overwrite fields (5.1, 5.10, 5.12).
\
5\. \*\*U5\*\* truncated replies, Stop and timeout, effort validation, tokenizer label (5.3, 5.5, 5.6, 5.2). Port task first.
\
6\. \*\*U6\*\* draft and iOS gaps (5.4, 5.8). Port task first.
\
7\. \*\*U7\*\* settings overrides and the failed-load guard (5.7).
\
8\. \*\*U8\*\* indicator debounce, context-viewer reads, chat-cache meta (rest of 4.2).
\
9\. \*\*U9\*\* small fixes a-m (5.13, U-N7).
\

\
All tasks add no new LLM calls. The only call-count change is U5 step 1.2, which removes the scene-recovery call on truncated replies.
\

\

\
\---
\

\
\# Final checks (after all phases)
\

\
1\. All tests pass. The count is 147 plus every test added by the tasks; nothing is skipped.
\
2\. \*\*Golden test (C2):\*\* with toggles off, the request equals MAIN's builder for all 13 scenarios.
\
3\. \*\*Call count:\*\* in a session with Scene and memory on, record 20 turns. No turn may make more than 2 LLM calls (narrator plus at most one of recovery, extraction or summary).
\
4\. \*\*Read count:\*\* one send makes about 7 Firestore reads (it was about 11; see Part U). Opening the context viewer adds reads only on open or Refresh.
\
5\. \*\*Scene format:\*\* run the eval in \`investigate/\` on a long real history, not only on the 2-message fixtures. The tag rate and the parse rate should both improve compared with before Phase 1. Save the numbers in \`investigate/report.md\`.
\
6\. \*\*iOS:\*\* check by hand: no black gap after a reply or under the composer, no zoom on edit, and the editor height fits its text.
\
7\. \*\*Deploy:\*\* the built \`\_site\` contains only app files. No \`REVIEW_FINDINGS.md\`, \`FIX_PLAN\*.md\`, \`investigate/\`, \`tests/\` or \`\*:Zone.Identifier\`.
\
