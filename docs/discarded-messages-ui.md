# Discarded Messages UI

A Stop on a Claude turn — the user's, or an expired lease's — also throws away
messages the user sent into that turn which the CLI had not folded in yet
([agent-integration.md](code/agent-integration.md#stop-ends-the-background-work-too)).
Those messages will never be answered. The usual moment is the one that matters
most: the user sends "do X instead" mid-turn, then presses Stop so the agent
takes it at once — and the Stop takes the message with it.

This page is what the transcript shows for that and how the user gets the
message back. How the state is kept is in
[frontend-state.md](code/frontend-state.md#discarded-messages). Codex has no such
mechanism and none of this appears for it.

## 1. Three places, one fact each

| Where | Says | Acts |
|---|---|---|
| The message itself, at the bottom | this message was not read and will not be answered | — |
| The end of the stopped turn, under `Interrupted` | what the Stop did: N unread messages discarded | **Restore to input** |
| The message's `…` menu | — | **Restore to input**, for this one message |

The ending is on the message so the user never has to match a bubble to a line
somewhere else. Claude's read point is written when the message is handed over,
so a bubble may already stand under the message; the note is what tells the
reader that output is not its answer. The message does not move: moving content
under the reader's eyes is worse, and the note already corrects the reading.

## 2. On the message

`Not read — won't be answered`, with an `EyeOff` glyph, as the last line inside
the bubble after the text and files. In the bubble's own text colour — no fading,
no strike-through: the user is about to read the message to decide whether to
send it again. Inside the bubble rather than beside it, so the row's alignment
(the `…` slot, the avatar) is untouched, and a screen reader reads it right after
the content.

The other shapes a message takes carry the same line at their bottom, muted: a
[Pockode command](pockode-commands.md#how-it-is-drawn) row and another agent's
answer. A system message's collapsed line ends in `· not read`.

## 3. At the end of the stopped turn

Under `Interrupted`, before the turn's changes card and actions:

```
Interrupted
⊘ 2 unread messages were discarded.        [Restore to input]
```

The count is every message the turn's records name. One press restores every
plain message the user typed, in the order they were sent, a blank line apart,
with their files. The wording does not say "Stop": an expired lease ends a turn
the same way, and `Interrupted` already says how it ended.

Muted lines below the summary say what the press leaves out:

- Commands are restored one at a time from their own menu (§4), unless the only
  thing to restore is one command — then the button restores it.
- A message whose page is not loaded yet cannot be restored from here: the line
  says how many and to scroll up. Once its page loads it joins the press. Only
  while older pages remain — with none left, a message the summary cannot find
  is this tab's own, whose id is still on its way in the reply to the send.

What is never offered back: an answer to posted questions (its text is the
answers flattened for the agent, not what the user typed — what becomes of the
questions themselves, and of their cards, which read `Not read` instead of
`Answered`, is [answering-ui.md](answering-ui.md)'s), and anything
Pockode or another agent sent. Those still get the note; a turn whose discarded
messages are all of that kind shows the summary with no button. A read-only
transcript shows the endings and offers nothing.

The button is a text button at the row's end, wrapping onto its own line on a
narrow screen; 36px tall under a fine pointer and 44px under a coarse one. Its
accessible name is its visible text, so a voice user can say what they see; the
count line describes it (`aria-describedby`).

## 4. In the menu

`Restore to input` is appended to the message menu's reversible group, after
`Fork from here`, and only on a message that was discarded and can be restored.
It needs no navigation, so a discarded message gets its `…` slot even in a
session that cannot fork; the fork row is then simply absent
([session-fork-ui.md](session-fork-ui.md#which-rows-reserve-a-slot)).

## 5. What restoring does

It writes the composer's draft (`inputStore`), as fork's dropped prompt and the
sign-in's *Send again* do, and sends nothing. Files come back through
`attachmentActions.adopt`: they are already in the session's store, so they
return as chips without uploading.

- **Never over the user's words.** An empty input takes the message as is; one
  with text in it keeps that text first, and the message follows a blank line
  later. Files go after the ones already there.
- **Only what is missing.** Text already in the draft is not added again, and a
  file already there by id is not either. Pressing twice repeats nothing, and
  after a reload — the draft keeps its text and loses its files — a press brings
  back only the files.
- **A command only into an empty input.** A Pockode command is recognised only
  as a whole message, so appended to other words it would go out as plain text.
  Behind a draft, the menu row is disabled with the reason, and the turn's button
  stays pressable and says the reason under itself when pressed (a touch screen
  has no tooltip): *Clear the input first. A command only runs as a whole
  message.* The reason stays while the draft it was refused against does; a
  later draft has to be refused again before it is said again.
- **Focus** follows the composer's rule: a fine pointer gets the caret, a coarse
  one does not get the keyboard thrown up.

The button and the row read `In input` while the draft holds all of the
message — its text and every file. Nothing records that a restore happened: that
is this device's passing state, not an event. Edit the text away or send it and
the button is back to `Restore to input`, which is the truth.

## 6. Across devices and reloads

The endings are derived from history, so every tab and every reload shows them
alike — including the tab that pressed Stop, which learns its own message's id
from the reply to its send ([frontend-state.md](code/frontend-state.md#discarded-messages)).
A restore writes the draft of the device it was pressed on only.
