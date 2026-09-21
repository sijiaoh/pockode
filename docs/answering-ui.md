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

- One entry point above the composer, always reachable, never scrolled away.
- One surface that answers, holding every open question at once, whether or not
  their cards have been paged in.
- A card in the stream that can be read but cannot be acted on, so there is
  never a second answer to "is this question still open".

## 1. What a surface reads

| Name | Where it lives | Who reads it |
|---|---|---|
| `unanswered: PendingQuestion[]` | the chat subscription's session payload, on the turn state | the strip, the sheet |
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
| 3 | a message went into a turn already open | `CornerDownRight` | "Sent into the reply the agent is working on." | — |
| 4 | `background` blocker | `Hourglass` | "Waiting on a background task — nothing to answer." | "Details" (expands) |

**Permission stays first**, and now for a sharper reason than precedence: it is
the only row left that the composer is disabled under, and it is the only state
in which answering is *refused by the server* — the CLI holding a permission
request open reads nothing else, so an answer message cannot be delivered. The
strip has to say the thing that must happen first.

**Questions come second, above the receipt and the background line.** They are the
one row with something for the user to do that is not already on screen.

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

## 3. The answer sheet

Shared `Sheet` ([packages/shared](../packages/shared/src/components/Sheet.tsx)):
bottom drawer below the expanded tier, centred dialog at and above it, scrolling
body between a fixed header and footer. Nothing new is built for it.

```
┌──────────────────────────────────────────────┐
│ 2 questions                              [×] │
├──────────────────────────────────────────────┤
│ [Database]                            14:02  │
│ Which database should I use?                 │
│  ( ) Postgres                                │
│      Managed, and we already run one         │
│  (•) SQLite                                  │
│      One file, no ops                        │
│  ( ) Other                                   │
│  ☐ Won't answer                              │
├──────────────────────────────────────────────┤
│ [Region]                              14:02  │
│ Which region?                                │
│  ☑ Won't answer                              │
│  The agent will be told you are not          │
│  answering this.                             │
│  [ already said it above______________ ]     │
├──────────────────────────────────────────────┤
│ 2 of 2 ready                        [ Send ] │
└──────────────────────────────────────────────┘
```

**Title is the count** — "1 question" / "{n} questions" — and it is live: it drops
as questions are resolved while the sheet is open. The verb is on the footer
button, where the thing it names actually happens. A title that said "Answer
questions" would spend the one fixed line on a word the button already carries,
while the count is the one fact that otherwise takes scrolling to work out — and
the one that answers "am I nearly done".

**One block per `request_id`, oldest first, in one flat scroll.** Not an
accordion and not a wizard: a wizard hides how much is left, forbids answering out
of order, and turns two questions into four taps. The stack is skimmable, and the
sheet's body already scrolls between a pinned header and footer.

Each block reuses `web/src/components/Chat/QuestionForm.tsx`, which was a
private helper inside the old `AskUserQuestionItem.tsx` and is now a component
of its own, so the sheet and the record card draw a question with one
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

There is no Cancel button. The sheet's own close — the `×`, the backdrop, Escape
— is the way out, and it costs nothing, because closing keeps every draft (§5).
A Cancel beside Send would promise that leaving discards, which is exactly the
promise this sheet does not make.

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

A sheet that vanishes under a finger is worse than one that explains itself, and
the last row is the case where the user may still have typing in it. Auto-closing
on an empty list would also make the sheet's disappearance the notification that
someone else answered, which is a thing to be told rather than a thing to notice.

## 4. Where the sheet is opened from

Three openers, all explicit. **It never opens by itself** — not on arrival, not
when a question lands, not when the strip appears.

| Opener | Opens | Anchored to |
|---|---|---|
| the strip's **Answer** button | the sheet | the first unanswered question |
| a pending record card's **Answer this** | the sheet | that card's question |
| the work detail's **Answer** | the chat, then the sheet | the work's first unanswered question |

"Anchored" means the sheet scrolls that block into view on open. It never filters:
a sheet holding one of three open questions would be a second, partial answer to
"what is waiting on me", and the user would find the other two only by going back.

**The pending card gets a button, and it is the one concession to the stream.**
The card is a record and holds no form (§6), but a card that states `Pending` and
offers nothing is a dead end, and nothing in this app states a problem without
stating the way out. The button is in the expanded body, not on the header row —
the header row is the expand toggle and its slot order is the tool row's grammar
([tool-call-ui.md](tool-call-ui.md#the-row)), which has nowhere to put a second
control. It carries no state: it calls the same opener the strip does.

**Opening a chat never opens the sheet, and opening it from a work list is no
exception.** Navigation should land where it said it would; a sheet that covers
the transcript on arrival has to be dismissed before the thing the user came for
is visible, and the same tap that navigated then has to be undone. The rule is
that the *intent* decides, not the destination: `Open Chat` is "show me this
conversation", the work detail's `Answer` is "let me answer", and only the second
one arrives with the sheet open.

That intent rides as one-shot navigation state, **not as a URL**. A URL that opens
the sheet re-opens it on every reload and every share of that link, which is
auto-open wearing a route.

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
unmounts under the user: the sheet closes on a stray backdrop tap, the whole chat
pane is replaced when an overlay (file, diff, commit, settings) takes it, and the
user switches sessions and comes back. Component state loses the draft to all
three, and the first one is a single mis-aimed thumb.

It is **memory only**. Not `localStorage`, not the server. A draft is seconds of
typing whose whole job is to survive a refused submit and a dropped socket —
neither of which reloads the page — and persisting it would resurrect an answer to
a question that was withdrawn two days ago, on a card that no longer exists.

Two things clear a draft, and both are the user's own act: its submit
succeeding, and the user dismissing a block that has gone stale (§7). Nothing
clears one behind their back — a question that leaves the list while it holds a
draft keeps its block on screen, because deleting text somebody typed without
showing it to them first is the failure this store exists to prevent.

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
  auto-expand and it never opens itself. A question that is open is announced by
  the strip, which is on screen; a card that opened itself would be the transcript
  scrolling under the reader to show them something they cannot act on there.
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
| No unanswered questions | Strip row absent; the sheet cannot be reached from chat. It is not "opened empty" from anywhere |
| A question arrives while the sheet is open | Its block is appended at the end; the title's count and the footer's `n` go up. Nothing scrolls — the user is reading something |
| A question is answered elsewhere, its block has **no draft** | The block disappears. The counts fall. Nothing is announced: nothing was lost |
| A question is answered elsewhere, its block **has a draft** | The block stays, disabled and dimmed, with "Already answered elsewhere." and a `×` that dismisses the block and clears its draft. The draft stays visible until then, and the block does not count toward `k`. The copy says *elsewhere* rather than naming a device, because the answer may equally have come from another agent through `question_answer` |
| A question is withdrawn by the agent (`question_cancel`) | Same two rules, with "The agent withdrew this question." The card in the stream reads `Cancelled` |
| The work closes, or its step advances | Its questions are cancelled by the engine; the blocks behave exactly as a withdrawal, which is what it is |
| Submit refused — one entry no longer pending | The whole call fails (§3). The offending blocks flip to the dimmed "Already answered elsewhere." state; every other block keeps its draft and `Send` is live again for them. One more tap, nothing retyped |
| Submit refused — the session is blocked on a permission request | The sheet stays open and `dismissible`, and states it: "The agent is waiting for a permission decision. Answer that first." The strip already ranks permission above questions, so the next thing to do is the row above the composer |
| Reconnect | The subscription result carries the list; the sheet re-reads it and blocks appear or leave by the rules above. Drafts are in a store, so the socket dropping costs nothing |
| Session switch | The sheet is mounted under `ChatPanel` and goes with it. Drafts are keyed by session and are still there on return |
| Fork | The fork's session has its own unanswered list, with the inherited `request_id`s. The sheet is the fork's sheet and needs no rule of its own — including the case where the original was answered after the fork point and the copy is open again |
| A question whose card has not been paged in | Answerable. That is the whole design: the sheet reads the list, not the transcript. The `Answer this` opener does not exist for it, because its card is not on screen to hold one |
| An agent answers the question (`question_answer`) | The block leaves the sheet by the two rules above; the card reads `Answered`, and the answering message is drawn as the named block of §6 rather than as a user bubble |
| Reduced motion | The sheet's anchor scroll degrades, as every scroll in this app does |

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
- **No draft persistence across a reload.** §5.
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
  handle: a question is reached through the sheet, which works whether or not that
  card is loaded, so a jump to it would be the one route that stops working
  exactly when the transcript is long.

## 9. Where it lives

Everything here is `web`. `web-cluster` has no chat, no sessions and no work, so
nothing in this design is shared code — the only thing it takes from
`@pockode/shared` is `Sheet`, which is already there.

| File | Role |
|---|---|
| `web/src/components/Chat/AttentionStrip.tsx` | renamed from `BlockerStrip.tsx`; gains row 2 and an `onAnswer` prop (§2) |
| `web/src/components/Chat/AnswerSheet.tsx` | new — the sheet, its blocks, the footer (§3) |
| `web/src/components/Chat/QuestionForm.tsx` | extracted from `AskUserQuestionItem.tsx`; the one renderer of a question, across every host that draws one — including the third shape, a textarea for a question with no options |
| `web/src/components/Chat/QuestionRecordItem.tsx` | replaces `AskUserQuestionItem.tsx` — the record card: four states, no form, collapsed by default, `Answer this` in the body (§6), and the one card a legacy `ask_user_question` record draws through |
| `web/src/components/Chat/ChatPanel.tsx` | holds whether the sheet is open and what it is anchored to; consumes the navigation intent of §4 |
| `web/src/components/Chat/MessageList.tsx` | loses the pill, its observer, its debounce and its live region; keeps the jump, narrowed to permission cards (`.jump-highlight`, renamed from `.question-highlight` now that no question card is a target) |
| `web/src/components/Chat/MessageItem.tsx` | the answering message's bubble — one entry per `answering` element — and, for an `agent` origin, the named block that replaces it (§6) |
| `web/src/utils/messageSource.ts` | new — `isTypedByUser`, the one place "a person typed this" is decided: a `role: "user"` message may be Pockode's own or another agent's answer, and neither should follow the transcript to the tail or claim the delivery receipt |
| `web/src/lib/answerIntent.ts` | new — the one-shot navigation intent of §4, deliberately not a route |
| `web/src/lib/questionDraftStore.ts` | new — §5 |
| `web/src/lib/rpc/chat.ts` | `sendMessage` takes `answering`; `questionResponse` and the `chat.question_response` RPC behind it are deleted |
| `web/src/utils/answerMessage.ts` | new — the message body (§3); replaces `degradedAnswer` in `AskUserQuestionItem.tsx` |
| `web/src/utils/questionAnswer.ts` | kept for the legacy records alone: `QuestionSelection` for the form, and `parseAnswer` / `lookupAnswer` to read an old flat answer string back |
| `web/src/utils/pendingQuestions.ts`, `Chat/PendingQuestionPill.tsx` | deleted |
| `web/src/lib/activity.ts` | `needsUser(activity)` → `needsAttention(activity, unansweredQuestions)`; two leaves removed (lifecycle-ui.md §1.1) |
| `web/src/components/common/SidebarListItem.tsx` | the second indicator (lifecycle-ui.md §2.1) |
| `web/src/components/Project/WorkRow.tsx` | the `{n} to answer` slot and the edge predicate (lifecycle-ui.md §6.1) |
| `web/src/components/Project/WorkDetailOverlay.tsx` | `WaitLine` shrinks to the `child` case; the unanswered-questions section (lifecycle-ui.md §6.2) |
| `web/src/types/message.ts`, `work.ts` | `PendingQuestion`, `unanswered`, `unanswered_questions`, `pending_questions`, `QuestionAnswerRecord.text`; `QuestionStatus` is gone and `QuestionRecordStatus` replaces it; `TurnBlockerKind` loses `question`; `WorkWait` loses `user` and `wait_reason` goes with it |
