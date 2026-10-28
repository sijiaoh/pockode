# Agent Handoff UI

Two halves of one loop between the chat and the Git workspace:

- **Prefill handoff** — how a surface outside the chat (today: the Git
  workspace) hands the agent a piece of work. It writes a prepared message into
  a session's composer — the one already under the page, or the chat's, which
  it takes the user to. **It never sends.** The user
  reads what will go out, edits it, and presses Send.
- **The review row** — the way back. When the agent is idle and the worktree
  has uncommitted changes, the chat's attention strip says so and offers the
  Git workspace's review.

The handoff is a mechanism, not an entry point. The entries that use it each
belong to their own design — today asking the agent about selected lines
([git-changes-ui.md](git-changes-ui.md#handing-lines-to-the-agent)), the
in-progress operation's `Resolve with agent` and the conflict view's `Ask agent`
([git-conflict-ui.md](git-conflict-ui.md#resolve-with-agent)), a branch's
`Ask AI to merge into current branch`
([git-branches-ui.md](git-branches-ui.md#asking-the-agent-to-merge)), and a
commit menu's `Ask AI to revert`
([git-history-ui.md](git-history-ui.md#ask-ai-to-revert)). This file says only
what every one of them gets by calling
it. The review row is the one entry this file does define.

Copy below is the UI's English.

## Goals and constraints

- **Pockode never sends a message the user did not send.** Any message that goes
  to the agent first sits in the composer, where the user can read and change
  it. A background send would bill the user and change the transcript with
  nothing on screen to say why. This is why the Git workspace has no composer
  of its own: the one under its details is the chat's
  ([git-ui.md](git-ui.md#the-composer)), and the way it hands work to the agent
  is to put the message in that one.
- **Never over the user's words.** A half-written draft is the user's. A prefill
  goes after it and never replaces it. This is the rule
  [discarded-messages-ui.md §5](discarded-messages-ui.md#5-what-restoring-does)
  already set for *Restore to input*. Both are the same operation, so they share
  one function.
- **The review row is live state, not an event.** It is drawn from the
  worktree's `git.status` as it is now. It is never written into history, never
  attached to a turn, and never left behind in the transcript. A card saying
  "5 files changed" would be wrong as soon as the user commits one
  ([AGENTS.md](../AGENTS.md), "Events are events, state is state"). What a turn
  did is already recorded by `TurnChangesCard`
  ([tool-call-ui.md](tool-call-ui.md#the-turns-changes)). This row says
  something different: what is uncommitted right now.

## 1. Prefill handoff

### 1.1 Which session

The Git workspace belongs to a worktree, but its URL carries `session`: the
chat it was opened over ([git-ui.md](git-ui.md#routes-segments-and-back)). That
session is the **current session** when it exists in this worktree. This is the
test `useWorkspaceEngine` already uses: the shell subscribes to the route's
session detail in the worktree the path names, whatever overlay is up
(`AppShell`'s `useSessionDetailSubscription`). A held detail means the session
is there. The test is the detail, not the session list, because a work's
session is hidden from the list and is still a chat the user can come from.

| The workspace URL's `session` | Target |
|---|---|
| Names a session whose detail this worktree holds | That session |
| Absent (a deep link, a sidebar entry with no chat behind it) | A new session ([§1.4](#14-no-current-session)) |
| Names a session this worktree does not have: deleted, or never here (the user switched worktree inside the workspace, which keeps the segment but not the chat) | A new session |

One rule decides both the engine and the target. So the AI-drafted commit
message and a handoff from the same screen always name the same session. A
read-only cross-worktree session is never a target, because its composer does
not exist ([cross-worktree-session-ui.md](cross-worktree-session-ui.md#the-read-only-screen)).
It needs no separate check: Git routes never carry `from`, so their `session`
is always looked up in the path's worktree, where a session read out of another
worktree does not exist.

The target is resolved **at the press**, from what is held then, and is not held
from when the entry rendered.

### 1.2 What is written

The draft (`inputStore`) of the target session, on this device:

| Draft before | Draft after |
|---|---|
| Empty (no text, or whitespace only) | The prefill text |
| Has text | The user's text, trimmed at its end, then a blank line, then the prefill text |
| Already contains the prefill text verbatim | Unchanged. A second press, or a press after the user came back without sending, adds nothing |

- **Files already in the draft stay as they are.** The handoff carries text
  only. An entry that needs to point at files names them by path in the text,
  which is how the agent reads them anyway.
- **No Pockode commands.** A command is recognised only when it is the whole
  message ([pockode-commands.md](pockode-commands.md)), so one appended to a
  draft would go out as prose. The handoff takes prose only. An entry that
  wants a command has to design its own refusal, as *Restore to input* did.
- **Asking is ruled out.** "Replace or keep?" would be a dialog every time the
  user had typed anything. Neither answer loses less than appending does: the
  user's words stay, and deleting a paragraph the user did not want is one
  gesture in a box they are about to edit anyway.
- **The text is set before navigating**, as fork does with its dropped prompt
  (`ChatPanel`'s `handleFork`). That way the composer is never on screen empty
  for a frame and then filled.

### 1.3 Landing in the composer

Where the text is shown depends on whether the target's composer is already on
the page:

| The press | Where it lands |
|---|---|
| The target is the route's session, on a page that keeps the composer under it — a Git detail (`overlayKeepsComposer`, [git-ui.md](git-ui.md#the-composer)) | **In place.** Nothing navigates: the draft and the reveal land in the composer under the page, and the user stays on the diff, commit or branch the message is about — the next thing they want to see is what the agent does to it |
| The target is the route's session, on a page without the composer — a Git list | The target session's chat route is **pushed**, in the workspace's worktree |
| A new session ([§1.4](#14-no-current-session)) | Pushed, from any page: whatever composer is on the page is not the target's |

The push keeps Back meaningful: Back returns to the Git screen the user came
from, with its selection and scroll (a review's selected lines excepted,
[git-changes-ui.md](git-changes-ui.md#selecting)), if the user decides not to send
after all.

The composer then shows the text. Three things make the handoff noticeable,
and each one has a reason:

| | Fine pointer | Coarse pointer |
|---|---|---|
| Caret | In the textarea, **at the end of the text**. Set explicitly, not left to where a browser puts the caret when a value changes under a textarea that is not mounted yet. After an append, a caret anywhere else would be in the middle of the user's own words | Not focused. The soft keyboard is not raised. This is the composer's existing rule ([InputBar](agent-chat.md#the-session-screen), *Restore to input*): the keyboard would cover half the transcript the user came back to read, and Send can be pressed without it |
| Textarea scroll | Scrolled to its end, so the prefill is what shows when the draft is taller than the box's maximum height | same |
| Ring | The composer's box (the reading column it is held to) wears a 2px inset `th-accent` ring for about half a second, which then fades out over about a second, once | same. The ring is the only visible sign on a touch screen, because nothing takes focus there |

- **The ring borrows the jump's grammar.** `MessageList`'s jump rings the card
  it lands on (`.jump-highlight`, which is `th-warning` because that card is a
  permission). The handoff lands on the composer, so the composer is what rings.
  The colour is `th-accent`: this is an arrival, not a warning. Under
  `prefers-reduced-motion` the ring shows and goes with no fade, like the jump's.
- **Nothing says "not sent".** The Send button in its slot already says it. A
  toast would be the global toast system the app deliberately does not have
  ([git-ui.md](git-ui.md#out-of-scope)).
- **Screen readers** hear one polite announcement from a live region the
  composer owns: `Message ready to send.` when the draft is now the prefill and
  nothing else (it was empty, or held exactly that already), `Added to your
  message.` when the prefill sits beside the user's own words. The ring does not reach them, and on a
  coarse pointer focus does not move either.

The reveal (caret, scroll, ring, announcement) is passing device state. It is a
one-shot request per session, and `InputBar` consumes it when it next renders
that session, and only once the bar is enabled (a session just created is
still resolving when the bar first draws it) and nothing covers the page
(`useIsPageCovered`). The second is for a handoff in place made from a sheet —
a commit's `⋯` → `Ask AI to revert`: the request lands while the sheet is still
up, and the sheet hands focus back to its opener as it closes, which would take
the caret from the draft and the ring from view. It is not persisted and not
part of the draft. A bar already on the page takes it there; otherwise the one
that mounts on landing does. The existing
`focusRequest` counter cannot carry it: that counter lives in `ChatPanel`, and
the handoff starts from outside the chat.

**A registry `InputBar` gets the text, not the reveal.** The request is read
from the store by the default bar, not passed through `InputBarProps`, so a bar
an extension puts in its place (`chatUIRegistry`) shows the prefilled draft
with no caret placement, ring or announcement. Its input is its own business,
as with dropped files ([agent-chat.md](agent-chat.md#attaching-by-drop-or-paste)).

### 1.4 No current session

The handoff creates a session in **the workspace's worktree**, which is the one
in the path and the one the work is about. It uses the plain `session.create`
that *New chat* uses. That puts the session on the global default engine and
mode, which is also what `useWorkspaceEngine` falls back to. There is no picker,
for the reason the AI draft has none: the user can change the engine in the
session panel before sending, and a question asked before every handoff would
be one with an obvious answer.

- **While the session is being created**, the entry shows its own pending state
  (the spinner of the button that was pressed, disabled). Nothing navigates yet.
  A second press on the same entry is ignored until its push has landed, so a
  double press never pushes the chat twice and leaves Back pointing at it. A
  press on any other entry, or *New chat*, joins the create already in flight:
  `lib/sessionCreate.ts` is the one create every caller goes through, and
  `useSession` uses it too. It is joined only from the worktree it was asked
  in, because a create sent before a worktree switch is answered in the
  worktree left behind.
- **While the connection is still switching to the workspace's worktree**,
  `session.create` would be answered in the old one, so the handoff does not
  send it: it reports `Couldn't start a new chat` with `This worktree is still
  opening. Try again in a moment.` as the failure below.
- **If the create fails**, the user stays where they were, and the failure is
  reported on the entry's surface as `Couldn't start a new chat` with the
  reason as its detail. Nothing is lost: the text exists only in the entry
  until the session does. The hook does not write a banner itself: it hands the
  failure back as a `GitFailure` (`summary`, and the server's message as
  `detail`) with `dismissError`, and the entry renders it as a failure of its
  own (an `ErrorBanner`, or the branch list's pinned failure), beside the ones
  its surface already has: the Git workspace's
  rule is that feedback appears where the action started
  ([git-ui.md](git-ui.md#feedback-and-errors)).
- **On success**, the draft is set on the new id and the route is pushed — even
  from a page that keeps a composer, which is the old session's — in
  that order, as in [§1.2](#12-what-is-written). If the user is no longer where
  they pressed by then — any navigation while the session was being created,
  leaving the workspace or moving inside it — the draft is still written, and
  nothing navigates and nothing is revealed: the user has gone somewhere of
  their own, and the text waits in the new chat.
- **The hook belongs to a surface that outlives the press** — the page or bar
  the entry sits in, not a menu row that closes on select. Its pending state
  and its error are that call's, and an error handed to a component that has
  unmounted is one nobody sees.

A new session arrives with no conversation behind it. That is visible: its
header reads `New Chat`. Its absence is also the reason it was created. The
chat the user came from is gone, or never existed, so landing in an empty chat
is the truthful result, not a fallback.

### 1.5 The target's state does not gate the handoff

| Target | Behaviour |
|---|---|
| Idle | As above |
| A turn is running | As above. Sending into an open turn is ordinary, and the strip's receipt row covers it ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)). Stop shares Send's slot and gives it up because the draft is no longer empty ([§2.3](lifecycle-ui.md#23-chat-composer-and-stop)) |
| Blocked on a permission | As above. Send is disabled and the placeholder says why; the strip's permission row is right there. The text waits |
| Unanswered questions | As above. Coming back from an overlay makes unseen questions raise the answer panel again ([answering-ui.md §4](answering-ui.md#4-when-the-panel-is-up)). That panel does not take focus, because nobody named a question. The composer stays lit with the prefill in it. On a short viewport the composer is folded only while focus is inside the card, and the handoff never puts it there |
| Deleted between the press and the landing | The draft is written to a dead key. The landing shows the existing missing-session handling. The window is one navigation long and is not designed for further |

Entries do not disable themselves because the session is busy: deciding to
send mid-turn is the user's call, in the composer.

### 1.6 Where it lives

| Piece | Place | Note |
|---|---|---|
| Merging text into a draft | `utils/discardedMessage.ts`'s text half of `restoreIntoDraft`, moved to a neutral `utils/draftText.ts` (`appendToDraft(draft, text)`) | *Restore to input* and the handoff call the one function, so "never over the user's words" has one definition |
| The handoff | `hooks/usePrefillComposer.ts`, returning `prefill(text)`, `isPending`, `error` and `dismissError` | Resolves the target ([§1.1](#11-which-session)), creates if needed, writes, files the reveal request, pushes the route unless the composer is already on the page ([§1.3](#13-landing-in-the-composer)). Every later entry calls this; none writes `inputStore` itself |
| Whether the composer is on the page | `overlayKeepsComposer` in `types/overlay.ts` | The one rule, read by `ChatPanel`, which draws the composer, and by the handoff |
| The reveal request | `inputStore`, a non-persisted one-shot keyed by session (`reveals`, `requestReveal`, `takeReveal`) | Consumed by `InputBar` |
| Creating the session | `lib/sessionCreate.ts` (`createSession`) | The one create `useSession` and the handoff share, so concurrent callers join one request |
| The ring | `.composer-arrival` in `index.css` | A keyframe animation, so the ring is there at once and only its going fades |

## 2. The review row

### 2.1 What it says

A row of the attention strip ([answering-ui.md §2](answering-ui.md#2-the-strip)),
in the strip's own vocabulary: one line, centred, `text-xs`, muted, a `size-3`
glyph, and a text action.

```
         ⧉ 5 changed files · Review
    [+] [ Type a message...        ] [↑]
```

| Part | Content |
|---|---|
| Glyph | `FileDiff`, muted, `aria-hidden`. It is the glyph `TurnChangesCard` uses for files a turn changed, so "changed files" looks the same in the transcript and below it |
| Statement | `describeChangeCount(n)`: `1 changed file`, `5 changed files`, `99+ changed files`. These are the badge's own words and truncation ([git-ui.md](git-ui.md#the-change-count-on-the-tab)) |
| Action | **Review**, the strip's underlined text action with `touch-target`. It is not the filled button that **Answer** uses: that one is the strip's single call to action, and this row is a way to *look* at something, like Details and the jumps. No `›`: the strip's text actions carry no chevrons |

The story's draft wording was `N 个改动 · 审阅 ›`. The final copy is the shape
above: the count in the badge's words, so the tab, its `Changes` entry and this
row never phrase one number three ways, and the action in the strip's grammar.

**No diffstat.** The sidebar's `+142 −37` would fit at 360px, but the row
answers "is there something to review", and the count answers that. Line
totals are one tap away, in the list header.

### 2.2 Its rank

The row is the strip's **lowest** and is shown only when nothing else is shown.

| # | Row | |
|---|---|---|
| 1 | permission | unchanged |
| 2 | questions | unchanged |
| 3 | receipt | unchanged |
| 4 | background / watching | unchanged |
| 5 | **review** | new |

The table in [lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)
carries this row, with a link here. As with the question row, only
the rank is decided there.

In practice the gate in [§2.3](#23-when-it-is-shown) already excludes rows 1, 3
and 4 (they need an open turn, or `watching`). So the rank only ever settles
review against questions. Questions win, by being excluded outright rather than
outranked; the next section explains why.

### 2.3 When it is shown

All of these, evaluated in `ChatPanel` on the same render as the rest of the
strip:

| Condition | Why |
|---|---|
| The composer is on screen: the chat route, not a page that hides it, and not a read-only session | The row sits above the composer. It also tells the agent's user what the agent left, and a read-only session is another worktree's chat over this worktree's tree |
| The project is a git repository (`isGitRepo` confirmed) | Otherwise there is no workspace to open ([git-ui.md](git-ui.md#projects-without-a-repository)) |
| `turnOpen` is false | "The agent is idle". The composer's own test ([lifecycle-ui.md §2.3](lifecycle-ui.md#23-chat-composer-and-stop)), including the optimistic half: the row goes in the same frame the user presses Send, not a round trip later. While a turn runs the files are still moving, and the tail line has the floor |
| The session's activity is `idle`, which leaves out `watching` and a work's `waiting_children` | A watching chat, or a story waiting on its tasks, is waiting on agents that may be editing this same tree. The watching row says what the chat is waiting for, and that outranks an invitation to review files that are still moving |
| The session's detail has landed, and a work's session has its work in the work store | Until the detail lands the turn is a placeholder that reads idle whatever the session is doing, so a running session would flash the row for a round trip. A work the store has not paged in costs the activity its wait, so a story waiting on its tasks would read idle too; not knowing, the row stays away |
| No unanswered questions, panel up or not | The answer panel hides row 2 while it is up, so a lower row would otherwise rise into row 2's place the moment the panel opens. That would put an invitation to leave the chat right under a card asking the user to answer here. With the row excluded, the strip goes empty while the panel is up, which is the one-line movement [answering-ui.md §2](answering-ui.md#2-the-strip) already accepts |
| The change count is known and ≥ 1 | `useGitChangeCount()` |

It disappears when any of these stops holding: the user sends (instantly, by
the optimistic half), the user commits or discards down to a clean tree, a
question arrives, the chat starts watching or waiting on its subtasks.

**Count changes are not announced.** As with the badge, the row has no
`aria-live`. The number reaches a screen reader when the user reaches the row.

**Stale over absent.** A refresh that fails keeps the last count, the badge's
rule. A first read that has not answered yet shows no row, because a badge is
not an error channel and neither is this.

**The worktree's count, not the session's.** Another session working in the
same worktree adds to it. That is correct: the review page shows the tree, and
the tree is what will be committed. The row does not try to attribute files to
this chat. That attribution is history, and `TurnChangesCard` already records it.

### 2.4 Keeping the count live

Today `useGitWatch` (`SessionSidebar`) runs only while the sidebar's tab bar or
the workspace is on screen ([git-ui.md](git-ui.md#who-subscribes-to-gitchanged)).
On a phone with the drawer closed, the count would be whatever it was when the
drawer was last open. So the review row adds a term to that condition:

```typescript
enabled: isGitRepo && (
  (!SidebarContent && isOpen) ||
  activeGitSegment !== null ||
  reviewRowCanShow   // the chat's composer is up and turnOpen is false
)
```

- **Only while idle.** During a turn the row is hidden whatever the count is, so
  watching then would cost the server's 3-second poll for nothing.
- **The turn ending is what refreshes it.** Re-enabling resubscribes, and
  `useGitWatch` refetches on `onSubscribed`. So the count is fetched fresh at
  exactly the moment the row may appear, which is when the agent has just
  stopped writing. Until that answer lands, the cached count is shown, under the
  stale-over-absent rule above.
- The flag is computed from the conditions in [§2.3](#23-when-it-is-shown) apart
  from the count itself. It cannot depend on the answer it enables.
- `turnOpen` is derived inside `ChatPanel`, and the watch is in
  `SessionSidebar`, its sibling under `AppShell`. The flag has to cross from one
  to the other: `ChatPanel` reports it up, and `AppShell` passes it down beside
  `activeGitSegment`. It must not be re-derived in the sidebar, where a second
  copy of the gate could disagree with the one that draws the row.
- The watch also needs `!SidebarContent` to stay out of this term, as
  `activeGitSegment` does: a custom sidebar takes away the badge, not the chat's
  row.
- `ChatPanel` reports it through `onReviewRowCanShowChange` from an effect that
  says `true` while the gate holds and `false` in its cleanup, so a panel that
  unmounts never leaves the watch on. The strip is handed the count only while
  the same flag holds (`changeCount`), so the row and the watch read one gate.

### 2.5 Pressing Review

It opens the review layer at the **first file in list order** — the file the
Changes list's first row opens — including the flat/tree order the user last
chose: `firstReviewTarget` in `lib/gitChanges.ts`, the first file of
`orderChanges` under the given view plus its side by `reviewSideOf`. The row's
press is `AppShell`'s `handleOpenReview`, which calls it on the status and the
view in `gitChangesViewStore` as they are at the press. (The list once had a
`Review` button of its own doing the same; it went, being the first row's press
— [git-changes-ui.md](git-changes-ui.md#the-bottom-bar).) The route
carries the current `session`, so the header's way back names this chat.

- **Push**, like every entry into the workspace, and without the list's
  `REVIEW_FROM_LIST_STATE` mark — which is why it is a handler of its own
  rather than `handleSelectDiffFile`, which sets that mark from outside a
  review. The system Back returns to the chat.
- **Leaving the review** follows the review's existing rule, unchanged: a review
  not pushed from the list has no list behind it, so `←` replaces it with the
  Changes list (`useLeaveReview`), and from there `←` returns to the chat. A
  commit made in the review ends on the list too, where any unstaged files are
  waiting. Taking the user straight back to the chat would skip the list at the
  moment it is most useful.
- At `expanded` the same route is two columns, the list beside the first file,
  with nothing special for this entry.
- **The file is not known at render.** It is computed at the press from the
  status as it is then, so a file committed between render and press is never
  opened. A cached status nothing has invalidated is used as it is; one that
  has been invalidated — a `git.changed`, the refetch as a turn ends, a
  worktree switch landing — is read afresh (a refresh already under way is
  cancelled first, so the readers' retry backoff does not hold the press up,
  then `fetchQuery` without retries), so the
  press never opens a file from before the refresh or from another worktree.
  If the tree is clean by the time of the press (the row is about to disappear
  on the next render), the read fails, or a worktree switch is still in flight,
  the press opens the Changes list instead, which is true in every case and
  says what failed when something did. A reader who navigated elsewhere while
  the read was out is left where they went, and one who sent meanwhile stays in
  the chat: the row's gate closing expires the press.

### 2.6 Width and layout

One shape at every width. The strip's content follows the conversation's
reading column (`max-w-3xl`), so the row is centred over the composer on a
desktop as on a phone. At 360px on a coarse pointer the longest form,
`⧉ 99+ changed files · Review`, is about 170px plus the action's 44px hit area,
well inside the row. The statement is the part that truncates if anything ever
must: the action is never cut.

## 3. Decisions not to lose

1. **The handoff writes the draft and never sends.** Every AI entry outside the
   chat goes through `usePrefillComposer`. None writes `inputStore` itself, and
   none sends.
2. **Append, never replace, never ask.** One function, shared with *Restore to
   input*. The same text twice is added once.
3. **The current session is the workspace URL's `session` if this worktree
   holds its detail.** Otherwise a new session is created in the workspace's worktree
   on the default engine. This is the same rule that picks the AI draft's
   engine.
4. **Land where the composer is, and land visibly.** In place under a Git
   detail, pushed into the chat otherwise. Caret at the end on a fine pointer,
   no keyboard on a coarse one, the textarea scrolled to the end, an accent
   ring once, one polite announcement — once nothing covers the page.
5. **The review row is live state.** It is drawn from `git.status`, never
   recorded, and gone the moment the condition is.
6. **Lowest rank, idle only, never beside questions or watching.** It never
   rises into the questions row's place when the answer panel opens.
7. **`git.changed` is watched while the row could show.** The turn's end is what
   refreshes the count.
8. **Review opens the first file in list order through the list's own function.**
   Leaving it follows the review's existing rule.
