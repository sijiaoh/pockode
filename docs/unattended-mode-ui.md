# Unattended Mode UI

How the web app presents `unattended`. What the mode is and what the server
provides is [unattended-mode.md](unattended-mode.md) — read "The contract at a
glance" first. Record shapes are in
[agent-event.md](agent-event.md#permission-requests-and-their-answers).

**The one idea every surface carries: Unattended is more permissive than YOLO.**
It is YOLO plus a permission reviewer session answering, in the user's place,
what YOLO still stops for. Nothing here may read as a safety feature — no
shield, no "safe", no calm colour on the mode itself. What *is* calm is a
request under review: it is not waiting for the user, and must not call them.

**web-cluster is not affected.** It manages nodes (start, restart, update,
cloud link) and draws no session, mode, permission card or session setting;
each node serves this web app for those.

## 1. One glyph for the reviewer

`Bot` (lucide) stands for "the permission reviewer" everywhere it appears: the
mode, the pending card, a verdict line, the reviewer page's bar, a reviewer row
in the list. One glyph so a user who learned it once reads it everywhere. It is
`aria-hidden`; the words beside it carry the meaning, as YOLO's `Zap` does
([agent-chat.md](agent-chat.md#the-session-screen)).

Colour: `text-th-warning` where it names the **mode** (as `Zap` does — the
mode is the permissive choice); `text-th-text-muted` everywhere else (the
reviewer at work is not an alarm).

## 2. The mode

### 2.1 Mode info

`lib/sessionMode.ts` has a third entry, in this order:

| Mode | Glyph | Label | Description (ChoiceRow, broken by hand) |
|---|---|---|---|
| `default` | `Shield` | Default | Follows the agent's own\npermission settings |
| `yolo` | `Zap` warning | YOLO | Skips all permissions |
| `unattended` | `Bot` warning | Unattended | YOLO, and a reviewer agent\nanswers what YOLO still asks |

Offered for Claude and Codex alike: each mode means the same on every agent.
Codex under YOLO never raises a permission request, so Pockode has no reviewer
for it (`lib/agentType.ts`'s `hasPermissionReviewer`, the twin of the server's
`session.AgentType.HasPermissionReviewer`) and a Codex session in Unattended
never reaches a review
([unattended-mode.md](unattended-mode.md#unattended-mode)). The UI says that in
the confirmation and the Settings hint, in those terms — never as "Unattended is
just YOLO on Codex", which would be a different definition of the mode.

The header's second line follows the existing rule unchanged: one muted line,
the glyph the only colour — `Opus · ⟨Bot⟩ Unattended`.

### 2.2 Choosing it: the confirmation

YOLO has no confirmation; its description is said at the moment of choice and
that is all. Unattended gets **more than that**, because its
description cannot carry the one surprising fact — that it is *more*
permissive than YOLO, and that tokens are spent on someone else's judgement.

Choosing `Unattended` — in the session panel's Permissions rows, or in
Settings' default Mode — opens a `ConfirmDialog` (`variant="default"`, not
`danger`: it is a deliberate choice, not a destruction). Nothing is sent until
it is confirmed; Cancel leaves the selection where it was. Choosing Default or
YOLO stays instant, and so does pressing the mode already chosen. A custom
`ModeSelector` goes through the same confirmation: both surfaces call
`hooks/useModeConfirmation.tsx`. There is no "don't ask again": the dialog is the
only place the fact is stated in full, and the choice is rare.

```
┌───────────────────────────────────────────┐
│ Turn on Unattended?                       │
│                                           │
│ Unattended is YOLO and more. The agent    │
│ runs every command without asking, and    │
│ the few requests YOLO still stops for —   │
│ like an rm whose target can't be checked, │
│ or a protected path — are answered by a   │
│ permission reviewer agent instead of you. │
│                                           │
│ Each answer and its reason is shown on    │
│ the request. You can still answer one     │
│ yourself first. Reviews use tokens; they  │
│ run on Haiku · Low (Settings › Session).  │
│                                           │
│               [Cancel] [Turn on Unattended]│
└───────────────────────────────────────────┘
```

- The settings dialog's title is `Make Unattended the default?` and its
  confirm `Make default`; the body is the same text, with "the agent" reading
  "new sessions' agents".
- The engine line names `permission_reviewer.claude`, through the same label
  code the Engine row uses; an empty value reads `Auto`. While settings have
  not loaded, the line is left out rather than guessed.
- For an agent without a reviewer (the session's agent; for the settings
  dialog, the default agent) the first paragraph keeps the same definition —
  "any permission request still raised under YOLO is answered by a permission
  reviewer agent instead of you" — and the second says why none will be:
  `Codex never raises one under YOLO, so this session never reaches a review.`
  (settings dialog: `new Codex sessions never reach a review`). It names no
  engine and says nothing about tokens, since none are spent. The agent is
  named through `getAgentLabel`, so an agent id this build does not know reads
  as itself rather than breaking the dialog.
- `ConfirmDialog` takes a plain `message`; the body is two paragraphs, so it is
  passed as a string with `\n\n`, and the shared dialog draws its message with
  `whitespace-pre-line`.

### 2.3 Settings: default Mode

The `ToggleGroup` has three segments: `Default | YOLO | Unattended`, the hint
under it the selected mode's description. Three labels with glyphs do not fit
one line at 320px, and dropping the glyphs is not enough either — three equal
segments leave `Unattended` too little room, and it breaks mid-word. So below
`sm` every segment drops its glyph (all three, so they stay alike) and none
gets narrower than its label: `ToggleGroup`'s `compactBelowSm`, measured in
Chromium and WebKit by `ToggleGroup.browser.test.tsx`.

### 2.4 A mode this build does not know

A newer server may send a mode this client has never heard of. It must not
crash, and must not wear `Default`'s name (the header's rule: a session with
its gates down never reads as one that keeps them).

- `getSessionModeInfo` returns, for an unknown id, `{ label: <the id as
  sent>, icon: CircleHelp (muted), description: "A mode this version of
  Pockode doesn't know" }` instead of falling back to Default.
  The wire type is widened at the boundary (`ReportedSessionMode = SessionMode
  | (string & {})`, on a session's `mode`, `default_mode` and the chat hook)
  and narrowed with `isKnownSessionMode`; `SESSION_MODES` stays the known
  three, so nothing offers an unknown mode.
- Header second line: `Opus · ⟨?⟩ turbo`.
- Session panel: the three known rows, **none selected**, and under them
  `Current mode: “turbo”, which this version doesn't know. Choose one to
  replace it.` Choosing one replaces it (Unattended still confirms).
- Settings: no segment selected; hint `Current default: “turbo”, which this
  version doesn't know.`

## 3. The permission card

The card (`PermissionRequestItem`) has one thing a person's card does not: a
**verdict line** — who answered, or who is answering — under the card's row
(`RowSubline`), outside the collapsible body, so it shows collapsed. A
person's answer has none (the person knows), so every card from before this
feature looks exactly as it does now.

### 3.1 Under review

A pending request whose blocker is `reviewing` (§6). `ChatPanel` hands the
cards the set of request ids under review through `permissionReviewContext`, a
context rather than props because the cards sit under memoized rows and
subagent renderers; it is keyed on the ids, so an unrelated turn update does
not redraw the transcript.

```
 ⟳ Bash  rm -rf "$OUT"/*                       ›
 ⟨Bot⟩ Permission reviewer is checking this. You can answer first.
 ─────────────────────────────────────────────────
 [Deny] [Always Allow] [Allow]
```

- **Not the warning card.** No warning tint, no warning outline: it is not
  waiting for the user. It keeps the pending card's shape (framed) with a
  neutral frame (`outline-th-border`) so it still reads as live.
- Glyph: the running glyph, muted (`RunningGlyph muted`), in place of
  `CircleHelp`.
- On a screen that cannot answer (a card drawn without a respond handler, such
  as a session read out of another worktree) the line stops at `Permission
  reviewer is checking this.`
- **Collapsed by default** (a plain pending card opens itself; this one has
  nobody to ask). A card drawn before the session's turn arrived — the
  transcript and the detail load separately — folds once the turn says it is
  under review.
- **All three buttons are secondary.** Allow keeps its place on the right but
  loses the accent: accent says "the one thing to do here", and the one thing
  to do here is nothing. Answering is still one press — first answer wins
  ([unattended-mode.md](unattended-mode.md#how-a-request-is-reviewed)).
- No link to the reviewer yet: the pending request does not name it (the
  `review.session_id` arrives with the answer).
- A person's press that loses to the reviewer gets the existing "no longer
  waiting" error inline, and the card shows the reviewer's verdict: a recorded
  answer naming `by` overrides this client's optimistic press, and a person's
  later answer never replaces it.

### 3.2 Answered

The status glyph is a person's card's: `Check` for an allow, `X` for a deny,
muted whoever answered, like a settled tool row
([tool-call-ui.md](tool-call-ui.md#the-permission-card-takes-the-rows-place)).
Shape tells the two apart, and colour is not used. Once the card hands its
place back to the call's row, the verdict line goes with the answer: it sits
under that row, where it sat under the card; folded, the reason is cut to two
lines as it was there, and open, it is whole at the top of the row's body
(`PermissionAnswerNote`).

The line adds who and why:

| `by` | Line |
|---|---|
| absent (a person) | none |
| `permission_reviewer`, allow | `⟨Bot⟩ Allowed by the permission reviewer · View review` |
| `permission_reviewer`, deny | `⟨Bot⟩ Denied by the permission reviewer — <category>` then `<reason>` · `View review` |
| `pockode` | `Denied by Pockode — <automatic>` then `<reason>` · `View review` (when `session_id`) |

**Category labels** (`review.category`; an unknown id is shown as sent):

| Id | Label |
|---|---|
| `system_damage` | Could damage the system |
| `prompt_injection` | Possible prompt injection |
| `system_reach_unverifiable` | Can't verify what it reaches |

**Automatic labels** (`review.automatic`; unknown → `Denied automatically`):

| Id | Label |
|---|---|
| `timeout` | No verdict in time |
| `no_verdict` | Reviewer gave no verdict |
| `reviewer_failed` | Reviewer failed |
| `reviewer_request` | Reviewers can't ask for permission |

- **The reason** is `review.reason`, plain text — never markdown, never
  linkified: it is model output that a prompt injection may have written.
  Collapsed it is `line-clamp-2`; the expanded body has it whole, above the
  tool input.
- **`View review`** is an in-app link (accent text, no `ExternalLink` glyph —
  it does not leave the app) to the reviewer session, `review.session_id`.
  - It goes to the worktree the card's session belongs to: the ordinary route
    for a live session, and for a main session read out of another worktree
    (`from`) the same `from` — a reviewer lives in its main session's worktree.
  - It is left out when `session_id` is absent (the review failed before a
    reviewer existed) or is the session on screen (a `reviewer_request` deny
    sits in the reviewer's own transcript and names that reviewer).
  - Whether the reviewer still exists is not read from the record: a deleted
    one lands on the existing session-not-found screen. (A reviewer is deleted
    with its main session, so only a reviewer deleted on its own leaves such a
    link.)
- An unknown `by` draws no line; the status glyph still says the outcome.
  Labels for both tables live in `lib/permissionReview.ts`.
- **The reducer keeps who answered.** `permission_response`'s `by` and
  `review` are kept on the card beside its status — history, from the record —
  and carried onto the run the card hands back to (`ToolRun.permission`); both
  draw the line from them, through the one `VerdictLine` in
  `Chat/PermissionAnswer.tsx`; a `by: "pockode"` deny is still
  status `denied`, and its glyph is every deny's.
- A deny never interrupts the turn, so the agent's next row usually rewrites
  the call; the card says nothing about that.

### 3.3 The attention strip

While **every** permission blocker is under review (several at once is
normal — `[+N]` counts them):

- The strip's permission row keeps Deny / Allow (first answer wins) but swaps
  `Lock` for the muted `Bot` and leads with `Reviewing` —
  `⟨Bot⟩ Reviewing · Bash rm -rf "$OUT"/* [+N]` — no warning colour. Allow
  loses its accent, for the card's reason (§3.1).
- Its fallback row, drawn when the card is not in the loaded transcript, swaps
  `Lock` the same way and reads `The permission reviewer is answering a
  request. Answer it yourself or Stop before sending.` instead of `Waiting for
  your permission. Answer above or Stop before sending.`
- If any blocker is not under review (one Pockode could not route, §6), the
  row is the ordinary one: something does need the user.

## 4. The session list

- `Filter sessions` gets a second checkbox under `Show task sessions`:
  `Show reviewer sessions`. Off by default, persisted the same way, sent as
  `exclude_permission_reviewer_sessions` to both `session.list.subscribe` and
  `session_view.list`. Both toggles travel as one `SessionListExclusions`
  (`web/src/lib/sessionFilter.ts`), which the live-notification narrowing
  reads too (`isExcludedSession`).
- The filter button's dot/rename rule is unchanged: these two checkboxes are
  preferences, not "somebody else's list".
- **A reviewer row says whose it is.** Every reviewer is titled `Permission
  reviewer`, so the title cannot tell two apart: the subtitle reads
  `⟨Bot⟩ for <main session title> · 14:22`, the main title truncating and the
  time holding its width (the cross-worktree row's subtitle rule). The main
  title is read live from the list when the main session's row is loaded; it
  often is not — an unattended work session is hidden with `Show task
  sessions` off, or sits on a page not yet fetched — and then the row reads
  `for another session`. The list does not fetch details to fill rows.
- Opening a reviewer from a verdict link while the filter hides them does not
  flip the checkbox: it is a preference, and one visit is not a change of it.
  The open reviewer simply has no highlighted row.

## 5. The reviewer session page

The same `ChatPanel`, read-only — the cross-worktree read-only screen's
structure ([cross-worktree-session-ui.md](cross-worktree-session-ui.md#the-read-only-screen)),
with its own copy. Decided by `permission_reviewer_of` on the session's detail:
once the detail has landed the composer is not drawn, so the server's
`permission_reviewer` refusal is not met; before that, see below.

**It is not the cross-worktree machinery.** That screen is read-only because it
reads a transcript out of another worktree through `session_view` (`from` in
the URL, `ChatPanel`'s `view`). A reviewer is a live session of *this*
worktree: it is subscribed as usual, so its transcript streams while a review
runs, and it is marked read like any session. Only input is withheld.
So `ChatPanel` gets two conditions, not a wider `isReadOnly`:

| Gate | Foreign transcript (`view`) | No input (reviewer) |
|---|---|---|
| Composer → `ReadOnlyBar` | yes | yes |
| Engine / Permissions in the panel | removed | replaced (below) |
| Permission and question answer handlers, answer panel, `AttentionStrip` | withheld | withheld |
| Escape interrupts the turn | no turn to end | **off** (see No Stop) |
| Fork | withheld | **kept** |
| Mark as read, live subscription | no | **yes** |

A reviewer read out of another worktree meets both; the foreign-transcript
copy wins (`Open there` first — the reviewer bar's way back would lead into a
worktree the user is not in), and the top bar is `ReviewerOriginBar` under
`SessionOriginBar`.

`ReadOnlyBar` takes its glyph, its sentence and an optional action (label,
accessible name, handler) from the caller; each caller supplies its own copy.

**Before the detail lands** the kind of session is unknown, and the composer
may already be on screen. That is accepted rather than delayed for every
session: a send that reaches the server then comes back `InvalidParams` with
`data.reason: "permission_reviewer"`, and the screen switches to the read-only
presentation (the draft stays in the input store) instead of showing the
refusal as an error. The echo of the refused message is taken back
(`isPermissionReviewerRejection`), and `Open main session` is left out until
`permission_reviewer_of` is known.

```
[☰] [ Permission reviewer ˅      ] [⚙]
    [ Haiku · ⟨Bot⟩ Permission reviewer ]
 ⟨Bot⟩ Permission reviewer of “Fix login redirect”        ← top bar, fixed
┌────────────────────────────────────────────┐
│  Pockode · Permission review  Bash rm -rf … │
│  ⟨verdict⟩ Deny · Can't verify what it…      │
│  …                                          │
└────────────────────────────────────────────┘
 Read-only — Pockode writes here, not you. [Open main session]  ← bottom bar
```

- **Top: `ReviewerOriginBar`**, beside `SessionOriginBar` and drawn the same
  way: `⟨Bot⟩ Permission reviewer of “<main title>”`, not scrolling. It names;
  it carries no control. The main title comes from the main session's detail
  (`permission_reviewer_of` names it; the page reads it as it reads any
  session's: `hooks/useSessionTitleOf.ts`, a live `session.detail.subscribe`
  in this worktree, which marks nothing read, and `session_view.get` in
  another), not from the list, which often lacks it (§4). Until it lands —
  or if the read fails — the bar reads `Permission reviewer of another
  session`.
- **Bottom: `ReadOnlyBar`** with `Read-only — Pockode writes here, not you.`
  and the secondary `Open main session` (accessible name
  `Open the session this reviewer answers for, <title>`). The way back sits
  where an answer would have been typed, as `Open there` does.
- **Header**: title as usual; renaming and deleting stay where they are for
  any session (the server allows both). The second line is
  `<engine> · ⟨Bot⟩ Permission reviewer` (the glyph muted), the engine read
  from the session's own `model` / `effort` — what the **last review** ran on
  (the server writes them when each review is sent).
- **Session panel**: Permissions is removed (the stored mode means nothing).
  Engine is replaced by a fact row that reads the **settings**, not the
  session: `Next reviews: Haiku · Low`, opening Settings (the settings page
  has no address for one section, so the row says `Chosen in Settings ›
  Session` under the value); not a selector, since the server refuses one.
  Left out for a reviewer whose agent has no reviewer — a Codex reviewer an
  earlier version created gets no more reviews, and showing Claude's settings
  as its next ones would be wrong.
  Right after a settings change the header (last review) and this row (next
  review) differ, and each says which it is. Work and Usage stay — Usage is where review cost is read.
- **No Stop.** The server allows `chat.interrupt`, but stopping a reviewer
  denies everything it holds (`reviewer_failed`), and the user who wants to
  decide can answer the card in the main session instead. There is no
  composer, so no Stop button, and `ChatPanel`'s Escape-to-interrupt returns
  early for a reviewer too.
- **Fork stays.** A fork is an ordinary session holding the reviewer's
  transcript — the way to ask the reviewer "why did you deny that?".
- `AttentionStrip` and the answer panel are not rendered (a reviewer asks no
  questions; its own permission requests are denied at once and appear as
  ordinary cards answered `by: "pockode"`, §3.2).
- Empty transcript: `No requests have been reviewed yet.`

### 5.1 In the reviewer's transcript

- **`permission_review` message** → a system event row like the work events
  (`WorkEventItem`'s shape), glyph muted `Bot`:
  `Pockode · Permission review  <tool summary>`. The summary is the review
  JSON's `tool_name` / `tool_input` through `toolSummary`, with paths made
  relative to the JSON's own `cwd` (the main session's worktree, as it was when
  the request was sent) rather than to the page's — the same title the main
  session's card shows, so the two can be matched by eye. Expanded: the
  JSON pretty-printed as plain text, never markdown (full screen highlights it
  as JSON). Content that does not parse falls back to the raw text. Drawn by
  `Chat/ReviewerEventItem.tsx`, parsed by `lib/reviewerTranscript.ts`.
- **`permission_review_nudge` message** → `Pockode · Review reminder`, summary
  the number of waiting requests if parseable (`3 requests waiting`), else
  none.
- **`permission_verdict` tool call** → its row's title is
  `Verdict: Allow` / `Verdict: Deny · <category label>`, detail the reason —
  via the tool-summary table, not a special component. Both names are read:
  Claude's `mcp__pockode__permission_verdict` and Codex's
  `pockode:permission_verdict`, which a Codex reviewer an earlier version
  created still has in its transcript.
- `warning` `permission_review_auto_denied` (here) and `permission_review_failed`
  (main session) use the existing warning row unchanged.

## 6. How the client knows "under review"

§3.1, §3.3 and the list all need *this blocker is being reviewed*, and none of
them reads the mode for it: `SessionListItem` carries no mode, so a list would
have to show an unattended session under review as `needs_permission` —
warning `Lock`, "Needs permission", counted under *Needs you*, for up to five
minutes — calling the user to the very thing the mode exists to spare them.

The server marks the blocker instead: a turn's `permission` blocker carries
`reviewing: true` (`TurnBlocker.reviewing`; absent means false), state owned by
the turn. When it is set and when it is not is the server's contract,
[unattended-mode.md](unattended-mode.md#a-request-under-review); what the web
relies on is that a blocker is born with it, so no surface shows a momentary
"Needs permission" for a reviewed request, and that a request handed back to
the person never has it. An older server sends no flag, and the request reads
`needs_permission` — the safe direction.

- `sessionActivity` has a leaf `reviewing_permission`: muted `Bot`,
  `Reviewing permission`, aria `Permission reviewer is answering a request`,
  not in the *Needs you* predicate. It applies when every permission blocker of
  a blocked turn is reviewing; one waiting on a person still reads
  `needs_permission`, since the turn cannot resume until that one is answered.
  The work activity derived server-side (`server/work/activity.go`) follows the
  same leaf, checked against the shared table
  (`server/work/testdata/activity_cases.json`); see
  [lifecycle-ui.md §1.1](lifecycle-ui.md#11-activity).
- The card and the strip read the blocker instead of the mode, which also makes
  them right on a client that has not loaded the detail yet.
- The composer still counts a reviewed request as owning the input
  (`ChatPanel`'s `promptOwnsInput`): the server refuses a send while any
  request is pending, reviewed or not.

## 7. Settings: the permission reviewer

In Settings › Session, under Mode, `Settings/sections/PermissionReviewerField.tsx`
— a heading `Permission reviewer`, drawn uppercase as the other field labels:

```
PERMISSION REVIEWER
[⟨Claude⟩ Claude · Haiku · Low          ˅]
Unattended Claude sessions' permission requests are reviewed
on this. Auto lets the CLI decide. Codex never raises a
permission request under YOLO, so its Unattended sessions
never reach a review.
```

- One row, Claude's: the one agent with a reviewer. It is `EngineField` with
  the agent **fixed** (`agentFixed`, which drops the Agent section, leaving
  Model and Effort — the same lists, labels and Auto row the defaults use),
  labelled `Claude permission reviewer`, under the field's own heading
  (`hideHeading`; see [projects/frontend.md](projects/frontend.md)). There is
  no Codex row: there is nothing to configure for a reviewer that never runs,
  and the hint says why rather than leaving a Codex user to wonder.
- Auto (empty on the wire) carries the CLI-decides description
  (`AUTO_MODEL_DESCRIPTION` / `AUTO_EFFORT_DESCRIPTION`).
- `settings.update` replaces the settings object, so a change sends the whole
  `permission_reviewer` (`{claude: {model, effort}}`) with the other field's
  value kept — read from the store when the change is made, so two quick edits
  cannot overwrite each other.
- Same loading (`valueState`) and failure handling as the Engine field above:
  the reason under the row that caused it.
- Shown whatever the default mode is: a session can be switched to Unattended
  from its own panel.
- A change applies from the next review on, existing reviewers included; the
  hint does not need to say so.
