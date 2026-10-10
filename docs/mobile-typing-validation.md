# Mobile typing performance validation

Implemented 2026-10-10. The displayed count stays unchanged while the composer has focus and refreshes on blur. Send and the context viewer still build their own current request. Pets, context content, configured limits and storage remain unchanged.

## Desktop verification

- Node v25.2.1, macOS arm64.
- Full suite: 706 passed (`node --experimental-vm-modules --test tests/*.mjs`).
- Syntax checks for changed JavaScript modules and `git diff --check` passed.
- Frozen pre-change builder: `tests/fixtures/mobile-context/memory-context.js`, copied from the commit recorded in `SOURCE.txt`. Entire results (including serialized messages, totals, inspection, reports and errors) match over 320 matrix cases. Additional cases cover irregular persisted turns, required-only windows, regeneration and tokenizer recovery.
- Deterministic scheduler and composer tests cover focused typing, repeated remote refreshes, blur/refocus cancellation, stale results/errors, scope changes, frame batching, unchanged text/width, growing/shrinking and width changes. The chat integration test verifies deferred counts and sending the latest draft.
- Operation checks count both token-counter calls and message-ID accesses at 500 and 2,000 messages, for newest-first and aligned block selection; both scale linearly. Timing has no CI assertions.

Reproduce the benchmark with:

```sh
node --experimental-vm-modules tests/tools/benchmark-mobile-context.mjs
```

The benchmark uses the real vendored tokenizer, the default bounded 3,000-entry token cache, two warmups and five measured builds. Messages contain about 280 characters each. Newest-first has enough budget for all history; aligned blocks have a 12,000-token budget. Median wall-clock milliseconds on this desktop:

| Messages | Newest-first | Aligned blocks |
| --- | ---: | ---: |
| 500 | 5.26 | 2.98 |
| 2,000 | 39.77 | 10.72 |

Both desktop targets are met (<50 ms at 500, <150 ms at 2,000). A same-fixture frozen baseline measured 446.17 ms and 44.04 ms respectively at 500 messages. The 2,000-message frozen comparison was interrupted because the old repeated scans plus cache churn were slow; no completed timing is claimed. Pass `--compare` to include the frozen builder when reproducing. These are fixture measurements, not measurements of a saved production chat or phone.

## iPhone validation — pending

The agent has no access to the user's iPhone 14 Pro Max. Desktop tests do not establish phone behavior. Check Chrome on that device separately:

- Short and long chats: type continuously and pause; count should stay unchanged while focused.
- Multiline typing and deletion: textarea grows, shrinks, caps its height and scrolls beyond the cap.
- Open the keyboard while near the bottom and while scrolled up; composer stays correctly positioned.
- Blur: count refreshes once with the latest draft; quick refocus cancels queued refresh.
- Change settings or receive history/lore updates while typing; refresh waits for blur.
- Repeat with pets enabled and disabled; pet behavior was not changed.

No live model calls, storage migration, commit or deployment were performed.
