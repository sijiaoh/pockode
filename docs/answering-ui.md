# Answering UI

How a user answers the questions an agent asks. This is the presentation layer
only; the model under it — `question_post` / `question_cancel`, the unanswered
list on the session's turn state, `answering` on a message — is
[lifecycle.md](lifecycle.md), and this document does not restate it. The rest of
the chat feature is [agent-chat.md](agent-chat.md); the vocabulary every surface
paints, and the second dimension this one is, are
[lifecycle-ui.md](lifecycle-ui.md).

It replaces the pending-question pill, which this design retires.

## The one thing this fixes

Answering used to happen **in the message stream**, on the card the agent's
question arrived as. That only works while the question is the last thing in the
transcript. An agent that asks and keeps running pushes its own card out of view
within seconds, and once the transcript has grown a page the card is not even
loaded: the pill that reached it worked only because a question blocked the agent
and nothing could be written after it — an assumption the new model deletes on
purpose.

> **Answering is not a place in the transcript. It is a list, and the list is
> state.** The unanswered questions ride on the session's turn state, arrive with
> the chat subscription, update live and have nothing to do with paging. Every
> surface that offers to answer reads that list. The cards in the stream are
> records of what was asked and what was said back — they hold no form and no
> live state.

Three consequences, and they are the whole design:

- One surface that answers, holding every open question at once, whether or not
  their cards have been paged in — and it puts itself on screen, because it is
  reading state rather than waiting to be opened (§4).
- One row above the composer, always reachable, never scrolled away: what that
  surface says when it is not up (§2).
- A card in the stream that can be read but cannot be acted on, so there is
  never a second answer to "is this question still open".

> **An unanswered question is where the work has stopped.** It is not a
> notification that may be read at leisure: the agent is sitting on it, and
> nothing on that line moves until it is answered.

That sentence is the direction every trade-off below is decided in, and it is
the reason they lean the way they do. The panel shows itself rather than waiting
to be found; it comes back after the user has looked away rather than staying
down once dismissed (§4); it stays put when the list empties under it rather
than vanishing with what was typed in it (§3). Showing a question once more than
necessary costs a tap. Leaving one on a screen nobody is looking at costs
however long it takes somebody to wonder why the agent went quiet.

## 1. What a surface reads

| Name | Where it lives | Who reads it |
|---|---|---|
| `unanswered: PendingQuestion[]` | the chat subscription's session payload, on the turn state | the strip, the panel |
| `unanswered_questions: number` | `SessionListItem`, `SessionDetail`, `WorkListItem` | session rows, work rows, the attention dot |
| `pending_questions: PendingQuestion[]` | `work.detail` | the work detail page |
| the `question_posted` record in history | the message stream | the record card |

```ts
interface PendingQuestion {
  request_id: string;
  /** The short label the agent gave it; the chip on every surface. */
  header: string;
  question: string;
  /** Absent or empty means the whole answer is free text. */
  options?: { label: string; description?: string }[];
  multi_select?: boolean;
  asked_at: string;
}
```

**One `question_post` is one question and one `request_id`.** The card in history
can still hold several — records written by the old `AskUserQuestion` path do —
but nothing new is ever written that way, and every surface here counts
`request_id`s. This is what makes "decline this one" a sentence with a subject:
declining half of a multi-question request would need a second identifier that
the answer path does not carry.

**Rows carry the count, never the questions.** A sidebar of thirty sessions does
not need thirty question texts to draw thirty glyphs, and the full list already
arrives on the one session the user is looking at.

## 2. The strip

`BlockerStrip` is now `AttentionStrip`, and the rename is the design. Its
question changes from *why is the agent quiet* to **what needs you**, and two of
its four rows were never about a blocker: a question no longer blocks a turn at
all, and the send receipt never did. A name that describes one of four rows is a
name the next reader has to work around.

Everything else about it is unchanged — one line between the transcript and the
composer, `ForkOriginBanner`'s chrome, centred, `text-xs`, `size-3` glyph, muted,
one bordered row so the composer moves by at most one line's height
([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)).

| # | State | Glyph | Copy | Trailing action |
|---|---|---|---|---|
| 1 | `permission` blocker | `Lock` | "Waiting for your permission. Answer above or Stop before sending." | "Jump to request" |
| 2 | `unanswered.length > 0` | `CircleHelp` | "1 question is waiting for your answer." / "{n} questions are waiting for your answer." | **Answer** |
| 3 | a message went into a turn already open, unread so far | `CornerDownRight` | "Sent — the agent has not read it yet." | — |
| 4 | `background` blocker | `Hourglass` | "Waiting on a background task — nothing to answer." | "Details" (expands) |

**Permission stays first**, and now for a sharper reason than precedence: it is
the only row left that the composer is disabled under, and it is the only state
in which answering is *refused by the server* — the CLI holding a permission
request open reads nothing else, so an answer message cannot be delivered. The
strip has to say the thing that must happen first.

**Questions come second, above the receipt and the background line.** They are the
one row with something for the user to do that is not already on screen.

**Row 2 is not rendered while the panel is up**, and that is the whole of the
division between them. The panel *is* that sentence — the questions are on
screen, counted in its own title — so a row saying they are waiting would be the
same fact twice, with a button that opens what is already open. Close the panel
and the row comes back unchanged, and its **Answer** is the way back in (§4).

The row and the panel are driven by **one flag, in one render**. Letting the
strip work the panel's state out for itself would put a frame on screen with
both of them in it, and the composer would jump down and back up again inside
one close — a movement the user would actually notice, unlike the single line
below. Passing the strip no `onAnswer` while the panel is up would hide the row
as a side effect, and the strip would then take itself to be a chat with no way
to answer at all and fall through to row 3 or 4.

**Row 1's "Jump to request" closes the panel before it jumps, and it is now the
only way to reach a permission card at all.** A permission request can arrive
while the panel is up (§7) — and while the panel is up the whole transcript is
behind the backdrop and `inert` (§3), so no card in it can be seen or pressed,
whether or not it happens to be scrolled into view. Scrolling to something
under a backdrop would be the dead end this surface exists to remove, so the
jump closes the panel on its way. Closing costs nothing: the drafts stay (§5),
and the panel is one tap away afterwards.

**The panel changes the strip's height by one line, and that is left alone.**
Row 2 goes when the panel opens and comes back when it closes, so the composer
moves by the one line the strip was always allowed to move it by — the same
movement the row's own arrival has always made. Removing it would mean either
holding an empty frame open in the strip, which this section forbids, or taking
the panel out of the layout and giving it the four measurements §3 exists to
avoid.

**Row 2 says nothing about sending**, and that is the visible half of the model
change. Sending is not refused while a question is open — the agent may be
running, and a typed message is an ordinary message that answers nothing (§6).
Row 1's second sentence exists to explain a disabled Send; row 2 has no disabled
control to explain, so a sentence there would be inventing a restriction to
explain.

**"Answer" is a button, not a link.** Every other action on this strip is a way
to *look* at something — jump, expand — and wears the strip's underlined-text
grammar. This one is the action itself, and it is the entry point a user is meant
to find without hunting, so it is drawn as a small filled control:
`rounded bg-th-accent px-2 py-0.5 text-th-accent-text`, `touch-target` for its
hit area the way the text actions get theirs. Breaking the grammar once, for the
one row that is a call to action rather than a statement, is what keeps the
other three readable as statements.

`text-th-accent-text` and **not** `text-th-bg`: no stylesheet declares a
`--color-th-bg`, so a utility naming it is dropped and the button inherits the
strip's muted text on an accent fill — a contrast failure nothing goes red over.
`th-accent` under `th-accent-text` is also the pair `contrast.test.ts` already
guards, and `colorTokens.test.ts` now guards against naming a colour that does
not exist at all.

**The glyph stays muted like the other three.** `text-th-warning` on a glyph is
under the 3:1 non-text floor in every light variant
([project-ui.md §3](project-ui.md#3-the-row) holds the numbers), so a hue here
would be saying nothing in half the themes while costing the strip its one
vocabulary. The loud element is the button, whose `bg-th-accent` /
`text-th-accent-text` pairing the app already uses for every primary action.

**At zero questions the row does not exist.** No "nothing to answer", no empty
frame. The strip falls through to whatever it has to say next, and when it has
nothing it renders nothing — unchanged.

## 3. The answer panel

`web/src/components/Chat/AnswerPanel.tsx`. It is a **card centred in the
transcript's rectangle, over a backdrop that dims that rectangle and nothing
else**: a scrolling body between a fixed header and footer, drawn on
`bg-th-bg-secondary` with `Sheet`'s centred rounding, width and shadow, never
taller than **85% of that rectangle** and usually shorter, because its height is
whatever the questions need.

**The backdrop stops at the transcript's edges, and that is the whole of what it
covers.** The session header above it, and the strip, the session bar and the
composer below it, stay lit, reachable and usable. Dimming those would make this
a modal over the entire app — and the composer in particular is where the user
says the thing the questions did not ask for, which §6 exists to keep possible.

```
┌──────────────────────────────────────────────┐
│ session header                               │ ← not covered
├──────────────────────────────────────────────┤
│ ░░░ their conversation, dimmed and `inert` ░░│ ← covered by the backdrop:
│ ░┌─────────────────────────────────────────┐░│   not readable, not pressable,
│ ░│ 2 questions                         [×] │░│   not in the tab order
│ ░├─────────────────────────────────────────┤░│
│ ░│ [Database]                       14:02  │░│
│ ░│ Which database should I use?            │░│
│ ░│  ( ) Postgres                           │░│
│ ░│      Managed, and we already run one    │░│
│ ░│  (•) SQLite                             │░│
│ ░│      One file, no ops                   │░│
│ ░│  ( ) Other                              │░│
│ ░│  ☐ Won't answer                         │░│
│ ░│ ─────────────────────────────────────── │░│
│ ░│ [Region]                         14:02  │░│
│ ░│ Which region?                           │░│
│ ░│  ☑ Won't answer                         │░│
│ ░│  The agent will be told you are not     │░│
│ ░│  answering this.                        │░│
│ ░│  [ already said it above____________ ]  │░│
│ ░├─────────────────────────────────────────┤░│
│ ░│ 2 of 2 ready                   [ Send ] │░│
│ ░└─────────────────────────────────────────┘░│
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
├──────────────────────────────────────────────┤
│ AttentionStrip (row 2 absent — §2)           │ ← not covered
│ engine · mode                         [Stop] │ ← not covered
│ [ type a message… ]                  [ Send ]│ ← not covered, and usable
└──────────────────────────────────────────────┘
```

### It is modal over one rectangle, and nothing else

That one sentence decides most of this section. A modal habit is a consequence
of what is covered, so each of them is taken or left on exactly that test: the
transcript is behind a backdrop, and the header, the strip, the bars and the
composer are not.

| Modal habit | Taken, or not |
|---|---|
| backdrop, and closing by tapping it | **Taken.** A layer of `bg-th-bg-overlay` over the transcript, and a press on it closes the panel — the one-thumb dismissal, back because there is now something outside the card that is not a live control. The backdrop is its own layer *under* the card rather than one container around both, and the press is read by asking whether it landed on that layer itself, so a press that starts on a question's text and ends past the card's edge — selecting by dragging — is not a dismissal: `click` fires on what the press and the release have in common, which is the container, not the backdrop. `Sheet` separates the layers for the same reason. The listener is on `window` rather than a React `onClick`, for the reason §4 gives |
| window-level Escape | **Taken**, and it is the sharpest case. The panel shows itself without taking focus (§4), so a user facing a dimmed transcript who presses Escape is pressing it at nothing in particular — and Escape in this chat is the agent's interrupt. Reading that press as an interrupt ends a turn and cannot be taken back; reading it as "put this away" costs one more press to interrupt. `ChatPanel` stands its interrupt down for as long as the panel is up. Which surface owns the key, and how a surface drawn over this one claims it first, is §4 |
| `inert` over what is covered | **Taken.** See below |
| portal + `fixed inset-0` | **Not taken.** The card and the backdrop are `absolute inset-0` inside the wrapper around the message list, and the card is capped at `max-h-[85%]` of it. That rectangle already exists and already follows a window resize, a soft keyboard and an error bar appearing; a fixed layer would have to be told the header's height, the strip's, the composer's and the error bar's, and the strip's changes *because* of this panel (§2). It is also what makes the dimming stop where it does. `z-10` is enough: the list carries no stacking of its own, and the portalled sheets — `z-50`, `z-70` — still come out over this |
| body-scroll lock | **Not taken.** Only one region is covered; the page is the user's to scroll |
| focus trap | **Not taken.** Tab runs out of the footer into the strip, the bars and the composer. That is what "the composer stays usable" means on a keyboard |
| `aria-modal="true"` | **Not taken.** The card is a `role="dialog" aria-labelledby`, and that is as far as it goes: `aria-modal` tells a screen reader the rest of the screen is unavailable, and the composer, the strip and the header can all still be reached by Tab. Saying dialog without it is not the cheaper option; it is the true one |
| taking focus on open | **Not taken.** §4: only when a user action named a question, or when the panel's own arrival has just cost the document its focus |

Two things the old sheet had are kept for reasons that were never about being
modal: the header/body/footer skeleton, and **not being closeable mid-send** —
the `×`, Escape and the backdrop all go dead while a submit is in flight,
because on a slow relay a panel that can be closed leaves the user unsure
whether the answer went.

The body carries `overscroll-y-contain`, the same class the message list's own
scroller wears. An overscroll at either end stops at the panel instead of
leaving it — on touch that means the browser's rubber-band and its
pull-to-refresh, both a flick past the last question away. It is not the
transcript underneath that this protects: that scroller is a *sibling* of this
one rather than an ancestor, and scroll chaining only ever travels up.

**The transcript behind the backdrop is `inert`, and stays mounted.** `inert`
rather than `pointer-events-none`: with no focus trap over them, every dimmed
control would otherwise stay in the Tab order — *ahead* of the card — and stay
in the accessibility tree, which for a conversation the backdrop has plainly
put out of reach would be a lie in the other direction. The list is never
unmounted, because its scroll position is what the user gets back on closing
the panel and re-mounting would reload the history and lose it.

**One expression decides the card's rendering, the `inert` and the Escape
guard** (`answerPanelShown` in `ChatPanel`), so the three cannot disagree. Five
separate acts close the panel and a read-only session never opens one at all; an
`inert` cleared by hand would eventually be left behind by one of those six
paths, and the whole conversation would be out of reach with nothing on top of
it.

Two things follow from covering the transcript, and both are losses taken
knowingly:

- A visible card's **`Answer this` cannot be pressed while the panel is up.**
  It is a way to *that one* question, not a way in, and reaching it now means
  closing the panel first — which costs nothing (§5). The button itself is
  unchanged; what changed is that its host is behind a backdrop.
- A **permission card cannot be approved in place.** The strip's "Jump to
  request" is the only route to one while the panel is up, and it closes the
  panel on its way (§2, §7).

**The dimming is the point, not a decoration.** It says which surface the next
press belongs to, which is the thing the drawer form had to keep re-explaining:
with a lit transcript underneath, "is this still live?" had no answer the user
could see. What it costs is reading the conversation while answering, and §4 is
where that trade is argued.

### One shape at every width

Compact, regular and expanded all draw the same centred card over the same
rectangle. No `sm:`, no `lg:`, no `useIsExpanded()`.

Width decides layout *form* ([responsive-ui.md](responsive-ui.md)), and here
there is no second form to decide between: the transcript is one column at every
tier, and "centred in that column" means the same thing in all three. What width
does change it handles without a branch — `mx-4 w-full max-w-md`, so a narrow
screen gets the column less its margins and a wide one is held to `max-w-md`,
the same value `Sheet` uses centred. At the expanded tier the rectangle is
already narrowed by the sidebar, so this is never near the screen's width.

`Sheet`'s own split — drawer below the expanded tier, centred at and above it —
is deliberately **not** copied. It exists because `Sheet` is modal over the whole
page, where a bottom drawer is the thumb-reachable form; here the split would
make one panel two different things at two widths for no gain, and the centred
card is already inside a rectangle that is never the whole screen.

**No `max-w` on the text inside the card.** The question lines run as wide as
the card, which `max-w-md` has already sized for reading. A second cap inside it
would be one component obeying a rule the rest of the app does not have.

### Why not the shared `Sheet`

Now that this panel *has* a backdrop, the gap between it and `Sheet` is
narrower than it was — and still wide enough that sharing is the wrong answer.
`Sheet` ([packages/shared](../packages/shared/src/components/Sheet.tsx)) is a
portal onto `fixed inset-0`: its backdrop necessarily covers the sidebar, the
header and the composer, which is precisely the thing this panel must not do.
It also locks body scroll, traps focus, and picks its form from the width tier.
Reusing it would mean a variant switching three of those off and pinning the
fourth — not a second form of `Sheet` but a `Sheet` that may or may not be a
modal over the page; and `Sheet` is shared with `web-cluster`, so every reader
of it in either project would have to work out which branch they are in for the
sake of one caller in one project. That fails both of the bars `AGENTS.md` sets
for shared code.

What is left to duplicate is a few lines of Tailwind and one boolean. That
repetition is cheaper than an API surface spanning two projects, and because
those lines copy `Sheet`'s own centred values — `rounded-xl`, `shadow-xl`,
`max-w-md`, `bg-th-bg-secondary`, the header and footer borders and padding,
the `touch-target` close button, and the separate backdrop layer — the panel
looks exactly like every sheet in the app. Consistency from the tokens, which is
where it belongs. The one value deliberately *not* copied is the drag handle
(§8). `Sheet` itself is untouched, and its other callers with it.

### What it draws

**Title is the count** — "1 question" / "{n} questions" — and it is live: it drops
as questions are resolved while the panel is up. The verb is on the footer
button, where the thing it names actually happens. A title that said "Answer
questions" would spend the one fixed line on a word the button already carries,
while the count is the one fact that otherwise takes scrolling to work out — and
the one that answers "am I nearly done".

**One block per `request_id`, oldest first, in one flat scroll.** Not an
accordion and not a wizard: a wizard hides how much is left, forbids answering out
of order, and turns two questions into four taps. The stack is skimmable, and the
panel's body already scrolls between a pinned header and footer.

Each block reuses `web/src/components/Chat/QuestionForm.tsx`, which was a
private helper inside the old `AskUserQuestionItem.tsx` and is now a component
of its own, so the panel and the record card draw a question with one
implementation rather than with two branches of one.

Three shapes, decided by the question:

| Question | Control |
|---|---|
| `options` non-empty, `multi_select` false | radios, plus an **Other** radio with a single-line input |
| `options` non-empty, `multi_select` true | checkboxes, plus an **Other** checkbox with a single-line input |
| `options` empty | a multi-line `textarea`, placeholder "Your answer" |

The third row is the shape a question with nothing to pick takes. It needs no
second surface and no second copy, and it is multi-line where the Other input is
not: the answers that arrive there are paragraphs, not labels.

### Other and Won't answer are not alternatives

Both are on every block that has options, and each says something the other
cannot:

| | What the user is saying | What the agent is told |
|---|---|---|
| **Other** | "My answer is something else." | an answer, in the user's own words |
| **Won't answer** | "I am not answering this." | a decline, with an optional note |

A user facing three options, none of which fits, who wants to say *"use SQLite"* is
**answering**. Recording that as a decline would tell the agent the user refused
to answer, throw away the most useful sentence on the screen, and leave the card
reading `Declined` against the facts.

**What the server checks, and what it deliberately does not.** Every option
label is checked against the question it answers (`chat.validateAnswer`), because
a label nobody was offered would read in the agent's transcript as its own word
handed back to it. Free text is under no such rule and is recorded in a field of
its own — `text` beside `answers` — so the agent can see which is which. The rule
being kept is *"do not invent an option"*, not *"the user may not say anything
else"*.

The two halves stay apart all the way out: `answers` carries labels, `text`
carries the user's words, and the prose the CLI actually reads marks the second
as such rather than listing it beside the first
(`web/src/utils/answerMessage.ts`).

The same form is drawn read-only on a record card, where an answer's two halves
land in the two controls they were filled into — no guessing from the labels,
because the record kept them apart.

**Option rows clear 44px where a finger may land.** The record card's rows are
read-only and owe nothing; these are the only place in this design a user aims at
a row, so they take `pointer-coarse:min-h-11` on top of the card's `p-2`
([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)).

### Declining, per question

A checkbox at the foot of each block, labelled **"Won't answer"**. Checking it
disables that block's form, dims it, and reveals one muted line and one input:

> The agent will be told you are not answering this.
>
> `[ Add a note (optional) ]`

"Won't answer" rather than "Skip": skipping reads as *later*, and this resolves
the question for good. The line under it says who finds out, because that is the
whole point of declining over ignoring — it is the user's lever for a question the
agent forgot to withdraw, and because it travels as a message, it wakes the agent
up.

Checking it does not clear what was already selected. Unchecking restores it:
trying a thing and coming back should not cost what was typed.

### The footer, and partial submits

One row: `{k} of {n} ready` muted on the left, **Send** on the right. `k` counts
blocks that are *resolved* — a selection, non-empty free text, or a decline.
`Send` is disabled at `k == 0`.

**A submit may cover a subset, and that is the point.** Forcing all-or-nothing
means one question the user cannot decide holds up the two they can. What is not
submitted stays unanswered, stays in the list, and stays in the strip.

There is no Cancel button. The panel's own close — the `×`, Escape, or a press
on the backdrop — is the way out, and it costs nothing, because closing keeps
every draft (§5). A Cancel beside Send would promise that leaving discards,
which is exactly the promise this panel does not make.

### What is sent

One `chat.message` carrying
`answering: [{ request_id, answers?, text?, declined?, note? }]` — labels in
`answers`, the user's own words in `text`, and `note` only on a decline — and a
body composed from the same entries by `web/src/utils/answerMessage.ts`, the one
place the wording lives:

```
Answering:

Q: Which database should I use?
A: SQLite

Q: Which runtime?
A: Node · and, in their own words: pin it to 22

Q: Which region?
A: (not answering) already said it above
```

The lead is one word because the message may be the only thing the agent reads:
`answering` is Pockode's structure and does not reach the CLI, so the text has to
stand on its own. It is `Answering:` rather than a sentence so that one question
and five read the same.

The middle line is why the prose marks free text as the user's own. The record
keeps `answers` and `text` in separate fields, but the CLI sees only this string —
an unmarked sentence sitting beside an option label would read as a third option
the agent had offered.

**The call is all-or-nothing about what it carries** — which is not the same as
refusing a partial submit. The user chooses how many blocks to send; the server
then validates every `request_id` in *that* set against the session's live list
before delivering, and refuses the whole message with `-32602` naming the ones
that are no longer pending. Delivering a partially valid
message would hand the agent text answering something it has already stopped
waiting for — the confusion this redesign exists to remove — and the body is one
string, so there is nothing to deliver half of. §5 is what makes the refusal cost
the user nothing.

### When it closes

| After a submit | Behaviour |
|---|---|
| nothing unanswered left | closes |
| something left — not submitted, or asked while it was open | stays open, the submitted blocks leave, and a muted line at the top of the body reads "2 answers sent." until the next change |
| the list empties from elsewhere | **does not close** — "Nothing left to answer." and the footer button becomes Close |

A panel that vanishes under a finger is worse than one that explains itself, and
the last row is the case where the user may still have typing in it. Auto-closing
on an empty list would also make the panel's disappearance the notification that
someone else answered, which is a thing to be told rather than a thing to notice.

**This is why whether the panel is up is a flag that is held, not one derived
from the list.** `unanswered.length > 0 && !permission && !dismissed` is the
obvious way to write §4 and it makes the last row of that table unreachable: the
frame the last question leaves the list in is the frame the panel disappears in,
taking the half-typed answer with it. Showing itself (§4) only ever *sets* the
flag. What clears it is the `×`, Escape, a press on the backdrop, a submit that
left nothing behind, and the strip's jump to a permission card (§2) — five acts,
each of them something the user asked for. The first three are one action under
three names, and all three stand down mid-send (§3).

## 4. When the panel is up

**It shows itself.** A question waiting is enough: nothing has to be pressed to
read one, on arrival at the chat or when one lands while the user is there. This
reverses what this section used to say, and the reason it used to say it is worth
keeping in view. The old rule was *never opens by itself*, because the old sheet
covered the **whole screen** (§3): arriving at a chat behind a full-screen sheet
meant dismissing it before the thing the user navigated for was even visible,
the tap that brought them there had to be undone, and the session — the header,
the composer, the strip — was not on the screen at all. That argument was about
covering everything. This panel covers the transcript and stops there: the
session header, the strip, the bars and the composer stay lit and usable, the
card is one press or one Escape from gone, and what it dims is one press from
back. Arriving at the chat puts the user in the session *and* in front of the
question. What is left is the principle at the top of this document: a question
that nobody is looking at is work that has stopped.

The conversation is not readable while the card is up, and that is the one thing
the drawer form bought that this gives up. It is worth it because the drawer
paid for it twice over: a live transcript under a panel needs the tail held
above it, needs `Answer this` and a permission card to keep working underneath,
and still leaves the user without an answer to "which of these two surfaces am I
pressing?". One press on the backdrop is the whole cost of reading what is
behind it, and every draft survives that press (§5).

The gate is three facts, all of them about whether answering is possible at all:

- something is unanswered,
- the chat itself is on screen — a read-only session has no panel
  ([cross-worktree-session-ui.md](cross-worktree-session-ui.md#read-only-is-structural-not-a-rule-the-screen-keeps)),
  a loading one has a skeleton,
- no permission request is outstanding.

The last one is not politeness about precedence. While a permission request is
open the server *refuses* answers (§2), so a panel opened over one could only be
typed into and then turned away; the strip's first row is the thing that has to
be dealt with, and in that state the strip shows that row instead of row 2, so
there is no button to press either.

The panel opens during the same render that reads the list, not in an effect
afterwards. An effect paints one frame of bare transcript first, and a panel
arriving a beat late reads as something the app just *did*, rather than as the
state the chat was already in.

### Closing lasts one visit

**A close covers this stretch of looking at this chat, and nothing longer.** Go
away, come back, and the panel is up again — even though the user closed it by
hand, and whatever way they left:

| Leaving | Coming back |
|---|---|
| switching to another session | the panel is up |
| closing an overlay over the transcript — file, diff, commit, settings | the panel is up |
| arriving from the work list or a notification | the panel is up |
| reloading the page | the panel is up |

**All four are the same thing and get no exceptions**, the overlay least of all:
an exception is where a rule this short starts to rot, and an overlay is as much
"the user is looking at something else" as a session switch is. Closing says *not
now*; leaving and coming back is what ends that *now*. Being shown a question a
second time costs a tap. The alternative is a question that was closed once and
then never puts itself forward again while the agent waits.

Within one visit, exactly one thing brings the panel back up on its own: **a
`request_id` it has not shown yet**. The same list arriving again is not a new
question, and neither is a question that was on screen when the user closed the
panel over it — otherwise a close would be undone in the next frame by the very
question it was closing.

Mechanically this is one set of ids, "what this visit has put on screen", and
every way of leaving empties it. A reload needs no code at all: the set is in
memory, so the answer is the empty set by construction. Nothing about it is ever
written to a record — it is live state about this browser tab, and an event
record would have no way to stop lying about it.

### The three entry points, after all that

| Entry point | What it does | Anchored to |
|---|---|---|
| the strip's **Answer** (row 2) | the way back in after a close — one line above the composer, never scrolled away | the first unanswered question |
| the work detail's **Answer** | **take me to this one**: navigates to the chat, scrolls that question into view and reads the panel out | that question |
| a pending record card's **Answer this** | **take me to this one**, from the transcript — reachable only while the panel is *down*, the transcript being behind the backdrop and `inert` whenever it is up (§3) | that card's question |

"Anchored" means the panel scrolls that block into view. It never filters: a
panel holding one of three open questions would be a second, partial answer to
"what is waiting on me", and the user would find the other two only by going
back.

**The work detail's `Answer` narrows rather than disappears.** It no longer
decides whether the panel is up — the panel decides that for itself — but it
still carries something the panel cannot work out on its own: *which* question.
Showing itself lands on the oldest one, because nothing told it otherwise; a user
who pressed `Answer` on the row about the database means that one. Without it the
button degrades into a second `Open Chat` that lands somewhere else than where it
was pressed.

That intent rides as one-shot navigation state, **not as a URL**
(`web/src/lib/answerIntent.ts`). A URL naming a question re-anchors on every
reload and every share of the link, which is a transient act wearing a route.

**The pending card keeps its button, and it is still the one concession to the
stream.** The card is a record and holds no form (§6), but a card that states
`Pending` and offers nothing is a dead end, and nothing in this app states a
problem without stating the way out. The button is in the expanded body, not on
the header row — the header row is the expand toggle and its slot order is the
tool row's grammar ([tool-call-ui.md](tool-call-ui.md#the-row)), which has
nowhere to put a second control. It carries no state: it names the same question
the same way the work detail's does.

### Focus moves when the user named a question, or when the panel dropped it

| How the panel came up | The caret |
|---|---|
| by itself, and focus was somewhere that stays lit — the composer, the strip, the header | **does not move** |
| by itself, and focus was inside the transcript | moves to the panel |
| the strip's **Answer**, `Answer this`, the work detail's **Answer** | moves to the panel |

Moving it reads the panel out from its title. The first row is the rule and the
other two are the exceptions, and they come from opposite directions.

**Most of the time the caret is left alone.** The panel is usually up because a
question is waiting, not because anybody asked for it, and the composer stays
usable the whole time — so taking the caret would be taking it out of a sentence
somebody is typing. A user who pressed a button *naming* a question, on the
other hand, asked to be put there.

**The second row is a rescue, not a grab.** The transcript goes `inert` in the
same commit the panel mounts in, and a control focused inside it — a message's
menu button the user had just tabbed to — is blurred onto `<body>`, from where
Tab restarts at the top of the page rather than entering the panel that is the
reason it moved. The panel took that focus away, so the panel takes it.

The test is *where focus was*, not "is `activeElement` now `<body>`": pressing a
button that unmounts itself leaves `<body>` too, and treating that as a rescue
makes the panel announce itself on an overlay's way back. So `ChatPanel`
remembers the last focused element from a `focusin` listener on the document —
a `focusin`/`focusout` pair on the wrapper cannot work, because React dispatches
the blur that `inert` causes *before* layout effects run, so the flag would
already be cleared by the time anyone asked.

The rescue is recorded as the same **anchor** the three entry points set, with
no `request_id` on it, rather than as a second flag. The anchor is already
cleared by everything that ends the reason for one — an overlay opening, a
session switch, the panel closing — so a rescue cannot survive a trip through a
file view and make the panel read itself out on the way back, which is the one
thing an automatic re-show must not do. An anchor naming no question scrolls
nothing.

Because the panel stays mounted across all of this, "named a question" is an
*edge*, not a state: focus moves when a request arrives, not while one is still
standing. The same goes for the anchor scroll — naming a second question while
the panel is already up scrolls to it, rather than the panel sitting still
because it has scrolled once already.

### Who owns Escape

The panel claims Escape for as long as it is up (§3), and several surfaces in
this one chat want that key. The order between them is a cross-component convention,
and it lives in **this document** because every part of it is a single line in a
different file — the next person to add an Escape listener will read none of
them:

| Surface | Where it listens | What it does with the press |
|---|---|---|
| `ConfirmDialog` | `document`, and it calls `stopPropagation` | closes itself, and the press never reaches `window` at all |
| `ResponsivePanel` — the session-info panel, the engine picker, the worktree and session-filter dropdowns | `document`, and it calls `preventDefault` | closes itself and **marks the press handled** |
| `ModeSelector` — the mode dropdown in the composer row | `document`, and it calls `preventDefault` | closes itself and **marks the press handled** |
| `Sidebar` — the session drawer, below the expanded tier | `document`, and it calls `preventDefault` | closes itself and **marks the press handled** |
| `InputBar`'s command palette | the textarea, and it calls `preventDefault` | closes the palette; the press never gets past it unmarked |
| the answer panel | **`window`** | closes, unless the press is already `defaultPrevented` |
| `ChatPanel`'s interrupt | `document` | ends the agent's turn — the fallback, and the only one that cannot be undone. It stands down while a fork sheet or the answer panel is up (`isSheetOpen`) |

Two rules, and they are the whole of it:

1. **A surface drawn over the answer panel claims the key**, by
   `preventDefault` or by `stopPropagation`. Three needed the line adding, all
   for one reason: they open from the session header or the composer row, both
   of which stay lit beside the panel, so each genuinely can be on top of one,
   and without the mark a single press put away both it and a panel the user was
   not even looking at — the drawer's case is the worst of the three, since it
   covers the panel outright. `ConfirmDialog` and the command palette already
   satisfied the rule for their own reasons. A shared `Sheet` does neither and would close alongside the
   panel — today nothing puts one over it, because an overlay unmounts the panel
   outright and the fork menu lives in the `inert` transcript; a future caller
   that manages it owes `Sheet` the same line.
2. **The answer panel listens on `window`, not on `document`, so that it is
   asked last.** Registration order cannot be relied on — the panel mounts
   first, so a `document` listener of its own would run *before*
   `ResponsivePanel`'s and find `defaultPrevented` still false — but `window` is
   past every `document` listener in the bubble path whatever order they were
   added in.

`ChatPanel`'s interrupt is not part of rule 1 and keeps a known hole: it also
listens on `document` and also registers before `ResponsivePanel`, so pressing
Escape with the engine picker open interrupts the agent's turn as well as
closing the picker. That predates this design and is not fixed here — fixing it
means teaching `ChatPanel` that a `ResponsivePanel` is open, which is a
different piece of work — but it is the reason rule 2 exists in the form it
does, and any future listener should assume the same trap.

### Who owns the dismissing click

The same two rules govern the press that dismisses, for the same reason and in
the same shape. Pressing the backdrop closes the panel (§3), and a surface open
over it is dismissed by the same press through `useOutsideClick` — so without
them one click puts away two things.

Most surfaces are safe by construction and need nothing: `ConfirmDialog`, the
mode dropdown and the session drawer each portal a backdrop of their own over
this one, and `ResponsivePanel` portals one below the expanded tier, so the
press never reaches this backdrop at all. The test is whether a surface has a
backdrop of its own, not whether it is a dropdown, and by that test two are
exposed:

| Surface | What it does with the press |
|---|---|
| `ResponsivePanel` **in the expanded tier** — the session-info panel, the engine picker, the worktree and session-filter dropdowns | closes itself and calls `stopPropagation`, and only on the press it actually closes on |
| `InputBar`'s command palette | the same. It hangs over the composer at *every* width, so it is the one that overlaps here on a phone as well as on a desktop |
| the answer panel | closes, on a **`window`** listener, if the press landed on the backdrop element itself |

The two rules, restated for the pointer:

1. **A surface drawn over the answer panel claims the gesture** — here
   `stopPropagation` and not `preventDefault`, which on a click means something
   else entirely. Only where it dismisses: a click it lets through is not its to
   take. `useOutsideClick` hands its caller the event as well as the target for
   exactly this, since only the caller knows whether the click was a dismissal.
2. **The answer panel is asked last**, which for a click means `window` and
   *not* a React `onClick` on the backdrop: React 19 delegates to the root
   container, so a handler there would be asked before any `document` listener,
   and the claim would arrive too late to stop anything.

The panel compares the press against the backdrop element rather than asking
whether it landed outside the card. A drag that starts on a question's text and
ends past the edge fires `click` on what the press and the release have in
common — the centring container, not the backdrop — so selecting text does not
dismiss.

The rule runs the other way too: a press *into* the panel is an outside click
for whatever the lit header or composer has open, and has to dismiss it.
`ResponsivePanel` spares presses that land inside a dialog, so that a
confirmation modal opened over it holds it open rather than pulling the ground
out from under itself — and that exemption asks for `aria-modal="true"`, not for
`role="dialog"` alone. This panel is a dialog over one rectangle and says so by
withholding `aria-modal`; the header above it is ordinary screen, and a press in
the panel is an ordinary press elsewhere.

## 5. Drafts

One store, `web/src/lib/questionDraftStore.ts`, keyed `sessionId → request_id →
{ labels, text, otherPicked, declined, note }`. `labels` holds options the
question offered and `text` holds the user's own words, and both may carry
something at once — **Other** beside a set of options, or, for a question that
offered none, the whole answer.

`otherPicked` is stored rather than derived from `text` being non-empty, and the
reason is the empty case: the input has to be on screen *before* there is
anything in it, and "Other ticked, nothing typed" is a real state that is not a
complete answer. It is also what makes unpicking Other keep the text rather than
delete it — the user can change their mind back without retyping, and an unpicked
Other sends nothing.

It is a store rather than component state because every host of this draft
unmounts under the user: the panel closes, the whole chat pane is replaced when
an overlay (file, diff, commit, settings) takes it, and the user switches
sessions and comes back. Component state loses the draft to all three.

### It is kept in `localStorage`

Key `question_drafts`, beside the composer's own `input_drafts`, in the same
shape it has in memory. Reload the page and the answer is still there — the
panel is painted with it, not filled in a frame later.

This section used to say **memory only**, and the reason it gave was that
persisting would resurrect an answer to a question withdrawn two days ago, *on a
card that no longer exists*. That reason has not been overturned; it has been
met. The danger was never the storing — it was putting words back into a block
that should not be on screen. So the rule is about the block, not the storage:

> **A stored draft goes on screen only when this session's unanswered list has
> arrived and is seen to still carry its question. Anything else is dropped,
> storage included.**

Three things follow, and they are the whole of the mechanism:

- **What comes back from storage is held apart until it is vouched for.** It
  lands in a second map and moves into the live one only for the ids the list
  still carries. "Unchecked drafts are never on screen" is then a fact about the
  shape of the state, rather than a promise about calling things in the right
  order.
- **The check is the list's *first* arrival for that session, once.** Until that
  first snapshot there is no list at all — only a placeholder — and reading "no
  list" as "an empty list" would discard every draft the reload was meant to
  keep. Afterwards the ordinary rules of §7 govern, so a later change to the list
  is not a second chance to throw anything away.
- **A draft that fails the check goes silently**, from screen and storage alike.
  There is nothing to tell the user: the question it answered is gone, so the
  block is not drawn, so nothing they can see has changed.

The check runs where the list does, in `ChatPanel` and not in the panel, because
a draft left behind by a question somebody else answered has to be cleared
whether or not the user ever opens the panel again. A session this page has not
opened is left untouched in storage until it is: with no list there is no
trustworthy verdict, and keeping words a little longer beats deleting them on a
guess. Read-only sessions do not take part at all.

Across two tabs it behaves exactly like the composer's drafts — each tab keeps
its own copy and writes the whole table back, so the last writer wins. That is
the existing behaviour of the same middleware, and this design adds no promise
of its own on top of it.

### Two things clear a draft

Both are the user's own act: its submit succeeding, and the user dismissing a
block that has gone stale (§7). Nothing clears one behind their back — a question
that leaves the list while it holds a draft keeps its block on screen, because
deleting text somebody typed without showing it to them first is the failure this
store exists to prevent.

The restore check is not a third: what it drops has **never been on screen** in
this page's life. That is the difference the rule turns on, and it is why the
two can coexist without either being an exception to the other.

## 6. The record card in the stream

`AskUserQuestionItem.tsx` is gone, and `QuestionRecordItem.tsx` stands in its
place holding no form. The new name is not tidying: `AskUserQuestion` is the
CLI tool this work stops using, and a component still named after it would be
the last place a reader looks for the record of a `question_post`. What it draws
is what it is — the record of a question, in one of four states.

- **It takes the `question_post` tool row's place**, the same generalisation
  `ask_user_question` and `permission_request` already use
  ([tool-call-ui.md](tool-call-ui.md#the-permission-card-takes-the-rows-place)).
  The join is **by position** and not on `tool_use_id`: an MCP call arrives over
  HTTP carrying the calling session, not the CLI's id for the tool use, so the
  `question_posted` record has none. The record is written *during* the call, so
  it always falls between that call's `tool_call` and its `tool_result` — the
  last unreturned call whose name ends in `question_post` is this question's.
  Drawing both is two adjacent rows saying one thing, which is the duplication that
  section removed once already; a join that misses simply leaves the two rows.
- **Default collapsed, in every state including `pending`.** It does not
  auto-expand and it never opens itself. An open question is already on screen —
  in the panel, or on the strip's row 2 once the panel has been closed — and a
  card that opened itself would be the transcript scrolling under the reader to
  show them something they cannot act on there anyway.
- **Status is on the header row**, in the chip slot it already has:
  `Pending` (warning), `Answered` (success), `Declined` (muted), `Cancelled`
  (muted). Four states; `Expired` is gone with the thing that produced it — a
  question outlives the process that asked it now, so a process ending is no longer
  an ending for the question.
- **`Declined` and `Cancelled` are told apart in the body, not by the chip's
  colour.** Both are "no answer was given", they differ in who decided, and that
  is a sentence: "You declined to answer this." (plus the note, when there was one)
  against "The agent withdrew this question." Two muted chips and one line each
  beats two colours the user has to have learnt.
- **A `pending` body holds a read-only view of the question and the `Answer this`
  button** (§4). An `answered` body holds `QuestionForm` read-only with the
  selection filled in, which is what keeps an answered card looking like the
  form that was filled in.
- Everything §5 of lifecycle-ui said about an **expired** question — the live
  form, "Send as message", the three banners, the degraded-answer message — is
  deleted. It existed because an answer could outlive its request; now an answer
  reaches a question that is still listed, or is refused because something already
  resolved it.

**A message the user types is still just a message.** It resolves nothing, and no
card changes because of it. If the user answers in prose, the agent is expected to
withdraw its own question; if it does not, the lever is Won't answer, which is why
that control exists.

### An answer another agent gave

An agent can answer a question another agent posted (`question_answer`), and the
reader of that transcript never saw the question. So two places say who
answered, and both say it plainly:

- **The message is not a user bubble.** It is drawn full-bleed on the
  conversation's left, on the quiet surface, led by *"Answered by the agent
  working on «{work title}» — not by you."* and followed by the same
  question/answer body a user bubble would hold. It is not folded into the
  collapsed work-event line either: an answer is conversation, not Pockode
  annotating itself, and the reader has to be able to read what was said. The
  origin (`"agent"`) is what selects this shape; the naming comes off
  `resolved_by` on the answers, which is the half that knows.
- **The card says it too**, because a reader who scrolls up to the question finds
  it marked `Answered` and would otherwise take it for their own: an `answered`
  body whose `resolved_by.kind` is `agent` states *"Answered by the agent working
  on «{title}», not by you."* An answer with no `resolved_by` at all is the
  user's — that is every record written before an agent could answer — so the
  common case says nothing extra and the chip is enough.

When no work owns the answering session, both sentences fall back to "another
agent": a plain chat has no title to give, and the point being made is not the
name.

### Questions the CLI asked, in old transcripts

Transcripts written before Pockode stopped letting a CLI ask its own blocking
question hold `ask_user_question` records, and the answers to them hold
`question_response`. Both are read and neither is ever written again
([agent-event.md](agent-event.md#legacy-ask_user_question-and-question_response)).

They render through **this same card**, and that is the only reason the old
records still read as anything: one card per question, since a legacy record
could carry several under one `request_id`, and `question_response` settles them
all at once. An answered one fills its read-only form in exactly as a new one
does — the old flat answer string is parsed back into the two halves
(`web/src/utils/questionAnswer.ts`, which exists for this).

One thing is different, and the card says it in words: a legacy card nothing
settled stays `Pending` and states *"This was asked through the CLI's own tool,
which held the turn open for the answer. It can no longer be answered."* It offers
no `Answer this`, and it wears the settled card's quiet surface rather than the
warning frame — the frame means "there is something for you here", and there is
not. That sentence is the whole of what replaced the `Expired` chip and its table
of reasons: one fact about one kind of card, rather than a state the live path has
to carry.

## 7. Edge cases

| Situation | Behaviour |
|---|---|
| No unanswered questions | Strip row absent; the panel does not come up, and cannot be reached from chat. It is not "opened empty" from anywhere |
| A question arrives while the panel is up | Its block is appended at the end; the title's count and the footer's `n` go up. Nothing scrolls — the user is reading something |
| A question is answered elsewhere, its block has **no draft** | The block disappears. The counts fall. Nothing is announced: nothing was lost |
| A question is answered elsewhere, its block **has a draft** | The block stays, disabled and dimmed, with "Already answered elsewhere." and a `×` that dismisses the block and clears its draft. The draft stays visible until then, and the block does not count toward `k`. The copy says *elsewhere* rather than naming a device, because the answer may equally have come from another agent through `question_answer` |
| A question is withdrawn by the agent (`question_cancel`) | Same two rules, with "The agent withdrew this question." The card in the stream reads `Cancelled` |
| The work closes, or its step advances | Its questions are cancelled by the engine; the blocks behave exactly as a withdrawal, which is what it is |
| Submit refused — one entry no longer pending | The whole call fails (§3). The offending blocks flip to the dimmed "Already answered elsewhere." state; every other block keeps its draft and `Send` is live again for them. One more tap, nothing retyped |
| Submit refused — the session is blocked on a permission request | The panel stays up and closeable, and states it: "The agent is waiting for a permission decision. Answer that first." The strip already ranks permission above questions, so the next thing to do is the row above the composer |
| Reconnect | The subscription result carries the list; the panel re-reads it and blocks appear or leave by the rules above. Drafts are in a store, so the socket dropping costs nothing |
| Session switch | The panel is mounted under `ChatPanel` and goes with it, and the destination puts up its own for its own questions (§4). Drafts are keyed by session and are still there on return |
| Fork | The fork's session has its own unanswered list, with the inherited `request_id`s. The panel is the fork's panel and needs no rule of its own — including the case where the original was answered after the fork point and the copy is open again |
| A question whose card has not been paged in | Answerable. That is the whole design: the panel reads the list, not the transcript. The `Answer this` opener does not exist for it, because its card is not on screen to hold one |
| `Answer this` on a card while the panel is already up | Cannot be reached: the card is behind the backdrop and `inert` (§3). It is a way to *that one* question, not a way in, so nothing is lost — the question already has a block in the panel. Closing first reaches the button, and closing keeps every draft (§5) |
| An agent answers the question (`question_answer`) | The block leaves the panel by the two rules above; the card reads `Answered`, and the answering message is drawn as the named block of §6 rather than as a user bubble |
| A permission request arrives while the panel is up | The panel **does not close** — it may hold half-typed answers, and a surface that disappears under the user is worse than one that explains itself. The strip shows row 1 instead of row 2 (which is not rendered anyway while the panel is up), and a submit is refused with the line above. The card itself is behind the backdrop and `inert` whether or not it is scrolled into view, so "Jump to request" — which closes the panel on its way — is the only route to it (§2) |
| Reduced motion | The panel's anchor scroll degrades, as every scroll in this app does. There is nothing else to degrade: the panel has no enter or leave animation (§8) |

## 8. Deliberately not done

- **No notification, no badge count in the title bar, no vibration.** The strip is
  on screen whenever the chat is, and the counts are on the rows. Reaching further
  than that belongs to a notification system.
- **No way to make an unanswered question go away without the agent being told.**
  Declining is not that: it resolves the question *and* sends a message. The `×`
  in §7 is not that either — it dismisses a block whose question something else
  has already resolved. A silent dismiss would leave an agent waiting on
  something the user has decided is gone, which is the shape of failure this
  project forbids.
- **No translucency, no frosted glass on the card.** The backdrop dims the
  conversation (§3) and that is as far as it goes: making the card itself
  see-through would cost the legibility of the one thing that has to be read,
  and what shows through it is exactly what has just been put out of reach.
  Reading the conversation is one press on the backdrop away.
- **No swipe-to-dismiss, and no drag handle.** Neither has anything to grab on
  a centred card, and `Sheet`'s handle is the one value of its the panel does
  not copy (§3): a handle with no drag behind it promises a gesture that does
  not exist. Closing is the `×`, Escape, or a press on the backdrop — three
  deliberate acts, none of them reachable by a flick through the last
  question.
- **No third, minimised form** — a bubble, a pill, a collapsed bar. Closed plus
  the strip's row 2 **Answer** already is that form, and it has one state
  instead of two.
- **Nothing touches the transcript's scroll position when the panel opens.**
  It stays mounted behind the backdrop and keeps its place, so closing returns
  the user to the screen they left, unmoved. Moving it would make "close it for
  a second" an act with a cost — and nothing needs moving: the panel covers the
  rectangle rather than sitting on its edge, so there is no tail to hold clear
  of it and no inset for the list to be told about.
- **No enter or leave animation.** The panel is usually not something the user
  just pressed for, and a thing that moves by itself pulls attention away from
  the question text. It is simply there. (`prefers-reduced-motion` therefore has
  nothing to do here.)
- **No handing focus back to whatever opened the panel.** A modal owes that; this
  one has nowhere to give it back to. The usual opener is the strip's row 2,
  which the panel's own arrival unmounts, so the gesture would be a no-op dressed
  as care — and building a focus handover across components for it would be more
  machinery than the case is worth.
- **No per-question submit.** One `Send` produces one message, however many
  blocks are ready. Three Sends would be three messages and three turns for one
  sitting at the phone, and the agent would answer the first before it had read
  the third.
- **No pill, and no jump to a question card.** Both existed to reach the place
  answering happened, and answering does not happen there any more.
  `web/src/utils/pendingQuestions.ts`, `PendingQuestionPill.tsx` and
  `MessageList`'s visibility observer, debounce and live region go with them.
  `MessageList` keeps the jump itself — the strip's permission row still uses it —
  and it now reaches **only** a permission card. The record card carries no jump
  handle: a question is reached through the panel, which works whether or not that
  card is loaded, so a jump to it would be the one route that stops working
  exactly when the transcript is long.

## 9. Where it lives

Everything here is `web`. `web-cluster` has no chat, no sessions and no work, so
nothing in this design is shared code. The answer panel deliberately does not
take `Sheet` from `@pockode/shared` either (§3), which also keeps its
`touch-target` controls inside the project whose stylesheet declares that
utility — the failure mode `AGENTS.md` warns about for shared components is
silent, and this design simply never enters it.

| File | Role |
|---|---|
| `web/src/components/Chat/AttentionStrip.tsx` | renamed from `BlockerStrip.tsx`; gains row 2, an `onAnswer` prop, and the `answerPanelOpen` that withholds row 2 while the panel is up (§2) |
| `web/src/components/Chat/AnswerPanel.tsx` | the panel, its blocks, the footer (§3); a card centred in the transcript's rectangle over a backdrop that covers that rectangle alone, capped at 85% of it, measuring nothing; owns Escape and the backdrop press on `window` (§4) |
| `web/src/components/ui/ResponsivePanel.tsx` | marks its Escape handled, and claims the click it dismisses on, so the answer panel underneath it does not close on the same press (§4) |
| `web/src/components/Chat/ModeSelector.tsx`, `web/src/components/Layout/Sidebar.tsx` | the same Escape line, for the same reason: both open from surfaces the backdrop leaves lit — the composer row and the session header — so both can be the thing on top of the panel. Neither needs the click line: both portal a backdrop of their own (§4) |
| `web/src/components/Chat/InputBar.tsx` | claims the click its command palette dismisses on — the palette hangs over the composer with no backdrop, at every width (§4) |
| `packages/shared/src/hooks/useOutsideClick.ts` | hands the caller the event beside the target, which is what lets a caller claim the gesture at all (§4) |
| `web/src/components/Chat/QuestionForm.tsx` | extracted from `AskUserQuestionItem.tsx`; the one renderer of a question, across every host that draws one — including the third shape, a textarea for a question with no options |
| `web/src/components/Chat/QuestionRecordItem.tsx` | replaces `AskUserQuestionItem.tsx` — the record card: four states, no form, collapsed by default, `Answer this` in the body (§6), and the one card a legacy `ask_user_question` record draws through |
| `web/src/components/Chat/ChatPanel.tsx` | holds whether the panel is up, what it is anchored to and the ids this visit has shown; wraps the message list so the panel has a rectangle, and derives the panel's rendering, the transcript's `inert` and the Escape guard from one expression (§3); remembers the last focused element for the rescue and stands its interrupt down while the panel is up (§4); consumes the navigation intent of §4 |
| `web/src/components/Chat/MessageList.tsx` | loses the pill, its observer, its debounce and its live region; keeps the jump, narrowed to permission cards (`.jump-highlight`, renamed from `.question-highlight` now that no question card is a target). It is told nothing about the panel: the panel covers it rather than sitting on its edge (§3) |
| `web/src/components/Chat/MessageItem.tsx` | the answering message's bubble — one entry per `answering` element — and, for an `agent` origin, the named block that replaces it (§6) |
| `web/src/utils/messageSource.ts` | new — `isTypedByUser`, the one place "a person typed this" is decided: a `role: "user"` message may be Pockode's own or another agent's answer, and neither should follow the transcript to the tail or claim the delivery receipt |
| `web/src/lib/answerIntent.ts` | the one-shot navigation intent of §4 — *take me to this question*, not *open the panel* — deliberately not a route |
| `web/src/lib/questionDraftStore.ts` | the drafts, persisted to `question_drafts` and vouched for against the unanswered list before they are shown (§5) |
| `web/src/lib/rpc/chat.ts` | `sendMessage` takes `answering`; `questionResponse` and the `chat.question_response` RPC behind it are deleted |
| `web/src/utils/answerMessage.ts` | new — the message body (§3); replaces `degradedAnswer` in `AskUserQuestionItem.tsx` |
| `web/src/utils/questionAnswer.ts` | kept for the legacy records alone: `QuestionSelection` for the form, and `parseAnswer` / `lookupAnswer` to read an old flat answer string back |
| `web/src/utils/pendingQuestions.ts`, `Chat/PendingQuestionPill.tsx` | deleted |
| `web/src/lib/activity.ts` | `needsUser(activity)` → `needsAttention(activity, unansweredQuestions)`; two leaves removed (lifecycle-ui.md §1.1) |
| `web/src/components/common/SidebarListItem.tsx` | the second indicator (lifecycle-ui.md §2.1) |
| `web/src/components/Project/WorkRow.tsx` | the `{n} to answer` slot and the edge predicate (lifecycle-ui.md §6.1) |
| `web/src/components/Project/WorkDetailOverlay.tsx` | `WaitLine` shrinks to the `child` case; the unanswered-questions section (lifecycle-ui.md §6.2) |
| `web/src/types/message.ts`, `work.ts` | `PendingQuestion`, `unanswered`, `unanswered_questions`, `pending_questions`, `QuestionAnswerRecord.text`; `QuestionStatus` is gone and `QuestionRecordStatus` replaces it; `TurnBlockerKind` loses `question`; `WorkWait` loses `user` and `wait_reason` goes with it |
