# AI CLI Login UI

How a user sees whether Claude and Codex are signed in on the server machine,
and signs them in or out, from a phone — no terminal, and no browser on the
server. Where the status lives, the two login flows (Codex's device code,
Claude's pasted code), what every failure says, and the way in from a chat turn
that failed to authenticate.

Related: [agent-chat.md](agent-chat.md) for the transcript the auth failure lands
in, [session-fork-ui.md](session-fork-ui.md#the-dropped-prompt) for the draft
hand-back reused here, [responsive-ui.md](responsive-ui.md) for the width ladder
and hit-area floors, [answering-ui.md](answering-ui.md#who-owns-escape) for the
Escape and dismissing-click conventions `Sheet` already follows,
[cluster.md](cluster.md) for why the cluster frontend has none of this.

## The rules

**One login flow, two ways in.** The flow is one sheet, `CliLoginSheet`, over one
store, `cliLoginStore`. Settings opens it from a CLI's card; the chat opens it
from an auth failure. Two entries into one flow, never two flows that can drift
apart.

**The chat never leaves the session.** From an auth failure the sheet opens over
the conversation. The user signs in, closes the sheet, and is where they were,
with their message waiting in the input. Navigating to Settings from there would
cost the context the user came back for.

**"Sign in", not "Log in".** Pockode's own account already owns "Logout"
(Settings → Account). The CLIs use "Sign in" / "Sign out" everywhere, so a user
reading either word knows which of the two accounts it touches.

**One name per CLI, from one place.** Every label here — card, sheet title,
button, dialog — is `AGENT_TYPE_INFO[type].label` (`web/src/lib/agentType.ts`):
"Claude" and "Codex", the names the engine picker already uses. The copy below
writes them out only for readability.

**Status is state, the failure notice is an event.** An auth failure in the
transcript records that a turn failed at that moment. It never says whether the
CLI is signed in *now*, and nothing reads status back out of it (AGENTS.md,
*Events are events, state is state*). Its words are in the past tense, its button
is an action, and what the user is signed in as is only ever read from live
status.

**Only Cancel cancels.** A login flow outlives the sheet showing it: the user
leaves for a browser, the socket drops, the chat gets covered by another page.
Closing the sheet puts the flow out of sight; the flow keeps running until the
user presses **Cancel**, it finishes, or the server's timeout ends it.

**Secrets live in the flow and nowhere else.** The login URL, the device code
and the pasted code are held in `cliLoginStore` (in memory, never persisted) and
in the server's flow. They never go into a route, `localStorage`, the input
draft store, the transcript, or a log.

**The server is the clock.** Expiry is the server's. The client draws a
countdown from the `expires_at` the server gives it, and never ends a flow on its
own.

## Where status lives: Settings → CLI sign-in

A new built-in settings section, registered in
`web/src/extensions/builtin/index.ts`:

| id | label | priority |
|----|-------|----------|
| `cli-sign-in` | CLI sign-in | 50 — right after Session (40), where the default engine is picked, and before Account (90) |

It holds one card per CLI, in `EngineField`'s order: Claude, then Codex. A CLI
is never hidden, whatever its state: "Codex is not installed" is an answer the
user came here for.

```
CLI SIGN-IN
                                        ↻ Refresh
┌───────────────────────────────────────────────────┐
│ Claude                              2.1.283       │
│ ● Signed in · ada@example.com · Max               │
│                                        Sign out   │
├───────────────────────────────────────────────────┤
│ Codex                               0.153.0       │
│ ○ Not signed in                                   │
│                                     [ Sign in ]   │
└───────────────────────────────────────────────────┘
```

- **Name** in `text-sm text-th-text-primary`, **version** right-aligned in
  `text-xs text-th-text-muted` when known. The version is there for the day a
  CLI update breaks a flow (*Flow broke*): it is the first thing anyone asks.
- **Status line** — a coloured dot or icon, then the phrase and detail in
  `text-sm text-th-text-primary`. Colour is on the dot or icon only: the success
  and warning tokens do not reach text contrast on the light theme.
- **Actions** — right-aligned on their own line, `min-h-11` on every pointer,
  the floor the settings rows already hold. At most one primary action per card.
- **Refresh** — a text button with a `RefreshCw` icon, the first row of the
  section body (a section owns its body; the heading is `SettingsPage`'s).
  Status also refreshes when the section mounts and when the page becomes
  visible again, because a user who signed in from a terminal expects to see it
  without hunting for a button.

The cards are one bordered group (`rounded-lg border border-th-border
bg-th-bg-secondary`, dividers between), the Account row's surface. Desktop gets
the same layout: Settings is already `max-w-2xl`, and a second column for two
cards would only move the button away from the name.

### The card states

| State | Dot / icon | Phrase and detail | Actions |
|-------|------------|-------------------|---------|
| Checking | — | Skeleton the height of the line | Skeleton the size of a button |
| Signed in | `●` `text-th-success` | "Signed in", then ` · ` account and ` · ` plan when the CLI reports them (a plan reported as `unknown` is left out). Nothing when it reports neither — never "unknown account" | **Sign out** — text button, `text-th-error` |
| Not signed in | `○` `text-th-text-muted` | "Not signed in" | **Sign in** — primary |
| Managed outside Pockode | `Info`, `text-th-text-muted` | "Managed outside Pockode", and a second line naming the source (below) | none |
| Not installed | `CircleSlash`, `text-th-text-muted` | "Not installed", and "Install the `<command>` CLI on the machine running Pockode, then refresh." | **Install instructions ↗** — text link to the CLI's install page |
| Sign-in in progress | Spinner | "Signing in…", and "Started earlier." when this page did not start it | **Continue** — primary, opens the sheet on the running flow · **Cancel** — text button |
| Status unavailable | `AlertTriangle`, `text-th-error` | "Couldn't read sign-in status", and the server's error in `text-xs` | **Retry** — primary |

"Started earlier" and not "on another screen": after a reload, the same phone is
a new page, and nothing can tell it apart from a second device. What matters is
that the flow is running and can be picked up.

"Managed outside Pockode" says *why*, because the user's next step depends on
it. The second line names the source and never its value, then says where to
change it:

- "Using `ANTHROPIC_API_KEY` from the server's environment."
- "Using Amazon Bedrock." / "Using Google Vertex AI." (Claude reports its
  provider in `claude auth status`'s `apiProvider`.)
- "Using an API key." / "Using Amazon Bedrock." / "Using a model provider that
  doesn't need an OpenAI sign-in." (Codex's app-server reports the account kind,
  and whether OpenAI auth is required at all.)
- Fallback when the server knows it is external but not which source: "Codex is
  set up with credentials Pockode doesn't manage."
- Then, always: "Change it on the server machine."

"Status unavailable" exists so a failed status call is never drawn as "Not
signed in". Guessing the benign state would send the user into a login that
cannot fix what is wrong (*No silent failures*).

## The sheet

`CliLoginSheet` is built on the shared `Sheet`: a bottom drawer on a phone, a
centered modal from the expanded tier up. It already locks the page, counts as
covering it, claims Escape and the dismissing click, and closes when its surface
is covered — nothing here re-does any of that.

Title: "Sign in to Claude" / "Sign in to Codex".

### Closing and cancelling

The footer has **Cancel**, which ends the flow on the server and closes the
sheet. Everything else that closes a `Sheet` — its close button, Escape, the
backdrop, and being covered (`useCloseWhenCovered`, which ignores `dismissible`
on purpose) — only closes it. The flow keeps running, the CLI's card says
*Sign-in in progress* with **Continue**, and the chat's button resumes it too
(*Starting*).

Cancel needs no confirm: a new flow is one tap and a few seconds away. The
reverse mistake is the one worth designing out — a user who finished in the
browser, came back, and tapped the backdrop would otherwise have cancelled a
login the browser just told them succeeded.

While a pasted code is being verified the sheet is `dismissible={false}`, as
`Sheet` documents for an in-flight operation. If it is covered anyway, the
verification carries on and its result lands in the store; the card and the
next opening of the sheet show it.

**Leaving the app closes nothing.** The page going hidden and the socket
dropping are the normal case here — a backgrounded PWA loses its socket while the
user is in the browser. On reconnect every screen showing the flow subscribes
to the CLI's sign-in again, and the snapshot it gets back is the server's
current copy: the sheet picks up in whatever phase that reports, including
"succeeded while you were away". A newer sign-in started elsewhere is followed;
a server with none at all (it restarted) sends the sheet back to *Starting*. After a reload the store is empty; the card's status
brings the flow back as *Sign-in in progress*.

### Phases

```
starting ──► waiting for user ──► (verifying) ──► signed in
                   │                   │
                   └───────────────────┴──────► failed
```

`role="status"` on the phase line, so a screen reader hears each transition once.
The countdown is **not** in the live region — it would talk every second.

### Starting

Spinner and "Starting sign-in…". Nothing to press but Cancel. If the server
cannot bring up a flow, this goes straight to *failed*.

The sheet reads live status first, and only starts a flow when the CLI is not
signed in and none is running:

- **In progress** — the sheet opens on the running flow. Never *Another flow is
  running*: after a reload the user's own flow looks exactly like that, and
  offering to replace it would throw away the code they have already typed into
  the browser.
- **Signed in** — "Claude is already signed in as ada@example.com" and the
  *Signed in* actions. This is how an old failure notice's button stays honest.
- **Managed outside Pockode** / **Not installed** — the card's wording, and
  **Close** (Not installed adds **Install instructions ↗**, as its failure
  does).
- **Status unavailable** — "Couldn't read sign-in status", the server's error,
  and **Retry** · Close.

While status is being read the sheet says "Checking sign-in status…", not
"Starting sign-in…": the read can take seconds and may end in *Signed in*.

### Codex: device code

```
Sign in to Codex                                    ✕
─────────────────────────────────────────────────────
1  Copy this code

      ┌─────────────────────────┐
      │      ABCD-1234          │   [ Copy ]
      └─────────────────────────┘

2  Enter it on the sign-in page

   [   Open sign-in page  ↗   ]      [ Copy link ]
   auth.openai.com/codex/device

   ◌ Waiting for you to finish in the browser…
     Expires in 9:32
─────────────────────────────────────────────────────
                                          Cancel
```

- **Code first.** The page the link opens asks for the code, so the user needs it
  in hand before leaving. The code is `font-mono text-2xl tracking-widest
  select-all`, centered, in a `bg-th-bg-tertiary` box — big enough to read off a
  phone and to type on a laptop, which is the other way people will do this.
- **Open sign-in page** is the primary button, an `<a target="_blank"
  rel="noopener noreferrer">`. Its click also copies the code, so one tap leaves
  the user in the browser with the code ready to paste. The copy result stays on
  screen until the sheet changes phase — "Code copied" — rather than flashing
  for two seconds while the user is in another app. If the copy fails, the link
  still opens, and the line reads "Copy the code above by hand."
- **Copy** beside the code and **Copy link** beside the button are secondary
  text buttons, `min-h-9 pointer-coarse:min-h-11`. Copy link is for doing the
  browser half on another device.
- The URL is printed under the button, host and path, `text-xs
  text-th-text-muted`, `break-all`. A user about to type a code into a page
  deserves to see which page before tapping.
- **Waiting** — spinner, "Waiting for you to finish in the browser…", and
  "Expires in m:ss" in `text-th-text-muted` from `expires_at`. In its last minute
  a `text-th-warning` clock icon joins it and the text goes to
  `text-th-text-primary`.

The sheet moves to *signed in* by itself when the server sees the CLI finish. The
user does nothing in Pockode after the browser.

### Claude: pasted code

```
Sign in to Claude                                   ✕
─────────────────────────────────────────────────────
1  Sign in with your Claude account

   [   Open sign-in page  ↗   ]      [ Copy link ]
   claude.ai/oauth/authorize…
   Use an Anthropic Console account instead

2  Paste the code shown after you sign in

   ┌─────────────────────────────────┐
   │                                 │   [ Paste ]
   └─────────────────────────────────┘
   Expires in 9:41
─────────────────────────────────────────────────────
                          Cancel      [ Sign in ]
```

- **Open sign-in page** — the same button and link line as Codex, without the
  copy (there is nothing to carry over). The URL is long; the printed line is the
  host and the start of the path, ellipsised. Copy link copies it whole.
- **Use an Anthropic Console account instead** — a text link that restarts the
  flow for API-billed Console accounts (`claude auth login` offers both). The
  default is the subscription, which is what most people signing in from a
  phone have. On a Console flow the line reads "Use a Claude subscription
  instead".
- **The field** is a single-line `<input>` with `autoComplete="off"`,
  `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`,
  `font-mono`. Plain text, not a password field: the user has to see that what
  they pasted is the code and not the URL they copied earlier. It is one-time,
  and it is never persisted.
- **Paste** calls `navigator.clipboard.readText()`, and is rendered only where
  that exists. Several browsers answer it with a paste prompt of their own, which
  the user can refuse; a refusal or error puts "Paste into the field instead."
  under the field, and the button stays. Long-pressing the field works
  everywhere.
- The value is trimmed before it is sent — codes are pasted with a trailing
  newline more often than not.
- **Sign in** is the sheet's submit (`Sheet` `onSubmit`, so Enter works), and is
  disabled while the trimmed field is empty. While verifying: the button shows a
  spinner and "Verifying…", the field is read-only, and the sheet is not
  dismissible.

### Copying

Copy appears three times here and once more in *Send again*, and the app already
has a copy in `shikiUtils` (the code block's copy button). One hook,
`useCopyToClipboard`, serves all of them, with the code block moved onto it:
it returns `copy(text)` and a state of idle / copied / failed.

Failed is a real state, not a rare one: outside a secure context — Pockode on a
LAN address over plain http — the browser has no clipboard API at all. On
failure the value is shown in full and selected so it can be copied by hand,
the same answer [cluster.md](cluster.md) gives for the node password. The device
code is always in full already; the link expands from its short form.

### Signed in

`CheckCircle2` in `text-th-success`, "Signed in to Codex", and the account under
it when there is one. The sheet does **not** close itself: this is the only
confirmation the user gets, and from the chat the next action is on this screen.

- From Settings: **Done**.
- From the chat: **Send again** (primary) and **Done**. See *From the chat*.

The card refreshes on success regardless of where the sheet was opened.

### Failed

Every failure is one layout: `AlertTriangle` icon, a **title** that says what
happened, a **body** that says what to do, the actions, and — where there is
one — a collapsed **Details** (`CollapsibleBody`) with the server's `detail`: the
CLI's own last words. The details are for the user who is going to file an issue; the
title and body have to be enough without opening them. Details never contain the
URL, the device code or the pasted code — the server strips them before the
message reaches the client, and the sheet does not re-add them.

| Failure | Title | Body | Actions |
|---------|-------|------|---------|
| Incomplete code (Claude, `code_malformed`) | *inline, see below* | "That code wasn't accepted. Check you pasted all of it, or open the sign-in page again for a new one." | stays in the flow |
| Refused code (Claude, `code_rejected`) | "That code wasn't accepted" | "Check you pasted all of it, or start again for a new sign-in page." | **Start again** · Close |
| Expired — the CLI's code lifetime, or Pockode's timeout | "This sign-in expired" | "Sign-in codes only work for a few minutes. Start again to get a new one." | **Start again** · Close |
| Codex device code failed (`device_auth_failed`) | "Codex couldn't finish the sign-in" | Codex's own message, then "If this is a ChatGPT account, check that device code authorization is turned on in its security settings, then start again." Codex does not report the setting being off distinctly, and there is no stable URL for a button | **Start again** · Close |
| Not installed | "Codex isn't installed" | "Install the `codex` CLI on the machine running Pockode, then try again." | **Install instructions ↗** · Close |
| Flow broke | "Pockode couldn't run the sign-in for Claude 2.3.0" | "Its sign-in steps didn't look the way Pockode expects. This usually follows a CLI update. Update Pockode, or sign in once from a terminal on the server with `claude auth login`." | Close · Details open by default |
| Managed outside Pockode (`external`) | "Claude is managed outside Pockode" | The card's *Managed outside Pockode* sentence for the source the server names | Close |
| Anything else | "Sign-in failed" | The server's message, verbatim | **Try again** · Close |
| Cancelled elsewhere | "This sign-in was cancelled" | "It was cancelled before it finished, here or on another screen." | **Start again** · Close |

**An incomplete code stays inline**, because the CLI waits for another: the
error goes under the field in `text-xs text-th-error role="alert"`, the field
keeps its value with all of it selected so a new paste replaces it, and the user
is one paste away from trying again. A code the server refuses ends the CLI, so
it is a failure screen, and its words point at **Start again** rather than at
the sign-in page — that page's code belonged to the sign-in that just ended.

**Flow broke** exists because the pasted-code flow is not a supported interface
for programs, and an update can break it
([what it depends on](code/cli-auth.md#what-the-flows-depend-on)). When it does, the user has to see that
the flow is broken — not a spinner that never ends, and not "wrong code".
Naming the version is what makes this readable weeks later, and the terminal
command is the honest way out. It is also why the server must fail the flow
with this reason when the CLI's output stops matching, rather than let it run
out the 15-minute deadline and call it *expired*.

**The timeout** is Pockode's, and it is the same screen as the CLI's own expiry:
to the user both mean "too slow, start again". `expires_at` is the earlier of
the two, so the countdown and the ending never disagree. The server uses 15
minutes ([cli-auth.md](code/cli-auth.md#the-deadline)).
Codex's device-code start reports no lifetime in its response, so there the timeout is the
whole of it.

## Sign out

**Sign out** on a signed-in card opens a `ConfirmDialog`, `variant="danger"`:

> **Sign out of Codex?**
> Every session using Codex on this server stops working until you sign in
> again. This includes other projects and cluster nodes on this machine.
>
> Cancel · **Sign out**

It asks, where the login sheet's Cancel does not, because this one is not cheap
to undo — getting back in is a full login in a browser — and because it reaches
further than the screen it was pressed on: the credentials are machine-wide.

While the request runs the card's action shows a spinner and is disabled. On
success the card becomes *Not signed in*. On failure the card keeps its signed-in
state and shows the error under the status line in `text-xs text-th-error`, the
pattern `SessionSection` uses for a refused write.

There is no sign-out from the chat.

## From the chat

### Where the failure lands

The turn's error record carries `auth_failure: {agent}` — *that it is an auth
failure* and *which CLI* — and so do the warnings that said so while the turn was
still retrying. The adapters decide it from each CLI's structured signal
([code/agent-integration.md](code/agent-integration.md#auth-failures)); the UI
never pattern-matches CLI text.

- **Claude** ends such a turn with a synthetic message, which the parser turns
  into a warning (code `authentication_failed`), and then a failed result, which
  becomes the turn's error. Both are marked, and the notice hides the warning, so
  the text is shown once.
- **Codex** fails the turn with an error whose own info is plain `other`; the
  401s on the retries before it are what mark it.

### The notice

For an error record marked as an auth failure, the transcript draws
`AuthFailureNotice` **in place of the red error line**:

```
┌ ⚠ Invalid API key · Fix external API key ─────────┐
│   Claude couldn't authenticate when this turn ran. │
│                            [ Sign in to Claude ]   │
└────────────────────────────────────────────────────┘
```

- The `bg-th-warning/10` surface of `WarningItem`, with the error's own text as
  the first line.
- The second line is Pockode's, `text-th-text-secondary`, in the past tense: it
  is a record of this turn, and stays true after the user signs in. It says
  "couldn't authenticate" and not "wasn't signed in": a bad key in the server's
  environment and a revoked token fail the same way, and the sheet tells them
  apart from live status. The CLI's own
  text is not always right about the fix ("Fix external API key" for an OAuth
  login that simply expired), which is why this line is there at all.
- The button: secondary, `min-h-9 pointer-coarse:min-h-11`, right-aligned under
  the text. Its label names the CLI recorded on the error, not the session's
  current engine, which may have changed since.
- In a turn whose error is an auth failure, its auth-marked warnings are not
  drawn — Claude's own notice, the retries. The notice already says it, and one
  failure said twice reads as two.
- The button is on every notice, old ones included — it is an action, and the
  sheet reads live status when it opens (*Starting*). The one exception is live
  status saying the CLI is **managed outside Pockode** (an API key in the
  server's environment, a cloud provider): there is nothing to sign in to, so the
  notice says where the credentials come from instead
  (`ExternalSource`, the card's sentence). The button waits for status to
  answer, so it never appears only to vanish. Status is read once per CLI for
  all the notices on screen, not once per notice — a Codex read starts an
  app-server — and a read that failed is tried again by the next notice.
- **Records from before this change** carry no auth mark and keep today's
  rendering, with no button. Guessing from the warning code would work for Claude
  only, and from the text for nobody; the next failure brings the notice anyway.

**Where the sheet lives.** Opened from a bubble, held by `ChatPanel`, inside the
transcript's `CoveredSurface` — exactly where `ForkSessionSheet` is and for the
same reason: the request belongs to the session, not to one bubble, and an
overlay taking the chat must put it away.

**How soon.** Claude retries a refused key ten times before giving up — about
three minutes, measured on 2.1.259 — and Codex retries for about twenty seconds.
The turn is not cut short (a retry after a token refresh can still succeed), but
the notice does not wait for it: while the turn is still running, the notice sits
on its latest auth-marked retry warning, and moves to the error line when the
turn ends. A turn that recovers draws those warnings as the plain warnings they
were.

### After signing in: Send again

**Send again** is on the notice of the session's **latest** turn only, and only
when that turn's message was typed by a person — its origin absent or `user`,
not `system` (Pockode's kickoff or nudge) and not `agent` (another agent's
reply). A typed message is stored with no origin today, so "is `user`" alone
would never match. On an older
notice it would re-draft a message the conversation has since moved past; on a
turn Pockode started — a work session's kickoff or auto-continue nudge — it would
draft words the user never wrote. In both cases the sheet offers **Done** alone.
An answer to posted questions is left out too: its text is the answers flattened
for the agent, not what the user entered. Latest is read against the transcript
as it is while the sheet is up, not as it was when it opened. The turn is named
by the place in history of the message that opened it as well as by its bubble's
id, because a reconnect — routine while the user is off in a browser signing
in — replays the transcript into bubbles with new ids; the bubble's own place
will not do, since it moves on to the error when a turn still retrying at the
press goes on to fail. The rule lives in `utils/sendAgain.ts`.

It is offered once the CLI is signed in — the flow succeeding, or the sheet
finding it signed in already (from a terminal, or from Settings since the turn
failed) — and once the turn has failed. Signed in from a retry's notice, the
sheet offers **Done** until the turn gives up, and **Send again** from then on:
a turn still retrying may yet succeed, and its message sent again would run
twice.

A work session does not repeat the failure: a turn that ends on an auth failure
stops the work instead of nudging it, with a comment saying why and where to
sign in ([code/work-system.md](code/work-system.md)). The user signs in and
restarts the work; its kickoff is Pockode's, so its notice offers **Done**
alone.

It puts the failed turn's user message back as a **draft in the session's input
box**, the way a fork's dropped prompt comes back
([session-fork-ui.md](session-fork-ui.md#the-dropped-prompt)): written to
`lib/inputStore`, not sent, not a record, and a command comes back as typed. Then
the sheet closes.

Focus differs from the fork's, because nothing navigates: `InputBar` only
focuses on a session change, and `Sheet` hands focus back to its opener — the
notice's button — as it closes. So the input bar needs to be asked. Its props
contract (`web/src/lib/registries/chatUIRegistry.ts`) gets one addition,
`focusRequest`: a counter `ChatPanel` bumps in the same commit that closes the
sheet. That order is what makes it work — React runs the sheet's cleanup, which
hands focus back to the notice's button, before the bar's effect. `InputBar`
answers with the pointer check it already makes on a session change: focus on a
fine pointer, nothing on a coarse one, where a keyboard would cover the
conversation. The rule stays in the one place that holds it.

It does not send by itself: a Codex login that expired mid-turn may have run
tools before failing, and the user should see what is about to be re-sent. (A
typed message carries text only today, so there are no attachments to lose; a
message that gains them will need a line under the button saying they are not
restored.)

If the input box already has text, **Send again** does not overwrite it. The
button reads **Copy message** instead and copies the text (`useCopyToClipboard`,
with its failed state showing the text in full), and the sheet's body says "Your
draft was kept." under the signed-in account. Losing an unsent draft to a login is the one outcome worse than
retyping.

The session itself is untouched throughout: nothing is deleted, the transcript
keeps the failed turn and its notice, and sending the draft continues the same
conversation. That the next turn runs with the new credentials is the backend's
to guarantee.

## Cluster

`web-cluster` gets no login UI. The nodes on one machine share the CLIs'
credentials, so signing in once from any node's Pockode covers all of them
([cluster.md](cluster.md)). That sharing is why the sign-out dialog mentions
cluster nodes.

## Components

| Piece | Where | What |
|-------|-------|------|
| `cliLoginStore` | `web/src/lib/` | Zustand, not persisted. Status per CLI and the latest flow per CLI; the flow comes back through each screen's subscription on reconnect, the status through a fresh read. A new global store is an *Ask First* item in `web/AGENTS.md`; it is needed because the flow outlives every component that shows it |
| `CliSignInSection` | `web/src/components/Settings/sections/` | The settings section: refresh, one `CliStatusCard` per CLI, the sheet |
| `CliStatusCard` | same | One card; renders the state table, and owns its sign-out confirm |
| `CliLoginSheet` | `web/src/components/CliLogin/` | The sheet, both flows, every phase. Takes the agent type; the chat's way in adds an optional `sendAgain` offer (the text, whether a draft is in the way, the hand-back) |
| `AuthFailureNotice` | `web/src/components/Chat/` | The transcript notice; asks `ChatPanel` to open the sheet, and reads live status to leave the button off an externally managed CLI |
| `useCopyToClipboard` | `web/src/hooks/` | Copy with idle / copied / failed; the code block moves onto it |

None of it is in `@pockode/shared`: `web-cluster` does not use it.

## What the UI needs to read

Not a wire format — the backend owns that — but what the screens above cannot be
drawn without:

- **Status per CLI**: signed in / not signed in / external / not installed / in
  progress / unavailable, plus account and plan (optional), external source
  (optional), CLI version (optional), and the running flow's id (when in
  progress).
- **A flow**, by id, readable again after a reconnect: its phase; for Codex the
  device URL, code and `expires_at`; for Claude the URL, `expires_at` and which
  account kind; on failure a reason from the failure table and a sanitized
  detail; on success the account.
- **Commands**: start (per CLI; Claude with an account kind), submit code
  (Claude), cancel, sign out. **Start on a CLI that already has a running flow
  returns that flow** instead of starting a second: two screens that both read
  "not signed in" and both press start then land in the same flow, and there is
  no "another flow is running" screen to design.
- **On a turn's error record**: that it is an auth failure, and which CLI.

## What to test

- Each card state renders its row of the state table, and *Status unavailable*
  is never drawn as *Not signed in*.
- Only **Cancel** cancels: close button, Escape, backdrop and being covered close
  the sheet and leave the flow running; the card then shows *Sign-in in
  progress*.
- The page going hidden and a socket reconnect keep the flow; the sheet resumes
  from the server's phase, including a success that happened while away.
- Opening the sheet on a running flow resumes it rather than starting another.
- An incomplete code keeps the field's value and selects it. A refused code is a
  failure screen with *Start again*.
- Each failure reason renders its title, body and actions.
- A failed copy shows the value in full.
- An auth-marked error draws the notice instead of the red line and hides the
  turn's auth-marked warnings; an unmarked one renders as today. A running
  turn draws it on its latest auth-marked retry. No button for an externally
  managed CLI.
- **Send again** appears on the latest turn only and only for a user-typed message, writes the draft when the
  input is empty, and does not touch a non-empty input.
- No URL, device code or pasted code reaches `localStorage` or the route.

## What the CLIs settled

The design was drawn before the real CLIs were run end to end, and a few
branches waited on them. All of them are now settled, and the answers are
written into the sections above: the failure table, *The timeout*, and the
*Managed outside Pockode* sentences. Why each answer is what it is lives in
[cli-auth.md](code/cli-auth.md#signing-in). One choice appears nowhere else:
Claude's `--sso` is left out until someone needs it.

The Claude flow still does not rest on a supported interface. Which of its
behaviours a CLI update could change, and what each change looks like on
screen, is in [cli-auth.md](code/cli-auth.md#what-the-flows-depend-on).

## Considered and not done

- **A login page instead of a sheet.** The chat entry would have to navigate
  away from the session and back; a sheet keeps the conversation under it.
- **Closing cancels.** A stray backdrop tap after the browser had already said
  "success" would have thrown away a login the user had just approved.
- **Auto-sending after login.** See *Send again*.
- **Auto-closing on success.** The success phase is the only confirmation, and
  from the chat it carries the next action.
- **Signed-in status on `EngineField`** (a dot beside each agent). Useful, but it
  puts live status into a picker that is also drawn per session and per role;
  the auth failure already brings the user to the fix at the moment it matters.
  Worth revisiting once status is cheap to read.
- **A QR code for the link.** It helps only when the browser half happens on a
  second device, which Copy link already covers, and it is one more rendering of
  a secret.
- **Entering an API key.** Out of scope: storing keys is its own problem.
