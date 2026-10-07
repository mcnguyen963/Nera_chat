# Main fixes adapted to story-memory

Compared `feature/story-memory` with the verified remote `main` commit `4523ae33a17ff35b514d7223a981526ada9072aa` on 7 October 2026. Applied the remaining relevant fixes without merging main's separate chat/context implementation.

| Main fix area | Handling in this branch |
| --- | --- |
| False stale-send errors after deletion or empty catch-up | Already uses history revisions and server reconciliation. Main's order-based catch-up is not used here. |
| Provider finish reasons | Added `max_output_tokens` normalization and rejection of `safety`, `recitation`, `blocklist`, and `prohibited_content`, in stream and non-stream paths. Other normal/unknown finish reasons remain supported. Truncated narration remains opt-in; truncated summaries still cannot replace checkpoints. |
| Mobile message editor | Added growth on input and released the fixed bubble height when text overflows. Cancel restores the rendered message. |
| Token-count cache | Already uses a bounded 3,000-entry LRU and does not cache tokenizer fallback estimates. |
| Settings recovery after failed startup | Saving first retries an authoritative server read. Recovered settings replace the draft for review; no write happens until the user saves again. Cached/default values cannot masquerade as server recovery. |
| Device-local profile and thinking choices | Already uses account-specific local overrides across reloads and remote settings updates; explicit Settings save removes the override. |
| Stop and idle timeout | Existing provider streaming has Stop and a 120-second idle timeout. Added cancellable, timed waits for reply preparation, including context construction and reconciliation inside the reply operation. |
| Logout and account caches | Pause new cache writes, cancel active generation and memory updates, clear in-memory story caches, and await started local writes before purging. Authentication transitions use the same preparation. Cache cleanup errors no longer prevent the rest of cleanup/sign-out. Summary callbacks check the active operation before committing. |
| Deployment hygiene | Existing app-only assembly retained; added removal of the Firebase example configuration from the artifact. Push trigger remains `feature/story-memory`. |

## Validation

- Baseline: 282 passing tests.
- After adaptation: **289 passing tests**, including seven additional regressions and expanded provider-finish tests.
- Existing 13 wire/usage parity cases remain green. These fixtures compare with earlier main `16b9356`; the newer main changes were reviewed directly, not claimed to have a frozen full-code parity test.
- Complete Pages assembly, JavaScript syntax, and whitespace checks pass.
- No paid provider calls, Firestore writes, browser/device tests, or deployment performed. Changes remain uncommitted at completion of this adaptation.

The branch keeps its story-memory scheduling, source checks, scene handling, fixed-plan behavior, 200–600-word narrator prompt, and 20,000-token summary ceiling.
