# HTML-first Session UI

A session is either an ordinary **Chat** session or an **HTML first** one. The
only difference between them is the guidance the agent starts with: in an HTML
first session it is told to say things with pages (`html_render`, `html_edit`,
`html_get`) and keep its text to a sentence or two. The tools, the screen and
the transcript are the same.
How a page sends to the agent and follows the theme is the same in both
([tool-call-ui.md § Sending to the agent](tool-call-ui.md#sending-to-the-agent),
[§ Theme](tool-call-ui.md#theme-a-page-that-asks-for-it)): a page follows the
theme because it uses the `--pk-*` variables, never because of the session's
style.

This document covers the two places the UI shows the choice: the switch on a
new session's empty state, and the glyph on an HTML first session's row. It also
says where the choice can be read once it is fixed.

It is deliberately much smaller than the canvas branch's kind chooser
(`feature/canvas-mode`, `docs/new-session-ui.md` there): there is no second
view, no project default, no setting. Chat is always the default.

Related: [agent-chat.md](agent-chat.md) for the session screen,
[sidebar-ui.md](sidebar-ui.md) for the session rows,
[tool-call-ui.md § A page the agent drew](tool-call-ui.md#a-page-the-agent-drew-html_render)
for the page card whose glyph this reuses.

## Key Files

| Path | Role |
|---|---|
| `web/src/lib/sessionStyle.ts` | The two values, their labels, glyphs and hints (§2.2) — the one place the words live, read by the switch, the row and the panel |
| `web/src/lib/rpc/session.ts` | `setSessionHTMLFirst`, and `htmlFirstRefusedReason`, which tells the refusals of §2.4 apart |
| `web/src/components/Chat/HtmlFirstSwitch.tsx` | The switch (§2): a `ToggleGroup` and the fixed line; and `useHtmlFirstSwitch`, the write, the hold and the refusal line |
| `web/src/components/Chat/MessageList.tsx` | Draws the switch in its empty branch, in place of `Start a conversation...` (§2.1) |
| `web/src/components/Chat/ChatPanel.tsx` | When the switch is offered (§2.5); holds `useHtmlFirstSwitch`, so Send and the extension's hints can wait for a switch in flight (§2.3) |
| `web/src/components/ui/ToggleGroup.tsx` | Its `disabled` prop (§2.3) |
| `web/src/components/Session/SessionItem.tsx` | The row's glyph and its screen-reader words (§3) |
| `web/src/components/Chat/SessionHeader.tsx` | The read-only line in the session panel once the session has started (§4) |

The write lives in a hook the chat panel holds rather than in the switch,
because most of the paths that send the first message are not under the
switch: the composer reads the hold off `canSend`, and an extension's hints
wait for it before sending.

## 1. The rule

The choice is a property of the session, `html_first`, **fixed when the agent
is first told anything** — that is, when the first message is delivered. The
guidance is fixed when the agent starts, so a switch after that would leave an
agent told one thing in a session that says another. Until then it is a draft
of the session, like the engine on an unstarted session.

- A new session from the **New Session** button starts as Chat.
- A fork copies the value and is started from birth: it is never offered the
  switch.
- A session the work system creates is always Chat and is never offered the
  switch.

**What the UI reads from the server.**

- `html_first` on `SessionDetail` and `SessionListItem` (omitted when false).
- `session.set_html_first { session_id, html_first }`, answering `{}`,
  refused once the session has started, with a reason the frontend can tell
  apart (`session_started`, §2.4). Writing the value already stored succeeds
  and pushes nothing.
- `started` on `SessionDetail` (the row does not carry it): a fact of its own,
  set immediately before the first message is delivered and never cleared. It
  cannot be `activated`: that is set when the agent first *answers*, so
  between the first delivery and the first output a switch would still be
  accepted for an agent already told the other guidance.
- A CLI process already spawned for the session with the other value is
  replaced when the first message is sent, so that message starts the right
  one (the switch itself closes nothing — see
  [code/agent-integration.md](code/agent-integration.md#html-first-sessions)).
- A refusal is `InvalidParams` with `data.reason`: `session_started`, or
  `work_session` for a work item's session.

## 2. The switch on the empty state

### 2.1 Where it is

It replaces the muted `Start a conversation...` line in `MessageList`'s empty
branch, centred in the area between the header and the composer — the place
the eye already goes on a new session, and the place the first message will
take. An extension's `CustomEmptyState` is still drawn, under the switch: the
empty branch becomes one centred, scrollable column (`gap-6`) holding the
switch and then the extension's content, rather than two `flex-1` blocks each
centring itself. Without an extension, the switch is the whole column.
The read-only branch (`Nothing was said in this conversation.`) is unchanged.

```
Phone (360px)                              Desktop (pane centred)
┌──────────────────────────────┐           ┌──────────────────────────────────────────┐
│ ☰  New Session ⌄          ⚙ │           │ New Session ⌄                          ⚙ │
├──────────────────────────────┤           ├──────────────────────────────────────────┤
│                              │           │                                          │
│  SESSION                     │           │        SESSION                           │
│ ┌──────────────────────────┐ │           │       ┌────────────────────────────┐     │
│ │[💬 Chat ]│ ▣ HTML first  │ │           │       │[💬 Chat ] │  ▣ HTML first   │     │
│ └──────────────────────────┘ │           │       └────────────────────────────┘     │
│  The agent answers in text,  │           │        The agent answers in text, and    │
│  and draws a page when it    │           │        draws a page when it helps.       │
│  helps.                      │           │        Can be changed until you send     │
│  Can be changed until you    │           │        the first message.                │
│  send the first message.     │           │                                          │
│                              │           │                                          │
├──────────────────────────────┤           ├──────────────────────────────────────────┤
│ [+] [ Message…          ] ➤ │           │ [+] [ Message…                       ] ➤ │
└──────────────────────────────┘           └──────────────────────────────────────────┘
```

- One block, `w-full max-w-sm`, centred; on a phone it takes the column less the
  pane's `px-4`. Nothing changes shape by width — two segments fit a 320px
  column with room to spare, and one control is one thing to learn.
- Text inside the block is left-aligned (it is `ToggleGroup`'s own layout); the
  block, not its lines, is centred.
- With the soft keyboard up the area shrinks; the block stays centred, and the
  area scrolls when it is shorter than the block (a phone in landscape). It
  never covers the composer.

### 2.2 What it is made of

**`ToggleGroup`**, used as it is — the instant-apply segmented control the
settings use. It already has everything this needs: the stored value lit, no
optimistic state, a skeleton while the value is unknown, a refusal shown under
it. No new control.

| Prop | Value |
|---|---|
| `label` | `Session` (the uppercase muted label, and the group's `aria-label`) |
| `items` | `chat`, `html_first` |
| `getInfo` | `chat` → `MessageSquare`, `Chat` · `html_first` → `AppWindow`, `HTML first` |
| `hint` | the lit value's line (below) |
| `selected` | the session's stored `html_first`, off the detail |
| `valueState` | always `known`: the switch is only drawn once the detail has arrived (§2.5), so there is no value it has not heard |
| `error` | §2.4 |

Hints, one per value — they say what the user will *see*, not how the agent
is prompted:

- Chat: `The agent answers in text, and draws a page when it helps.`
- HTML first: `The agent answers with pages you can work in, and keeps its text short.`

Under the group, outside it, one more muted `text-xs` line, the same for both:
`Can be changed until you send the first message.` This is the line that says
the choice is not forever *yet*, and that sending is what fixes it.

**Why `AppWindow`.** It is the glyph the page card already uses
(`HtmlRenderCard`), so the switch, the row (§3) and the cards in the
transcript all point at the same thing: pages. It also avoids `Code` (the card's
*Show source*) and `PanelsTopLeft` (the canvas branch's glyph), which would
read as a different feature.

**Why "HTML first".** It is the name the story uses and says the ordering
honestly: the session is still a chat, pages come first. "Pages" alone would
read as a different screen, which this is not.

How the current value reads: the lit segment (`bg-th-bg-tertiary`, primary
text, `aria-pressed=true`) and the hint that names it. A screen reader hears
`Session, group; Chat, toggle button, pressed`.

### 2.3 Pressing the other value

1. The group is `disabled` for the length of the hold below. `disabled` is a
   new `ToggleGroup` prop rendered as `aria-disabled` plus `opacity-50` and
   ignored presses — not the native attribute, which would drop focus from the
   segment just pressed. No spinner: it is one round trip.
2. The write goes out (`session.set_html_first`). The lit segment moves when
   the stored value comes back changed (detail push), not at the press —
   `ToggleGroup`'s rule, so the lit segment is always the server's answer.
3. Nothing else on the screen changes: same view, same composer, same draft,
   no history entry. Only the lit segment and its hint move.
4. Focus stays on the pressed segment. The composer does not take the caret.

**Send waits for a switch in flight.** Every path that sends the first
message — Send, Enter, a command from the command palette, an extension's
empty-state hints — is held until the write has answered **and** a fresh detail has
arrived since the press — the reply and the push arrive in either order, and the
first message must go to the session the screen shows. Any fresh detail counts,
not only one where the value moved to the one asked for: another device may
have switched it back, or there and back between two renders, and a hold
waiting for a move it never sees would keep Send held for good. The hold is
the composer's ordinary disabled Send and lasts one round trip. A hint pressed
during the hold is sent once it settles — and dropped if the user has moved to
another session by then: it was not a message for wherever they went.

Pressing the lit segment sends nothing; it only clears a refusal line.

### 2.4 When the switch fails

The reason goes in `ToggleGroup`'s own `error` line (`role="alert"`,
`text-th-error`) under the hint, above the fixed line — not in the chat's
setting error bar: the user's eyes are on the switch. The lit segment stays on
the stored value. The line clears on the next press or when the switch goes
away.

| Server answer | Line |
|---|---|
| already started (the first message got there first, from this device or another) | `This session has already started, so it stays a {Chat\|HTML first} session.` — then the switch leaves with the empty state (§2.5), and the line with it |
| session not found, or a work session | no line: the shell already handles a deleted session by leaving it, and a work session is never offered the switch |
| anything else (disconnect, internal error) | `Couldn't switch: {reason}` — the next press retries |

### 2.5 When it is offered, and what happens on send

The switch is drawn while **all** of these hold:

- the session has not started (and is not `activated`);
- the transcript is loaded and empty (messages, not records — a lone
  `process_ended` record is still empty);
- the session is not read-only (another worktree), and not a work session
  (`work_id` absent on the detail);
- the detail has arrived. `started` is only there — the row cannot tell a
  fork from a new session — so the switch waits for it rather than appear and
  then vanish. The shell mounts the chat once the detail subscription has
  answered, so in practice this is no wait at all.

While the transcript is still loading, the existing skeleton is shown as
today — never a switch that might vanish a moment later.

**On Send, it simply goes away.** The send's echo enters the transcript at
once, the empty state is replaced by the user's message, and the switch goes
with it — the choice freezes where it was made. It is not turned into a
read-only copy in the transcript: a control-shaped thing that no longer
answers would invite presses, and the place a fixed choice is read is the
session panel (§4) and the row (§3). A send the server refuses before
delivery (an open question, attachments the agent cannot take) takes its echo
with it; nothing was delivered, so the switch comes back with the draft. One
that fails in the handover itself does not bring it back: the message is in the
transcript by then, so the session has started.

## 3. The session row

An HTML first session's row carries `AppWindow` in `SidebarListItem`'s
`leftSlot`, before the fork glyph when there is one:

```
┌──────────────────────────────────────┐
│ ▣  Compare three state libraries     │   HTML first
│    Nov 2, 14:02                      │
├──────────────────────────────────────┤
│ ▣ ⑂ Compare three state libraries    │   HTML first, forked
│    Nov 2, 14:10                      │
├──────────────────────────────────────┤
│    Fix the login redirect            │   Chat: no glyph
│    Nov 2, 13:40                      │
└──────────────────────────────────────┘
```

- `size-3 shrink-0 text-th-text-muted`, `aria-hidden` — exactly the fork
  glyph's classes, so the two read as one family of quiet markers. Chat rows
  get no glyph: the default needs no mark, and a glyph on every row is noise.
- Order: the style first, then the fork. The style is what the session *is*;
  the fork is where it came from.
- **Screen reader:** `<span className="sr-only">, HTML first</span>` next to
  the title, before the fork's `, forked from …` — beside the title rather than
  in the row's `aria-label`, which would replace the whole name and the row's
  own state indicator with it (the fork glyph's reasoning).
- **Live.** The glyph follows the stored value, so on an unstarted session it
  appears and disappears as the user switches. Every surface reading the value
  then says the same thing at every moment.
- The glyph is decoration on a row whose height and hit area do not change, so
  the touch floor is unaffected.

## 4. Once started: the session panel

After the first message the choice is not shown on the chat screen — the
transcript is the screen, and the header stays as it is. For an HTML first
session, the session panel (the header's title dropdown) carries one read-only
line, so the choice can be read from inside the session — on a phone the
sidebar with the row's glyph is usually closed.

- A `PanelSection` titled `Session`, placed after the Engine and Mode sections
  (whichever are shown) and before Work: it is a fact about how the agent was set up, closer to the settings
  than to what the session has done.
- Its body, one row, no control:
  `▣ HTML first` (primary text) and under it, muted `text-xs`:
  `Fixed when the first message was sent.`
- Shown only when `html_first` is true and the session has started. A Chat
  session gets no section — the default needs no mention — and before the
  start the switch on the screen is the one place to read and change it.
- A fork of an HTML first session shows it too: it is started from birth. So
  does a read-only session opened from another worktree: it is a fact, not a
  setting.
- Plain text, not a disabled control: there is nothing to try and nothing to
  explain about why it cannot be pressed.

## 5. Accessibility summary

- The switch is a labelled group of `aria-pressed` toggle buttons, each
  `min-h-11` (44px) and sharing the width — above both pointer floors.
- The hint and the fixed line are plain text after the group, read in order.
- `disabled` during the hold is `aria-disabled`, keeping focus where it was.
- A refusal is `role="alert"`.
- The row's glyph is `aria-hidden` and said in words next to the title.
- Colours are `th-` tokens only; the switch uses `ToggleGroup`'s, the glyph the
  fork glyph's.
