# Canvas Mode

A second way to talk to an agent. In an ordinary session the screen is a
transcript and the user types. In a **canvas session** the screen is a page the
agent draws, and the user answers by operating it: pressing its buttons, filling
its forms, typing into its fields. The transcript is still there, one tap away,
holding every detail; the canvas is what the user works in.

This document is the whole design: what the screen looks like, how the agent
draws, how sizes are handled, how the user talks back, what the server checks,
what is stored, what the agent is told, and how permissions and progress are
shown. It also fixes the **contract between the server and the frontend**:
the session option, the RPCs, the pushed state, the record shapes, the tool
results, the snapshot storage, and the protocol between the sandboxed page and
the app. A frontend can be built from this document alone, and the server
against it.

It builds on, and does not repeat:

- [tool-call-ui.md § A page the agent drew](tool-call-ui.md#a-page-the-agent-drew-html_render)
  — the sandboxed double frame, its policy and project files. The canvas reuses
  all of it.
- [page-external-hosts-ui.md](page-external-hosts-ui.md) — why a page reaches
  no other host until the reader allows it, and the strip that offers it.
- [lifecycle.md](lifecycle.md#session-one-reducer) — `TurnState`, blockers, and
  why nothing can be sent into a turn blocked on a permission.
- [session-fork-ui.md](session-fork-ui.md) — the fork rule, which the canvas
  follows.
- [turn-progress-ui.md](turn-progress-ui.md) — the clock and the thinking line
  the activity strip reuses.
- [AGENTS.md § Events are events, state is state](../AGENTS.md#code-organization)
  — the rule behind every storage decision below.

## Key Files

Partly built. The canvas store, the session property, the pushed state, the
link from a result to its revision, the fork, the history reads, lint, the send
RPC, the size on messages, the pending permission requests on subscribe, the
two tools and the guidance exist; the frontend is later work that reads this
document. Rows marked *planned* do not exist yet.

| Path | Role |
|------|------|
| `server/canvas/` | The canvas package: the store (`Store` — state, snapshots, `Apply`, `ReportSize`, `Fork`, the history reads), the tool result text and reading a revision back out of it (`ResultText`, `FailureText`, `RevisionFromResult`), a canvas action and its text (`Action`, `ActionText`), `ForkPoint`, both engines' names for the two tools (`IsTool`), applying an update's ops and lint (`CheckRender`, `ApplyUpdate`) |
| `server/process/canvas_calls.go` | Stamping `canvas_revision` on a canvas call's `tool_result` before it is recorded and broadcast (§13.4) |
| `server/ws/rpc_canvas.go` | `chat.canvas_action` and the checks on it and on a `canvas_size`; `chat.canvas_history`, `chat.canvas_snapshot` |
| `server/worktree/manager.go` | Wiring: one `canvas.Store` per worktree (`Worktree.CanvasStore`), pushing through `ChatMessagesWatcher`, forgetting deleted sessions |
| `server/mcp/canvas.go`, `server/mcp/tools.go` | The `canvas_render` and `canvas_update` handlers, which call into `server/canvas`; the refusals in and outside a canvas session (§3.4), decided from the stored property (`Sessions.ResolveCanvas`); the canvas tool definitions and the per-session list (`listedTools`) |
| `server/mcp/proxy.go`, `server/mcp/server.go` | The proxy's `--canvas` flag, choosing the instructions and the tool list |
| `server/agent/guidance.go` | `CanvasGuidance`, beside `Guidance`; `GuidanceFor` picks one |
| `server/agent/cli_question.go` | The canvas wording of the refusal of the CLIs' own question tool (`CanvasCLIQuestionRefusal`, `CLIQuestionRefusalFor`) and of the user's warning (§3.4) |
| `server/agent/agent.go` | `StartOptions.Canvas` carries the property to both adapters (`claude.go`'s MCP config, `codex.go`'s thread parameters and `instructions.go`), set by `process.Manager` from `SessionMeta.Canvas` |
| `server/session/types.go`, `server/session/store.go` | `SessionMeta.Canvas`, `CreateSpec.Canvas`; `CreateFork` copying the property |
| `server/rpc/types.go` | `SessionListItem.Canvas`, the canvas params and results |
| `server/chat/client.go` | Copying the canvas into a fork in `Fork`, once its history is written (§13.6); sending a canvas action (`SendCanvasAction`); a message's size (`Sender.CanvasSize`) — reported to the store and added to what the agent reads (`deliveredText`) |
| `server/ws/rpc_chat.go`, `server/ws/rpc_session.go` | The canvas half of `chat.messages.subscribe`, and `chat.message`'s `canvas_size`; `session.create`'s option |
| `server/watch/chat_messages.go` | Pushing `chat.canvas_state`; the pending permission requests a subscription starts from (§10.4) |
| `web/src/lib/canvasTools.ts` | *planned* — Both engines' names for the two tools, and nothing else |
| `web/src/lib/canvasBridge.ts` | *planned* — The script injected into the page, the base stylesheet, and the message types of the bridge |
| `web/src/components/Canvas/` | *planned* — `CanvasView`, `CanvasFrame`, `ActivityStrip`, `PermissionPanel` |

---

## 1. The rules

**Canvas is a property of the session, fixed at birth.** It is chosen when the
session is created and never changes afterwards. It is not a `Mode`: `Mode` is
how permissions are handled (today `default` and `yolo`) and can be changed; canvas is
what the session *is*, and changing it halfway would leave an agent that was
told one thing living in a session that became another. A fork of a canvas
session is a canvas session.

**The page is the agent's; everything that decides anything is Pockode's.** The
agent draws freely, scripts included. What allows a host, grants a permission or
switches views is drawn by the app outside the frame, where nothing the page
draws can reach — however much it looks like the real thing.

**The current canvas is state; each drawing is an event.** The page on screen
now is session state, owned by the canvas store and pushed to the client. That a
call drew revision 8 at 14:02 is a fact, recorded on the call's result and kept
as a snapshot forever. The frontend never finds the current page by looking for
the last drawing in the transcript — that page of the transcript may not even be
loaded.

**Agent content is trusted.** The page sends what the agent wrote it to send.
There are no anti-forgery tokens and no rate limits on sending: a page that
spams actions is a page the agent wrote badly, and the transcript shows it. The
sandbox still protects Pockode and the user's data from the page, exactly as it
does for `html_render`.

**Both engines.** Claude and Codex both reach Pockode's MCP server, so both draw
through the same two tools and read the same messages. Nothing below is
engine-specific except where guidance is delivered (§9).

---

## 2. The screen

```
┌──────────────────────────────────────────────┐
│ ←  Release checklist        [Canvas│Chat]  ⋯ │  session header
├──────────────────────────────────────────────┤
│ ⚠ 2 permission requests waiting      [Show] │  permission banner — only when collapsed (§10)
├──────────────────────────────────────────────┤
│ ⊘ Not loaded · cdn.jsdelivr.net      [Load] │  hosts strip — only when something was refused
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│             the canvas: the page             │
│             the agent drew, filling          │
│             everything between               │
│                                              │
│                                              │
├──────────────────────────────────────────────┤
│ ⟳ Running tests · npm test           1m 4s › │  activity strip (§11)
├──────────────────────────────────────────────┤
│ [ Message…                              ]  ■ │  collapsed input; ■ = Stop while a turn is open
└──────────────────────────────────────────────┘
```

- **The header** is the session header every chat has, with a **Canvas | Chat**
  segmented control. Which view is up is the device's own UI state — not session
  state, not in the URL's history: switching replaces the entry rather than
  pushing one, so Back leaves the session as it does from either view. A canvas
  session opens on Canvas. **The canvas frame stays mounted while chat view is
  up** — hidden, not unmounted — so switching views neither loses what the user
  did in the page nor runs its scripts again.
- **The canvas** takes every pixel the bars leave. It is the page frame of §4.
- **The activity strip** is one line saying what the agent is doing or last
  said (§11).
- **The input** is collapsed to one line: `Message…` and, while a turn is open,
  Stop. Tapping it expands it into the ordinary composer (attachments, commands,
  the same send rules) over the bottom of the canvas. Sending or blurring an
  empty field collapses it again. Typing is the fallback for what the page did
  not offer; the page is the main way in.
- **Chat view** is the session's ordinary transcript, untouched except for how
  the canvas tools and canvas actions are drawn there (§12). Every detail the
  canvas view leaves out — the whole reply, every tool call, every thinking — is
  there.

**Before anything is drawn** (revision 0) the canvas area shows a muted line in
its centre: `Nothing drawn yet`, or `The agent is drawing…` while the session's
turn is running. Never a spinner of its own: liveness is the strip's.

---

## 3. How the agent draws

Two MCP tools, both only in canvas sessions.

### 3.1 `canvas_render` — the whole page

```json
{ "html": "<!doctype html>…" }
```

`html` is a full document or a fragment, at most 256KB. It replaces the
canvas. Free HTML: scripts run, SVG and `<canvas>` draw, CSS is the agent's.
Project files are referenced by path exactly as an `html_render` page does
([project files](tool-call-ui.md#project-files)); every other host waits for the
user ([page-external-hosts-ui.md](page-external-hosts-ui.md)).

### 3.2 `canvas_update` — changing parts of it

```json
{
  "ops": [
    { "op": "replace", "region": "results", "html": "<li>…</li>" },
    { "op": "append",  "region": "log",     "html": "<p>Step 3 done</p>" },
    { "op": "remove",  "region": "spinner" }
  ]
}
```

A **region** is any element carrying `data-pk-region="name"`. Names are
case-sensitive, non-empty, and unique within the page.

| Op | Effect | `html` |
|---|---|---|
| `replace` | The region's **contents** are replaced; the element and its attributes stay, so the region still exists afterwards | required (may be empty) |
| `append` | `html` is added at the end of the region's contents | required, non-empty |
| `remove` | The region element itself is removed, contents and all | not allowed |

Ops apply **in order, all or nothing**: each op sees the page the previous one
left, so a `replace` can create a region a later op in the same call targets. If
any op fails, none is applied and the canvas stays at its revision.

Why contents and not the element for `replace`: an agent replacing a region
would have to repeat the marker in every `html`, and forgetting it once makes
the region vanish from under the next update. An agent that wants the element
itself gone uses `remove`.

**The server applies the update and checks the result.** It holds the current
full document; it parses it with an HTML5 parser, applies the ops to the tree,
serializes the result, and lints that (§7).

- **The parser** is `golang.org/x/net/html`, the Go project's implementation of
  the HTML5 parsing algorithm browsers follow; adding it was approved under the
  *Ask First* rule of [server/AGENTS.md](../server/AGENTS.md), and its licence
  goes into the third-party notices with the rest.
- **A render is stored serialized too**, not as written: parsed and serialized
  once, so every revision has gone through the same normalization (an `<html>`,
  `<head>` and `<body>` around a fragment, closed tags) and an update starts from
  the same tree the previous revision was stored as. The 256KB limit applies to
  the agent's `html` and to the stored document alike.
- **An op's `html` is parsed as a fragment in the region element's context**
  (`html.ParseFragment` with the region as context), which is what the browser's
  `innerHTML` does — so `<tr>` in a `<tbody>` region and `<option>` in a
  `<select>` region come out as rows and options, not as stray text.
- **Serialization is best-effort for broken markup.** For well-formed HTML the
  serialized document builds the tree it was parsed into; for misnested markup
  (a `<div>` inside a `<p>`, content directly in a `<table>`) the parser's
  repairs are kept, and the browser may repair the serialized text differently
  again. The stored document is still the truth every client draws.
- **Regions are what is in the markup.** A region an agent's own script creates
  in the browser does not exist on the server, and an update that targets it is
  refused as missing. A region has to be written into the HTML the agent passes.
  Nor is a region inside a `<template>`: a browser keeps a template's contents
  out of the document, where `querySelector` never looks, so the server does not
  count it either — not as a target, not as a duplicate.

A `canvas_update` with no canvas yet (revision 0) is refused: there is nothing to
update, draw the whole page with `canvas_render` first.

Parallel tool calls in one turn are serialized per session: the second update
applies to the first one's result.

### 3.3 Theme and default styling

Pockode provides **theme colour variables and default styling of native
controls**, and nothing else — no component library, no layout, no classes. The
agent's CSS wins over all of it.

The variables follow the app's theme, light or dark and whichever palette is
chosen, and change live when the user switches theme (§8.4):

| Variable | Comes from | For |
|---|---|---|
| `--pk-bg` | `--th-bg-primary` | the page background |
| `--pk-bg-secondary` | `--th-bg-secondary` | cards, panels |
| `--pk-bg-tertiary` | `--th-bg-tertiary` | a third level, hover fills |
| `--pk-text` | `--th-text-primary` | body text |
| `--pk-text-secondary` | `--th-text-secondary` | secondary text |
| `--pk-text-muted` | `--th-text-muted` | hints, meta |
| `--pk-border` | `--th-border` | lines, field borders |
| `--pk-accent` | `--th-accent` | the primary action, links, focus |
| `--pk-accent-text` | `--th-accent-text` | text on `--pk-accent` |
| `--pk-success` | `--th-success` | |
| `--pk-error` | `--th-error` | |
| `--pk-warning` | `--th-warning` | |
| `--pk-code-bg` | `--th-code-bg` | code blocks |
| `--pk-code-text` | `--th-code-text` | |

The names are the contract with the agent; what each maps to is the app's. A
theme token added to the app is not automatically a `--pk-*` variable — every
one is a promise to every page ever drawn.

The **base stylesheet** is placed before the agent's markup and written entirely
inside `:where()`, so it has zero specificity and any rule of the agent's
overrides it:

- `:root` gets the variables, `color-scheme` matching the theme, and
  `background: var(--pk-bg); color: var(--pk-text)` — the theme following
  light/dark is the variables *applied*, or a dark-themed page would start as
  black text on a dark canvas. Nothing else of the document is styled: no font,
  no margin, no layout; those are the agent's.
- `button`, `input`, `select`, `textarea` get the theme: `--pk-bg-secondary`
  fill, `--pk-border` border, rounded corners, `font: inherit`, a focus ring in
  `--pk-accent`, and the coarse-pointer hit-area floor of 44px
  ([responsive-ui.md](responsive-ui.md)) as a `min-height` under
  `@media (pointer: coarse)`. A `button` inside a `form[data-pk-send]`, and any
  `[data-pk-send]` button, takes the accent fill.
- Disabled controls are dimmed.

Unlike an `html_render` page, which is a white sheet of paper whatever the theme,
the canvas *is* the screen: it follows the theme, because a white page filling a
dark app is a light switched on in the user's face.

### 3.4 Not for canvas sessions, and not outside them

- `html_render` is neither listed nor accepted in a canvas session: the canvas
  is where things are shown. A call is refused with: `This is a canvas session:
  show it in the canvas with canvas_render or canvas_update instead.`
- `canvas_render` and `canvas_update` are neither listed nor accepted outside a
  canvas session; a call is refused with `canvas tools are only available in a
  canvas session`.
- `question_post` and `question_cancel` are not listed in a canvas session, and
  are refused with `This is a canvas session: draw the question into the canvas
  — buttons for choices, a form for input — instead of posting it.` A canvas
  session asks by drawing; a question card over the canvas would be a second,
  competing way to ask. `question_answer` stays: answering another agent's
  question is not asking the user.
- **The refusal of the CLIs' own question tool** — today
  `agent.CLIQuestionRefusal`, which points at `question_post`
  ([agent-integration.md](code/agent-integration.md#refusing-the-clis-own-question))
  — gets a canvas wording, chosen from the session property: `This question was
  not delivered to the user: in a canvas session, draw it into the canvas —
  buttons for choices, a form for input.` Pointing a canvas agent at a tool its
  session refuses would only send it into a second refusal. The user's warning
  record (`cli_question_refused`) says the agent was told to draw the question
  into the canvas instead.

Which tools are listed is chosen by the proxy (§9.1); whether a call is accepted
is decided by the executor from the session's stored property, so the list and
the refusal cannot disagree about which session is which.

---

## 4. The page frame

The canvas is drawn in the same **double frame** as an `html_render` page — the
wrapper whose one child is the page, both `srcdoc`, both sandboxed with
`allow-scripts allow-popups allow-popups-to-escape-sandbox` and never
`allow-same-origin` or `allow-modals`, the policy at byte 0 of both documents,
the project capability as the base
([the sandbox and the policy](tool-call-ui.md#the-sandbox-and-the-policy)).
`CanvasFrame` takes the policy, the reporter and the capability from the same
modules `HtmlFrame` does; it does not copy them.

What differs:

| | `html_render` card | Canvas |
|---|---|---|
| Size | as tall as the page, capped | the canvas area, or the drawn size (§5) |
| Height reporter | appended | not used |
| Background | white, `color-scheme: light` | the theme (§3.3) |
| Base stylesheet | none | §3.3, before the agent's markup |
| Bridge | none | §8, after the reporter and before the agent's markup |
| Redrawn | never once mounted | on every revision, in place when it can (§8.3) |
| Host allowance | per call | per session: a host allowed once stays allowed across redraws of this session, until the app reloads |

The page document is therefore, in order: the policy, the base, the reporter,
the bridge, the base stylesheet, then the agent's document with absolute project
paths rewritten (`projectRelativeHtml`). The `html` of every patch op (§8.3) is
rewritten the same way before it is posted.

**The project capability** is taken fresh for every document drawn, as for an
`html_render` page ([project files](tool-call-ui.md#project-files)). A canvas
lives longer than a card — it is patched in place for hours — so a patch is
applied only while the frame's capability has at least five minutes left (the
`fresh` margin); past that, the new revision is drawn whole under a new
capability. A canvas left untouched past its capability's lifetime loses its
project requests until it is drawn again, the known limit `html_render` pages
share.

`form-action 'none'` stays in the policy: a form submits only through the
bridge, which takes the `submit` before the browser would refuse it.

The hosts strip sits between the header (or the permission banner) and the
canvas, as on every other page surface.

---

## 5. Size

A page drawn for a phone held upright and shown on a tablet on its side is a
different page. So the agent is told the size, and the frontend shows each
revision at the size it was drawn for.

**The canvas size** is the CSS-pixel size of the canvas area on the sending
device — the rectangle between the bars, in whole pixels (rounded down).

**A soft keyboard does not count.** The page will be read without it, but a
keyboard is up for nearly every send — Enter in a page field, or the composer —
and with `interactive-widget=resizes-content` it shrinks the canvas area. So the
size sent is the **last measurement taken while nothing editable had focus**:
the app measures the canvas area on every resize, and keeps a measurement only
while neither the composer nor an editable element in the page has focus. The
app cannot see focus inside the frame — its own `document.activeElement` is the
frame after any tap in the page — so the bridge reports it
(`pockode:canvas-focus`, §8.2): editable means a text-holding `input`, a
`textarea`, a `select` or a `contenteditable`. A measurement whose width differs
from the kept one replaces it regardless — that is a rotation or a resized
window, not a keyboard.

**Every message the user sends carries the sending device's canvas size** —
canvas actions and typed messages alike, from either view (chat view sends the
last size this device measured in canvas view, or none if it never showed it).
The server keeps the latest size it was told as canvas state
(`reported_size`). The agent sees the size in every message (§6.3) and designs
for the latest one.

**Every revision records the size it was drawn for** (`drawn_for`): the
`reported_size` at the moment the call was applied. It is absent when no size
has been reported yet.

**Showing a revision.** In each dimension, the frame is the larger of the
canvas area and `drawn_for`:

- Screen at least as large as `drawn_for` (or `drawn_for` absent): the frame
  fills the canvas area. A page drawn narrower than the screen gets the whole
  width, which a page laid out in normal flow handles; letterboxing it would
  waste a tablet to protect a page that did not need it.
- Screen smaller than `drawn_for`: the frame keeps `drawn_for` in that dimension
  and the canvas area scrolls to it. **Never scaled**: text scaled down to fit is
  text too small to read and buttons too small to press; scrolling keeps both
  real. The page's own scrolling stays inside the frame.

So after the user rotates their phone, the page they see is still the one the
agent drew, with a scroll — and the next message they send tells the agent the
new size.

**Tool results report the size too** (§9.4), so the agent knows what it just
designed for without looking back for the last message.

---

## 6. How the user talks back

### 6.1 In the page

Three attributes and one function. All of them go through the bridge (§8).

| Markup | Sends | When | Data |
|---|---|---|---|
| `<button data-pk-send="approve">` — any element but a `form`, `input`, `select` or `textarea` | `approve` | on click on it or anything inside it (`closest("[data-pk-send]")`) | inside a form: every named field of that form; plus, when the element has a `name`, `{ [name]: value }` (`value` being its `value` attribute, `""` without one) |
| `<form data-pk-send="create">` | `create` | on submit (a submit button in it, or Enter in a field) | every named field of the form, and the submitter's `name`/`value` |
| `<input data-pk-send="search" name="q">` | `search` | on Enter | `{ q: <value> }`, or `{ value: <value> }` when it has no `name` |
| `pockode.send(action, data)` | `action` | when called | `data`, any JSON value; `{}` when omitted |

Precedence, so one press never sends twice:

- **The nearest `data-pk-send` wins.** A button with its own `data-pk-send` inside
  a `form[data-pk-send]` sends the button's action (with the form's fields); the
  form's submit is prevented. A plain submit button in that form submits the
  form's action.
- **Enter in an `<input data-pk-send>`** sends the input's action only, even
  inside a `form[data-pk-send]`; the implicit submit is prevented. A click on
  such an input sends nothing — Enter is its gesture.
- **Enter while an input method is composing** (`isComposing`, or `keyCode`
  229) sends nothing: it is confirming a Chinese or Japanese word, not
  submitting.
- `select` and `textarea` take no `data-pk-send` of their own (a lint error,
  §7.1): a select's change and a textarea's Enter are not a send anyone means.
  Put them in a form.

- **Form data** is the form's `FormData`: a field with a `name` is included; a
  name that occurs once is a string, a name that occurs more than once (checkboxes,
  a multiple select) an array of strings; file inputs are left out — a file is
  not something a page can send (§7.2 warns about one). Unchecked checkboxes are
  absent, as in any form.
- **`<input data-pk-send>` is cleared** once the send is accepted, and keeps its
  text when it is refused, so a refused message is never lost.
- **`pockode.send`** returns a `Promise` that resolves once the server accepted
  the message and rejects with an `Error` when it was not sent; the error's
  `code` is one of the reasons in §8.2, and its `message` is a sentence the page
  may show. `action` must be a non-empty string. `data` is passed through
  `JSON.stringify` / `JSON.parse` in the bridge before it is posted, so what the
  app receives is what the agent will read: a `Date` arrives as its string,
  `undefined` fields vanish, and a value JSON cannot hold (a `BigInt`, a cycle)
  rejects with `code: "invalid"` without sending.
- **A send while the agent is working** is an ordinary mid-turn message: it
  folds into the running turn
  ([the read point](agent-event.md#the-read-point-message_ingested)). **A send
  while the turn is blocked on a permission request is refused** (§10.3) — both
  CLIs read nothing while a permission is open
  ([lifecycle.md](lifecycle.md#session-one-reducer)).
- **A send on load** — a script calling `pockode.send` as the page starts —
  works, and runs again every time the page is drawn again: on every revision
  that redraws it in full, on every reopening of the session, and on **every
  device** showing the canvas — two phones open on one session send it twice.
  Each one starts or joins a turn. The agent is told so (§9); nothing prevents
  it. (Switching between canvas and chat view does not redraw, §2.)

### 6.2 The canvas action record

What reaches the agent is a **user message carrying a structured canvas
action**. It is the existing `message` record (`origin` user), with one field
added — like `command`, a structured copy the client draws from:

```jsonc
{
  "type": "message",
  "message_id": "…",
  "content": "Canvas action \"create\" from revision 7:\n{\"title\":\"Fix login\"}",
  "canvas_action": {
    "action": "create",
    "data": { "title": "Fix login" },
    "revision": 7
  },
  "canvas_size": { "width": 390, "height": 664 }
}
```

- `canvas_action.revision` is the revision **the frame was showing** when the
  user acted — the app's knowledge, never the page's (§8.2). It may be older than
  the current one: the user pressed a button on a page that was being redrawn,
  and the agent is told exactly that.
- `canvas_size` is on every user message in a canvas session that carried a
  size, typed ones too. It is a fact about the moment of sending.
- `content` is the canvas action as the agent reads it, without the size (§6.3).

It is an event, and it stays one: it says what the user did on which revision,
and nothing on it changes when the canvas does. The chat view draws it as such
(§12).

**A canvas action never becomes a draft.** Two existing features put a user
message's `content` back into the input box: a fork anchored on it
([the dropped prompt](session-fork-ui.md#the-dropped-prompt)) and restoring a
message a Stop discarded
([discarded-messages-ui.md](discarded-messages-ui.md#5-what-restoring-does)). For
a canvas action that content is machine text no user wrote, so neither applies:
a fork anchored on a canvas action drops it and leaves the input empty, and a
discarded canvas action is drawn discarded with no restore. The user acts on the
page again instead — which, in the fork, is the canvas as it was at the cut
(§13.6).

### 6.3 What the agent reads

A canvas action's text is

```
Canvas action "create" from revision 7:
{"title":"Fix login"}
```

— the action name quoted, the revision, then `data` as compact JSON on the next
line (`{}` when empty).

In a canvas session, **every user message that carried a size** is delivered with
one more line at the end:

```
[Canvas size: 390×664]
```

The line is added at delivery, by one function in the chat client, and is not in
the record's `content`: `content` stays what the user typed (or the action text),
so a forked-away prompt comes back as a draft without a size line in it
([the dropped prompt](session-fork-ui.md#the-dropped-prompt)), and the size is
read from `canvas_size` by anyone who needs it.

### 6.4 The RPC

```
chat.canvas_action {
  session_id: string,
  action: string,          // 1–128 characters, no control characters
  data?: unknown,          // any JSON; omitted = {}; at most 64KB serialized
  revision: number,        // the revision the frame was showing
  canvas_size?: { width: number, height: number }
} -> MessageResult
```

`MessageResult` is `chat.message`'s reply (`seq`, `message_id`, `content`),
plus `canvas_action` echoed back, so the sender — excluded from the broadcast of
its own message, as with `chat.message` — can draw it.

Refusals, all `InvalidParams` with these words:

| Case | Message |
|---|---|
| The session does not exist | `session not found` |
| The session is not a canvas session | `this session is not a canvas session` |
| `action` empty, too long, or with control characters | `action must be 1–128 characters with no control characters` |
| `data` over 64KB | `data is <n> bytes, over the 64KB limit` |
| `revision` below 1 | `revision must be 1 or higher: an action comes from a page that was drawn, and revision <n> was not` |
| `revision` newer than the canvas | `revision <n> does not exist yet: the canvas is at <m>` |
| `canvas_size` not whole numbers from 1 to 10000 | `canvas_size must be whole CSS pixels between 1 and 10000` |
| Blocked on a permission request | `chat.ErrTurnAwaitingAnswer`'s message, unchanged |

It goes through the same send path as a typed message (`chat.Client.sendEvent`):
refused before anything is recorded when the turn awaits an answer, persisted,
delivered, broadcast as `chat.message`, with a read point when it lands mid-turn.

`chat.message` gains the same optional `canvas_size`, refused with the same
words when out of bounds. Sent to a session that is not a canvas session it is
ignored — chat view of an ordinary session has no canvas to measure, and a client
that sends one anyway has done no harm. A size received on either RPC becomes the
canvas's `reported_size` (§13.3) only once the message has passed every check
above, right before it is recorded: a refused message reached no agent, so it
reports nothing.

---

## 7. Lint

The server checks every result — a render's document, an update's resulting
document — before storing it. The purpose is to help the agent get it right on
the next call, so **every message names the problem and says how to fix it**.
Errors reject the call and leave the canvas unchanged; warnings are returned in
the result of a call that succeeded.

Text checks (scripts, inline styles) are done on the parsed tree: attributes on
elements, the text of `<script>` and `<style>` elements, `on*` handler
attributes, `javascript:` URLs in any attribute, and `style` attributes. The tree checked is the
stored document read back — what every client and the next update will parse —
not the tree before serialization, so the two cannot disagree. Fields inside a
`<template>` are not checked: they are inert until a script clones them. They are deliberately simple. **An error is
raised only when the check is sure**; where the page may do something the server
cannot see — a script loaded from a file, code that builds its calls at run time
— the error is not raised, and a warning is used where one helps.

### 7.1 Errors

| Check | Message |
|---|---|
| Empty: whitespace only, or a body with no element and no text, and no script anywhere (a script alone may draw the page, and a leading one is parsed into `<head>`) | `The page is empty: pass the whole page to draw, or use canvas_update to change part of it.` |
| Over 256KB (the render's `html`, an op's `html` — prefixed `ops[<i>]: ` and refused before anything is parsed — or the document an update produces) | `The page is <n> bytes, over the 256KB limit: move large data, images or libraries into project files and reference them by path.` |
| Nothing can send: no `data-pk-send` anywhere, the word `pockode` in no inline script, `on*` attribute or `javascript:` URL (any mention: `pockode?.send` and `const { send } = pockode` send too), and no script loaded from a file — a `<script src>`, an svg `<script href>`, or an inline script that `import`s — `import "x"`, `import(`, `import {`, not a word like `important` (a file may send, and is not read) | `Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.` For an update: `After this update nothing on the page could send anything back — <the same fix>.` |
| A `form[data-pk-send]` with a field (`input` other than `submit`/`button`/`reset`/`image`/`hidden`/`file`, `select`, `textarea`; inside the form or naming it with `form="id"`) that has no `name`, is not itself `data-pk-send`, has no `on*` handler of its own (a filter or a toggle the page acts on) and is not disabled (itself or by a `fieldset`) | `The form data-pk-send="<action>" has fields without a name, which are not sent: give each field a name attribute (for example <input name="title">). Unnamed: <tag#id or tag[type] list>.` |
| `<input data-pk-send>` whose `type` cannot hold text: `checkbox`, `radio`, `file`, `hidden`, `range`, `color`, `date`, `datetime-local`, `month`, `time`, `week`, or a button type (`submit`, `button`, `reset`, `image` — a click on an input sends nothing, §6.1). An unknown `type` is a text input to the browser, so it passes | `<input type="<type>" data-pk-send="<action>"> cannot be sent with Enter: put it in a form with data-pk-send and a submit button, or use a text input.` |
| `data-pk-send` on a `select` or `textarea` | `<<tag> data-pk-send="<action>"> cannot send by itself: put it in a form with data-pk-send and a submit button.` |
| A region name used twice | `Region "<name>" is used <n> times: region names must be unique — rename one, or remove the duplicate.` |
| An update op targets a region that does not exist | `There is no region "<name>". Regions on the page: <a, b, c> (or: the page has no regions — mark the element with data-pk-region="name", or redraw with canvas_render).` |
| An op is malformed (checked for every op before any is applied) | `ops[<i>]: <op> needs html` / `ops[<i>]: remove takes no html` / `ops[<i>]: unknown op "<op>": use replace, append or remove` / `ops[<i>]: <op> needs a region: the data-pk-region name of the element to change` / `ops is empty: pass at least one op (replace, append or remove).` |
| `replace` or `append` with content on a void region (`<img data-pk-region>`) | `ops[<i>]: region "<name>" is an <img>, which cannot hold contents: mark an element around it with data-pk-region instead, or replace the whole element through its parent region.` |
| A raw-text region (`script`, `style`, …) would hold its own end tag — its new text, or for an `append` the text it had plus the new. Such a region takes its `html` as one text node, as `innerHTML` does; stored as written, the end tag would close it on the next parse | `ops[<i>]: <script> region "<name>" would contain "</script", which would end the element when the page is drawn: write it as "<\/script" instead.` |
| A `<script>` region would end (counted the same way) inside a `<!--` that holds a `<script` (followed by a space, `/` or `>`) with no `-->` after it — the tokenizer's double-escaped state, in which the region's own `</script>` stops ending it and the rest of the page is read as script. A `<!-- … -->` around a `<script>`, as in the legacy `document.write` pattern, is fine | `ops[<i>]: <script> region "<name>" would contain "<script" inside "<!--" with no "-->" after it, which makes the browser read the rest of the page as script: close it with "-->", or write "<\!--" instead.` |
| The stored document, read back, has lost regions the call's tree had (something before them swallows the rest of the page, for example a `<plaintext>`) | `The page does not read back as written: regions <a, b> are lost, because something before them — markup inside a <script>, <style> or <svg>, or a <plaintext> — swallows the rest. Check what this call puts there.` |
| Nested more than 512 elements deep, the parser's limit (for an op's `html`, prefixed `ops[<i>]: `) | `The page nests elements more than 512 deep, which cannot be read: flatten it, or build deep structures from a script.` |
| A void element the parser gave contents (foreign content such as `<svg><track><rect/></track></svg>`), which cannot be serialized; the other errors are still listed, all but the size | `<track> cannot hold anything, but the page puts content inside one: it has no closing tag, so put that content after it, or use another element.` |
| An update with no canvas yet | `There is no canvas yet: draw the whole page with canvas_render first.` |
| An empty `data-pk-send` or `data-pk-region` value | `data-pk-send needs an action name, for example data-pk-send="save".` / `data-pk-region needs a name, for example data-pk-region="results".` |

All errors found are listed, not only the first: an agent fixing one at a time
pays one call per problem.

### 7.2 Warnings

| Check | Message |
|---|---|
| A `src`, `href` (not a link's: an `<a>` or `<area>` is followed, not loaded; a `<base href>` counts, since relative loads then go to its host), `srcset`, `poster`, CSS `url()` or `@import` naming another host (`http:`, `https:`, `//`) | `Loads from <hosts>: the user must allow each host before it loads, and until then it is missing. Prefer project files or inline code.` |
| `alert(`, `confirm(` or `prompt(` in a script — the global function, or through `window.`/`self.`/`globalThis.`; not a method of the same name | `alert/confirm/prompt do nothing here: show the message in the page instead.` |
| `position: fixed` | `position: fixed may put content off screen on a small device, and the canvas scrolls: prefer normal flow.` |
| A hard-coded `width`/`min-width` (CSS, or a `width` attribute) in `px` larger than the drawn width. Not inside `@media` or `@container` (it applies only where the query says it fits) nor in an `@import`'s media query, and not a `width` attribute on an element whose own `style` sets its width (a high-DPI `<canvas>`) | `Fixed widths wider than the canvas (<w>px): <values>. The user will have to scroll sideways; use max-width or percentages.` (Not checked when the size is unknown.) |
| Colour literals (`#…`, `rgb(`, `hsl(`) in CSS declarations, outside `var()` fallbacks and `url()`s (a `data:` image's colours are its own) | `<n> hard-coded colours: they will not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text)).` With one, `1 hard-coded colour: it will not follow …`. |
| A field (`input` other than a button type or `hidden`, `select`, `textarea`) that no send carries — its form (the one around it, or the one its `form="id"` names) is neither a `form[data-pk-send]` nor a form holding a `data-pk-send` button (§6.1), or it has no `name` in a form only a button sends — is not itself `data-pk-send` and has no `on*` handler of its own, while nothing can send from a script by the rule of the "Nothing can send" error (§7.1) | `<n> fields can never be sent: <list>. Put them in a form with data-pk-send, or send them from a script with pockode.send.` A file input is listed here too, wherever it is, unless it has a handler of its own. With one field, the singular: `1 field can never be sent: <field>. Put it … send it …`. |

**An update reports only the warnings it introduced**: a kind of warning the
previous revision did not have, or one that grew — a host, field or width it did
not list, or more colours than it counted. Both documents are checked at the
current canvas width, so the comparison is like with like. The rest were
already said when they were drawn; repeating them on every small update would
teach the agent to ignore the list.

---

## 8. The bridge between page and app

### 8.1 What is injected

`canvasBridgeScript` runs in the page before the agent's markup. It:

- defines `window.pockode` — `send(action, data)` and nothing else;
- takes `click`, `submit` and `keydown` (Enter) in the capture phase on the
  document, so an element the agent added later works without wiring, and calls
  `preventDefault()` on what it sends;
- applies patches and theme changes the app posts (§8.3, §8.4);
- reports whether an editable element has focus, for the size rule (§5);
- reflects whether sending is possible on `document.documentElement` as
  `data-pk-blocked="permission"` while it is not, so a page may style itself for
  it.

It is a script in the agent's document, so the page can call or overwrite
anything it defines. That is accepted (§1): the page can only ever ask the app to
send, which is what it is for. What protects the user is on the app's side.

### 8.2 Messages

Every message is a plain object with a `type`, posted with target origin `"*"`
(the frames are opaque origins). The app takes a page message only when its
`source` is the canvas page's window, exactly as `usePageReports` does; the
bridge takes an app message only when its `source` is the app's window
(`parent.parent`).

**Page → app**

```ts
{ type: "pockode:canvas-send", id: string, action: string, data: unknown }
{ type: "pockode:canvas-patched", revision: number, ok: boolean }
{ type: "pockode:canvas-focus", editable: boolean }   // on focusin/focusout, for §5
```

`id` is the bridge's own, for matching the result. The page's
`pockode:page-refused` and `pockode:page-link` reports are unchanged.

**App → page**

```ts
{ type: "pockode:canvas-send-result", id: string, ok: true }
{ type: "pockode:canvas-send-result", id: string, ok: false, code: SendRefusal, message: string }
{ type: "pockode:canvas-patch", from_revision: number, revision: number, ops: CanvasOp[] }
{ type: "pockode:canvas-theme", scheme: "light" | "dark", vars: Record<string, string> }
{ type: "pockode:canvas-sendable", sendable: boolean, reason?: "permission" }

type SendRefusal = "permission" | "readonly" | "offline" | "invalid" | "failed";
```

| `code` | When | `message` |
|---|---|---|
| `permission` | the session is blocked on a permission request | `Answer the permission request first.` |
| `readonly` | the frame shows an old revision (§13.5) | `This is an earlier version of the canvas; it cannot send.` |
| `offline` | not connected | `Not connected — try again when the connection is back.` |
| `invalid` | the bridge could not serialize `data`, or the server refused it as invalid (§6.4) | the bridge's or the server's message |
| `failed` | anything else | the error's message |

**On a send** the app fills in what the page must not choose: the session, the
`revision` the frame is showing, and the device's `canvas_size`; then calls
`chat.canvas_action` and posts the result back. The `permission` refusal is
decided on the client first, from `TurnState`, and visibly (§10.3); the server
refuses it again regardless. The `readonly` refusal is the app's alone and does
not depend on the bridge: a frame showing an old revision is never the current
canvas, and a send from it — on load, before `pockode:canvas-sendable` could
even arrive — is refused by the app on receipt.

### 8.3 Redrawing

The frontend receives a new state (§13.2) and decides how to show it:

- The frame shows `from_revision` of an `update` change: post
  `pockode:canvas-patch`. The bridge applies the ops to the live DOM — the same
  ops, the same semantics as §3.2 — so a field the user is typing in outside the
  changed regions keeps its text, its focus and its scroll. Scripts inside
  inserted HTML are run (the bridge re-creates each `<script>` element, which
  `innerHTML` alone would leave inert). It answers `pockode:canvas-patched`.
  A patch whose region the bridge cannot find in the live DOM — the agent's own
  script removed it — fails whole (`ok: false`); nothing is half-applied.
- Otherwise — a render, a frame two revisions behind, a patch that answered
  `ok: false`, no answer within 2 seconds, or a capability about to expire (§4):
  **draw the revision whole** from its `html`. Local state is lost; the page is
  what the agent drew.

**One patch at a time.** The app keeps the revision the frame shows, and it is
the app's record, not the page's: it moves to a patch's `revision` only on a
`pockode:canvas-patched` for the patch it posted (same `revision`, the first
answer only), and to a whole drawing's revision when that drawing is made. While
a patch is unanswered the frame counts as showing `from_revision` — a send in
that window carries it — and a newer state waits; when the answer comes (or the
2 seconds pass), the newest state is compared with what the frame now shows, and
patched or drawn whole by the rules above. A page forging an acknowledgement
gains nothing it could not have by sending, which it can do anyway (§1).

**The server's document stays the truth.** A patch applies the same ops to the
same markup, so normally it lands where a redraw would — but the live DOM is
also what the agent's scripts made of it, so it may differ, and that is
accepted: it is what keeps a half-typed form alive across an update. The next
whole drawing — a render, a reopening, another device — shows the stored
document exactly.

### 8.4 Theme

On mount and on every theme change the app posts `pockode:canvas-theme` with
the computed value of each `--th-*` token behind a `--pk-*` variable (§3.3). The
bridge rewrites the base stylesheet's `<style>` element with them and the new
`color-scheme`, without redrawing — never an inline style on `:root`, which
would outrank an agent's own `:root { --pk-…: … }` and break "the agent's CSS
wins".

---

## 9. What the agent is told

### 9.1 Which text reaches which CLI

`agent.Guidance` is what an agent must know before it has loaded a tool
([agent-integration.md](code/agent-integration.md#telling-the-agent-when-to-ask)).
A canvas session gets **`agent.CanvasGuidance` instead** — a different session,
not an addition: the asking section would tell it to ask with `question_post`,
which a canvas session does not do, and the rendering section would point at
`html_render`, which it does not have.

It travels through the channels `Guidance` does:

- **Claude** — the MCP server's `initialize` instructions. The proxy is spawned
  with `--canvas` for a canvas session
  (`pockode mcp --data-dir … --session-id … [--worktree …] --canvas`), and
  answers `initialize` with `CanvasGuidance` and `tools/list` with the canvas
  set (§3.4). The flag can be fixed at spawn because the property is fixed at
  birth.
- **Codex** — `developerInstructions` on `thread/start`, with `CanvasGuidance`
  where `Guidance` would go, and `--canvas` in the `mcp_servers.pockode`
  arguments. That Codex fixes the instructions when the thread starts costs
  nothing here, for the same reason.

`CanvasGuidance` has to fit Claude's 2048-character limit, like `Guidance`;
`TestToolDefinitions_FitClaudesLimit` holds both. How to write the markup lives in
the tool descriptions, which the agent reads once it reaches for the tool.

### 9.2 The guidance

```
This session is a Pockode canvas: the user's whole screen is a page you draw, and they answer by operating it.

- Draw with canvas_render (the whole page) and canvas_update (replace, append or remove parts marked data-pk-region); load them through your tool search first if you only have their names. Their descriptions show how the page sends things back to you.
- Draw every decision and input you need from the user into the canvas: choices as buttons, details as a form. Do not ask in your reply text. Never ask for passwords, tokens or API keys; tell the user which environment variable or file to set instead.
- Keep your reply text to short progress notes: the user sees only its latest line, beside the canvas. Never repeat what the canvas shows.
- Every message from the user ends with the size of their canvas. Design for the latest one; the canvas scrolls, so use normal flow and avoid position: fixed and 100vh.
- Do not draw permission confirmations: Pockode asks the user for permissions itself, outside your page.
- A send fired when the page loads fires again every time the page is drawn again, on every device showing it, and starts a new turn each time: do it only on purpose.
- Change the regions that changed with canvas_update rather than redrawing everything, so what the user typed elsewhere stays.
- Minimal examples: <button data-pk-send="approve">Approve</button> · <form data-pk-send="create"><input name="title"><button>Create</button></form> · <input data-pk-send="search" name="q"> (Enter sends) · <script>pockode.send("pick", {id: 3})</script> · <ul data-pk-region="results"></ul>, changed later with canvas_update.
```

The examples are here as well as in `canvas_render`'s description on purpose:
this text is read before any tool is loaded, and an agent that has not seen the
markup yet plans its first page without it.

### 9.3 The tool descriptions

`canvas_render`:

```
Draw the whole canvas: the page that fills the user's screen in this session, replacing what was there.
Free HTML, a full document or a fragment, at most 256KB: scripts, SVG and <canvas> run. Project files load by path (relative to the worktree root); other hosts are blocked until the user allows them, so prefer project files or inline code.
Pockode adds only theme colours that follow light/dark — --pk-bg, --pk-bg-secondary, --pk-bg-tertiary, --pk-text, --pk-text-secondary, --pk-text-muted, --pk-border, --pk-accent, --pk-accent-text, --pk-success, --pk-error, --pk-warning, --pk-code-bg, --pk-code-text — and default styling of native inputs. Use the variables instead of fixed colours.
How the page sends you something:
  <button data-pk-send="approve">Approve</button>
  <form data-pk-send="create"><input name="title"><button>Create</button></form>   (fields with a name are sent)
  <input data-pk-send="search" name="q">   (sends its value on Enter)
  <script>pockode.send("pick", {id: 3})</script>   (returns a promise; rejects with a reason when it cannot send)
Each arrives as a message naming the action, its data and the canvas revision it was sent from.
Mark parts you will change later in the markup itself: <ul data-pk-region="results"></ul>, then change them with canvas_update. Region names are unique.
The result gives the new revision, the size it was drawn for, and warnings. An error leaves the canvas unchanged and says how to fix it.
```

`canvas_update`:

```
Change parts of the canvas without redrawing it: what the user typed or scrolled elsewhere on the page stays.
Each op targets a region, an element marked data-pk-region="name": replace swaps its contents (the element stays), append adds to the end of its contents, remove deletes the element. Ops apply in order and all or nothing; a replace may create regions a later op uses.
The whole resulting page is checked as canvas_render's is. The result gives the new revision, the size it was drawn for, and new warnings; an error leaves the canvas unchanged, lists the regions that exist when one is missing, and says how to fix it.
```

Input schemas:

```
canvas_render: { html: string }                               required: html
canvas_update: { ops: [{ op: "replace"|"append"|"remove", region: string, html?: string }] }
                                                              required: ops (non-empty), op, region
```

### 9.4 Tool results

Success:

```
Canvas revision 8 · drawn for 390×664.
The user sees it now; do not describe it in your reply.
Warnings:
- Fixed widths wider than the canvas (390px): 480px. The user will have to scroll sideways; use max-width or percentages.
```

The `Warnings:` block is left out when there are none. With no size reported
yet, the first line reads `Canvas revision 8 · drawn for an unknown size (no
message has reported one yet: design for a narrow phone screen, about 360px
wide, that also works wider).`

**The first line is a contract**: `Canvas revision <n> · ` is what the server
reads the revision back from (§13.4). It is produced and parsed in one place,
`server/canvas`.

Failure is an `is_error` result:

```
Canvas not changed (still revision 7):
- There is no region "resluts". Regions on the page: results, log.
```

The text is the whole result, as written: unlike other tool errors it gets no
`Error:` in front of it. Calls outside a canvas session, malformed arguments and
server faults are ordinary tool errors.

---

## 10. Permissions

A canvas session can be blocked on a permission request like any other, and
the page must never be able to answer one. So permissions are answered only in a
**native Pockode panel** drawn outside the frame.

### 10.1 The panel

```
┌──────────────────────────────────────────────┐
│ session header                               │
├──────────────────────────────────────────────┤
│ ░░░░░░░ the canvas, dimmed and inert ░░░░░░░ │
│ ░┌──────────────────────────────────────────┐│
│ ░│ 2 permission requests              [ ⌄ ] ││  ⌄ collapses to the banner
│ ░├──────────────────────────────────────────┤│
│ ░│ Bash                               14:02 ││
│ ░│ npm install --save-dev vitest            ││  the request in full
│ ░│        [Deny] [Always allow] [Allow]     ││
│ ░│ ──────────────────────────────────────── ││
│ ░│ Write                              14:02 ││
│ ░│ src/config.ts                            ││
│ ░│ + export const …                         ││
│ ░│        [Deny] [Always allow] [Allow]     ││
│ ░└──────────────────────────────────────────┘│
├──────────────────────────────────────────────┤
│ activity strip                               │
│ [ Message… ]                              ■  │
└──────────────────────────────────────────────┘
```

- **Shape.** The answer panel's
  ([answering-ui.md §3](answering-ui.md#3-the-answer-panel)): modal over the
  canvas rectangle and nothing else, the header, strip and input left lit; up to
  85% of that rectangle, scrolling inside. It is the same reasoning — the user may
  want to Stop, or read the strip, while deciding.
- **Every pending request, in full.** Several can be pending at once (parallel
  tool calls), and each is listed with what the permission card in the chat shows
  for it — tool, input, diff — using the same component
  ([tool-call-ui.md](tool-call-ui.md#the-permission-card-takes-the-rows-place)).
  Oldest first.
- **Each is answered on its own**, with that card's own buttons. There is no
  "Allow all": a batch of requests is several decisions, and one button for all
  of them is a way to grant something unread.
- **Answered rows leave**; when none is left the panel closes by itself.
- **An expired request** leaves the list as well; the chat view's card states
  what became of it ([lifecycle-ui.md § 5](lifecycle-ui.md#5-expiry)).

### 10.2 Opening and collapsing

- **It opens by itself once per batch.** A batch starts when the number of
  pending requests goes from 0 to at least 1, and ends when it is back at 0. The
  panel opens at the start of a batch, and not again within it. Arriving at the
  canvas view with requests already pending — opening the session, switching
  from chat view — counts as the start of a batch for that visit: the user has
  not seen this panel yet.
- **It collapses to a banner** at the top of the canvas: `⌄`, Back
  ([project-ui.md §5.2](project-ui.md#52-back-closes-the-topmost-layer) — it is
  a layer, through `useCoverPage`), Escape, or a press on the backdrop.
  Collapsing never denies anything.
- **The banner**: `⚠ N permission request(s) waiting` and **Show**, which opens
  the panel again. A request arriving while collapsed **only raises the count**;
  it never reopens the panel over a user who chose to look at the canvas.
- The banner uses the warning colour, as the attention strip's permission row
  does: unlike a hosts strip, it is about something the agent cannot go on
  without.

### 10.3 While blocked

The canvas **stays viewable and locally interactive**: scrolling, tabs, toggles,
anything the page does by itself. **Sending is refused, visibly:**

- the bridge is told `pockode:canvas-sendable { sendable: false, reason:
  "permission" }`; a `data-pk-send` press or a `pockode.send` call is answered
  with the `permission` refusal and the page does not send;
- each refused attempt flashes the banner (or the panel's header, when open) and
  shows under it, for a few seconds, `Answer the permission request first.`;
- `pockode.send` rejects with `code: "permission"`;
- the collapsed input's text field, and the composer's if expanded, is disabled
  but keeps its text. **Stop stays usable** — stopping the turn is one of the two
  ways forward ([lifecycle.md](lifecycle.md#session-one-reducer)).

### 10.4 Where the requests come from

**Which requests are pending is state**: the `permission` blockers in
`TurnState.blockers`, read from the session detail subscription like the rest of
the turn. **What each one asks is an event**: its `permission_request` record,
which never changes — and which is what `chat.permission_response` needs sent
back (`tool_input`, `tool_use_id`, `permission_suggestions`). The panel lists
the blockers, each drawn from the record with the same `request_id`.

The panel must not depend on that record being in the loaded page of the
transcript — a long turn can push it out. So **`chat.messages.subscribe`'s
result gains `permission_requests`**: the `permission_request` records of every
request pending when the subscription opened, as stored (with their `seq`),
whatever page they are on. Requests raised later arrive as live
`chat.permission_request` records, as today. The server finds them from the
turn's blockers, scanning the history back from its end — they belong to the
current process, so they are near it. The subscribe reply's `turn` is read
together with `permission_requests`, after the history page, so the two always
agree — and that `turn` may be a little newer than the page it comes with: a
turn that ended in between shows as ended, and its ending record arrives live
right after
([subscription-system.md](code/subscription-system.md#why-a-session-is-two-subscriptions)).

The contents are deliberately **not** copied onto the blocker. `TurnState` is in
every session-list row and in the session index; a pending Write's whole file on
each would go to every client on every list change — the cost
[subscription-system.md](code/subscription-system.md#why-a-session-is-two-subscriptions)
split the list from the detail to avoid. The chat subscription is held only by
whoever shows this session's content.

**The field is kept apart from the transcript.** Its records may sit far older
than the loaded page, so they are never fed to the message reducer — that would
put records out of order and break paging. They go into a store of their own,
keyed by `request_id`, beside the live `chat.permission_request` records the
subscription delivers, and the panel reads that store. Chat view goes on drawing
its permission cards from the transcript, as today; the field is the one
addition to the chat subscription outside canvas sessions, and only the panel
reads it.

**A blocker with no record** — the append of its `permission_request` failed,
so it was only broadcast, and a client that subscribed afterwards never saw it —
is still listed, as `A permission request is waiting, but its details could not
be read. Stop the turn to go on.` with no answer buttons: an answer would have
to quote what the client cannot show, and the user must not grant something
unread.

Answering is the existing `chat.permission_response`, one call per request.

---

## 11. The activity strip

One line, between the canvas and the input, saying what the agent is doing — so
a user looking at the canvas knows whether it is working and on what, without
switching to chat.

**What it shows: the latest item of the current turn.**

| Latest item | Line |
|---|---|
| text | its last non-empty line, as plain text (Markdown stripped) |
| a tool call | its title and detail, as the tool row writes them ([title and detail](tool-call-ui.md#title-and-detail)) |
| a canvas tool | `Drew the canvas` / `Updated the canvas · <regions>` |
| thinking | `Thinking… · <latest line>` ([turn-progress-ui.md §2.3](turn-progress-ui.md#23-what-it-says)) |
| nothing yet | `Working` |

While the turn runs, the line has the spinner before it and the turn clock after
it, in the tail line's format ([turn-progress-ui.md](turn-progress-ui.md#the-rules)).

**Liveness comes from `TurnState` only** — `turn.phase` from the session detail
subscription, as for the tail line. The latest record says *what*, never
*whether*:

| Turn | Strip |
|---|---|
| `running` | spinner, latest item, clock |
| `blocked(permission)` | the latest item, no spinner, no clock — the banner or panel says why |
| `blocked(background)` | `Waiting on a background task`, no clock (the attention strip's wording) |
| `idle` | the last text line of the last turn, muted, no glyph; nothing at all before any turn |

One line, `truncate`; the full text is in the expanded view.

**Tap** opens the turn's details in a `Sheet`: the turn's parts as chat draws
them (text, tool rows, thinking), with **Open in chat** at the bottom, which
switches to chat view at that turn. A settled strip opens the last turn.

The strip is part of the canvas view only: chat view has its own tail line.

---

## 12. In chat view

Chat view is the transcript as any session's, with three additions:

- **Canvas tool calls are rows, not cards.** `canvas_render` reads `Drew the
  canvas`, `canvas_update` `Updated the canvas` with the regions as detail;
  the result's revision is meta (`rev 8`). The page is not drawn into the
  transcript: it is drawn once, in the canvas. A row whose result names a
  revision offers **Show** in its body, which switches to canvas view showing
  that revision — the history view of a later story.
- **A canvas action is a user bubble of its own kind**: the action name, a
  `from revision 7` meta, and the data, folded when it is more than a line. Not
  the raw `content` — that is for the agent.
- **A typed message's `canvas_size`** is not shown. It is for the agent.

---

## 13. State, history and fork — the contract

### 13.1 The session option

```
session.create { canvas?: boolean } -> SessionListItem
```

`canvas` is `session.create`'s only parameter; absent params, or `canvas`
absent or false, are an ordinary session. It is `session.CreateSpec.Canvas`,
stored as

```go
Canvas bool `json:"canvas,omitempty"`
```

`SessionDetail` embeds `SessionMeta`, so it carries `canvas` without more ado.
`SessionListItem` lists its fields one by one, so it gains `canvas?: true`
explicitly (`rpc.NewSessionListItem`) — a row may mark a canvas session, and the
reply to `session.create` is such a row. Both copies are of a birth fact, so
they cannot disagree
([why that is allowed](code/subscription-system.md#why-a-session-is-two-subscriptions)).
There is no setter. `FileStore.CreateFork` copies it with the rest of the engine
choice. Sessions the work system creates are never canvas sessions.

### 13.2 The pushed state

The current canvas is pushed through the **chat subscription**, not session
detail. Session detail goes out on every change to a session — every turn
transition, every title — and a 256KB page on each of them would be paid for
every time the agent starts a tool. The chat subscription is the one held by
whoever is showing the session's content, which is who needs the page.

```ts
type CanvasSize = { width: number; height: number };

type CanvasOp =
  | { op: "replace" | "append"; region: string; html: string }
  | { op: "remove"; region: string };

type CanvasChange =
  | { kind: "render" }
  | { kind: "update"; from_revision: number; ops: CanvasOp[] };

type CanvasState = {
  revision: number;        // 0 = nothing drawn yet; the fields below are then absent
  html?: string;           // the whole document of this revision
  drawn_for?: CanvasSize;  // absent when no size had been reported
  change?: CanvasChange;   // how this revision came from the previous one
  drawn_at?: string;       // RFC 3339
};
```

- **`chat.messages.subscribe`** — its result gains `canvas?: CanvasState`,
  present exactly for canvas sessions. It is the current state when the
  subscription opened, not part of the page of history it arrives with.
- **`chat.canvas_state`** — a notification `{ id, canvas: CanvasState }` sent to
  every chat subscriber of the session whenever the canvas changes. It is
  **not a record**: no `seq`, never stored in history, and the frontend's event
  routing must not feed it to the message reducer (the `chat.` prefix is shared
  with records; the method name is not a record type).
- After a reconnect, resubscribing returns the current state, so a missed
  notification costs nothing. Each notification carries the whole state, so
  there is no ordering to reconstruct: the highest `revision` wins.
- The subscription is registered before the canvas is read for the reply, so
  no revision falls between the two — and a `chat.canvas_state` may therefore
  arrive **before the subscribe reply**. The client accepts one for a
  subscription whose reply it is still waiting for, and compares revisions
  with the reply when it arrives.
- A fork is listed before its canvas is copied (§13.6); a client that
  subscribes in between is handed revision 0 and then pushed the copied
  canvas.

`reported_size` is server state too, but it is not pushed: no client draws it.

### 13.3 Storage

```
sessions/<id>/canvas/
  state.json          { revision, reported_size? } — rewritten on every new revision and every reported size
  <revision>.json     CanvasSnapshot — one per revision; never rewritten once state.json has named it
  revisions.jsonl     one history entry per revision (§13.5), appended after state.json
```

```ts
type CanvasSnapshot = {
  revision: number;
  html: string;
  drawn_for?: CanvasSize;
  change: CanvasChange;
  drawn_at: string;
};
```

- **Every revision keeps a full snapshot.** History is the list of snapshots;
  an old revision is read whole, never rebuilt by replaying ops. The cost is
  disk, up to 256KB per revision, and the session's directory takes it with it
  when the session is deleted.
- **Not in the tool result.** The call's input already holds what the agent
  wrote; the result says only the revision, the size and warnings. So a snapshot
  costs the model no tokens, and the history's page of records stays the size it
  was.
- **Write order**: the snapshot file, then `state.json`, each with
  `filestore.WriteFileAtomic` (the persistence rule in
  [server/AGENTS.md](../server/AGENTS.md)). A crash between the two leaves a
  snapshot beyond the state's revision, which no state names; the next call
  takes the state's revision + 1 and overwrites it.
- **A `state.json` that is unreadable** (quarantined as `state.json.corrupt`)
  does not restart the numbering: the revision is recovered from the highest
  snapshot on disk, because tool results in the transcript name those numbers.
  The recovered state is written back at once, so a restart before the next
  draw does not mistake the quarantined file for one never written. The
  reported size is lost until the next message reports one. A `state.json`
  that was never written names nothing, so a snapshot a crash left before it
  is overwritten like any other.
- **A snapshot the state names but the disk lost** (a rename a power cut
  undid) does not make the session unopenable: the current canvas falls back
  to the newest readable revision before it, and the numbering still goes on
  after the named one. An update drawn next comes `from_revision` the one
  shown, the lost revision is left out of the history list, and reading it is
  refused as a revision the canvas does not have. Both cases are logged.
- **`revisions.jsonl` is only a shortcut** for the history list, so it can be
  appended without an fsync: a revision it lacks is read from its snapshot,
  and one whose snapshot cannot be read either is left out of the list and
  logged.
- **The current state is `state.json` plus the snapshot it names.** The store
  keeps it in memory once read, until the session is deleted — a page of at most
  256KB for every canvas session opened since the server started. Nothing evicts
  it yet; that is the trade-off for never reading the page from disk on a send.

### 13.4 Linking a snapshot to its tool call

The executor does not know the CLI's tool call id — an MCP call does not carry
it. The link is made from the other side: **when the server records the
`tool_result` of a `canvas_render` or `canvas_update` call** — where the process
appends a result to history, the call's name known from the `tool_call` with the
same `tool_use_id` and matched against both engines' names for the tools
(`server/canvas`) — it reads the
revision from the result's first line (§9.4) and records it on the record:

```jsonc
{ "type": "tool_result", "tool_use_id": "toolu_…", "tool_result": "Canvas revision 8 · …", "canvas_revision": 8 }
```

That is a fact about the call — this call drew revision 8 — written once, at the
moment it became true. Everything that needs the link reads `canvas_revision`:
the chat view's row (§12), the history view, and the fork (§13.6). A failed call
has no revision and gets no field.

### 13.5 Reading history

For the history view (a later story); the data above is what makes it possible,
and the two reads are cheap to add with it:

```
chat.canvas_history  { session_id }           -> { snapshots: [{ revision, change_kind, drawn_for?, drawn_at, bytes }] }   newest first
chat.canvas_snapshot { session_id, revision } -> CanvasSnapshot
```

They serve only the connection's current worktree, like the rest of `chat.*`.
A canvas session seen through the read-only `session_view.*` namespace (any
other worktree's sessions) has no canvas read yet: it shows its transcript
only.

Both are refused with `this session is not a canvas session` for any other
session; `chat.canvas_snapshot` for a revision the canvas does not have with
`the canvas has no such revision: revision <n>, the canvas is at <m>` — or,
for one the disk lost (§13.3), `the canvas has no such revision: revision <n>
was lost from disk` — all `InvalidParams`. A snapshot that is still there but
cannot be parsed stays listed, and reading it is an internal error that names
the revision.

A shown old revision is read-only: its bridge is told `sendable: false`, and the
app refuses every send from that frame with `readonly` (§8.2) whatever the
bridge was told.

### 13.6 Fork

A fork keeps the canvas **as it was at the cut**, following the fork rule
([session-fork-ui.md § The rule](session-fork-ui.md#the-rule)) without a rule of
its own — like the unanswered questions, the state is derived from the kept
records ([agent-integration.md](code/agent-integration.md#a-fork-inherits-what-was-open-at-the-cut)):

- The fork's revision **R** is the highest `canvas_revision` on a kept
  `tool_result` record; 0 when there is none.
- Snapshots **1…R** are hard-linked into the fork's `canvas/` directory, as
  attachments are (`attachments.Clone`). Revisions are numbered in the order they
  were drawn, so everything up to R was drawn before the call that drew R —
  including a revision whose result was never recorded. A snapshot the source
  lost from disk (§13.3) is left out, as it is from the source's own history;
  if R itself is one, the fork shows the newest one before it, as the source
  would.
- The fork's `reported_size` is the `canvas_size` of the last kept message that
  carried one.
- The fork's next revision is R + 1. The source's later revisions are not
  copied, so the numbers cannot collide.
- **Where**: in `chat.Client.Fork`, after the truncated history has been written
  to the fork (`WriteHistory`) — R is read from that history, which only `Fork`
  holds, and `WriteHistory` replaces the fork's whole history, so anything
  appended before it would be lost. It is the place the
  `fork_agent_context_unavailable` warning is appended for the same reason.
- A copy that fails — or finds none of 1…R on disk — is not fatal, as for
  attachments: the fork starts with no page (revision 0 shown), and a `warning`
  record (code `fork_canvas_unavailable`) appended to its transcript says so —
  `The canvas could not be copied into this session. Ask the agent to draw it
  again.` Its numbering still goes on after R: the transcript it inherited
  names revisions 1…R, and a new page under one of those numbers would be shown
  as the page that record drew.

The source is untouched.

---

## 14. Considered and not done

- **Scaling a page drawn for a larger screen to fit.** Unreadable text and
  unpressable buttons; scrolling keeps both (§5).
- **Questions as cards over the canvas.** Two ways to ask, one inside the page
  and one over it, would compete; the canvas is how a canvas session asks (§3.4).
- **Anti-forgery tokens on sends.** The page is the agent's own output and can
  only ask to send what the agent could have asked for anyway (§1).
- **An "Allow all" in the permission panel.** §10.1.
- **Pushing the canvas on session detail.** §13.2.
- **Ops in the snapshots only, rebuilding old revisions by replay.** One parser
  change would silently rebuild every old revision differently from what was
  shown; a full snapshot is what was shown.
- **Switching an existing session to canvas.** The agent was told one thing at
  the start (§9.1); a property fixed at birth keeps that true.
