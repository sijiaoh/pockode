# Canvas Mode

A second way to talk to an agent. In an ordinary session the screen is a
transcript and the user types. In a **canvas session** the screen is a page the
agent draws, and the user works in it: a page that does things by itself —
its tabs switch, its lists filter and sort, its rows expand and its fields edit
in place — and that sends to the agent only what needs the agent. The things on
the page are the controls: a card is pressed, a field sits next to what it is
about. The transcript is still there, one tap away, holding every detail; the
canvas is what the user works in.

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

Built. The server side is complete: the store, the session property,
the pushed state, the link from a result to its revision, the fork (by message
or by page, with `numbered_from` and `fork_note`), the history reads with
`fork_blocked`, lint, the send RPC, the size on messages, the pending
permission requests on subscribe, the two tools and the guidance. On the
frontend, the client side of the contract (creating a canvas session, the
pushed state, sending an action), both sides of the bridge, the page frame, the
canvas screen (the view switch, the empty state, the collapsed input, the size
measurement), chat view's canvas rows and action bubbles, the permission panel,
its banner and the expiry line (§10), the activity strip with its turn details
(§11), and the history view (§15) with its three entries and forking from a page
exist.

| Path | Role |
|------|------|
| `server/canvas/` | The canvas package: the store (`Store` — state, snapshots, `Apply`, `ReportSize`, `Fork` with the numbering past the source's floor (`numbered_from`, `forked_at`) and the line a fork's first delivery carries (`ForkNote` / `ForkNoteDelivered`), the history reads), the tool result text and reading a revision back out of it (`ResultText`, `FailureText`, `RevisionFromResult`), a canvas action and its text (`Action`, `ActionText`), `ForkPoint`, `fork_blocked` (§13.5: `fork.go` — the one pass over the records, `ReadForkCuts`, that both the list and the fork read; `ListedRevision`; the reasons and their wording, `ForkBlocked`, `ForkBlockedError`; what is running, `LiveCalls`), both engines' names for the two tools (`IsTool`), applying an update's ops and lint (`CheckRender`, `ApplyUpdate`) |
| `server/process/canvas_calls.go`, `server/process/manager.go` | Stamping `canvas_revision` on a canvas call's `tool_result` before it is recorded and broadcast (§13.4), and counting the call in flight until that result is recorded, or the turn or the process ends, so a page is never between `pending` and recorded; `Manager.CanvasLive` — those calls and when the running turn began, for a page drawn before its call was read (§13.5) |
| `server/ws/rpc_canvas.go` | `chat.canvas_action` and the checks on it and on a `canvas_size`; `chat.canvas_history`, `chat.canvas_snapshot` |
| `server/worktree/manager.go` | Wiring: one `canvas.Store` per worktree (`Worktree.CanvasStore`), pushing through `ChatMessagesWatcher`, forgetting deleted sessions |
| `server/mcp/canvas.go`, `server/mcp/tools.go` | The `canvas_render` and `canvas_update` handlers, which call into `server/canvas`; the refusals in and outside a canvas session (§3.4), decided from the stored property (`Sessions.ResolveCanvas`); the canvas tool definitions and the per-session list (`listedTools`) |
| `server/mcp/proxy.go`, `server/mcp/server.go` | The proxy's `--canvas` flag, choosing the instructions and the tool list |
| `server/agent/guidance.go` | `CanvasGuidance`, beside `Guidance`; `GuidanceFor` picks one |
| `server/agent/cli_question.go` | The canvas wording of the refusal of the CLIs' own question tool (`CanvasCLIQuestionRefusal`, `CLIQuestionRefusalFor`) and of the user's warning (§3.4) |
| `server/agent/agent.go` | `StartOptions.Canvas` carries the property to both adapters (`claude.go`'s MCP config, `codex.go`'s thread parameters and `instructions.go`), set by `process.Manager` from `SessionMeta.Canvas` |
| `server/session/types.go`, `server/session/store.go` | `SessionMeta.Canvas`, `CreateSpec.Canvas`; `CreateFork` copying the property |
| `server/rpc/types.go` | `SessionListItem.Canvas`, the canvas params and results; `SessionForkParams` taking exactly one of `anchor_seq` and `canvas_revision` |
| `server/chat/client.go` | Copying the canvas into a fork in the step `Fork` and `ForkAtCanvasRevision` share (`fork`, through `forkCanvas`), once its history is written (§13.6); the fork at a page (`ForkAtCanvasRevision`, the cut at the record that drew it); the history list with `fork_blocked` (`CanvasHistory`); sending a canvas action (`SendCanvasAction`); a message's size (`Sender.CanvasSize`) — reported to the store and added to what the agent reads (`deliveredText`), with a fork's `fork_note` after it |
| `server/ws/rpc_chat.go`, `server/ws/rpc_session.go` | The canvas half of `chat.messages.subscribe`, and `chat.message`'s `canvas_size`; `session.create`'s option; `session.fork`'s `canvas_revision` and its check against `anchor_seq` |
| `server/watch/chat_messages.go` | Pushing `chat.canvas_state`; the pending permission requests a subscription starts from (§10.4) |
| `web/src/lib/canvasTools.ts` | Both engines' names for the two tools (`isCanvasRenderTool`, `isCanvasUpdateTool`, `isCanvasTool`), and nothing else |
| `web/src/types/canvas.ts` | The contract's types: `CanvasState`, `CanvasChange`, `CanvasOp`, `CanvasSize`, `CanvasAction`, `CanvasActionParams`, `CanvasStateNotification`, `CanvasHistoryEntry`, `CanvasForkBlocked`, `CanvasSnapshot`; the record's `canvas_action` / `canvas_size`, the result's `canvas_revision` (`ToolRun.canvasRevision`), the session's `canvas`, `SessionCreateParams`, `SessionForkParams` and the chat subscription's `ChatNotification` are on the existing types in `types/message.ts` |
| `web/src/lib/canvasStore.ts` | The open session's current canvas, the highest revision winning (`useCanvasStore`, `selectCanvasState`, `useCanvasRevision`, `canvasActions`), the device's canvas size every message to a canvas session carries (`size`, `canvasActions.setSize`), whether there is a page for the history view's two entries to open on (`isCanvasDrawn`, `NOTHING_DRAWN`, §15.1), and a count of what may have settled a canvas call (`callsSettled`, §15.3) |
| `web/src/hooks/useChatMessages.ts` | Taking `chat.canvas_state` and the subscribe reply's `canvas` into the store, never into the transcript; `sendCanvasAction`, echoed as a typed message is; the size on `chat.message`; counting what may settle a canvas call — any tool result, or a turn ending (`settlesCanvasCalls`) |
| `web/src/lib/rpc/chat.ts` | `chat.canvas_action` (`sendCanvasAction`) and `chat.message`'s `canvas_size`; `chat.canvas_history` / `chat.canvas_snapshot` (`canvasHistory`, `canvasSnapshot`) |
| `web/src/lib/rpc/session.ts`, `web/src/lib/sessionCreate.ts`, `web/src/hooks/useSession.ts`, `web/src/components/AppShell.tsx`, `web/src/components/Session/SessionsTab.tsx`, `web/src/components/Session/SessionItem.tsx` | Creating a canvas session (§13.1): `session.create`'s option (`SessionCreateParams`), one create in flight per kind, the retry of a failed create with its own params (`createErrorParams`, retried by `AppShell`); the **Canvas** button beside **New Chat**; a canvas row's glyph. Also `session.fork`'s `canvas_revision` (`forkSessionAtCanvasRevision`, §13.6) |
| `web/src/utils/forkAnchor.ts`, `web/src/utils/discardedMessage.ts`, `web/src/utils/sendAgain.ts` | A canvas action never becoming a draft (§6.2) |
| `web/src/lib/canvasBridge.ts` | The script injected into the page (`canvasBridgeScript`), the base stylesheet (`canvasBaseStylesheet`, `canvasBaseCss`, the variables' tokens `CANVAS_THEME_TOKENS` and `canvasThemeFrom`), and the messages of the bridge (`CanvasPageMessage`, `CanvasAppMessage`, `readCanvasPageMessage`, `SEND_REFUSAL_MESSAGES`, and `readonly`'s two wordings, `READONLY_REFUSAL_MESSAGES` by `CanvasReadOnly`); tested in real engines by `canvasBridge.browser.test.ts`, and the variables against `canvas_render`'s list and the app's tokens by `web/tests/canvasThemeVars.test.ts` |
| `web/src/lib/messageReducer.ts`, `web/src/lib/toolSummary.ts`, `web/src/lib/subagentRun.ts`, `web/src/lib/toolRun.ts`, `web/src/lib/toolGroups.ts`, `web/src/components/Chat/ToolRow.tsx` | Chat view's canvas rows (§12): `canvas_revision` read off the result record onto the run (`messageReducer`), the rows' wording by outcome (`toolSummary`, and a subagent's latest-child line through `subagentRun`), a refusal's second line (`toolRun`), never folding them (`toolGroups`), and `rev N` as their meta (`ToolMeta`) |
| `web/src/components/Chat/ToolCallItem.tsx`, `web/src/components/Chat/canvasShowContext.ts` | A canvas row's **Show** in its body (§12, §15.1), through `CanvasShowContext`, which `ChatPanel` provides only for a canvas session it can read |
| `web/src/components/Chat/CanvasActionBubble.tsx`, `web/src/lib/messagePreview.ts` | A canvas action's bubble in chat view (§12), chosen in `MessageItem`; a canvas action quoted by its name |
| `web/src/lib/agentPage.ts` | What `CanvasFrame` and `HtmlFrame` share (§4): the sandbox's floor (`HTML_FRAME_SANDBOX`) and the canvas's own (`CANVAS_FRAME_SANDBOX`), the page document's order (`agentPageDocument`), the wrapper (`agentWrapperDocument`), the project capability (`usePageProject`, whose freshness for a patch is `useRawMediaSource`'s `isFreshCapability`) |
| `web/src/lib/canvasRedraw.ts` | How each new state reaches the frame (§8.3): patch or whole drawing, one patch at a time, the app's record of the revision shown (`CanvasRedraw`) |
| `web/src/components/Canvas/CanvasFrame.tsx` | The page frame (§4): the document, the size (§5), redrawing through `CanvasRedraw`, the host allowance per session, and the app side of the bridge (§8.2, §8.4) — answering sends, the theme, `sendable`, the page's focus for the size rule, the room the wrapper scrolls on past what the composer covers (`covered`, §5), `readOnly` saying which page a history frame is (§15.4), the shield while a layer is up (`shielded`, [under a layer](#under-a-layer)); tested in real engines by `CanvasFrame.browser.test.tsx` |
| `web/src/components/Canvas/CanvasView.tsx` | The canvas view's canvas (§2): the session's current canvas from the store in a `CanvasFrame`, the empty state at revision 0, and the size measurement (§5), held off while the permission banner is up; the permission banner, expiry line and panel in its column, the panel's layer and its focus (§10); shielding the frame while any layer is up ([under a layer](#under-a-layer)); tested in real engines by `CanvasView.browser.test.tsx` |
| `web/src/lib/canvasSize.ts` | The size rule (§5): a measurement in whole pixels (`canvasSizeOf`), which measurement is kept (`keepsMeasurement`), and what counts as editable in the app (`isEditableElement`) |
| `web/src/components/Canvas/CanvasComposer.tsx` | The collapsed input (§2), which opens into the ordinary composer (`CanvasComposer`), with a control of the host's leading it (`leading`), and the bars under the canvas floating over it while it is open (`ComposerDock`), saying how far they cover it (`onCover`, §5); its Stop is the composer's own (`StopButton` in `Chat/SendStopSlot.tsx`); the float tested in real engines by `CanvasComposer.browser.test.tsx` |
| `web/src/components/Canvas/CanvasHistoryButton.tsx` | The history view's entry from canvas view, leading the collapsed input (§15.1) |
| `web/src/components/Canvas/CanvasViewSwitch.tsx`, `web/src/components/Chat/SessionHeader.tsx` | The header's **Canvas \| Chat** switch, drawn after the session's title (`viewSwitch`); the session panel's **Canvas** section and its **History** row (`canvasHistory`, §15.1) |
| `web/src/components/Chat/ChatPanel.tsx` | The canvas screen's place in the session screen: which view is up, both kept mounted, the canvas wired to `useChatMessages`' `sendCanvasAction`, the input in canvas view and the History button leading it; which revision the history view is open on, over either view (§15.1), and the view and the fork sheet replacing one another, Cancel reopening the view (§15.6); what it hands the canvas for §10 and §11 (§10.1's list), and what the floating composer covers of it (§5) |
| `web/src/components/Canvas/PermissionPanel.tsx`, `web/src/components/Canvas/PermissionBanner.tsx`, `web/src/components/Canvas/usePermissionBatch.ts` | The panel (§10.1); the banner, the expiry line and the refused-send flash (`PermissionBanner`, `PermissionExpiryLine`, `RefusalFlash`); the batch, open-or-collapsed, waiting behind another layer and the refused-send sentence (`usePermissionBatch`, §10.2, §10.3), held by `CanvasView`, which draws them in its column and registers the panel as a layer |
| `web/src/components/Chat/PermissionRequestItem.tsx` | The permission card (`PermissionRequestItem`, with its `armKey` and `endingTurn` for the panel), `PERMISSION_EXPIRY_COPY` and the batch's sentence (`permissionExpiryText`), and the card of a blocker with no record (`UnreadablePermissionItem`) — moved out of `MessageItem.tsx` so the chat, the panel and the expiry line use the same ones (§10.1) |
| `web/src/lib/activityStrip.ts` | What the activity strip says (§11.1): which reply it speaks for (`stripReplyIndex`) and the message it answers (`replyPrompt`), the reply's latest item (`latestItem`), how it ended (`endingPrefix`), the phase from the turn alone (`stripPhase`), the line and its words for the accessible name (`stripLine`, `stripLineText`) |
| `web/src/components/Canvas/ActivityStrip.tsx`, `web/src/components/Canvas/TurnDetailsSheet.tsx` | The strip, first in `ComposerDock` while canvas view is shown (§11.2), and the sheet its tap opens (§11.3); the line reuses the tool row's `Detail`, the subagent row's `LatestChildLabel` and the tail line's `TurnClock`, the sheet `MessageItem` (`withoutActions`); **Open in chat** is `MessageList`'s `jumpToMessage` |
| `web/src/lib/permissionRequestStore.ts` | The pending requests' records and what became of them, kept apart from the transcript (§10.4): filled by `useChatMessages` from the subscribe reply's `permission_requests`, the answers and expiries on its first page, the live records, and the answers this client sent; `resolvePermission` puts it together with the transcript's card |
| `web/src/components/Canvas/CanvasHistorySheet.tsx` | The history view (§15): a `fullScreen` `Sheet` holding one read-only `CanvasFrame` keyed by its revision, the stepper in its footer, the revision list (a layer of its own), the note line; Fork, `fork_blocked`'s reasons (`FORK_BLOCKED_REASONS`) and the page handed to the fork sheet (`CanvasForkPage`); owns the open revision |
| `web/src/hooks/useCanvasHistory.ts` | The history view's reads (§15.3): the list, read again on every new pushed revision, after a reconnect, and on `callsSettled` while an entry is `pending` or a read is in flight — one read in flight and at most one more asked for; one snapshot at a time, kept while the view is up |
| `web/src/components/Chat/ForkSessionSheet.tsx`, `web/src/hooks/useForkSession.ts` | The fork sheet's page anchor (`page`) beside its message anchor, and its `onCancel`; the cut as a message's seq or a page's revision (`ForkCut`) (§15.6) |

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

**The page works by itself; it sends only what needs the agent.** Whatever the
page can do with its own scripts — switching a tab, filtering, sorting,
expanding, editing — never goes back to the agent: a round trip there costs the
user a whole turn, and the agent's attention, for something the page could have
done at once. What the page sends is a decision that changes what the agent
does next, or work only the agent can do, and it carries what it is about with
it (§6.1). A page that sends nothing is a page too — one that only shows, or
does everything itself — since the input under the canvas is always there for
the user to type into (§2). So nothing requires a page to send (§7), and the
agent is told to build the page this way, not as a report with buttons under it
(§9).

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
│ 🔒 2 permission requests waiting     [Show] │  permission banner — only when collapsed or waiting (§10)
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
│ ⟳ Bash  npm test                     1m 4s › │  activity strip (§11)
├──────────────────────────────────────────────┤
│ [⟲] [ Message…                          ]  ■ │  collapsed input; ⟲ = history (§15.1), ■ = Stop while a turn is open
└──────────────────────────────────────────────┘
```

- **The header** is the session header every chat has, with a **Canvas | Chat**
  segmented control. Which view is up is the device's own UI state — not session
  state, not in the URL's history: the session screen holds it, so switching
  touches no history entry at all, and Back leaves the session as it does from
  either view. A canvas session opens on Canvas, every time it is opened. **The
  canvas frame stays mounted while chat view is up** — hidden, not unmounted —
  so switching views neither loses what the user did in the page nor runs its
  scripts again; so does the transcript while canvas view is up, keeping the
  reader's place. Both stay mounted under a page drawn over the session (a file,
  the work list) too. The session list's row says a session is a canvas one
  before its detail arrives, so the screen does not open on chat and flip. A
  session read out of another worktree (read-only) is shown as chat only: its
  canvas is not pushed to this client.
- **The canvas** takes every pixel the bars leave. It is the page frame of §4.
- **The activity strip** is one line saying what the agent is doing or last
  said (§11).
- **The input** is collapsed to one line: `Message…` and, while a turn is open,
  Stop. Tapping it expands it into the ordinary composer (attachments, commands,
  the same send rules) over the bottom of the canvas, with the caret in it.
  Sending, or focus leaving the composer with nothing in the draft, collapses it
  again. Typing is the fallback for what the page did not offer; the page is the
  main way in.
  - A **History** button leads the line — the history view's entry from canvas
    view (§15.1). It is part of the line, not of the screen: gone while the
    composer is expanded, in chat view and under a page drawn over the session,
    and the line's own height, so the dock and the canvas area keep their size.
  - A draft left in it shows on the collapsed line, its first line in place of
    `Message…` (or how many files are attached).
  - Drawn *over* the canvas rather than in the column, so opening it and the
    draft growing change neither the page's viewport nor the canvas size (§5).
    Nothing it covers is out of reach, though: the frame scrolls on past the
    bottom of the page by as much as the floating block covers, so the user
    can bring any part of the page — the bottom of one that fits the area
    included — above it (§5). The page is never pushed up or scrolled for it;
    the user scrolls. The bars above the input — the strips and error bars —
    float up with it, on top of the composer, rather than being covered by it.
    Two exceptions put it back in the column, where the canvas gives way
    instead: the answer panel up over the canvas (floating, a growing draft
    would cover the card's buttons), and a block taller than the whole session
    screen under the header (a short landscape screen with the keyboard up),
    which floating would draw over the header.
  - A press with a mouse moves focus before the button comes up, so whether
    leaving collapses the composer is decided once the press is over — or the
    bars dropping back into the column would move the button from under it.
  - Switching views also collapses it; the draft stays.
  - Stop on the line is armed afresh each time it collapses, as the composer's
    is when it replaces Send: a send puts it under the thumb that pressed Send.
  - A page drawn over the session from canvas view (a file, a Git detail) gets
    the ordinary composer, as over a chat; the line is canvas view's alone.
  - The window losing focus — a file picker opened from the composer's own `+` —
    is not focus leaving it, and collapses nothing.
  - A prefill handed in from outside the chat
    ([the prefill handoff](agent-handoff-ui.md#1-prefill-handoff)) opens it, so
    the composer can place the caret and show the arrival as it would in chat
    view; while the line is disabled it waits there.
  - While a permission request owns the agent's input, the line is disabled and
    reads `Allow or deny to send` when it holds no draft (§10.3). A composer
    open when the request arrives collapses into the line, its draft kept: it
    could not send anyway, and floating it would cover the bottom of the
    permission panel — the buttons.
  - A typed message that could not be delivered is reported under it in the
    transcript, which canvas view does not show, so canvas view says so above the
    input — `Your message couldn't be sent. The chat says why.` — as a page
    over the chat does.
- **The chat's attention strip** is shown in canvas view too, between the
  activity strip and the input, *without* its two turn rows — permission and
  background, which canvas view says in its own surfaces (§11.4).
- **No question card is ever over the canvas.** A canvas session posts no
  questions (§3.4), so `turn.unanswered` stays empty, and the answer panel and
  the strip's questions row do not arise in canvas view. The permission panel
  (§10) is the only layer designed to be drawn over the canvas itself. The
  composer's answer-panel exception above and
  [answering-ui.md §3](answering-ui.md#3-the-answer-panel)'s canvas sentence
  describe what the code still handles should a question exist anyway; nothing
  in §10 or §11 relies on them, or removes them.
- **Chat view** is the session's ordinary transcript, untouched except for how
  the canvas tools and canvas actions are drawn there (§12). Every detail the
  canvas view leaves out — the whole reply, every tool call, every thinking — is
  there.

**Before anything is drawn** (revision 0) the canvas area shows a muted line in
its centre: `Nothing drawn yet`, or `The agent is drawing…` while the session's
turn is running (`turn.phase` is `running`). Never a spinner of its own:
liveness is the strip's. Before the subscription has said anything about the
canvas, the area is blank.

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
| `--pk-accent-hover` | `--th-accent-hover` | the primary action under a hovering pointer |
| `--pk-success` | `--th-success` | |
| `--pk-error` | `--th-error` | |
| `--pk-warning` | `--th-warning` | |
| `--pk-code-bg` | `--th-code-bg` | code blocks |
| `--pk-code-text` | `--th-code-text` | |

The names are the contract with the agent; what each maps to is the app's. A
theme token added to the app is not automatically a `--pk-*` variable — every
one is a promise to every page ever drawn. The agent reads the names in
`canvas_render`'s description (§9.3), a second copy of `CANVAS_THEME_TOKENS`:
`web/tests/canvasThemeVars.test.ts` keeps the two the same list, and fails when
a token they map to is not defined in `web/src/index.css`.

The **base stylesheet** is placed before the agent's markup, in a cascade layer
of its own (`@layer pockode-base`), and written entirely inside `:where()`, so
any rule of the agent's overrides it: unlayered rules beat every layer, a layer
named first is below every later one — so an agent's CSS framework that puts
its rules in layers wins too — and zero specificity settles the rest:

- `:root` gets the variables, `color-scheme` matching the theme, and
  `background: var(--pk-bg); color: var(--pk-text)` — the theme following
  light/dark is the variables *applied*, or a dark-themed page would start as
  black text on a dark canvas. Nothing else of the document is styled: no font,
  no margin, no layout; those are the agent's.
- `button`, `input`, `select`, `textarea` get the theme: `--pk-bg-secondary`
  fill, `--pk-border` border, rounded corners, a little padding, `font: inherit`,
  a focus ring in `--pk-accent`, and the coarse-pointer hit-area floor of 44px
  ([responsive-ui.md](responsive-ui.md)) as a `min-height` under
  `@media (pointer: coarse)`. The inputs that are a native widget rather than a
  box — checkbox, radio, range, colour, file — keep their own look and take the
  accent through `accent-color` on `:root`. A submitting button inside a
  `form[data-pk-send]` (not `type="button"` or `reset`, which send nothing), and
  any `[data-pk-send]` button, takes the accent fill.
- What a press acts on looks pressable: buttons, `input` of type `button`,
  `submit` or `reset`, and any other element that sends (§6.1) get a pointer
  cursor and Pockode's own colour transition (`color`, `background-color`,
  `border-color`, 150ms) — none under `prefers-reduced-motion: reduce`.
- Under a hovering pointer a pressable takes the hover fill of Pockode's own
  buttons: `--pk-bg-tertiary`, and on the accent-filled primary
  `--pk-accent-hover` for background and border alike. Only the colour changes —
  no brightness filter, no scale, no pressed state. The hover is gated on
  `(hover: hover) and (pointer: fine)`, the app's `pointer-fine:`
  ([responsive-ui.md](responsive-ui.md)), because on a touch screen a tap
  leaves `:hover` stuck on the button until the next tap elsewhere. A disabled
  control takes no hover fill; it excludes them by `:not(:disabled)` rather than
  `:enabled`, which matches nothing that cannot be disabled — every element
  that sends but is not a button among them.
- An element that sends but is not a button — a card, a list row — gets the
  pointer, the plain hover fill and the focus ring, and never the accent fill:
  a card painted in the primary's colour would not be the agent's card any
  more. It gets no box, no padding and no 44px floor either; its look is the
  agent's.
- Disabled controls are dimmed.

Order matters inside the layer, since every rule weighs the same: the accent
comes after the plain fill, the hover fills after the accent, and the dimming
last, so a disabled control keeps its `not-allowed` cursor.

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
wrapper whose one child is the page, both `srcdoc`, both sandboxed with the
floor `allow-scripts allow-popups allow-popups-to-escape-sandbox` and never
`allow-same-origin` or `allow-modals`, the policy at byte 0 of both documents,
the project capability as the base
([the sandbox and the policy](tool-call-ui.md#the-sandbox-and-the-policy)).
`CanvasFrame` takes the policy, the reporter and the capability from the same
modules `HtmlFrame` does; it does not copy them.

What differs:

| | `html_render` card | Canvas |
|---|---|---|
| Size | as tall as the page, capped | the canvas area; a page drawn larger keeps its size, scrolled inside the wrapper, which also scrolls on past what the composer covers (§5) |
| Height reporter | appended | not used |
| Sandbox | the floor (`HTML_FRAME_SANDBOX`) | the floor and `allow-forms` (`CANVAS_FRAME_SANDBOX`), on both frames — [forms](#forms) |
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

The hosts strip sits between the header (or the permission banner or its
expiry line) and the
canvas, as on every other page surface. The allowance is keyed by the session
(`canvas:<session id>`), so a Load or Reload draws the current revision whole
under it, and every later drawing of that session starts with it.

The wrapper and the page's frame are transparent where an `html_render`
wrapper is white, under the `color-scheme` of the theme it was drawn in, and
the app's element behind them is `--th-bg-primary`: what shows is the page's
own root, `--pk-bg`, and nothing white flashes in a dark app while a document
loads.

### Under a layer

**While a layer of the app's own is up over the page, the live canvas's frame
is shielded.** "A layer" is anything counted by `useIsPageCovered`: the
header's session panel, the worktree and session-filter dropdowns, the
composer's `+` menu, the sidebar drawer, and the sheets and dialogs. The
command palette is not one (it registers no `useCoverPage`), so it does not
shield the frame: a press on the canvas with it open still goes to the page
and leaves the palette open. `CanvasView` passes
`shielded={useIsPageCovered()}`, and `CanvasFrame` then lays a transparent
`aria-hidden` element over the frame. It has no handler and no stacking of its
own.

The reason is the frame itself. A press inside an iframe is dispatched in the
page's document and never reaches the app's, so `useOutsideClick` cannot see
it. A panel with no backdrop of its own would stay open, and the press would
go on into the page: it could press a button there and send an action while
the user only meant to put the panel away. With the shield up, the press lands
in the app's document. The panel closes on it the usual way, claiming it as
[answering-ui.md](answering-ui.md#who-owns-the-dismissing-click) asks, and the
page never gets it. Because the shield is in the way physically, the page
cannot get the press whichever layer is up, even one that does not claim its
dismissing click.

**Not the window's `blur`.** A press in the frame does blur the app's window,
and a panel could close on that. But the press would still act in the page, so
the click would close the panel *and* press whatever is under it.

What it covers, and what it leaves alone:

- **The frame alone.** The hosts strip and the project notice above it are in
  the app's document already, so outside-click handling sees presses on them,
  and they are not shielded.
- **The floating composer stays above it.** The shield fills only the canvas
  area and makes no stacking context, so `ComposerDock` (`z-10`, §2) is drawn
  over it and stays pressable. With the composer's `+` menu open, a press on
  the canvas closes it too, rather than going into the page.
- **The permission panel** (§10) is a layer itself, so the frame is shielded
  while it is up. That changes nothing: the frame is `inert` under it already,
  and the panel is the frame's sibling, not inside the shielded area, so its
  buttons are untouched. When a navigation has taken the panel's history
  entry it no longer counts, and the page is off the screen then anyway.
- **The answer panel** is deliberately not a layer
  ([answering-ui.md §3](answering-ui.md#3-the-answer-panel)), so it never
  shields the canvas. The canvas is inert under it anyway.
- **The history view's frame is never shielded.** `shielded` is opt-in and
  `CanvasHistorySheet` does not pass it: the sheet is a layer itself, so a
  shield would cover the very page it shows (§15.2). The live canvas under the
  sheet is shielded, which is harmless.
- **While shielded, the page cannot be scrolled** by wheel or touch: the press
  and the drag both land on the shield. A press on it still takes focus off
  the composer, as a press on the frame did, so an expanded empty composer
  collapses on it (§2).

The tests are in real engines: `CanvasView.browser.test.tsx` (the panel closes
and the page's own `click` listener gets nothing; the composer and the
permission panel stay pressable; no shield without a layer) and
`CanvasHistorySheet.browser.test.tsx` (no shield on the history frame).

### Forms

A canvas page is one the reader works in, and a form is how it sends
(`data-pk-send`, §6.1), so the canvas's sandbox adds **`allow-forms`** to the
floor. Without it Chromium abandons a submission before its `submit` event:
neither the bridge nor the page's own handler hears it, and a form sends
nothing — by button or by Enter. WebKit fires `submit` before it checks the
sandbox, so iOS Safari never had the problem; Chrome on Android and desktop did.
Both frames carry the flag, because a nested frame gets no flag its parent
lacks. Only the canvas: an `html_render` card and a file preview have nothing to
submit to, and keep the floor.

With forms allowed, three things keep a submission from going anywhere. They
overlap, but `form-action` and the bridge each hold something nothing else
does, and none may be removed:

- **The wrapper's `frame-src`** refuses a form that navigates the frame to
  another host, as it does any navigation of the frame
  ([the wrapper](page-external-hosts-ui.md#the-wrapper)).
- **The policy's `form-action 'none'`** refuses a form submitted to another
  host, in the frame or — what nothing else holds — into a window of its own
  (`target="_blank"`): a popup escapes the sandbox and is no child of the
  wrapper, so its `frame-src` never sees it, and the page's fields would go to
  any host.
- **The bridge cancels a submit nobody handled**: a listener on `window`, in the
  bubble phase and the last there, calls `preventDefault()` on a submit no
  handler cancelled. It covers what Chromium's `form-action` lets through, the
  page's own `about:srcdoc`: a plain form would reload the page into itself and
  lose what was typed. It never stops propagation and acts only after every
  handler of the page's own has run, so the page hears every submit as it
  would anywhere, uncancelled. A dialog's form (`method="dialog"` on the form,
  or `formmethod="dialog"` on its button) navigates nothing and is left to the
  browser, so it closes its dialog.

So a submission by the reader's click or Enter is cancelled before it navigates:
nothing is refused, and the [hosts strip](page-external-hosts-ui.md) shows
nothing for it. Two are out of the bridge's reach — a submit whose propagation
a page handler stops before it reaches `window` (React's `onSubmit` with
`stopPropagation()`), and `form.submit()`, which fires no event. Nothing they
send reaches another host, but in Chromium the page is lost: a plain form
reloads it into itself, and one to another host is refused by the wrapper and
reads `Page left · <host>` with Reload. In WebKit `form-action` refuses both
and the page stays; one to another host reads `Not loaded · <host>` with a Load
that cannot help, since Load allows the host and `form-action` stays `'none'`.
Cancelling earlier, in the capture phase, would close the gap at the price of
every page handler seeing `defaultPrevented === true`, a form that behaves
unlike any other.

`CanvasFrame.browser.test.tsx` holds the three in Chromium and WebKit, in the
real double frame, by real clicks and Enter: a sending form sends by its button
and by Enter; a plain form and forms posting and getting another host go
nowhere — no landing, loaded once, the same frame, the text kept, the page's
listener seeing the submit uncancelled; a dialog closes by its form's method
and by its button's; and a form submitted by script into a new window opens
nothing.

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
`textarea`, a `select` or a `contenteditable`, unless it is disabled or
read-only — neither brings up a keyboard. A measurement whose width differs
from the kept one replaces it regardless — that is a rotation or a resized
window, not a keyboard. With no measurement kept yet, the first one is kept
whatever has focus, until a better one replaces it: a size a little short is
closer than none.

How the app does this: it observes the canvas area's content box — what a page
drawn for that size gets at 100%; the area never scrolls, so it has no
scrollbars to leave out — only while canvas view is on the screen with nothing
over it, since under chat view or a page the hidden area is not the rectangle
canvas view has — nor while the answer panel is up over it, where the composer
sits in the column and the canvas gives way to it (§2). At each change it asks
where focus is *now*: an editable element of the app's own (the
composer), or the canvas frame while the bridge last said the page's focus is
editable. Focus is not re-measured when it leaves a field: at that moment the
keyboard is often still up, and the resize that follows its going is what
brings the height back.

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
- Screen smaller than `drawn_for`: the page keeps `drawn_for` in that dimension
  and the frame scrolls to it. **Never scaled**: text scaled down to fit is
  text too small to read and buttons too small to press; scrolling keeps both
  real. The page's own scrolling stays inside the frame.

The frame is the canvas area's one child and always fills it; the area is what
the canvas size is measured from, and never scrolls. What scrolls is the
frame's wrapper (§4): the page's own frame inside it is sized
`max(100%, <drawn_for>px)` in each dimension, so the page's viewport — its
`vw`, its media queries — is the size it was drawn for. The size followed is
the revision the frame shows, a patched one included: the app posts a patched
revision's size to the wrapper, which resizes the page's frame in place, the
page keeping its document as through any patch. A touch drag over a page that
does not scroll itself in that direction scrolls the wrapper, as any nested
scroller hands on a gesture.

**Why not the area.** A frame moved by a scroller in the app's own document —
the area scrolling a frame larger than itself, in either direction — makes
Chromium on some tablets (Huawei Browser, seen at 658×744) drop the app's bars
around the canvas for as long as the scroll lasts: they flash white or the
background colour at every frame. The same frame scrolled inside its wrapper,
or a page scrolling itself, does not; giving the area a compositing layer of
its own or `contain: paint` does not help. Confirmed on the device, not
reproducible in desktop Chromium. So no scroller in the app's document may
ever contain the canvas frame — `CanvasFrame.browser.test.tsx` holds it.

**What the composer covers** the wrapper scrolls on past. While the composer
floats (§2), `ComposerDock` reports how far the floating block reaches over the
canvas — its height less the collapsed line's, which the column already holds
— on every resize, so a growing draft counts; in the column it reports 0. The
wrapper adds that much empty room after the page's frame (`--pk-covered`, a
`body::after` block): written into it when the page is drawn, posted to it on
every change after (`pockode:canvas-frame-covered`), and posted again on every
`pockode:canvas-ready`, so a change made while it loads is not lost. So the
wrapper can scroll the page's bottom — a `position: fixed` bar of the page's
included, which moves with its frame — above the composer, even for a page
that fits the area and could not scroll before. When the composer collapses or
drops back into the column, the room goes and the browser pulls the scroll
back. The area, the frame and the page's viewport keep their size:
the canvas size is still measured from the area, by the same rule — kept only
while nothing editable has focus, the composer included — and the page gets
no resize event and nothing in its document.

**Why not padding in the page, or a shorter frame.** Padding the page's body by
the cover would put the app into the agent's document, where its own styles
and scripts can undo it, and it reaches only what is in the body's flow: a
page that scrolls a container of its own, or pins a bar with `position:
fixed`, keeps that under the composer. Shortening the page's frame by the
cover instead would resize the page's viewport at every line the draft grows —
a resize event, its `vh` and its media queries changing, the page laid out
again for a size nobody drew it for. Room in the wrapper, after the page's
frame, does neither. `CanvasFrame.browser.test.tsx` holds it: the page's
viewport and the area keep their size while covered, and — in Chromium, the
one engine whose protocol makes a real touch drag — a page that fits the area
scrolls by one only while covered.

So after the user rotates their phone, the page they see is still the one the
agent drew, with a scroll — and the next message they send tells the agent the
new size.

**Tool results report the size too** (§9.4), so the agent knows what it just
designed for without looking back for the last message.

---

## 6. How the user talks back

### 6.1 In the page

Most of what the user does in the page never reaches this section: the page's
own scripts handle it, and the agent is not told (§1). What follows is the way
the page sends something to the agent when it needs to — three attributes and
one function, all through the bridge (§8). What a send is about travels with it
by what the markup already has: a button's `name` and `value`
(`<button data-pk-send="open" name="id" value="42">` sends `{"id":"42"}`),
hidden inputs in the form, or the `data` of `pockode.send`. There is no
attribute of its own for it.

| Markup | Sends | When | Data |
|---|---|---|---|
| `<button data-pk-send="approve">` — any element but a `form`, `input`, `select` or `textarea`; one that is not natively a control, a `div` or an `li`, is made a button (below) | `approve` | on click on it or anything inside it (`closest("[data-pk-send]")`) but a field or `label` — a checkbox in a card that sends still toggles; on one made a button, also Enter or Space on it | inside a form: every named field of that form; plus, when the element has a `name`, `{ [name]: value }` (`value` being its `value` attribute, `""` without one) |
| `<form data-pk-send="create">` | `create` | on submit (a submit button in it, or Enter in a text field — also where the form has no submit button, or its first one carries a `data-pk-send` of its own or sits inside one, which the browser's click on it would send instead; a disabled first button submits nothing, as in any form) | every named field of the form, and the submitter's `name`/`value` |
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

**An element that sends but is not a button is made one.** A `<button>` is the
markup to reach for, but an agent writes a sending card or list row as a `div`
or `li` as often, and that is a thing a mouse can press and a keyboard can
neither reach nor press. The bridge follows the
[WAI-ARIA button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
for every element with a non-empty `data-pk-send` that is not a `button`,
`input`, `select`, `textarea`, `form`, `a[href]` or `summary` — those the
browser already makes reachable and operable, or they send by a gesture of
their own:

- it gets `role="button"` when it has no `role` attribute, and `tabindex="0"`
  when it has no `tabindex`. A role or tab stop the agent set is the agent's
  and is never touched;
- **Enter** on it presses on keydown, once for a held key; **Space** presses on
  release, only when the key goes up on the same element and focus never left
  it in between, and does not scroll the page. A press is `click()`, as on a
  native button (a dispatched `click` event on an SVG element, which has no
  `click()`): the page's own click handlers see it, and the click sends what
  a pointer's would — a form's fields included;
- the keys count on the element itself, not on a field inside it, so a checkbox
  in a sending card still toggles on Space and sends nothing; a key the page's
  own handler `preventDefault`ed, a key while composing, and one in
  `contenteditable` are left alone;
- it holds for what is added or changed later — by a patch or by the page's
  scripts. When an element stops sending (its `data-pk-send` removed or
  emptied, or an `<a>` given an `href`), the bridge takes back what it added,
  and only where the value is still the one it set.

Such an element has no disabled state: `aria-disabled` is not read. A page
stops one sending by removing its `data-pk-send`.

- **Form data** is the form's `FormData`: a field with a `name` is included; a
  name that occurs once is a string, a name that occurs more than once (checkboxes,
  a multiple select) an array of strings; file inputs are left out — a file is
  not something a page can send (§7.2 warns about one on a page with no
  script). Unchecked checkboxes are absent, as in any form.
- **`<input data-pk-send>` is cleared** once the send is accepted, and keeps its
  text when it is refused, so a refused message is never lost — and when the
  user has typed on while it was being sent, so the new text is not lost either.
- **A disabled element sends nothing** (`:disabled`, itself or by its
  `fieldset`), and a held Enter sends once, not once per repeat.
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

**A canvas action never becomes a draft.** Three existing features put a user
message's `content` back into the input box: a fork anchored on it
([the dropped prompt](session-fork-ui.md#the-dropped-prompt)), restoring a
message a Stop discarded
([discarded-messages-ui.md](discarded-messages-ui.md#5-what-restoring-does)), and
*Send again* after signing in
([cli-login-ui.md](cli-login-ui.md#after-signing-in-send-again)). For a canvas
action that content is machine text no user wrote, so none applies: a fork
anchored on a canvas action drops it and leaves the input empty, a discarded
canvas action is drawn discarded with no restore, and a turn it opened that
failed on sign-in offers no *Send again*. The user acts on the
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
cannot see — a script loaded from a file, a script that draws the page or reads
its fields at run time — the error is not raised, and a warning is used where
one helps, or nothing is said at all.

### 7.1 Errors

| Check | Message |
|---|---|
| Empty: whitespace only, or a body with no element and no text, and no script anywhere (a script alone may draw the page, and a leading one is parsed into `<head>`) | `The page is empty: pass the whole page to draw, or use canvas_update to change part of it.` |
| Over 256KB (the render's `html`, an op's `html` — prefixed `ops[<i>]: ` and refused before anything is parsed — or the document an update produces) | `The page is <n> bytes, over the 256KB limit: move large data, images or libraries into project files and reference them by path.` |
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

**A page that cannot send is not an error.** It once was, and agents answered
it by inventing buttons to get past it — the report-with-buttons page §1 turns
away from. A page that only shows something, or acts only through its own
scripts, is a page the user can still answer by typing (§2), so there is
nothing to refuse.

### 7.2 Warnings

| Check | Message |
|---|---|
| A `src`, `href` (not a link's: an `<a>` or `<area>` is followed, not loaded; a `<base href>` counts, since relative loads then go to its host), `srcset`, `poster`, CSS `url()` or `@import` naming another host (`http:`, `https:`, `//`) | `Loads from <hosts>: the user must allow each host before it loads, and until then it is missing. Prefer project files or inline code.` |
| `alert(`, `confirm(` or `prompt(` in a script — the global function, or through `window.`/`self.`/`globalThis.`; not a method of the same name | `alert/confirm/prompt do nothing here: show the message in the page instead.` |
| `position: fixed` | `position: fixed may put content off screen on a small device, and the canvas scrolls: prefer normal flow.` |
| A hard-coded `width`/`min-width` (CSS, or a `width` attribute) in `px` larger than the drawn width. Not inside `@media` or `@container` (it applies only where the query says it fits) nor in an `@import`'s media query, and not a `width` attribute on an element whose own `style` sets its width (a high-DPI `<canvas>`) | `Fixed widths wider than the canvas (<w>px): <values>. The user will have to scroll sideways; use max-width or percentages.` (Not checked when the size is unknown.) |
| Colour literals (`#…`, `rgb(`, `hsl(`) in CSS declarations, outside `var()` fallbacks and `url()`s (a `data:` image's colours are its own) | `<n> hard-coded colours: they will not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text)).` With one, `1 hard-coded colour: it will not follow …`. |
| On a page with **no script at all** — no inline `<script>`, no `on*` attribute, no `javascript:` URL, no `<script src>` and no svg `<script href>` — a field (`input` other than a button type or `hidden`, `select`, `textarea`) that no send carries: its form (the one around it, or the one its `form="id"` names) is neither a `form[data-pk-send]` nor a form holding a `data-pk-send` button (§6.1), or it has no `name` in a form only a button sends; and it is not itself `data-pk-send`. A file input is listed wherever it is, last | `<n> fields do nothing: no send carries them and no script reads them: <list>. To send a field, give it a name inside a form with data-pk-send; otherwise remove it.` With one field, the singular: `1 field does nothing: no send carries it and no script reads it: <field>. To send a field, …`. When file inputs are listed, `A file input is never sent: read the file from a script, or ask for a project path instead.` is added — and is the only fix sentence when every listed field is one. |

**Why only a page with no script.** Any script may read any field — to filter
a list, sort a table, edit in place, read a file with a `FileReader` — and the
server cannot tell which fields a script reads. A field that no send carries is
the page's own business the moment a script exists (§1), and warning about it
would teach the agent that a local control is a mistake. On a page with no
script, nothing sends or reads the field, so it really is one. The
unnamed-field error of §7.1 stays even with scripts: a `form[data-pk-send]`
exists to send its fields, so an unnamed one there is a mistake whatever else
the page does.

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
- makes a button of every element that sends but is not one (§6.1): a
  `MutationObserver` on the document, started before the agent's markup is
  parsed, watches insertions and `data-pk-send` / `href` changes, and a sweep
  when the document is ready catches what was parsed before it. The `role` and
  `tabindex` it adds are real attributes of the live DOM, which the page's own
  scripts see, and they never reach the server — the app never reads the page's
  DOM back. Its Enter and Space are taken on the document in the *bubble*
  phase, unlike the sends above, so a page handler that took the key first
  keeps it;
- cancels any other submit nobody handled, last, so a plain form does not
  reload the page into itself ([forms](#forms));
- applies patches and theme changes the app posts (§8.3, §8.4);
- reports whether an editable element has focus, for the size rule (§5), and
  that the page is parsed and ready (§8.2);
- reflects whether sending is possible on `document.documentElement` as
  `data-pk-blocked` while it is not, so a page may style itself for it: its
  value is the `reason` (`data-pk-blocked="permission"`), and empty when there
  is none — a frame of the history view (§15.4).

It never refuses a send because of what sending is told, not even while told
sending is impossible: every well-formed send is posted, and the app refuses it,
because each refused attempt is something the app shows (§10.3). Only a call it
cannot post — `pockode.send` with no action name, or `data` that is not JSON —
is refused in the page, with `invalid` (§6.1).

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
{ type: "pockode:canvas-ready" }                      // the page is parsed, each time it loads
```

`id` is the bridge's own, for matching the result, and unique to the document:
a page that reloads itself keeps its window, and an answer to the old
document's send must not settle the new one's. `pockode:canvas-ready` is
posted once the page's markup is parsed (`DOMContentLoaded`), without waiting
for what it loads, and again whenever the page loads anew — a reload by its own
script included. The page's
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
| `readonly` | the frame is the history view's (§15.4): an old revision, or the current one shown there | an old revision: `This is an earlier version of the canvas; it cannot send.` The current one: `This page is shown in history; close history to use it.` |
| `offline` | not connected | `Not connected — try again when the connection is back.` |
| `invalid` | the bridge could not serialize `data`, or the server refused it as invalid (§6.4) | the bridge's or the server's message |
| `failed` | anything else | the error's message |

**On a send** the app fills in what the page must not choose: the session, the
`revision` the frame is showing, and the device's `canvas_size`. It answers
every send one way or the other — the bridge refuses nothing it posted (§8.1),
so a send left unanswered would leave the page's promise pending for good. It
refuses on the client first, in this order:

1. `readonly` — the app's alone, and not dependent on the bridge: a frame
   in the history view is never the live canvas, and a send from it —
   on load, before `pockode:canvas-sendable` could even arrive — is refused on
   receipt.
2. `permission` — from `TurnState`, and visibly (§10.3); the server refuses it
   again regardless.
3. `offline` — the WebSocket not connected.

Then it calls `chat.canvas_action`: an `InvalidParams` refusal answers
`invalid` with the server's words, any other failure `failed` with the error's
message.

The app posts the theme and `pockode:canvas-sendable` again on every
`pockode:canvas-ready`, since what it posted before reached no bridge.

### 8.3 Redrawing

The frontend receives a new state (§13.2) and decides how to show it:

- The frame shows `from_revision` of an `update` change: post
  `pockode:canvas-patch`. The bridge applies the ops to the live DOM — the same
  ops, the same semantics as §3.2 — so a field the user is typing in outside the
  changed regions keeps its text, its focus and its scroll. Scripts inside
  inserted HTML are run (the bridge re-creates each `<script>` element, which
  `innerHTML` alone would leave inert) once every op has applied, in document
  order, and only those still in the page. A `src` script the engine fetches
  as JavaScript, without `async`, holds back every script after it — the next
  patch's too — until it has loaded or failed, as the parser would; one it
  does not fetch (`nomodule`, a template `type`) holds nothing back. The ops
  are tried first on a copy of the page in a document that loads and runs
  nothing, and the live page is touched only once they all applied there, so a
  patch that fails runs none of its markup — no script, no image `onerror`. It
  answers `pockode:canvas-patched`.
  A patch whose region the bridge cannot find in the live DOM — the agent's own
  script removed it — fails whole (`ok: false`); nothing is half-applied.
- Otherwise — a render, a frame two revisions behind, a patch that answered
  `ok: false`, no answer within 2 seconds, or a capability about to expire (§4):
  **draw the revision whole** from its `html`. Local state is lost — the
  scroll into a page drawn larger than the screen too, which belongs to the
  wrapper (§5) — and the page is what the agent drew.

**One patch at a time.** The app keeps the revision the frame shows, and it is
the app's record, not the page's: it moves to a patch's `revision` only on a
`pockode:canvas-patched` for the patch it posted (same `revision`, the first
answer only), and to a whole drawing's revision when that drawing is made. While
a patch is unanswered the frame counts as showing `from_revision` — a send in
that window carries it — and a newer state waits; when the answer comes (or the
2 seconds pass), the newest state is compared with what the frame now shows, and
patched or drawn whole by the rules above. A document drawn whole is busy the
same way until its bridge says it is ready — it hears nothing before, and its
regions are not there to patch — so a newer state arriving meanwhile waits for
that, at most the same 2 seconds, and is then drawn whole. A page that loads
itself again after it was patched shows the revision it was drawn with, not
the patches since, so a `pockode:canvas-ready` from it then is answered by
drawing the current revision whole: a send from it would otherwise carry a
revision it does not show. A page forging an acknowledgement
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
This session is a Pockode canvas: the user's whole screen is a page you draw. Make it work by itself, not a report with buttons under it.

- Draw with canvas_render (the whole page) and canvas_update (replace, append or remove parts marked data-pk-region); load them through your tool search first if you only have their names.
- What the page can do itself never comes back to you: tabs, filters, sorting, expanding, editing are the page's own scripts. The things on the page are the controls: a card or a row is a <button> unless it holds fields (a div or li with data-pk-send acts as one too), a field sits next to what it is about.
- Send only when you are needed: a decision that changes what you do next, or work only you can do. Carry what a send is about with it: a button's name and value, hidden inputs in a form, or pockode.send(action, data).
- Draw what you need from the user into the page; do not ask in your reply text. Never ask for passwords, tokens or API keys; tell the user which environment variable or file to set instead.
- Keep your reply text to short progress notes: the user sees only its latest line, beside the canvas. Never repeat what the canvas shows.
- Every message from the user ends with the size of their canvas. Design for the latest one; the canvas scrolls, so use normal flow and avoid position: fixed and 100vh.
- Do not draw permission confirmations: Pockode asks the user for permissions itself, outside your page.
- A send fired on page load fires again on every redraw, on every device showing it, each starting a turn: do it only on purpose.
- Change the regions that changed with canvas_update rather than redrawing everything, so what the user typed and the page's scripts changed elsewhere stays.
- Minimal examples: <button data-pk-send="open" name="id" value="42">Open</button> · <form data-pk-send="rename"><input type="hidden" name="id" value="42"><input name="title"><button>Save</button></form> · <input data-pk-send="search" name="q"> (Enter sends) · <ul data-pk-region="results"></ul>.
```

The examples are here as well as in `canvas_render`'s description on purpose:
this text is read before any tool is loaded, and an agent that has not seen the
markup yet plans its first page without it. The button and the form carry what
the send is about — an `id` in a button's `value` or a hidden input — because a
send that says only "open" leaves the agent to guess which. `pockode.send` is
named in the text but has no example of its own there, for the 2048-character
limit; `canvas_render`'s description has one.

The text leads with what the page should be, not with how it sends, because
an earlier text led with sending ("they answer by operating it", "choices as
buttons, details as a form") and agents built exactly that: a report with a
row of buttons under it, every one a turn. It says what the page does by
itself before it says when to send, and says nothing that would make a page
send for its own sake (§1). "A card or a row is a `<button>` unless it holds
fields" because a field inside a `<button>` is invalid markup; a card that holds
a checkbox is a `div` with `data-pk-send` instead, which the bridge makes a
button while the checkbox in it still toggles without sending (§6.1).

### 9.3 The tool descriptions

`canvas_render`:

```
Draw the whole canvas: the page that fills the user's screen in this session, replacing what was there.
Free HTML, a full document or a fragment, at most 256KB: scripts, SVG and <canvas> run. Project files load by path (relative to the worktree root); other hosts are blocked until the user allows them, so prefer project files or inline code.
Pockode adds only theme colours that follow light/dark — --pk-bg, --pk-bg-secondary, --pk-bg-tertiary, --pk-text, --pk-text-secondary, --pk-text-muted, --pk-border, --pk-accent, --pk-accent-text, --pk-accent-hover, --pk-success, --pk-error, --pk-warning, --pk-code-bg, --pk-code-text — and default styling of native inputs. Use the variables instead of fixed colours.
Make the page work by itself: tabs, filters, sorting, expanding and editing are its own scripts and never reach you. Send only what needs you — a decision that changes what you do next, or work only you can do:
  <button data-pk-send="open" name="id" value="42">…a card…</button>   (sends {id: "42"}; inside a form, also the form's named fields)
  <form data-pk-send="rename"><input type="hidden" name="id" value="42"><input name="title"><button>Save</button></form>   (fields with a name are sent)
  <input data-pk-send="search" name="q">   (sends its value on Enter)
  <script>pockode.send("pick", {ids: [3, 5]})</script>   (returns a promise; rejects with a reason when it cannot send)
Prefer <button> for anything pressable — a card or a row can be one, unless it holds fields; a div or li with data-pk-send is made a button too.
Each arrives as a message naming the action, its data and the canvas revision it was sent from.
Mark parts you will change later in the markup itself: <ul data-pk-region="results"></ul>, then change them with canvas_update. Region names are unique.
The result gives the new revision, the size it was drawn for, and warnings. An error leaves the canvas unchanged and says how to fix it.
```

`canvas_update`:

```
Change parts of the canvas without redrawing it: what the user typed or scrolled, and what the page's scripts changed, elsewhere on the page stays. Scripts in the new HTML run.
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
│ ░│ 🔒 2 permission requests        [Hide ⌄] ││  header; Hide collapses to the banner
│ ░├──────────────────────────────────────────┤│
│ ░│ ? Bash  npm install --save-dev vitest    ││  the chat's pending permission card,
│ ░│   Command                                ││  opened
│ ░│   npm install --save-dev vitest          ││
│ ░│   [Deny] [Always Allow] [    Allow     ] ││
│ ░│                                          ││
│ ░│ ? Write  src/config.ts                   ││
│ ░│   Proposed change                        ││
│ ░│   + export const …                       ││
│ ░│   [Deny]                [    Allow     ] ││
│ ░└──────────────────────────────────────────┘│
├──────────────────────────────────────────────┤
│ activity strip                               │
│ [ Allow or deny to send ]                 ■  │
└──────────────────────────────────────────────┘
```

- **Shape.** The answer panel's
  ([answering-ui.md §3](answering-ui.md#3-the-answer-panel)): modal over the
  canvas rectangle and nothing else, the header, strips and input left lit; up to
  85% of that rectangle, scrolling inside. It is the same reasoning — the user may
  want to Stop, or read the activity strip, while deciding. One shape at every
  width, as there: centred, `mx-4`, `max-w-2xl`, `max-h-[85%]`, `rounded-xl`,
  `bg-th-bg-secondary`, `shadow-xl`, over a `bg-th-bg-overlay` backdrop. No
  short-viewport fold: the panel has no field to type in, and the composer is
  collapsed while it is up (§2), so no keyboard competes for the room. On a phone
  on its side the rectangle leaves about one card on the screen at a time; the
  body scrolls, and that is accepted — every card carries its own buttons, so
  none of them is ever below a fold the card does not also cross.
- **Where it is drawn.** Inside the canvas view's column (`CanvasView`), as an
  `absolute inset-0 z-10` layer over the hosts strip and the frame, which go
  `inert` under it; the panel is their sibling, not their child, so it stays
  reachable. The layer is the canvas view's own, so the session screen's layout
  around it does not change.
- **What `ChatPanel` has to do for §10 and §11**, and nothing more, since the
  history story is changing the same screen: hand `CanvasView` the turn and
  whether it is known yet (`isSessionDetailLoaded`), the transcript's
  permission cards by request id, the last reply's status (open, or ended
  `interrupted`),
  the answer path (`handlePermissionRespond`, `promptError`), `isCodex` and
  `onOpenFile`, as one `permissions` prop; collapse the canvas composer when a permission block starts
  (§2); pass `AttentionStrip` its new prop (§11.4); and mount the activity strip
  as `ComposerDock`'s first child while canvas view is shown, which unmounts it
  — and the sheet it raised — when canvas view leaves the screen (§11.3), with
  the transcript's jump to a message for its **Open in chat**. The banner, the panel, the panel's open-or-collapsed
  state, the expiry line and not measuring while the banner is up are all
  `CanvasView`'s; whether another layer is up it reads itself
  (`useIsPageCovered`, §10.2).
- **The header** is the answer panel's (`border-b`, `px-4 py-3`): a `Lock`
  (`size-4`, `text-th-warning` — the `needs_permission` glyph and tone,
  [lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity); the glyph's shape carries
  it, the hue only reinforces, [project-ui.md §3](project-ui.md)) and the title,
  `text-base font-bold`: `Permission request`, or `N permission requests` while
  several are waiting — N counting the requests still unanswered, so it falls as
  the user answers. At the far end **Hide** with a `ChevronDown` (`size-4`) — a text
  button in the attention strip's Deny style (`touch-target h-7 rounded-md border
  border-th-border px-3 text-xs text-th-text-primary`). Not the answer panel's `✕`: beside Deny, an `✕` reads as
  *refuse*, and the button refuses nothing; it puts the panel away to a banner,
  and the chevron says where it goes.
- **Every pending request, in full.** Several can be pending at once (parallel
  tool calls), and each is listed as the chat's permission card for it —
  `PermissionRequestItem`, the same component, moved out of `MessageItem.tsx`
  into a file of its own so both can import it
  ([tool-call-ui.md](tool-call-ui.md#the-permission-card-takes-the-rows-place)):
  its warning tint and outline, its title line, its body opened (a pending card
  opens by itself, and outside a transcript list `useRowExpanded` is its own
  state), its *Always Allow* sentence, its buttons — **Deny**, **Always Allow**
  where offered, **Allow** at the thumb's end — and its refusal line. Oldest
  first, in the blockers' order, `space-y-3` apart in a body of `p-4`. Its file
  links open the file over the session as they do from the chat; coming back
  finds the panel as it was left (§10.2).
- **Each is answered on its own**, with that card's own buttons, through the same
  answer path as the chat's card (`chat.permission_response`, one call per
  request). There is no "Allow all": a batch of requests is several decisions,
  and one button for all of them is a way to grant something unread.
- **An answered card stays where it is, settled, until its blocker goes**, and
  then leaves: the press's receipt for the round trip, as the attention strip's
  row holds one — a card vanishing under the thumb the moment it is pressed would
  look like the press did nothing, or something else. Settled is the card as chat
  draws a settled one — its title line, the `Check` or `X` glyph — with its body
  closed: the panel keys each card by request *and* status, so a settled card
  mounts afresh and `useRowExpanded` starts it closed (outside a list its initial
  value is read once). Its status is the transcript's when the request's card is
  loaded there, and otherwise the answer the panel itself sent: the record may be
  on a page not loaded (§10.4), and a pressed card must not look still pending.
  The remount drops a keyboard user's focus with the pressed button, so a
  keyboard answer (focus was on the button; a pointer press never focused it,
  as in the attention strip) moves focus on — to the next pending card's first
  button once it is armed, and meanwhile to the panel itself — as
  `AttentionStrip` carries it over.
- **A denial on Claude ends the turn**, so every other request is about to
  expire, and an answer to one would only be refused. While any request listed
  is denied on Claude (`!isCodex`) — denied from any surface: the panel, the
  turn's details sheet, chat view or another device, read from the card's
  status as above — the other cards' buttons give way to a muted `Ending the
  turn…` until their blockers go: the reason `permissionRowEntry` holds a denial
  in the attention strip. On Codex a denial refuses that call alone, and the
  rest stay answerable.
- **Every answer re-arms the cards still pending.** A card settling closes its
  body, and the cards under it move up under the thumb that pressed. The panel
  hands each card an `armKey` — its request and the number of cards listed as
  settled, however they were answered (here, in chat, in the sheet, on another
  device) — and a card given one wraps its button row in an `Armed` of that key
  (full width, so Allow keeps its `flex-1`); without one, as in chat, it is drawn
  as today. So the buttons are inert for `ARM_MS` after any card settles —
  the rule the attention strip's row follows when the next request takes its
  place, for the same reason: a second tap must not approve what nobody read.
  The same `Armed` covers the panel's arrival: it opens by itself, possibly
  under a finger already on its way to the page, so its buttons — and the
  backdrop's collapse — wait `ARM_MS` after it appears.
- **When none is left the panel closes by itself.** Focus, if it was in the
  panel, goes back to the canvas frame.
- **An expired request** leaves the list as well; the chat view's card states
  what became of it ([lifecycle-ui.md § 5](lifecycle-ui.md#5-expiry)). In canvas
  view, once the batch is over, that card's sentence
  (`PERMISSION_EXPIRY_COPY`, shared with the card) shows as a neutral line —
  `text-xs text-th-text-secondary` on `bg-th-bg-secondary`, `border-b
  border-th-border`, the banner's inner line, a `✕` (`touch-target`) to dismiss
  it — so the banner going is never the only trace. Not while the batch goes on:
  the panel or the banner is still up, and the line would be a second strip
  about the same batch.
  - **In the banner's place in the column**, above the hosts strip, so it
    covers neither the strip's control nor the top of the page. Unlike the
    banner it is measured through: it lasts until dismissed or until the next
    batch starts, sending works all that time, and while it is up the canvas
    really is that size — the size sent is the page's true room, and its
    dismissal is an ordinary resize (§5).
  - **Only for what the user did not cause.** A Stop, or a Deny on Claude,
    expires the other requests too; that is the user's own act, already
    answered on the screen, and reporting it as if the agent gave up would read
    as a failure they did not cause. So the line is left out when the batch held
    a denial on Claude (`!isCodex`) or its reply ended `interrupted`. A denial
    on Codex ends nothing else, so an expiry after one is still reported.
    The Stop is known only after the batch is over — Codex withdraws its
    approvals while the turn still runs, and the turn's end is announced
    before the reply's `interrupted` record — so an expiry that gives no
    reason waits, unsaid, until the turn and its reply have both ended; one
    with a reason (timeout, process ended, work closed) is never a Stop's.
  - Several expiring at once say it once, with a count and the reason in the
    plural when their reasons agree (`2 permission requests expired: they were
    not answered in time, so they counted as denials and the tools did not
    run.`), and the fallback sentence in the plural when they do not (`… the
    agent stopped waiting for them, …`).
  - It is the canvas view's UI state, not a record: gone on another visit,
    where the chat card still says it.
- **A blocker with no record** (§10.4) is a card of the same tint with the
  `Lock` and its sentence, and no buttons. It counts in the title and the
  banner; the banner's summary names the oldest request that has a record, and
  none when no request has one.

### 10.2 Opening and collapsing

**The rule: the panel opens by itself once per batch, and a collapse holds for
the rest of that batch, wherever the user goes inside the session.**

- **A batch** starts when the number of pending requests goes from 0 to at least
  1, and ends when it is back at 0 — counted from the session detail only once
  it is loaded (`isSessionDetailLoaded`), as the answer panel's logic is. Until
  then the count is unknown, not 0: a resubscribe or a reconnect that passes
  through no detail must not end a batch and reopen a panel the user put away. The panel opens at the start of a batch.
  Requests joining a batch never reopen a collapsed panel: they **only raise the
  banner's count**. Permissions come first, so the panel puts itself in front of
  the canvas the moment the agent needs one; and a user who put it away chose to
  look at the canvas, so nothing the agent does within that batch takes the
  canvas from them again.
- **A visit is this session on this screen**, and what is remembered — open or
  collapsed — lasts exactly one. It is UI state of the canvas view: `CanvasView`
  is keyed by the session and stays mounted under chat view and under a page
  drawn over the session, so the state lives there and needs no store — and
  so does an open panel, hidden, so it comes back with its scroll and the
  sections opened in its cards. Hence:

  | Leaving and coming back | Panel |
  |---|---|
  | switching to chat view and back | as left |
  | a page over the session (a file, the work list) and back | as left |
  | another session and back, a reload, arriving from a notification or from the work list at a session not already open | opens, if anything is pending |

  Arriving with requests already pending is the start of a batch for that
  visit: the user has not seen this panel yet. A batch that started while chat
  view was up starts open, and is open when the user switches over.

  **While any other layer is up** — `useIsPageCovered()`, read before the panel
  registers its own: the turn's details sheet (§11.3), the session's settings
  sheet, a sign-in sheet, the sidebar drawer — the panel waits. A panel opened
  under one would be a layer nobody sees, and Back would close it first. It comes
  up when the last of them goes, unless the batch ended meanwhile; the banner
  stands in until then, its condition being *collapsed or waiting*. The details sheet needs no special case beyond this: it
  already shows the pending card, buttons and all.

  This departs, on purpose, from the answer panel's rule that a question it has
  not shown reopens it
  ([answering-ui.md](answering-ui.md#closing-lasts-one-visit)): the banner
  already says a request is waiting, in the warning colour at the top of the
  screen, and reopening over a user who put the panel away would take the canvas
  from them once per parallel tool call. It departs from that page's rule that
  an overlay ends the visit too: the canvas, unlike the transcript's question
  card, is kept exactly as left under an overlay (§2), and so is the user's
  choice about it. A switch back from chat view does not reopen it either — the
  user has just seen the cards there.

  What makes the never-reopen safe is the banner, and it is prominent by
  position and words rather than by hue — the warning hue is under the 3:1
  floor in the light themes ([project-ui.md §3](project-ui.md)): it is the
  first thing under the header, full width, pushing the page down; its words
  are in the primary tier; and its **Show** is the accent pill.
- **It collapses to the banner** by **Hide**, Back
  ([project-ui.md §5.2](project-ui.md#52-back-closes-the-topmost-layer) — it is
  a layer, registered with `useCoverPage` only while it is actually on the
  screen, whose `onLeave` keeps it as it was under a page navigated to (a file
  link in a card, say), so coming back finds it open, holding an entry again; a
  navigation that lands where it was — the open session's own row, tapped in the drawer over
  it — leaves it on the screen without one until it is next put away and
  shown, so a Back then leaves the session rather than collapsing it, which
  is accepted: taking an entry back while the navigation is still landing
  could push it over the page landed on), Escape, or a press on the backdrop —
  both read on `window` and only when nothing drawn over it claimed them first,
  as the answer panel's are
  ([answering-ui.md](answering-ui.md#who-owns-escape)); while it holds its
  entry it is a counted layer, which keeps `ChatPanel`'s Escape from
  interrupting the turn. In the drawer-row corner above it holds none and is
  not counted, so there `CanvasView` claims Escape itself, on `window` in the
  capture phase — ahead of that interrupt on `document` — unless a layer drawn
  over it is up: one Escape collapses it and stops nothing.
  **Collapsing never denies anything.**
- **Focus.** The panel is `role="dialog"`, `tabIndex={-1}`, without
  `aria-modal`, as the answer panel. Opening by itself, it takes focus onto
  itself — never onto a button, so no key already on its way lands on Allow —
  only when the focus was where the block just took it away: in the canvas, now
  `inert` under it, or in the composer, now collapsed. Focus anywhere else (the
  header, the view switch) is the user's and stays. A field the user was typing
  into in the page loses its keyboard: that is the price of permissions coming
  first, paid once per batch. Opened by **Show**, it always takes focus — the
  banner that had it is gone; on collapse, focus goes to the banner.

**The banner**

```
┌──────────────────────────────────────────────────┐
│ 🔒 2 permission requests waiting · Bash n… [Show] │
└──────────────────────────────────────────────────┘
```

- **Where.** The first child of the canvas view's column, above the hosts strip
  (§4), full width; the canvas gives way to it (it is in the column, not over the
  page: covering the top of the page would hide what the agent put first). It
  exists only while requests are pending, the panel is collapsed or waiting
  behind another layer, and canvas view is up. **`CanvasView` does not measure the canvas while it is up**, as under
  the answer panel: its height must not become the canvas
  size, and its going may coincide with focus in a page field, when §5 keeps a
  height-only change from replacing the measurement.
- **Look.** The pending card's colours, so the banner and the cards read as one
  thing: `bg-th-warning/10`, a `border-b border-th-warning` rule — reinforcement
  only, as on the card. Inside, the
  attention strip's permission line (`mx-auto max-w-3xl flex items-center gap-2
  px-3 py-2 text-xs`), 44px tall with its `h-7` pill — a statement-strip height
  that does not push the page further than it must. `Lock` `size-3`
  `text-th-warning`; `N permission request(s) waiting` in `text-th-text-primary
  font-medium` (`1 permission request waiting`) — N the unanswered requests, or,
  while every one is answered and its blocker not yet gone, all of them, so it
  never reads 0; then `·` and the oldest pending
  request's title and detail as the tool row writes them (`toolSummary`),
  `text-th-text-muted`, truncated — a tool name tells the user how urgent this
  is. At the end a **Show** pill in the attention strip's Allow style (`h-7
  rounded-md bg-th-accent px-3 font-medium text-th-accent-text`).
- **One control.** The whole banner is one `<button>` that opens the panel —
  the pill is its visible label, not a second control. No `aria-label`: its
  accessible name is its visible text, summary included. Live announcements
  (§10.3) are a visually hidden `role="status"` *beside* the button, never
  inside it. No Allow or Deny on it: in canvas
  view the request is not on the screen anywhere else, and answering from a cut
  line is granting it unread. One tap to the panel is the way.
- The banner wears the warning tint where a hosts strip is neutral: it is about
  something the agent cannot go on without.

### 10.3 While blocked

The canvas **stays viewable and locally interactive** while the panel is
collapsed: scrolling, tabs, toggles, anything the page does by itself. Under the
open panel it is dimmed and inert, as anything under a modal is. **Sending is
refused, visibly:**

- the bridge is told `pockode:canvas-sendable { sendable: false, reason:
  "permission" }`; a `data-pk-send` press or a `pockode.send` call is answered
  with the `permission` refusal and the page does not send;
- **each refused attempt flashes the banner**, or the panel's header while it is
  open (a script's send can be refused under the open panel):
  - the flash is a `pointer-events-none absolute inset-0 bg-th-warning/30`
    layer over the banner, fading to nothing in 600ms, keyed by the attempt
    count so every attempt restarts it — a layer rather than re-keying the
    banner, which would drop focus from it. A keyframe beside `stop-arm` in
    `index.css`; under `prefers-reduced-motion` there is no flash, only the
    sentence below;
  - **the sentence**: `Answer the permission request first.` takes the place of
    the banner's text — count and summary — for 4s, restarted by each attempt,
    `text-th-text-primary`, the `Lock` and **Show** staying where they are. In
    place, not on a line of its own: a line appearing would push the page down
    under the finger that just pressed in it. In the open panel it takes the
    visible title's place in the header for the same 4s, for the same reason —
    a line under the header would push every card's buttons down; the dialog
    keeps its name (`aria-labelledby` on the title, kept in the DOM, visually
    hidden meanwhile). It is announced once when it appears, through the
    `role="status"` beside the banner or in the panel — not again while
    attempts keep restarting it, so a page sending in a loop does not flood a
    screen reader;
  - the attempt does *not* reopen the panel: the banner is under the user's eye
    already, with **Show** in it;
- `pockode.send` rejects with `code: "permission"`;
- the collapsed input's text field is disabled but keeps its text (§2). **Stop
  stays usable** — stopping the turn is one of the two ways forward
  ([lifecycle.md](lifecycle.md#session-one-reducer)) — and the panel never
  covers it. So does the History button beside the line (§15.1).
- **Over an earlier revision** (the history view, §13.5) the banner and the panel
  are the same: a permission is the session's, whichever revision is shown. A
  send from that frame is refused as `readonly` first (§8.2) and flashes nothing:
  it could not have been sent with the permission answered either.

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
subscription delivers and what became of each request — answered or expired,
live or on the first page, which is how the expiry line learns of an expiry
while the client was away — and the panel reads that store. Chat view goes on drawing
its permission cards from the transcript, as today; the field is the one
addition to the chat subscription outside canvas sessions, and only the panel
reads it.

**A blocker with no record** — the append of its `permission_request` failed,
so it was only broadcast, and a client that subscribed afterwards never saw it —
is still listed, as `A permission request is waiting, but its details could not
be read. Stop the turn to go on.` with no answer buttons: an answer would have
to quote what the client cannot show, and the user must not grant something
unread. Only a request the subscribe reply's `turn` lists without a record is
that: one raised later is broadcast whatever its append did, and the server
settles the blocker a moment before it sends the record, so until the record
lands such a card reads `Loading the permission request…`, with no buttons
either.

Answering is the existing `chat.permission_response`, one call per request.

---

## 11. The activity strip

One line, between the canvas and the input, saying what the agent is doing — so
a user looking at the canvas knows whether it is working and on what, without
switching to chat.

```
├──────────────────────────────────────────────┤
│ ⟳ Bash  npm test                     1m 4s › │  running
│ ⟳ Thinking… · Checking the retry path 12s › │  thinking
│ 🔒 Write  src/config.ts                     › │  blocked(permission)
│ ⧗ Waiting on a background task              › │  blocked(background)
│   Done — the checklist is on the canvas.    › │  idle, muted
├──────────────────────────────────────────────┤
```

### 11.1 What it says

**The latest item of the reply being written** — the reply the chat's tail line
sits in ([turn-progress-ui.md §2.1](turn-progress-ui.md#21-where-it-is)): the
latest assistant reply, which a message read mid-turn opens afresh. Settled, the
last reply. A turn running or blocked on a permission with no reply open yet —
reported before its first record, as a send from another device is, the turn
and the transcript arriving on two subscriptions — has none: `Working`, not the
last reply, whose `Stopped` or error would be read as this turn's.

| Latest item | Line |
|---|---|
| text | its last non-empty line, as plain text (Markdown stripped) |
| a tool call | its title and detail, as the tool row writes them (`toolSummary`, [title and detail](tool-call-ui.md#title-and-detail)) — a canvas tool in §12's wording and tense (`Drawing the canvas`, `Updated the canvas · <regions>`), a subagent's call with its latest child's line, as its row has it |
| thinking, live | `Thinking…` and, when there is text, `· <latest line>` ([turn-progress-ui.md §2.3](turn-progress-ui.md#23-what-it-says)) |
| a settled thinking | its row's `Thought for 12s` |
| a permission card | its title and detail, as a tool call; settled, followed by `· Allowed`, `· Denied` or `· Expired` — words where the card has only its glyph, there being no glyph-only way to say it in a line of text |
| nothing yet | `Working` |

Notices in the reply — system, warning and work-event messages — are skipped:
the strip says what the agent did, and chat view holds the rest. So is a
subagent's child sitting flat in the reply because its call is not loaded: it
is not what the main agent did. **How the reply
ended** is said before its latest item, once it has (`MessageStatus`):

| Reply ended | Line |
|---|---|
| `complete` | the latest item alone |
| `interrupted` | `Stopped · <latest item>` |
| `process_ended` | `The agent's process ended · <latest item>` |
| `error` | the error's message, in `text-th-error` — an error is never left to chat view alone |

Before the server reports the turn — a send just went out, the optimistic
placeholder is up — the strip is `Working` with the spinner and no clock, as the
tail line is ([turn-progress-ui.md §2.2](turn-progress-ui.md#22-when-it-shows)):
a press in the page has to be answered on the screen at once, and the strip is
where canvas view answers it.

**Liveness comes from `TurnState` only** — `turn.phase` from the session detail
subscription, as for the tail line. The latest record says *what*, never
*whether*:

| Turn | Glyph | Line | Clock |
|---|---|---|---|
| `running` | `Spinner`, `text-th-accent` (`CircleDot` under reduced motion) | latest item | turn clock |
| `blocked(permission)` | `Lock`, `text-th-text-muted` | latest item — the banner or panel says why | — |
| `blocked(background)` | `Hourglass`, `text-th-text-secondary` | `Waiting on a background task` (the attention strip's wording) | — |
| `idle` | none, the slot kept | the last reply's line, all `text-th-text-muted` (an error keeps `text-th-error`) | — |
| no turn yet | none | `Not started`, muted; not a button — there is nothing to open | — |

**Before the session detail and the transcript have loaded** the strip is the
`Not started` box with no words: neither phase nor reply is known, and a
placeholder `IDLE_TURN` must not be read as *no turn yet*. It becomes the button
once both have arrived.

**The strip is always drawn in canvas view**, from the first frame, so the
canvas area has its final height before the first send measures it: a strip
appearing with the first turn would make the size that send carried 36–44px
taller than the page then gets (§5).

The `Lock` is muted here, not warning: the banner is the one warning surface,
and a second would make two things to look at for one request. The clock is the
tail line's turn clock (`open_elapsed_ms`, not under 3s), `tabular-nums`.

### 11.2 How it looks

- **One full-width `<button>`**, `border-t border-th-border`, `min-h-9
  pointer-coarse:min-h-11` — the tail line's height, written down on the button
  itself so it meets the hit-area floors without `touch-target` (a height on a
  child is one the floor's scan cannot see) — its content in `mx-auto flex
  max-w-3xl items-center gap-1.5 px-3 text-xs`. `Not started` is the same box as a
  plain `div`, so the height never changes when the first turn makes it a
  button.
- **The glyph** in a fixed `size-3` slot that is kept even when empty, so the
  line never moves sideways as the turn settles or blocks.
- **The line**, `min-w-0 flex-1 truncate`: a tool call's title in
  `text-th-text-secondary` and its detail in `text-th-text-muted` (the tool row's
  `Detail`, monospace where the row's is); text and the other items in
  `text-th-text-secondary`; all of it muted when idle.
- **The clock at the far end**, then a `ChevronRight` (`size-3`, muted). Not
  after the label as on the tail line: here the label *is* the changing line, and
  a clock after it would be dragged across the row several times a second; at the
  end it moves only when it gains a digit.
- Its accessible name is its visible line, prefixed by `Turn details:` —
  written out as one string (`aria-label`), since the line is spans side by
  side whose text would run together in a computed name. A visually hidden `role="status"` *beside* the button — never
  inside it, where a button's name overrides its children — says only the
  phase, `Agent working`, `Waiting for permission`, `Waiting on a background
  task`, `Agent finished`, when it changes; not every line, which would be read
  out several times a second, and not the phase the strip first finds the turn
  in, which is no change.
- It floats with the other bars over the canvas while the composer is open
  (§2), as part of `ComposerDock`; it is the dock's first child.
- Before the reply's first record — a turn reported running before anything
  of it has arrived (§11.1) — it is the button disabled, for the moment there
  is nothing to open. A sheet already open stays on the reply it was showing
  through that moment — a turn started elsewhere passes through it — and moves
  on to the new reply when it opens. A sheet whose reply goes (the session
  detail cleared) closes for good: coming back is not the user asking again.

### 11.3 The turn's details

**Tap** opens the reply in a `Sheet`:

- Title `Current turn` while a turn is open (or the placeholder is up),
  `Last turn` when settled; the turn clock under it while running — the
  sheet's subtitle, its title being a string, held at a line's height for the
  whole open turn, so the header does not move when the clock appears at 3s.
- The body is the reply as chat draws it — its text, tool rows, thinking, the
  tail line — with the message it answers (a typed message or a canvas action,
  §12) at its top. The same `MessageItem`s, read from the same transcript, so it
  is live: rows arrive and settle in it as in chat, and the sheet follows the
  end while the reader is at it, as chat does. Without the transcript's
  per-message menus (fork, copy): the sheet is for reading what is happening,
  and chat view is one tap away for the rest. A pending permission card in it is
  the card, with its buttons, as in chat — the same component as the panel's.
- At the bottom, **Open in chat**, full width: switches to chat view with the
  reply's start at the top of the transcript, highlighted as a jump to a
  permission card is, and closes the sheet. `MessageList`'s jump reaches a
  message by its id (`jumpToMessage`, the row's `data-message-id`) beside a
  permission card (`jumpToRequest`), the one addition to it this section
  makes. The row takes focus for the keyboard, unless chat view's composer
  takes it as it comes up, as it does under a fine pointer.
- A settled strip opens the last reply. Before any turn the strip is no button
  (`Not started`), so there is nothing to open.
- It is a `Sheet`, so Back and Escape close it; switching to chat view or a page
  over the session closes it with the strip, which is mounted only while
  canvas view is shown and holds the sheet's state — no `CoveredSurface` is
  needed for what is unmounted.

### 11.4 Beside the attention strip

The strip is part of the canvas view only: chat view has its own tail line. In
canvas view the attention strip stays, minus the two rows that are about the
turn (§2), and sits under the activity strip, by the input its rows are about:

```
│ canvas                                       │
├──────────────────────────────────────────────┤
│ ⟳ Bash  npm test                     1m 4s › │  activity strip
│ ↳ Sent — the agent has not read it yet.      │  attention strip (send receipt), when it has a row
│ [ Message…                              ]  ■ │
```

The permission row is left out because the banner and the panel are that row in
canvas view, and its way to the card would leave the canvas for chat; the
background row because the activity strip says the same wait — without the
row's **Details** note that a Stop loses the tasks, which chat view keeps. `AttentionStrip`
takes a prop saying the turn's rows are drawn elsewhere
(`turnRowsElsewhere`), and with it the strip's one-row choice becomes, in
canvas view:

| Turn | Row |
|---|---|
| `blocked(permission)` | the send receipt if a message is pending, else none |
| `blocked(background)` | the send receipt if pending, else none |
| `running`, `idle` | as in chat: the send receipt, then watched stories, then the files to review |

Never falling through to a row the chat shows only without a blocker: the
watched-stories and review rows are gated on there being no blocker today, and
stay so. The questions row does not arise (§2).

---

## 12. In chat view

Chat view is the transcript as any session's, with three additions:

- **Canvas tool calls are rows, not cards.** `canvas_render` reads `Drew the
  canvas`, `canvas_update` `Updated the canvas` with the regions as detail;
  the result's revision is meta (`rev 8`). The page is not drawn into the
  transcript: it is drawn once, in the canvas. A row whose result names a
  revision offers **Show** in its body, which opens the history view on that
  revision, over chat view (§15.1) — not a switch to canvas view: Back and ✕
  put the reader back in the transcript where they were. A session read out of
  another worktree has no canvas reads (§13.5), so its rows offer none.
  An update's regions are each named once, in the order of its ops. The title
  is past tense only once the call has drawn — succeeded, or carries a revision
  (one that returned after its turn was interrupted still drew): running it
  reads `Drawing the canvas` / `Updating the canvas`, and failed, cut short or
  asked about on a permission card `Draw the canvas` / `Update the canvas`. A failed call drew
  no revision and names none; its second line is the first reason of §9.4's
  list, with `(+N more)` when there are several. A canvas call is never folded
  into a group of calls ([tool-call-ui.md § Groups](tool-call-ui.md#groups)):
  folded, its revision would not be seen.
- **A canvas action is a user bubble of its own kind**: the action name, a
  `from revision 7` meta, and the data, folded when it is more than a line. Not
  the raw `content` — that is for the agent. Drawn from `canvas_action` alone,
  so the sender's echo reads right before the reply brings `content`. The data
  is one line of JSON; no data (`{}`) draws none. "A line" is counted, not
  measured — 40 characters, about a phone bubble's line — so the bubble keeps
  its shape as it is laid out; longer data shows its start cut on one line, and
  opens into the JSON indented, its first 20 lines (at most 2,000 characters)
  in the bubble and all of it in the full screen viewer. Where a message is
  quoted on one line (the fork sheet) a canvas action is quoted by its name,
  for the same reason.
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

The app offers it as **Canvas** beside **New Chat** in the sessions tab, and a
canvas session's row carries a glyph of its own (and `, canvas` for a screen
reader). Creates of the two kinds are separate requests: one never joins the
other in flight ([agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session)),
and Retry after a failed create asks for the same kind again.

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
  state.json          { revision, reported_size?, numbered_from?, forked_at?, fork_note? } — rewritten on every new revision, every reported size, at a fork and when its note is delivered; the last three are a fork's (§13.6): the next revision is max(revision, numbered_from) + 1 — the state's **next-revision floor** —, forked_at is the revision it was cut at (so the numbers above it up to numbered_from are the source's pages it never had, not pages it lost), absent when the copy failed, and fork_note is cleared once a delivery carrying it has succeeded
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
  takes the state's next revision — `revision` + 1, or in a fork
  `max(revision, numbered_from)` + 1 — and overwrites it.
- **A `state.json` that is unreadable** (quarantined as `state.json.corrupt`)
  does not restart the numbering: the revision is recovered from the highest
  snapshot on disk, because tool results in the transcript name those numbers.
  The recovered state is written back at once, so a restart before the next
  draw does not mistake the quarantined file for one never written. The
  reported size is lost until the next message reports one, and so are a
  fork's `numbered_from` and `fork_note` (§13.6): a fork whose state is lost
  before it draws numbers on from its highest snapshot, and its agent is not
  told where the canvas is — accepted, and logged with the rest, for a file a
  crash had to corrupt in the window before the fork's first page. Its
  `forked_at` goes too, whenever the file is lost: the source's pages past
  the cut are then listed as lost from disk rather than never copied — the
  wording and the log line are wrong, the list and the numbering are not. A `state.json`
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

For the history view (§15):

```
chat.canvas_history  { session_id }           -> { snapshots: [{ revision, change_kind, drawn_for?, drawn_at, bytes, fork_blocked? }] }   newest first
chat.canvas_snapshot { session_id, revision } -> CanvasSnapshot

type ForkBlocked = "pending" | "no_record" | "superseded" | "subagent";
```

**`fork_blocked`** says a fork from this page (§13.6) would be
refused, and why, so the view can say so before the user asks (§15.6). Absent
when the fork can be made. It is not stored: it is read from the session's
history records each time the list is asked for, in one pass that notes, for
each `tool_result` carrying a `canvas_revision`, its index and the highest
revision named at or before it.

| Value | When |
|---|---|
| `pending` | no `tool_result` record names this revision, and the session's live process has a canvas call in flight (`process`'s `canvasCalls`, which already tracks them to stamp their results, counts each until its result is recorded, and clears them when the turn or the process ends) — a call of the turn, or a parallel one: one of them drew it and has not returned (a page is applied, and pushed, before its result is recorded). Also for a page drawn since the open turn (running or blocked) began that is newer than every one a record names: the page is applied through the MCP server, which can draw it before the process has read the call's `tool_call` off the CLI's output. An older page with no record stays `no_record` however long a later turn runs. Decided from what is running now, not from history, where a call whose result never came stays unanswered for good. It clears, or turns into one of the others, when the result is recorded |
| `no_record` | no `tool_result` record names this revision, and it is not `pending`: its result was never recorded (the server stopped mid-call, the append failed, the turn was interrupted and no result came, or the call was still running when its turn ended, as a backgrounded subagent's can be — `canvasCalls` stamps only the calls of a running turn), so there is no point in the conversation to cut at |
| `superseded` | a record at or before the one naming it names a higher revision — parallel calls in one turn returned out of order — so the conversation at that point already had a later page, and a fork cut there would open on that one (§13.6's R) |
| `subagent` | the record naming it is a subagent's (`parent_tool_use_id` set). Neither CLI can reopen its conversation inside a subagent's run (`agent.EventRecord.ProviderMessageID`), and a cut there would keep the subagent's earlier records while dropping the call that spawned it |

The values are checked in the table's order. The cost is a read of the whole
history per call, which the fork pays anyway; the view asks only while it is
up, and coalesces its asks (§15.3). An entry whose snapshot is lost is
not listed (below), so has no `fork_blocked` to carry.

They serve only the connection's current worktree, like the rest of `chat.*`.
A canvas session seen through the read-only `session_view.*` namespace (any
other worktree's sessions) has no canvas read yet: it shows its transcript
only.

Both are refused with `this session is not a canvas session` for any other
session; `chat.canvas_snapshot` for a revision the canvas does not have with
`the canvas has no such revision: revision <n>, the canvas is at <m>` — or,
for one the disk lost (§13.3), `the canvas has no such revision: revision <n>
was lost from disk` — or, in a fork, for one of the source's pages the fork
did not copy (numbered above its `forked_at` and at or below its `numbered_from`, §13.3), `the canvas has
no such revision: revision <n> was not carried into this session when it was
forked`; such a page is not listed either, and not logged as lost — all
`InvalidParams`. Until the fork draws past its `numbered_from`, such a number
is above its revision, and is refused with the first wording. A snapshot that
is still there but
cannot be parsed stays listed, and reading it is an internal error that names
the revision.

A revision shown in the history view — an old one, or the current one shown
there — is read-only: its bridge is told `sendable: false`, and the app refuses
every send from that frame with `readonly` (§8.2) whatever the bridge was told.

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
- The fork's next revision is past the **source's** next-revision floor at
  the moment of the fork (§13.3) — not R + 1. The source's later revisions are not copied,
  and the agent may still remember them (*From a revision*, below), so their
  numbers are not reused; the gap between R and the next revision is the truth,
  since none of those pages is on the fork's canvas. Reading the floor rather
  than the source's `revision` is what covers a fork of a fork that has not
  drawn yet: its `revision` is still its R, its `numbered_from` past everything
  its own source had drawn. The fork's `state.json` keeps `revision` at R, the page it
  shows, and records the source's floor as `numbered_from`, and R as
  `forked_at` (§13.3) — not a
  `revision` naming a page it does not have, which would read as one lost from
  disk.
- **Where**: in `chat.Client`'s `forkCanvas`, which both `Fork` and
  `ForkAtCanvasRevision` reach through the one fork step they share (`fork`),
  after the truncated history has been written to the fork (`WriteHistory`) —
  R is read from that history, which only that step holds, and `WriteHistory` replaces the fork's whole history, so anything
  appended before it would be lost. The same step (`fork`) is where the
  `fork_agent_context_unavailable` warning is appended, for the same reason.
- A copy that fails — or finds none of 1…R on disk — is not fatal, as for
  attachments: the fork starts with no page (revision 0 shown), and a `warning`
  record (code `fork_canvas_unavailable`) appended to its transcript says so —
  `The canvas could not be copied into this session. Ask the agent to draw it
  again.` Its numbering still goes on from the next revision above: the
  transcript it inherited names revisions 1…R, and a new page under one of
  those numbers would be shown as the page that record drew.

The source is untouched.

**From a revision** — the history view forks from a page (§15.6),
not from a message, and the client cannot name the cut itself: the record that
drew the page may be in a page of history it never loaded, and a seq is quoted
back, never looked up or computed
([session-fork-ui.md § Data contract](session-fork-ui.md#data-contract)). So
`session.fork` takes the revision instead, and the server finds the cut:

```
session.fork { session_id, anchor_seq, title }       -> SessionListItem   (a message, as today)
session.fork { session_id, canvas_revision, title }  -> SessionListItem   (a page)
```

Exactly one of `anchor_seq` and `canvas_revision`; both or neither is
`InvalidParams`.

- **The cut is the `tool_result` record carrying that `canvas_revision`**, kept
  — the moment the page had just been drawn, as an agent message is kept. What
  follows it is dropped: the rest of that turn (its text, its later calls, the
  pages it drew after), and everything after. Everything else is §13.6 above
  and the ordinary fork, unchanged — `TruncateHistory` drops a parallel call
  the cut left without its result, R is the highest `canvas_revision` kept, which
  is this one, and the fork opens on it.
- It is never a user anchor, so there is no dropped prompt and no
  `nothing-before`: a canvas call always has the message that started its turn
  before it.
- **Refused**, checked before anything is created, in this order: both or
  neither of `anchor_seq` and `canvas_revision` (`InvalidParams`); the
  session not found and an agent that cannot fork, as for any fork; then, all
  `InvalidParams`: not a canvas session (`this session is not a canvas
  session`); a revision the canvas does not have — §13.5's wordings, lost from
  disk and not carried into a fork included, since a fork from a page that is
  not there would open on another one (a snapshot that cannot be parsed is, as
  there, an internal error); then `fork_blocked`'s four (§13.5), the same check in one place
  (`server/canvas`) — `pending` and `no_record` as `revision <n> has no
  recorded result in this session's history, so there is no point to fork at`,
  `superseded` as `revision <n> was replaced by revision <m> before its call
  returned; fork from revision <m>`, `subagent` as `revision <n> was drawn by a
  subagent; a fork cannot be cut inside a subagent's run`.
- **What the agent remembers** is the ordinary fork's
  ([session-fork-ui.md § What the agent remembers](session-fork-ui.md#what-the-agent-remembers)):
  each agent resumes at the finest point it has. Claude's tool result carries
  the uuid of its own message, so Claude resumes there — a resume point that
  is a tool result, which no message fork asks `--resume-session-at` for:
  measured on claude 2.1.312 and pinned by
  `TestIntegration_ForkAtToolResult`, the fork remembers the call and its
  result and nothing the turn said after it. Codex names turns, so a cut inside a turn
  carries the whole turn into its memory — the pages it drew after this one
  included — while the transcript and the canvas stop here. Left alone that
  would mislead it twice: the fork's next page would reuse a number it
  remembers as another page, and an update it aims at the later page it
  remembers lands on this one wherever the two share a region. Codex forks the
  thread at the fork's first launch, so a turn still running at the fork may
  even carry pages drawn after it. So, for every fork of a canvas session — by
  message or by page, whichever agent, since the server need not know whose
  memory runs past the cut:
  - **numbering skips what the agent may remember** — the fork's next revision
    is past the source's floor at the fork (above). Pages the source draws
    after the fork, in a turn Codex then carries whole, can still share numbers
    with the fork's own new pages; the line below is what covers them;
  - **the first input delivered in the fork says where the canvas is** — a
    typed message, a canvas action, or an answer to a question the fork
    inherited, whichever reaches the agent first; added in `deliveredText`,
    which every delivery goes through — one more line added at delivery, after the size line
    where there is one (§6.3):
    `[Canvas: this session was forked at revision 7, which is on the canvas
    now; any page you remember drawing after it is not.]` — or, when the copy
    failed (`fork_canvas_unavailable`), `[Canvas: this session was forked, but
    its canvas could not be copied: the canvas is empty; draw it again with
    canvas_render.]`, and with R = 0 nothing at all. It names the revision the
    fork shows — the newest copied one, when R itself was lost (above). It is
    canvas state (`fork_note` in `state.json`, written by the fork once the
    copy has succeeded or failed, cleared once a delivery carrying it has
    succeeded — a delivery that fails leaves it for the next), not
    a record: what the agent is told, not something that happened in the
    conversation. A fork of a fork that still holds one writes its own, about
    its own canvas.

---

## 14. Considered and not done

- **Scaling a page drawn for a larger screen to fit.** Unreadable text and
  unpressable buttons; scrolling keeps both (§5).
- **Questions as cards over the canvas.** Two ways to ask, one inside the page
  and one over it, would compete; the canvas is how a canvas session asks (§3.4).
- **Requiring every page to send** (a lint error, §7.1). Agents answered it by
  adding buttons the page did not need; the input under the canvas already
  lets the user answer any page (§1).
- **An attribute of its own for what a send carries.** A button's
  `name`/`value`, hidden inputs and `pockode.send`'s `data` already carry it
  (§6.1); a fourth way would only be one more to learn.
- **Anti-forgery tokens on sends.** The page is the agent's own output and can
  only ask to send what the agent could have asked for anyway (§1).
- **An "Allow all" in the permission panel.** §10.1.
- **Pushing the canvas on session detail.** §13.2.
- **Ops in the snapshots only, rebuilding old revisions by replay.** One parser
  change would silently rebuild every old revision differently from what was
  shown; a full snapshot is what was shown.
- **Switching an existing session to canvas.** The agent was told one thing at
  the start (§9.1); a property fixed at birth keeps that true.
- **Showing an old revision in the canvas area itself**, with a bar saying so.
  It would put a bar of its own into the column the banner, the strips and the
  input share (§2), take Back from a page that is not a layer, and make the
  page the user works in sometimes not the current one. A sheet over the screen
  has all of Back and the cover for free (§15.2).
- **Thumbnails of every page.** Each would be a whole page with its scripts in
  a frame of its own, scaled down — the scaling §5 refuses, multiplied by the
  list. The list names revisions and times; the page is one press away (§15.3).
- **Swiping between pages.** The drag belongs to the page and its scroll
  (§15.3).
- **A live, sendable current page in history.** Two frames that send would be
  two copies of the one page the user works in, patched apart; the current page
  is shown read-only there and is one press from canvas view (§15.4).
- **Forking at the end of the turn that drew the page** rather than at the
  page. It would make every page but a turn's last open on a later one — the
  opposite of what was pressed — to keep Codex's memory exactly level with the
  transcript. What Codex remembering past the cut would cost is paid instead
  by the numbering and the fork's first message (§13.6).

---

## 15. The history view

Every page the agent drew, one at a time, each as it was: the stored snapshot
(§13.3) in the same page frame as the live canvas, at the size it was drawn
for, scrolled and never scaled (§5). From any of them the user can fork, and
the new session opens on that page. §13.5 and §13.6 are the contract it
reads.

### 15.1 Where it opens

| From | Opens on | Over |
|---|---|---|
| **History** button leading canvas view's input line (§2) | the newest earlier page — the revision before the current one in the list — or the current one when there is no earlier | canvas view |
| **History** in the session panel's **Canvas** section (the panel the header's title opens) | the newest earlier page — the revision before the current one in the list — or the current one when there is no earlier | the view that is up |
| **Show** on a canvas row in chat view (§12) | that row's revision | chat view |

- **The button** leads the collapsed `Message…` line (`CanvasHistoryButton`,
  through `CanvasComposer`'s `leading`), where the ordinary composer has its
  `+`: a tool the app draws, the field, then Stop. It is the `+`'s shape —
  36px, 44px on a coarse pointer — with the row's `History` glyph, named
  `Canvas history`, and no count: a revision is not a number of pages, and the
  view's stepper says `Revision 7 of 12`. It is on and off by
  the row's rule (`isCanvasDrawn` and `NOTHING_DRAWN` in `canvasStore`, shared
  by both): before the subscription has said anything about the canvas and at
  revision 0 it is `aria-disabled` and dimmed, named `Canvas history: Nothing
  drawn yet` — there rather than absent, so the line does not move when the
  state arrives. At revision 1 and up it is on, even with one page: whether an
  earlier one exists is the list's to say (gaps, forks), and with one page the
  view opens on the current page, which still offers Fork. What blocks sending
  never turns it off — reading history sends nothing: while a permission
  request owns the input it stays usable, as Stop does (§10.3), and opened over
  the open panel the view is a layer stacked over it
  ([project-ui.md §5.2](project-ui.md#stacked-layers)), closing back onto the
  panel as it was. Closing the view hands focus back to the button.
- **The row** is the only row of a `Canvas` `PanelSection` in `SessionHeader`'s
  panel, after Work and before Usage — with the facts about what this session
  has done, below the settings that decide its next message. The section is
  there for a canvas session only, and only where the canvas is pushed — not
  for a session read out of another worktree, which has no canvas here (§2,
  §13.5). The row is the Engine row's shape: 48px, a `History` glyph, `History`
  and, as its second line, the current page (`At revision 12`) — not a count
  of pages, which a lost snapshot would make wrong. At revision 0, and before the subscription has said anything about
  the canvas, it is `aria-disabled` and dimmed, its second line `Nothing drawn
  yet` — a row that says why, not one that vanishes. The panel closes as the
  view opens: one layer replacing another
  ([project-ui.md §5.2 Stacked layers](project-ui.md#stacked-layers)), whether
  the panel is a drawer or the expanded tier's dropdown.
  The row stays the entry from chat view that needs no canvas row found
  first, and the one a user reading through the session's facts expects.
- **Why a button as well as the row.** The row alone was the canvas screen's
  only way to an earlier page, and it was not found. Nothing on the screen
  said there was a history; the title the panel opens from reads as the
  session's name, engine and mode — settings — and the row sat below the
  settings sections, at the foot of a phone's drawer, lower still in a work
  session. Back, the gesture for "the page before", leaves the session (§2).
  Users went to chat and hunted for a row's **Show**. The input line is canvas
  view's own bar, drawn by the app outside the page and always there, so the
  button costs the canvas area nothing. Elsewhere it would: in the header it
  would cut a phone's title, already truncated beside the switch and the gear,
  to a few characters; floating over the canvas it would cover what the agent
  drew; in the activity strip it would be a second target in a line that is
  one tap (§11.3), and the strip speaks for the agent, not the canvas.
- **Show** opens the view rather than switching to canvas view. The user was
  reading the transcript; a page they look at and put away should put them
  back in it, and the live canvas is not the place to show an old revision —
  it is the page they work in, and it stays the current one. Show is offered
  on every row whose result names a revision, the current one included, so
  every **Show** does the same thing — in a session whose canvas this client
  can read (§12).
- **Back to the current page** is closing the view — ✕, Back, Escape — which
  lands on the live canvas, or on the transcript Show was pressed in, exactly
  as it was. The view never changes the live canvas: the frame there keeps its
  revision, its typed fields and its scroll under the sheet, as it does under
  any page drawn over the session (§2). From the current page, **Go to
  canvas** (§15.4) closes the view and switches to canvas view in one press.

### 15.2 The view

A `fullScreen` `Sheet` — a reader over the session, like the file and media
viewers. It is a layer, so everything the layer rules say holds without a
word of its own here
([project-ui.md §5.2](project-ui.md#52-back-closes-the-topmost-layer)): Back
closes it, a reload never reopens it, a navigation from inside it is held
until it has gone, and the page under it is covered (`useCoverPage`, which
`Sheet` calls). It is full screen at every width, because the page needs the
area: in a drawer or a centered modal a page drawn for the whole canvas would
scroll in both directions at once.

```
┌──────────────────────────────────────────────┐
│ Canvas history                            ✕  │  Sheet header
│ Revision 7 · updated · 14:02                 │  subtitle
├──────────────────────────────────────────────┤
│ ⊘ Not loaded · cdn.jsdelivr.net      [Load]  │  hosts strip — only when something was refused
├──────────────────────────────────────────────┤
│                                              │
│            the snapshot, at the size         │
│            it was drawn for (§5)             │
│                                              │
├──────────────────────────────────────────────┤
│ Earlier version · read-only                  │  the note line (§15.4)
│ [‹]       Revision 7 of 12 ▾      [›] [Fork] │  footer: the stepper, the list, Fork
└──────────────────────────────────────────────┘
```

- **The subtitle** names the page: `Revision 7`, how it came (`drawn` for a
  render, `updated` for an update — `change_kind`), and when (`drawn_at`, in
  the device's time through `utils/dateTime.ts`: the time alone today, the date
  and time before).
- **The body** is one `CanvasFrame` with `readOnly` (§15.4), filling `Sheet`'s
  body exactly — its height is the body's, so the body itself never scrolls and
  the only scroller is the frame's wrapper, as in canvas view; nested scrollers
  would fight over every drag. The size rule is §5's, applied to this area: in
  each dimension the larger of the area and the snapshot's `drawn_for`, the
  frame's wrapper scrolling to it. This area is never measured and never
  reported (§5): it is not the canvas area of anything, and only canvas view's
  area is.
- **One frame per revision.** The frame is keyed by the revision it shows, so
  each page is a document drawn whole from its snapshot, never a patch (§8.3)
  applied to the page before — whose scripts may have changed its DOM — which
  would not be the page as it was. A second `CanvasFrame` for a session whose
  live frame is mounted is fine: what the two share is the session's host
  allowance, which is meant to be shared.
- **The hosts strip** is the frame's own (`PageHostsStrip`, at the top of the
  body), keyed by the session (§4): a host allowed in the live canvas loads
  here too, and one allowed here is allowed there.
- **The footer** is `Sheet`'s, holding the note (§15.4) above the stepper,
  the list and Fork.
- **The theme** follows the app's, as the live canvas does (§3.3, §8.4) — the
  page is drawn as it would be drawn now, in today's theme; the stored
  document carries no colours of its own to restore.
- **The page's scripts run.** It is the page as drawn, and many pages are
  their scripts. What they could do that matters — send — is refused (§15.4).

### 15.3 Moving between pages

The list is `chat.canvas_history`, read when the view opens and again while it
is up whenever the answer may have changed:

- on every `chat.canvas_state` the session is pushed — a new page joins the
  list, and the page that was current becomes an earlier one;
- on anything that may settle a canvas call, while some listed entry is
  `pending` (§13.5) or a read is in flight, since nothing pushes its clearing:
  any `tool_result` record — a canvas call that failed names no revision and
  settles all the same, and a result does not say whose call it answers — or
  a turn ending (`done`, `interrupted`, `error`, `process_ended`), which ends
  every call still in flight and turns a page whose call never returned into
  `no_record`. The server settles a call before it broadcasts the record, so
  the read made on it already says so; a read in flight may have been answered
  from before, so it is followed by one more;
- when the connection is back after a reconnect, since nothing replays what
  it missed.

One read is in flight at a time, and asks arriving meanwhile make one more
read once it answers, so a burst of updates costs two reads, and an answer is
never overtaken by an older one.

- **‹ and ›** step to the next older and next newer listed revision. They are
  buttons, 44px under a coarse pointer, and disabled at either end. There is
  no swipe: a horizontal drag over the page is the page's, or its wrapper's
  scroll (§5).
- **`Revision 7 of 12 ▾`** — the revision shown, of the current revision —
  opens the list in place of the body (sheets do not nest): one row per
  listed revision, newest first, `Revision 12 · current`, then
  `Revision 11 · updated · 14:02`, the open one marked. A row opens that page;
  the list's first row, `Back to revision 7`, returns to the page it was opened
  from, and the sheet's ✕ still closes the whole view. The list is a layer of
  its own over the page (`useCoverPage`, its `onBack` the return to the page):
  the user opened it, so Back puts it away and leaves the view up. Escape does
  the same: the list listens on its own container, whose open row — or its
  Back row, when the open page is not listed — takes focus when the list
  opens, and on the footer, where Tab can take focus
  meanwhile, and calls `stopPropagation`, so `Sheet`'s `document` listener
  never sees the press — the find bar's arrangement
  ([answering-ui.md § Who owns Escape](answering-ui.md#who-owns-escape)).
  Closing the list hands focus back to the `▾` button. The
  numbers are revisions, not positions: a revision lost from disk is not
  listed (§13.3), and the gap it leaves is the truth.
- **The page stays put.** A new revision arriving does not move the view: the
  user chose this page. If it was the current one, it becomes an earlier one,
  and the note line says so (§15.4).
- **Snapshots are read one at a time**, when a page is opened, and kept for as
  long as the view is up — a snapshot never changes, so a page stepped back to
  is not read again. Nothing is read ahead: a snapshot is up to 256KB, and most
  views look at a handful.

### 15.4 Read-only, and how it is said

Every frame in the view is read-only, the current page's included: the page
the user works in is the live canvas, and only one frame sends. The frame's
bridge is told `sendable: false` (so `data-pk-blocked=""` is on the page's root
for a page that styles itself for it), and the app refuses every send from it
with `readonly` (§8.2, §13.5) — so a page that sends on load does not start a
turn each time it is looked at. Which of `readonly`'s two wordings the page is
answered with is told to the frame by its `readOnly` prop — `"earlier"` or
`"current"` — which changes when a newer page arrives while it is shown.

The note, in the footer above the stepper, says what this page is, in one muted line that is
always there:

| Page | Line |
|---|---|
| an earlier one | `Earlier version · read-only` |
| the current one | `Current page · read-only here` and **Go to canvas**, which closes the view and switches to canvas view |
| it was current when the user came to it, and a newer one has since been drawn | `Earlier version · a newer page was drawn` and **Newest**, which opens the current one |

and, under it, at most one second line:

| When | Second line |
|---|---|
| a fork from this page cannot be made | the reason (§15.6) |
| a send from it was refused, until the page changes | `Sends are off in history.`, followed — where a fork can be made — by `Fork from here to go on from this page.` The press the user made is answered where they made it, not only inside the page, which may show nothing |
| the list could not be read (§15.5) | `The list could not be read: <message>` — or, once it had been read, `The list could not be read again: <message>` — and **Retry** |

The rows are in rank. The fork's reason outranks a refusal: it is the one that
says what the footer can do. A failed list read is last: the page on screen is
unaffected by it.

### 15.5 Loading and failing

Nothing fails silently.

- **The list loading**: the stepper and Fork are disabled. Show's revision is
  read and shown at once, without waiting for the list; the button's and the
  row's wait for it, with a `Spinner` in the body, since which page is the
  newest earlier one is the list's to say.
- **A snapshot loading**: the frame of the page before is taken down and the
  body shows a `Spinner`, so an old page is never shown under a new one's
  subtitle.
- **A read failing**: in the body, the server's message in `text-th-error`
  and **Retry**. Offline is the same message from the connection, retried
  automatically once it is back. For a revision lost from disk — reachable
  only through **Show**, since the list leaves it out — the message is §13.5's
  `revision <n> was lost from disk`, with no Retry (nothing will bring it
  back) and Fork disabled (`This page could not be read.`). So for every
  `InvalidParams` refusal of a snapshot: a revision the canvas does not have
  is not brought back by asking again either.
- **The list failing to be read**: from the button or the row, before any page
  is up, it is the body's failure above. With a page up — Show's, read without
  waiting for the list, or any page once the list has been read and a read
  again fails — the page stays, the view keeps the list it has, if any, and the
  note's second line says so with **Retry** (§15.4).
- **A snapshot that cannot be parsed** (§13.5): its internal error, with Retry.
- **Nothing readable.** When every snapshot is lost, or a fork's canvas could
  not be copied (§13.6's `fork_canvas_unavailable`), the store pushes revision
  0 (§13.3), so the button and the panel's row are the dimmed `Nothing drawn
  yet` and the view does not open from them. A list that comes back empty all
  the same — the disk changed between the push and the read — makes the body
  say `No page of this canvas could be read.`, with nothing to step to or fork
  from.
- **"Of N"** is always the pushed state's revision, the current one — when
  that revision's own snapshot is lost and the canvas fell back to an older one
  (§13.3), the pushed revision is that older one, and so is N.
- **The session closing under it** — deleted, or the user navigated — takes
  the view with it, as any layer on the session screen.

### 15.6 Forking from a page

**Fork** in the footer forks the session at the moment this page had just been
drawn (§13.6, *From a revision*). The new session holds the conversation up to
that call, and opens — on Canvas, as every canvas session does (§2) — on this
page; its own history view lists revisions 1 to this one, which the fork
copied.

- **The fork sheet is the session fork's own** (`ForkSessionSheet`,
  [session-fork-ui.md § The fork sheet](session-fork-ui.md#the-fork-sheet)),
  with a page as its anchor beside a message:
  - **Anchor preview**: `Canvas · revision 7 · updated · 14:02`, one line in
    the preview's place — the page is what the user was just looking at, and a
    second, scaled copy of it in a sheet would be neither readable nor needed.
  - **What is cut**: *"The new session keeps the conversation up to the moment
    this page was drawn, and opens on it. Everything after it stays in this
    session."* No count: the record the cut falls on may be in history this
    client has not loaded, so a count would be a guess.
  - **Title**: the same prefill ([Naming](session-fork-ui.md#naming)).
  - Footer, in-flight, failure and success: unchanged — `Forking…` and not
    dismissible while it runs, the server's refusal above the footer, and on
    success the app navigates to the new session (a held navigation, so the
    layers go first).
- **The sheets replace one another.** The view closes as the fork sheet
  opens (sheets do not nest; the message menu and the fork sheet already do
  this, [project-ui.md §5.2 Stacked layers](project-ui.md#stacked-layers)).
  The fork sheet's **Cancel** button reopens the view on the same page: the
  user backed out of forking, not out of history. A page that was the current
  one still says so when a newer one was drawn meanwhile (§15.4); the
  snapshots read are not kept across the two, which a reopened view reads again. ✕, Back and Escape do not:
  they are the sheet's plain close, which a held navigation calls too
  ([Closing it by its own UI](project-ui.md#closing-it-by-its-own-ui)) — a
  reopening there would raise a layer under the very navigation a fork makes on
  success. So the reopening is behind the button, the closing shared, as §5.2
  asks: `ForkSessionSheet` gains `onCancel` beside `onClose`, the button
  calling it and every other close calling `onClose`.
- **When Fork is not there.** For an agent that cannot fork
  (`fork_support: "none"`) Fork is not drawn, as the session fork draws no `…`
  ([Blocked and failed](session-fork-ui.md#blocked-and-failed)): the view is
  for looking, and fork never applied.
- **When Fork is there but cannot run**, it is `aria-disabled` and the note's
  second line says why (§15.4), tied to the button by `aria-describedby`, so
  the reason is read beside the button and by a screen reader with it:

  | Cause | Note line |
  |---|---|
  | `fork_blocked: "pending"` (§13.5) | `Can't fork from this page until its call returns.` — the list read again on the result (§15.3) clears it |
  | `fork_blocked: "no_record"` | `Can't fork from this page: its call was never recorded in the conversation.` |
  | `fork_blocked: "subagent"` | `Can't fork from this page: a subagent drew it, and a fork can't be cut inside a subagent's run.` |
  | `fork_blocked: "superseded"` | `Can't fork from this page: a later page was drawn before its call returned.` |
  | the snapshot could not be read (§15.5) | `This page could not be read.` |
  | the list or the snapshot still loading, or the page not in the list yet (it is read again on the push that drew it) | nothing: Fork is disabled without a reason, for a moment |
  | the revision list open (§15.3) | nothing: Fork, ‹ and › are disabled until it is put away |

  The server refuses all of them again (§13.6), and a refusal that reaches the
  fork sheet anyway — the list was read before the session changed — is shown
  there, as any fork failure is.
- **A running turn disables nothing.** A page whose call has returned is a
  settled point, and what the agent is still doing falls after the cut, as for
  a message fork
  ([Which messages get a menu](session-fork-ui.md#which-messages-get-a-menu-and-when-fork-is-on-it)).
  A permission request still unanswered at the cut is not carried
  (`TruncateHistory` drops what the cut left unanswered).
- **Nothing comes back as a draft**: the cut is never on a message the user
  sent.

### 15.7 What it leaves alone

It is drawn over the canvas screen, not in it. The column of §2 — the header,
the permission banner and panel (§10), the hosts strip, the canvas area, the
activity strip (§11), the input — loses nothing and gains only the History
button leading the input line, and the view reads nothing of theirs. The only
changes outside the view are that button, a row in the session panel
(`SessionHeader`), **Show** in a canvas row's body,
`readOnly`'s two wordings in `CanvasFrame`, the fork sheet's page anchor and
`onCancel`, and canvas view's area not being measured while the view is up — a
keyboard raised there is the history page's, not the canvas's (§5).
