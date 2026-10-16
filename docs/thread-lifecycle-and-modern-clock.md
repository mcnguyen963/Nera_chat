# Thread lifecycle and modern Director clocks

Ordinary questions should receive an answer, an honest lack of knowledge, or a direct refusal in the current scene. Deferral needs an established reason. Narrator, Director and memory extraction receive the same required thread policy, including after a custom prompt. This reduces manufactured obligations; it cannot guarantee every model response follows the policy.

Only meaningful unresolved goals, substantive promises, accepted appointments, supported conflicts and player decisions belong in active threads. A suggestion is not player acceptance. Updates reuse the existing ID/title; matching scheduled metadata also prevents duplicate appointments under different titles. Existing incidental generated notes can be archived as background-unresolved by extraction. Authored goals require manual review.

## Scheduling and outcomes

Thread metadata is optional. It stores kind (`ongoing`, `appointment`, `commitment`), due date, optional clock, participants, optional location, and outcome. Unknown details remain unknown. Existing plain-text notes still work. Conservative legacy adoption recognizes one explicit scheduled date and at most one clock; ambiguous, hypothetical or stale evidence remains unscheduled.

An appointment or one-off commitment expires **72 fictional hours after its scheduled time**. For example, 24/10/738 08:00 expires at 27/10/738 08:00. Date-only 24/10/738 expires at 28/10/738 00:00. Real-world elapsed time does nothing. Broad goals, mysteries, relationships and **fixed Plan entries do not expire**.

Expiry archives an item as `expired-unresolved`, never as resolved. Other outcomes are `resolved`, `cancelled`, and `background-unresolved`. Timing alone does not establish attendance, rejection, betrayal or any story outcome. Closed items leave active context but retain their notes. Lorebooks → Events & threads → Archived shows archived lore entries. Director live state shows its recent archive (up to 200 items); older state snapshots remain in checkpoint history and full backups. Reopening an expired/background item makes it an ongoing goal with no stale deadline; set a new date to reschedule it.

Projection is local and deterministic: no per-turn model call or cloud scan was added. Lore expiry is shown from accepted scene state and persisted through the existing guarded memory-extraction write. Director ledger changes become canonical only with completed accepted narration; cancellation does not advance canonical state. Historical edits invalidate affected evidence and require review instead of silently treating stale timing as fact.

## Existing stories

1. Export a full backup, then reload the updated app.
2. Exact recognized built-in prompts update automatically. Custom prompts remain unchanged. To adopt the reviewed foundation, open story prompt settings and use **Use updated Classic Narrator defaults**, **Use updated Director Narrator defaults**, and the Director/default extraction reset where needed, then save. Both narrator modes share player agency, modern language/time, grounded consequences, NPC personality and direct dialogue rules. Intimacy remains non-graphic and adult; abuse is not eroticized.
3. If the app asks to review a legacy Director clock, open **Director → live state**. Confirm the date and modern `HH:mm`, select the conversion-review checkbox, and save. Hours 1–23 offer an `HH:00` suggestion. **Hour 24 has no automatic conversion**: explicitly enter both date and time. Existing `15:45` scene tags seed modern states directly.
4. Existing version-1 Director checkpoints and game-hour history stay unchanged. Regenerate reuses their saved contract. New planning needs reviewed modern live state; historical legacy Re-plan cannot silently reinterpret its original clock.
5. Review old threads as desired. Use **Thread timing and outcome** to correct schedules, resolve a completed matter, archive an incidental item, or reopen it. **Update now** can run normal extraction; no separate paid migration task runs automatically.

No bulk lore migration is required. Legacy and selective-record lorebooks retain their format and provenance. Native JSON, whole-book Markdown and card import/export preserve thread timing/outcomes. Existing Plan schedules, phases and manual Complete/Reopen behavior remain unchanged.

Modern Director state uses version 2 and `scene.time: "HH:mm" | null`; the contract/turn envelope stays version 1. Settings version 6 accepts versions 1–5. Provider profiles, effort and price limits are unchanged.

## Validation

Run the complete offline suite with `node --experimental-vm-modules --test tests/*.mjs`, syntax checks and `git diff --check`. The lifecycle tests cover exact expiry boundaries, unknown precision, legacy review/replay, duplicate appointments, evidence invalidation, guarded extraction and interchange. The offline comparison fixture remains inside its existing conservative $0.10 ceiling; this release does not authorize a paid run.

The supplied 947-message, 228-card backup is used only for local benchmarks. The UX benchmark preserves the actual 300 ms context debounce; the general unit harness accelerates that delay and must not be used for interaction latency. Desktop fixture timings do not prove real-phone responsiveness. Live Firebase, paid model behavior and real-phone checks are separate validation tasks.
