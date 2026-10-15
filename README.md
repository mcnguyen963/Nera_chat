Hello world


## Director–Narrator mode

This branch adds an optional mode in **Settings → Prompts**. Classic is the default. Create a connection profile for the Director, select it for the story, and save its mode and instructions. Select the Narrator profile independently, or leave it on the active connection profile.

Director mode makes two model requests per narrative turn. A due summary or memory extraction can add one maintenance request. Its default input limit is 20,000 tokens, output limit is 4,000, and history window is five complete turns. Limits are estimates; inspect the actual Director and Narrator requests in the context viewer.

Use **Review live state, decisions & promises** to correct the scene or add older commitments. Dates use day/month/year and game hours use integers 1–24; unknown fields can stay empty. Modern-clock stories require an explicit live-state review before enabling the mode. Completed commitments are archived in turn records and leave the active ledger.

Scene attendance is separate from focus: the default is five focused NPCs plus the player, configurable under **Focused NPCs**. Other attendees remain present in a compact background note. Explicit class-roster passages are supplied as evidence, including absence exceptions; membership alone does not establish attendance. Directly named characters and locations take priority over broad cast cards in Director control lore. Custom Director prompts are preserved; the recognized previous built-in default upgrades automatically. The context viewer shows preparation, model, validation and save timings with reported cost.

The Director's contract is saved before narration. Canonical state advances only when completed narration is saved. If narration is cut off, Continue finishes the same contract; new turns wait. Regenerate rewrites the same contract. Re-plan evaluates the latest reply again from its original starting state. Continue after a completed reply cannot answer a pending player decision.

History edits require live-state review. Copies and backups preserve completed checkpoints; pending attempts are archived rather than resumed automatically. A missing connection profile, invalid Director JSON, or insufficient context budget stops the request with a recoverable error.

Pages deployment is configured for `feature/director-narrator`. Automated checks cover request assembly and persistence; live model quality, Firebase behavior, and device rendering require runtime validation.
