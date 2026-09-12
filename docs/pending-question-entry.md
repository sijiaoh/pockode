# Pending Question Pill

How chat keeps an unanswered `AskUserQuestion` reachable after it has scrolled away. The chat feature as a whole is in [agent-chat.md](agent-chat.md); this document covers only this one affordance — what it does, and the reasoning that the code cannot state on its own.

## The problem

`AskUserQuestion` renders as a card in the message stream. An agent usually keeps producing output after asking (tool calls, text, work cards), and the list auto-scrolls while the user sits at the bottom, so the card is pushed out of view within seconds. The user loses the one signal that matters — *there is a question waiting on me* — and the agent looks hung when it is in fact blocked on an answer.

## What it is

A pill floating at the top of the message list. It appears while at least one unanswered question is out of view, and tapping it scrolls that question back and highlights it.

```
┌──────────────────────────────┐
│ (?)  Question waiting     ↑  │
└──────────────────────────────┘
```

It floats inside the message list's `relative` container rather than sitting in the chat header:

- Vertical space is scarce on a phone, and a permanent banner would spend a row on a state that is usually absent. The pill only exists when it has something to say and never pushes layout around.
- It describes the *current session's message stream*, so living inside the list gets its lifecycle for free — `MessageList` is keyed by `sessionId` and unmounts entirely when an overlay (file, diff, commit, settings) takes over the pane, and the pill disappears with it. No teardown of its own.
- The scroll-to-bottom button already floats at the bottom of that same container, so the pill takes the top edge and the two never contend for the same spot. It borrows that button's chrome (`rounded-full`, opaque `bg-th-bg-primary`, `shadow-xl`) so the pane has one vocabulary for floating controls, and swaps the border for `th-warning` — the colour the pending card is already outlined in, so the pill and its target read as the same thing without either of them saying so.

The position stays fixed at top-center even when the target is *below* the viewport; the arrow inside the pill carries the direction. A control that moves between the top and bottom edges to track its target is harder to hit than one that stays put.

## When it shows

Two inputs: the unanswered questions, and whether each one is on screen.

`findPendingQuestions` (`web/src/utils/pendingQuestions.ts`) reads the set straight out of `messages`, off the same `status === "pending"` that `messageReducer` already maintains for the card itself — one answer to "is this question still open", not two that can disagree. Nothing is mirrored into a store, and visibility is never written back into a message: a message is an immutable record of what happened, while visibility is a fact about right now.

**Visible** means the card's collapsed header row is *fully* in view (`intersectionRatio >= 0.99`, with the scroll container as root). The header row rather than the whole card, because an expanded card can be taller than the viewport and would then never qualify; and *fully* rather than partially, because a user who can see 3px of a card's edge does not know there is a question above it.

A rendered card is assumed to be on screen until the observer reports on it. Starting from "hidden" instead would flash the pill over a question the user is already looking at whenever the first callback lands after the debounce; guessing this way round only ever delays the pill by one callback.

**A question with no visibility entry counts as hidden.** The map is rebuilt around the cards that actually exist, so an answered question cannot leave a stale "visible" behind to suppress the pill, and a question the map has not caught up with yet errs toward being announced. Erring in that direction is what stops an old unanswered question from vanishing from the UI altogether — precisely the failure this feature exists to prevent.

A question in history the client has not paged in yet is a different case: it is not in `messages` at all, so it is not in the pending set either and the pill says nothing about it. In practice a pending question blocks the agent, so nothing can be written after it and it sits in the newest page the subscription already returned.

Everything else follows from the hidden set:

| | |
|---|---|
| Shown when | at least one pending question is hidden |
| Count in the copy | how many are *hidden* — a question already on screen does not need to be announced |
| Jump target | the earliest hidden one |

Defining it this way removes any need for "where did I jump last" state. After a jump the target becomes visible and leaves the set on its own, so the pill either disappears or starts pointing at the next one. Multiple unanswered questions need no extra rule.

Appearing is debounced by 250ms because streaming output reflows the list constantly and an undebounced pill would flicker. Disappearing is immediate — once the user can see the question, the control should get out of the way.

## Jumping

Tapping the pill scrolls the target card into view (`block: "start"`), rings it for 1.5s, and moves focus to its header row.

Three things about that sequence are load-bearing:

- **`scroll-mt-14` (56px) lives on the card root**, the node that actually receives `scrollIntoView` — `scroll-margin` has no effect on an ancestor wrapper. The value is tied to the pill's own geometry: the pill's bottom edge sits at 52px on desktop, and with several questions waiting it *stays* after the jump, so a smaller margin would park the card underneath the button that just scrolled to it.
- **The jump leaves the tail.** The list auto-follows new output while the user is at the bottom, and a jump is a deliberate move away from it; unless the jump clears the at-bottom flag itself, the next reflow of streaming output snaps back down and the tap appears to do nothing.
- **Focus uses `preventScroll: true`**, or the browser's focus scroll fights the smooth scroll already in flight. Focus lands on the header row, not the first option: arrow keys inside a radio group would change the selection, and focusing a form control on iOS pulls up a scroll of its own.

The ring is applied as a class on the node the code already has in hand rather than as React state threaded down through `MessageItem` and `ContentPartItem` — it is a transient visual effect, not something the tree needs to know about. Moving it always removes it from the previous card first; keeping only the timer would strand a ring on that card permanently when two jumps land within 1.5s.

There is no auto-expand: a pending card starts expanded and only collapses once answered, so the target is already open unless the user deliberately closed it.

## Edge cases

| Situation | Behaviour |
|---|---|
| Question already in view | No pill. Its only reason to exist is a question the user cannot see |
| Question above / below the viewport | Pill either way, `ArrowUp` / `ArrowDown`; position unchanged |
| Several unanswered | One pill, counting the hidden ones; jumps to the earliest, then points at the next |
| Question answered, cancelled or expired | It leaves the pending set; when the set empties the pill goes immediately. No "answered" confirmation — the card itself says Answered |
| Session switch | `MessageList` is keyed by `sessionId` and remounts; the state resets with it |
| Overlay opened | `MessageList` is unmounted; on return, visibility is judged afresh |
| Question just arrived, user at the bottom | Auto-scroll already brought it into view, so no pill until later output pushes it out |
| Streaming / agent running | Irrelevant. Unanswered is unanswered |
| Reconnecting | No conflict: `ReconnectBanner` is in `AppShell`'s document flow above the whole app row, the pill floats inside the list |

## Accessibility

- The live region (`<output>`, whose implicit role is `status`) is **always mounted** and only its contents are conditional. A live region that appears together with its content is not announced by most screen readers. It is `pointer-events-none` so an empty one cannot swallow taps meant for messages underneath.
- The pill's visual height is 36px (40px on `sm:`); the hit area comes from the `touch-target` utility, which lays a pseudo-element over it — 36px always, 44px where a finger may land ([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) — without changing how it looks. It floats over the message list, so its own height is the layout and growing the box was not an option.
- Entrance animation, jump scrolling and the ring's fade-out all degrade under `prefers-reduced-motion: reduce`.
- No keyboard shortcut: the product is mobile-first, and the remaining shortcut space is already taken by Escape and the command palette.

## Deliberately not done

- **Pending permission requests are not covered.** `permission_request` has the identical problem, but its urgency and copy differ, so covering both would mean a pill that takes a variant. Generalise `pendingQuestions.ts` when that side actually asks, not in anticipation of it.
- **No dismiss button.** An unanswered question blocks the agent, so letting the user permanently silence the reminder is letting them wedge themselves. It goes away for one reason: the question stopped being both unanswered and out of sight.
- **No system notification or vibration.** That belongs to a notification system and is orthogonal to this entry point.

## Where it lives

| File | Role |
|---|---|
| `web/src/utils/pendingQuestions.ts` | `findPendingQuestions(messages)` — the pending set, derived and testable |
| `web/src/components/Chat/PendingQuestionPill.tsx` | Presentation only: `count`, `direction`, `onClick` |
| `web/src/components/Chat/MessageList.tsx` | Visibility observation, debounce, scroll, highlight, focus, live region |
| `web/src/components/Chat/AskUserQuestionItem.tsx` | `data-question-request-id` on the card root, `data-question-header` on the header row |
| `web/src/index.css` | `question-pill-in` entrance animation and `.question-highlight`, both with reduced-motion fallbacks |

The hooks are data attributes rather than `id`s: an `id` is document-global and would collide if the same request were ever rendered twice, whereas these lookups are already scoped to the scroll container.
