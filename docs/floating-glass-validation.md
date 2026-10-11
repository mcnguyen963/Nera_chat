# Floating glass UI and old-message editing

Implemented on `main`, based on `9515db3`. The `feature-lorebook-improve` commit was not merged. The existing main-branch lorebook UI receives styling and compact-sheet presentation only; its record model, selection, persistence, prompts, and Firestore rules are unchanged.

## Changes

- A 52px row of floating controls plus the device safe area, overlaid on the conversation with no header fill, border, shadow, or blur. Each top icon button has its own rounded background with 20px backdrop blur and a 20% smoked tint. The story name is hidden; Stories, a context usage ring that gradually changes from gray to red as input usage reaches the configured limit, and More remain accessible. Empty space between the controls passes pointer gestures through to the story. Initial message padding and scroll alignment keep the first turn below the controls. More retains Settings, Memory, Summarize, Lorebooks, and maintenance actions.
- A closed-by-default stories drawer; 12px phone reading gutters, 16px story text, 1.65 line spacing, and a 780px desktop reading width.
- A frosted rounded composer with a full-width native textarea and a bottom row of separate, directly accessible Model and Thinking selectors beside 44px action controls. There is no combined model/thinking popup; long model names truncate within the available row width. Its outer wrapper has no filled rectangle; it overlays the story so text can scroll behind the field, while 24px backdrop blur and a 62% smoked tint separate the draft from story text. Focus increases these to 28px and 72%. Batched height measurement reserves enough scrollable padding for the last message to clear the controls as the input grows or shrinks. The field is associated with its message form; profile and thinking controls have no message form owner. Rewrite, Continue, Restore, Send, and Stop preserve their existing operations.
- Transparent Copy and an adjacent labelled message menu sit on the message header row, aligned right beside the assistant/pet label. Editor Save and Cancel stay below the draft. Floating Copy uses a 5% tint, 3px blur, a faint border, and no shadow. Floating Copy hit-tests the conversation midpoint, requires a completed message taller than the conversation area with its header Copy offscreen, and hides during editing, selection, and open surfaces. Clipboard fallback restores focus, selection, and scroll.
- Shared glass styling and SVG helpers across authentication, welcome, navigation, settings, memory, lorebooks, context viewing, editors, sheets, and notifications. Short sheets sit at the bottom on phones; substantial sheets fill the available height. Blur is restricted to floating/navigation surfaces, with opaque, reduced-transparency, and reduced-motion fallbacks. Glass tint is 36% opacity on the remaining surfaces; the header itself is completely transparent.
- Visual viewport handling retains the browser-reported available height, avoids duplicate bottom safe-area padding when a software keyboard is inferred, and leaves pinch zoom alone.

The separate Model and Thinking selectors show only their selected values and dropdown arrows, with accessible names retained. Their compact 27px visual height sits inside 44px label targets. Composer padding and spacing stay compact; the writing area has a 36px minimum height, reduced by 17px from the previous 53px minimum while retaining native textarea growth and existing action targets.

## Older-message Save

The main branch restored older messages from the device cache while subscribing only to the latest chunks. Opening an editor used that displayed message's revision, and a save failure was rendered at the end of the conversation. Those paths allow stale revision conflicts with feedback outside the current reading area.

Opening Edit now refreshes the selected message from one bounded server chunk. Loading, saving, and errors appear in the editor. A concurrent edit keeps the draft and offers the latest saved version for review; replacement requires an explicit choice and a subsequent Save. Reads from an editor cancelled by a story switch cannot update the new story. This addresses the reproduced stale-cache paths; the reported phone occurrence has not been observed live.

## Automated verification

Run:

```sh
node --experimental-vm-modules --test tests/*.mjs
```

The full suite passes all 733 tests on Node v25.2.1. Focused coverage includes composer icon/label transitions, More routing, inline model/thinking switching and failed-save recovery, floating Copy eligibility and bounded hit-testing, displayed body content, clipboard fallback focus/selection/scroll restoration on success and failure, keyboard safe-area state, pinch zoom, old-message freshness, visible save errors/retry, concurrent-edit review, and story-switch races.

JavaScript syntax checks and `git diff --check` pass. HTML source checks verify balanced elements, unique IDs, message form ownership, the requested textarea attributes, and retained credential autofill.

## Checks not performed

Browser testing was explicitly declined. Actual layout checks at 320px, 390px, 430px, tablet, and desktop widths remain pending; source review is not visual verification. Physical iPhone 14 Pro Max Chrome checks also remain pending: typing, multiline deletion, keyboard dismissal, rotation, hardware keyboard, pinch zoom, accessory/AutoFill strip, and address-bar transitions.

Chrome owns its address bar. Nera adapts to its reported viewport; it cannot set an idle-hide rule or the amount of upward scrolling required to show the bar. Message-input attributes request autofill suppression and do not guarantee removal of the iOS accessory strip.

No live model calls, commit, push, or deployment were performed.
