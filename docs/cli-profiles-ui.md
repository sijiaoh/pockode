# AI CLI Accounts UI

How a user keeps more than one account per AI CLI and picks which one Pockode
uses, from a phone: the account list in Settings → AI CLIs, adding, switching,
renaming, signing out and removing an account, and the way to switch from a
chat turn that failed on its credentials or on a rate limit.

> **Status:** built — Settings → AI CLIs, the chat's notice and the switch
> sheet. The server side is done ([code/cli-profiles.md](code/cli-profiles.md),
> [code/cli-auth.md](code/cli-auth.md)).

Related: [cli-login-ui.md](cli-login-ui.md) — the card, the sign-in sheet and
the auth-failure notice this extends, and whose words this keeps;
[code/cli-profiles.md](code/cli-profiles.md#the-rpc) for `cli_profile.*` and
every reason quoted below; [agent-event.md](agent-event.md) for
`auth_failure` / `usage_limit` and their `profile_id`;
[git-branches-ui.md](git-branches-ui.md#the-branchs-menu-) for the `⋯` menu
shape reused here.

## The rules

**One account changes nothing.** A CLI with no stored profiles — only its
default one — draws its card exactly as today, account row and all. The one
addition is a quiet **Add account** in the card's header. Everything below
about lists, names and "Current" applies only to a CLI that has at least one
stored profile; each CLI decides for itself, so Claude can show a list while
Codex keeps today's card.

**"Account" on screen, "profile" in code.** The user has accounts; `profile`
is the server's word and never appears in copy. The default profile is drawn
as an account named **Default** — the server gives it no name and refuses to
rename it, so the client supplies the one word for it, from one place
(`profileName` in `lib/cliProfiles.ts`).

**Switching is global, and says so.** There is one current account per CLI
for the whole OS user — every project, every cluster node on this machine. The
UI never offers a per-session choice, and wherever it switches it says in one
line what that reaches.

**The list is pushed, each account's state is read, each on its own.** The
list and the current account come from `cli_profile.subscribe`
(`cli_profile.changed`). Sign-in state and conflicts are read per account with
`cli_profile.inspect { agent, profile_id }` — one request per account, sent
together — so each row fills in when its own read answers and a slow Codex read
of one account never holds up the others (the server reads concurrently either
way; the reply is what would wait). `inspect` without `profile_id` is not used
by the UI. Both `inspect` and `remove` use the long requester `cli_auth.status`
and `cli_auth.logout` already use ([code/cli-auth.md](code/cli-auth.md#timeouts)).
A subscription that fails is a section notice, "Couldn't load accounts:" and
the error, until a list arrives; meanwhile the cards keep the last list the
page heard — the one-account layout if it never heard one.

**Events are events.** A notice in the chat names the account the record
carries (`profile_id`), looked up in the live list when drawn. Which account is
current is only ever read from the live list, never from the record.

**Words from cli-login-ui.md.** "Sign in" / "Sign out", CLI names from
`AGENT_TYPE_INFO`, *Managed outside Pockode*, *Couldn't read sign-in status* —
unchanged. New words are listed where they appear.

## Settings → AI CLIs

### One account (no stored profiles)

```
┌───────────────────────────────────────────────────┐
│ Claude                              + Add account │  header
│ ✓  Version 2.1.283                                │
│    Up to date                                     │
│ ●  Signed in                           Sign out   │  today's account row
│    ada@example.com · Max                          │
└───────────────────────────────────────────────────┘
```

- **Add account** — an accent text link with a `Plus` icon, right of the CLI's
  name, `text-xs`, its hit area widened with `touch-target` so the header keeps
  its `h-5` and the card does not move. Absent until the CLI is known to be
  installed (so it never appears only to vanish), while it is not installed,
  and while it is being updated or installed. On a machine that cannot have
  profiles (`available: false`) it is still there and opens the reason instead
  of the name field ([below](#no-accounts-on-this-machine)), so the user who
  looks for the feature learns why it is missing, and the one who does not is
  not told anything.
- The account row, its states, its sign-out and the sign-in sheet are
  [cli-login-ui.md](cli-login-ui.md#the-card-states)'s, unchanged — except the
  sign-out dialog's body ([below](#sign-out)).

### Several accounts

```
┌───────────────────────────────────────────────────┐
│ Claude                              + Add account │
│ ✓  Version 2.1.283                                │
│    Up to date                                     │
│ ●  Work  Current                              ⋯   │  one row per account
│    ada@work.example · Max                         │
│ ●  Default                     [ Switch ]     ⋯   │
│    ada@example.com · Pro                          │
│ ○  Spare                       [ Sign in ]    ⋯   │
│    Not signed in                                  │
│    New sessions and each session's next message   │  caption
│    use the current account, in every project here.│
└───────────────────────────────────────────────────┘
```

The single account row becomes one `CliRow` per account, same box, same
fixed height:

- **Order** — Default first, then the stored accounts in the server's order
  (the order they were added). The current one is **not** moved to the top:
  rows that jump when the user switches would put a different account under
  their thumb.
- **Icon** — the state's dot or icon from the card state table
  ([cli-login-ui.md](cli-login-ui.md#the-card-states)).
- **Title** — the account's name, `truncate`, then `Tag` "Current" on the
  current one. In the one-account card the title is the state ("Signed in");
  here the name takes the title and the state moves to the subtitle, because
  the name is what tells the rows apart.
- **Subtitle** — the state, in the card table's words: the account and plan
  for *Signed in* ("Signed in" when the CLI reports neither); "Not signed
  in"; "Managed outside Pockode · ANTHROPIC_API_KEY"; "Signing in…" (with "·
  started earlier" when this page did not start it); "Couldn't read sign-in
  status". While its read is out, the subtitle alone is a skeleton — the name
  is known from the list at once.
- **Action slot** — at most one button, by this priority:
  1. **Continue** (primary) — this account is the one signing in.
  2. **Sign in** (primary) — signed out and the CLI is not signing in.
  3. **Retry** (primary) — its read failed.
  4. **Switch** (secondary, `bg-th-bg-tertiary`) — signed in or external and
     not current.
  5. nothing.

  "At most one primary per card" ([cli-login-ui.md](cli-login-ui.md#where-status-lives-settings--ai-clis))
  becomes at most one primary per row: a list is rows, and each row's next step
  is its own.
- **`⋯`** — `iconButtonClass`, `Ellipsis`, `aria-label="Actions for Work"`,
  44px on a coarse pointer. Opens the account's menu (below). Every row has one.
- **Caption** — under the last row, `text-xs text-th-text-muted`: "New
  sessions and each session's next message use the current account, in every
  project here." The rule that would otherwise surprise someone, said once per
  card, not in every dialog.

No checkbox or radio: tapping a row does nothing. A switch reaches every
session on the machine, so it is a button press, never a stray tap
([git-branches-ui.md](git-branches-ui.md#the-branchs-menu-) made the same call
for branches).

### The account's menu (`⋯`)

A `Sheet` of `MenuRow`s, titled "Claude · Work" — the project's menu shape.
Order is frequency; the destructive item last, behind a divider, `danger`.

| Item | Shown | Unavailable when (`description`) |
|------|-------|-----------------------------------|
| **Switch to this account** (`ArrowLeftRight`) | not current | a switch on the card is running — "Wait for the switch to finish." |
| **Sign in** (`LogIn`) | signed out, and not the account signing in (its row has **Continue**) | the CLI is signing in another account — "Wait for Spare's sign-in to finish." ("Wait for the sign-in to finish." when status has not said which); the CLI is updating — "Wait for the update to finish." |
| **Sign out** (`LogOut`) | signed in | the CLI is signing in — "Wait for the sign-in to finish."; updating — "Wait for the update to finish." |
| **Rename…** (`Pencil`) | stored accounts (not Default) | — |
| **Remove account…** (`Trash2`, danger) | stored accounts (not Default) | current — "Switch to another account first." |

Following `MenuRow`'s rule: an item that never applies (renaming Default) is
absent; one that applies but not now is disabled and says why. The server stays
the boundary — its refusals are shown even where the menu thought it could go
ahead.

Switching to an account that is not signed in is allowed — the server does not
refuse it and the user may be about to sign it in. The row then says "Not
signed in" with **Sign in** beside "Current", which is its own warning.

### Adding an account

1. **Add account** opens `CliAccountNameSheet`: title "Add a Claude account",
   one field labelled "Name", placeholder "e.g. Work", `maxLength={64}`,
   focused on a fine pointer, and **Add** as the sheet's submit
   (disabled while the trimmed field is empty, spinner "Adding…" while it
   runs). Under the field, muted: "You'll sign in to it next. It won't become
   the current account until you switch to it."
2. `cli_profile.add`. A refusal (empty after trimming, too long, a control
   character, a name in use ignoring case) is the server's message under the
   field in `text-xs text-th-error role="alert"`, field kept and selected. The
   client checks nothing the server checks.
3. On success the name sheet closes and `CliLoginSheet` opens for the new
   account (its `account` prop, `{ id, name }`) — sheets don't nest, so it is one sheet replacing the
   other in the section's single sheet slot. The sign-in is today's, untouched.
4. **Signed in** from Settings on an account that is not current offers
   **Switch to Work** (primary) and **Done**. Switch runs `cli_profile.switch`
   and closes; Done closes. Adding then switching is the whole reason for
   adding, so it is one tap from the confirmation. A switch that fails stays
   on the sheet as "Couldn't switch:" and the error. Where this machine can't
   use accounts there is no switch to offer — every session runs as Default
   whichever is chosen — and it ends on **Done**.

If the CLI is already signing in another account when the sheet opens for
this one, the sheet says so instead of following that sign-in: "Claude is
signing in Spare" ("…another account" when the list does not have it) and
"Claude signs in one account at a time. Finish or cancel that sign-in, then
try again.", with Close and **Try again**.

An account whose sign-in is cancelled or fails stays in the list as "Not
signed in": it was added, and the row offers **Sign in** again. Nothing is
removed behind the user's back.

### Renaming

**Rename…** opens the same `CliAccountNameSheet`, title "Rename account",
the field prefilled and selected, submit **Save**. `cli_profile.rename`;
refusals as for adding. The new name arrives through `cli_profile.changed`.

### Switching

**Switch** (row) or **Switch to this account** (menu) calls
`cli_profile.switch` directly, no confirm: it is undone by switching back,
interrupts nothing (a running turn keeps its account until it ends) and the
caption has already said what it reaches. While it runs that row's slot shows a
spinner and every Switch on the card is disabled. The "Current" tag moves when
`cli_profile.changed` arrives — not optimistically, since another device may
have switched meanwhile and the push is the truth. The switch counts as running
until a pushed list has moved "Current" (to it, or elsewhere) or the list stops
being followed — not merely until the next push, which may be the unchanged
list the server sends again whenever another page subscribes. A failure is the
row's notice (`CliRowNotice` error).

### Sign out

`ConfirmDialog`, `variant="danger"`, as today. The copy depends on what the
sign-out reaches:

- **One account** (no stored profiles) — unchanged: "Sign out of Claude?" /
  "Every session using Claude on this server stops working until you sign in
  again. This includes other projects and cluster nodes on this machine."
- **The current account, with others** — "Sign out of Work?" / "Work is the
  current Claude account, so sessions using Claude stop working until you sign
  in again or switch to another account. This includes other projects and
  cluster nodes on this machine."
- **Another account** — "Sign out of Work?" / "Sessions don't use Work while
  it isn't the current account. A turn still running as Work may fail. You'll
  need to sign in again before switching back to it."

The title names the account, not the CLI, once there is more than one: "Sign
out of Claude?" would read as all of them. `cli_auth.logout { agent,
profile_id }`; spinner and error on that row as today.

### Removing

**Remove account…** opens a `ConfirmDialog`, `variant="danger"`:

> **Remove Work?**
> Pockode signs Work out of Claude and deletes its sign-in from this machine.
> Conversations are kept — they belong to every account. Sessions idle on Work
> are stopped; if one is still running a turn, nothing is removed.
>
> Cancel · **Remove**

Then `cli_profile.remove` on the long requester (the server's budget is in
[code/cli-profiles.md](code/cli-profiles.md#removing-a-profile)).
Meanwhile that row's slot shows a spinner and "Removing…", its `⋯` is disabled,
and the card's Switch buttons stay enabled — except to this row. On success the
row disappears with the next `cli_profile.changed`; when it was the last stored
account, the card goes back to the one-account layout.

A refusal (`-32014`, `data.reason`) is the row's notice; the profile is
unchanged by definition. The client words each reason itself; the server's
message is used only for a reason this build does not know:

| `reason` | Notice |
|---|---|
| `current` | "Work is the current account. Switch to another account first, then remove it." |
| `in_use` | "Work is still running a turn in 1 session (2 sessions, …). Idle sessions on it were stopped. Try again once the turn finishes." — the count from `data.sessions` |
| `signing_in` | "Claude is signing in Spare. Finish or cancel that sign-in, then try again." — the account the running sign-in is for (its login, else live status' `login_profile_id`; absent: Default); without "Spare" when it is this account, when nothing has said which, or when the list does not have it. The signing-in row already carries **Continue**, so the notice adds no button |
| `updating` | "Claude is being updated. Try again when it's done." |
| `removing` | "Work is already being removed." |
| `sign_out_failed` | "Pockode couldn't sign Work out, so it kept the account. Its sign-in has to be removed first, or it stays on this machine." with the server's message (which carries the CLI's error) in a collapsed **Details**. When the CLI's status reads *not installed*: "Claude isn't installed, so Work can't be signed out first. Install Claude, then remove it." |
| `still_exiting` | "Sessions on Work are still stopping. Try again in a few seconds." |
| anything else | the server's message, verbatim |

A removal that took the account off the list but left its directory is an
internal error; the row is gone (the list was pushed), so the error goes to the
card's notice: "Work was removed, but its folder couldn't be deleted:" and the
server's message (which names the path). Only an internal error is read that
way: a lost connection or an invalid-params answer (another device removed it
first) says nothing about a folder, and stays on the row — gone with it.

### While Claude signs in, or updates

A sign-in holds the whole CLI, and while it runs every account's status reads
`signing_in`. Only the row whose id is `login_profile_id` is drawn as signing
in (`login_profile_id` absent is Default). Every other row:

- keeps its last settled read — `settledInspections`, the per-account
  counterpart of the `settledStatuses` the update uses — with the subtitle "Wait for the sign-in to finish.", or
  "Checked after the sign-in." when there is no earlier read;
- has nothing in its slot that would run the CLI (Sign in, Sign out, Retry),
  and those menu items are disabled with the reason above. **Switch** stays:
  switching runs no CLI and the server allows it.

When the sign-in ends the store reads every account again, as it already reads
the one status today. An update or install is the same, with today's words
("Wait for the update to finish." / "Checked after the update.") on every row.

## Explaining why

### The same credentials on every account

When every account of a CLI reads `external` with the same `kind` and
`source` (`provider` / `method` too), the credentials come from the
environment or shared configuration, not from any account, and switching
changes nothing a session uses. The card says so once, as a notice under the
list (`Info`, `text-th-text-secondary`):

> Every Claude account uses `ANTHROPIC_API_KEY` from the server's environment,
> so switching accounts doesn't change what sessions use. Change it on the
> server machine.

— `ExternalSource`'s sentence with "Every Claude account uses" in place of
"Using", then the "so switching…" clause. The rows still say *Managed outside
Pockode* each, without the per-row notice (it would repeat four times). The
judgement waits for every row's read; until then no notice.

`external` on **some** accounts only is that account's own sign-in (a Codex
API key in its `auth.json`): drawn as today's *Managed outside Pockode* row
with its notice, and **Switch** works as for any other.

One account (no stored profiles) is today's card: there is nothing to switch
to, so nothing to say about switching.

### No accounts on this machine

`available: false` is a machine fact, so it is said once, at the top of the
section under Refresh, as a notice (`Info`):

> This machine can only use each CLI's default account. Turn on Developer Mode
> in Windows (Settings > System > For developers), then restart Pockode.

— the first sentence is the client's; the second is `unavailable_reason`
verbatim. It is a section notice only when some CLI has stored profiles (made
by a Pockode process that can use them), since then the list on screen does
not work as drawn. Otherwise it costs nobody anything until they ask: **Add
account** opens a `Sheet` titled "Add a Claude account" holding these two
sentences and **Close**, with no field — the one-account card stays as it is.

Then, on a card with stored profiles: the rows are drawn (the list is shared
and real), every non-Default row reads `unavailable` and is drawn **dimmed**
with "Can't be used on this machine" instead of *Couldn't read sign-in status*
and no Retry. "Current" stays where the list puts it — another process follows
it — but when it is not Default the caption reads "This machine uses Default
whatever is current." Switch and Rename stay (the server takes them); Remove
stays (the server removes without signing out here).

Without a configuration directory `add` / `rename` / `switch` fail with the
reason; the failure is shown where the action was pressed, like any other.

### Entries an account doesn't share (conflicts)

An account with `conflicts` gets a notice on its row (`AlertTriangle`
`text-th-warning` in the notice, not on the row's dot — the account works):

> Work doesn't share 2 items with your other accounts. Pockode found Work's own
> copy where a link belongs and left it alone. Move or delete the copy on the
> server, then Refresh.
> ▸ Details — `history.jsonl` · `/…/cli-profiles/claude/<id>/history.jsonl`

Names and paths in a collapsed **Details** (`Details` from `loginParts`,
monospace). `conflicts_error` instead: "Couldn't check what Work shares:" and
the error. Default never has either.

## In the chat

### What the records give

`normalizeRecordedAccount` keeps `profile_id` instead of dropping it, and
`usage_limit` is normalised the same way, so a part or an error carries
`authFailure` / `usageLimit: { agent, profileId?: string }` — `profileId`
`undefined` when the key is absent (recorded before accounts: unknown), `""`
for Default. Everything below treats the two marks alike except the words, so
it reads them through one value with a kind, `CliRefusal` (`cliRefusalOf` in
`web/src/utils/cliRefusal.ts`, which also says where a turn's one notice goes
and whether a turn failed on a refusal, for Send again).

### The notice

`CliRefusalNotice` (once `AuthFailureNotice`) is drawn for both kinds where
today's auth notice is drawn: in place of the error line for a marked error,
and on the latest marked warning while the turn runs. A turn's marked warnings
of the same kind as its marked ending are hidden under it, as today. A usage limit is Claude's on a
warning and then an *unmarked* failed ending, so for Claude the notice stays
on the warning after the turn ends, and that turn counts as failed on a
refusal for Send again. The unmarked ending keeps its red line:
the server marks only the warning so the limit is not reported twice, but the
client cannot know the ending says nothing else, and hiding an unmarked error
would be a silent failure.

```
┌ ⚠ <the CLI's own text> ─────────────────────────────┐
│   Claude couldn't authenticate as Work when this    │
│   turn ran.                                          │
│              [ Switch account ]  [ Sign in to Claude ]│
└──────────────────────────────────────────────────────┘

┌ ⚠ <the CLI's own text> ─────────────────────────────┐
│   Claude's requests as Work were turned away for    │
│   rate limits when this turn ran. If it's the       │
│   account's usage limit, switch to another account  │
│   and send again.                                   │
│                                 [ Switch account ]  │
└──────────────────────────────────────────────────────┘
```

**The account clause** — " as Work" — names the account on the record,
looked up in the live list by id: the stored name; "Default" for `""`;
"a removed account" when no stored profile has the id. It is left out when
the record has no `profile_id` (unknown — guessing the current one would be
reading state out of an event), and when the id is `""` and the CLI has no
stored profiles now (one account: today's sentence, word for word).

**The words**, past tense, a record of that turn:

- auth: "{CLI} couldn't authenticate{ as Work} when this turn ran." — today's
  sentence plus the clause.
- usage limit: "{CLI}'s requests{ as Work} were turned away for rate limits
  when this turn ran." and, when the switch entry is offered, "If it's the
  account's usage limit, switch to another account and send again." Never
  "hit its usage limit": Claude's marker covers every 429 it gave up on,
  temporary capacity included. The CLI's own text, on the first line, is
  what says which it was.

**The buttons** (secondary, `min-h-9 pointer-coarse:min-h-11`, right-aligned,
wrapping on a narrow bubble):

- **Switch account** — when the CLI has at least one stored profile and the
  machine can use them (`available`). Opens the switch sheet (below). Not for
  one account: there is nothing to switch to, and the notice stays as today
  (an auth failure) or the plain warning/error it is today (a usage limit) —
  the "one account changes nothing" rule. A usage limit where this machine
  can't use accounts stays plain too: every session runs as Default there.
  Not when every account is managed outside Pockode with the same source: the
  notice says so instead, with the sentence from [The same credentials on every account](#the-same-credentials-on-every-account).
- **Sign in to Claude** — auth only, as today, and for the account the record
  names when it still exists; for the current account when the record's is
  unknown or removed. Where this machine can't use accounts it is today's
  sign-in of the account the CLI runs as (Default): signing another in would
  fix nothing, and naming Default would end on a pointless switch. Left off
  when that account reads `external`, as today.
  The sheet title names the account once there are several: "Sign in to
  Claude · Work". When that account is no longer the current one (the user
  switched since), signing it in does not make the next message work —
  sessions use the current account — so its success offers **Switch to Work**
  and **Done** instead of **Send again**; after the switch, the same button
  becomes **Send again** under its usual conditions. For the current account
  it is today's success screen.

Both wait for what they depend on (the list and the "every account external"
judgement for Switch, the list and the status for Sign in) so neither appears
only to vanish; the judgement is settled by the first read that differs, so
one slow account does not hold Switch up. Status is read once per account for all
notices on screen, as today once per CLI; the "every account external" check
reads each account of that CLI once, and only when the CLI has stored
profiles.

**Switch account** is offered wherever the notice is drawn — a switch is
global, not the session's. **Sign in** and **Send again** keep today's limits
(no Sign in where today's notice has none, such as a viewed session — the
switch sheet's rows included).

Every notice keeps its buttons, old ones included: they are actions on live
state, and the sheets read it when they open.

### The switch sheet

`CliAccountSwitchSheet`, held by `ChatPanel` in the same slot as
`CliLoginSheet` (inside the transcript's `CoveredSurface`, one sheet at a
time):

```
Switch Claude account                              ✕
─────────────────────────────────────────────────────
Sessions use the current account from their next message,
in every project on this machine.

 ●  Work  Current                                  ← the record's account
    ada@work.example · Max · Turned away this turn
 ●  Default                              [ Use ]
    ada@example.com · Pro
 ○  Spare                                [ Use ]
    Not signed in
─────────────────────────────────────────────────────
                                                 Done
```

As it opens: Work, the account the record names, is still current, so the
footer has **Done** alone. After **Use** on Default, "Current" moves there and
**Send again** joins Done.

- Rows as in Settings (same component, same live reads), no `⋯`: managing
  accounts is Settings' job; this sheet does one thing.
- The record's account carries "· Turned away this turn" / "· Couldn't
  authenticate this turn" after its state — a fact from the record, worded
  in the past, beside live state. Only when the record names an account that
  still exists.
- **Use** on every row but the current one: `cli_profile.switch`, spinner in
  that row, the other Use buttons disabled; "Current" moves on the push.
- After switching to an account that is **not signed in**, its row gets
  **Sign in** (primary), which replaces this sheet with `CliLoginSheet` for
  that account carrying the same Send again offer — the existing flow then ends
  on **Send again**. Pick, sign in, send again: one line, no backtracking.
- **Send again** is [cli-login-ui.md](cli-login-ui.md#after-signing-in-send-again)'s,
  offered under the same conditions (latest turn, typed by a person, the turn
  has ended) and additionally only once the **current** account reads signed
  in or external and is **not** the account the record names. Before any
  switch it is not there: sending again as the account that was just turned
  away is what the user came to avoid. When the record names no account
  (recorded before accounts) or a removed one, it is offered once the current
  account reads signed in or external — today's rule. A draft in the way turns it into
  **Copy message**, as there. **Done** always.
- No switch happens on opening, and closing changes nothing.

From Settings there is no switch sheet — the card is the list.

## Cluster

`web-cluster` gets none of this, as it has no sign-in UI
([cli-login-ui.md](cli-login-ui.md#cluster)). The list is shared by every
Pockode process of the OS user, so a switch made from any node's Pockode
applies to all of them — which is what the caption and the dialogs say.

## Components

| Piece | Where | What |
|-------|-------|------|
| `cli_profile.*` requests, types | `web/src/lib/rpc/cliProfile.ts`, `web/src/types/cliProfile.ts` | `inspect` and `remove` on the long requester; `cliProfileRemoveRefusal` reading `-32014`'s `data.reason` / `data.sessions` into a `CliProfileRemoveRefusal` |
| `cli_auth.*` requests, types | `web/src/lib/rpc/cliAuth.ts`, `web/src/types/cliAuth.ts` | `profileId` on `cliAuthStatus` / `cliAuthLogout` / `cliLoginStart`; `profile_id`, `login_profile_id` on `CliAuthStatus`, `profile_id` on `CliLogin` |
| `cliLoginStore` | `web/src/lib/` | Also holds the `Overview` (`profiles`, followed per screen with `useCliProfileSubscription`) and each account's inspection, live and settled (`inspections`, `settledInspections`, `ensureInspection(agent, id)`); the login and update halves stay per CLI (one sign-in per CLI) — [code/cli-auth.md](code/cli-auth.md#the-web-client) |
| `lib/cliProfiles.ts` | `web/src/lib/` | `profileName(overview, agent, id)` ("Default", the name, or "a removed account") for records, `liveProfileName` for live state (undefined rather than "removed" for an id not heard of — another process's changes are not pushed), `chosenProfileIdOf` (the list's current account, where "Current" is drawn) and `currentProfileIdOf` (the one the CLI runs as — Default where accounts can't be used), `hasStoredProfiles`, `sharedExternal(statuses)` / `profilesSharedExternal(ids, inspections)`, `removeRefusalText(…)`, `unavailableText(reason)` |
| `CliProfileRow` | `web/src/components/Settings/sections/` | One account's row — `useProfileView` reads it, `profileNeed` / `offersSwitch` say what it asks for, the caller draws the button; `useProfileSwitch` runs a switch. Settings and the switch sheet both draw it |
| `CliAccountList` | same | The rows of a CLI with stored profiles, their dialogs and refusals; `CliStatusCard` picks it or today's `CliAccountRow` |
| `CliAccountMenu`, `CliAccountNameSheet` | same | The `⋯` sheet; add / rename, and the reason in place of the field on a machine without accounts |
| `CliLoginSheet` | `web/src/components/CliLogin/` | Takes `account` (`{ id, name }`); its title names it; a signed-in account that is not current ends on **Switch to …** and **Done**; another account's running sign-in is said, not followed |
| `cliRefusal` | `web/src/utils/` | `CliRefusal` (either mark, with its kind), `refusalNotice` (where a turn's one notice goes), `isRepeatedByEnding`, `failedOnRefusal` (what Send again asks of a turn), `refusalAccounts` (every account the transcript's marks name) |
| `CliRefusalNotice` | `web/src/components/Chat/` | Replaces `AuthFailureNotice`; both markers. Draws the caller's `plain` record for a usage limit on one account, or where this machine can't use accounts. `ChatPanel` follows the account list (`useCliProfileSubscription`) only while its transcript holds a refusal, and subscribes afresh once for each recorded id the list lacks (another Pockode process's additions are not pushed); until the list arrives the notice offers no button, and a list that fails reads as one account |
| `CliAccountSwitchSheet` | `web/src/components/CliLogin/` | The chat's switch sheet: `recordedProfileId` (the record's, as recorded) / `recordedNote` for its row while it still exists, `onSignIn(account)` to swap in `CliLoginSheet`, `sendAgain` — the offer, which the sheet shows only once the current account is signed in (or external) and is not the record's |
| `useSendAgainParts` | `web/src/components/CliLogin/loginParts.tsx` | The Send again / Copy message button and the "draft kept" note, for both sheets |

## What to test

- A CLI without stored profiles renders today's card (plus **Add account**),
  and its auth notice today's words; a usage limit stays a plain warning.
- Each account's row fills in when its own `inspect` answers; one slow read
  does not hold the others.
- During a sign-in only the `login_profile_id` row is drawn signing in; the
  others keep their settled read with no CLI-running actions, and Switch stays.
- Every `-32014` reason renders its row; an unknown one renders the server's
  message.
- Same `external` on every account → one card notice and no Switch entry in
  the chat; on one account only → no card notice.
- `available: false` with stored profiles → the section notice and dimmed
  rows; without them → no notice, and Add account opens the reason.
- A notice names the record's account by live name, "a removed account" for an
  unknown id, nothing for a missing `profile_id`; it never reads the current
  account into the sentence.
- The switch sheet offers Send again only after the current account is no
  longer the record's and is signed in (or, for a record with no or a removed
  account, once the current one is); a sign-in from the notice to an account
  that is not current offers Switch, not Send again; the usage-limit words never say the
  limit was hit.

## Implementation notes

- **`profile_id` absent means "current" on `cli_auth.*`**, but `switch`
  requires it and `inspect` reads every profile without it
  ([code/cli-profiles.md](code/cli-profiles.md#the-rpc)). Every
  call this UI makes names its account explicitly — never "current" — so an
  action pressed on a row can't land on a different account after a switch
  elsewhere. The exceptions are the one-account card and the one-account chat
  notice, which keep today's calls, and the chat's Sign in where this machine
  can't use accounts, which signs in the account the CLI runs as.
- **A removed account's name.** The notice looks names up at render; a
  record whose account has since been removed must not crash or blank — it
  reads "a removed account". Live state (a running sign-in) never says
  "removed": an id missing from the list may be another process's new account.
- **The store's shape.** `statuses` stays per CLI — the status of the account
  the CLI runs as, which the one-account card and the chat's Sign in read —
  and each account's read lives beside it in `inspections` /
  `settledInspections`, keyed by agent and account. The login and update halves
  stay per CLI (one sign-in per CLI). The rules the store applies — when it
  reads again, which read wins — are in
  [code/cli-auth.md](code/cli-auth.md#the-web-client).
- **The chat marks stay two fields.** `authFailure` and `usageLimit` are kept
  as the records give them rather than folded into one field on the message;
  `cliRefusalOf` reads either as a `CliRefusal`, so the components see one value.

## Considered and not done

- **Tapping a row to switch.** One stray tap would move every session on the
  machine; a button costs nothing.
- **Moving the current account to the top.** Rows that jump on switching put
  the wrong account under the finger.
- **A confirm for switching.** Undone by switching back, interrupts nothing,
  and the caption already says what it reaches.
- **Per-session account choice.** Out of scope by the story: one current
  account per CLI.
- **Offering "Add account" from a one-account usage-limit notice.** It would
  be the moment the feature is most useful, but it puts a new button on a
  screen the one-account rule promises to leave alone. Revisit if users ask.
- **Removing without signing out, or a forced removal.** The server has
  neither, on purpose ([code/cli-profiles.md](code/cli-profiles.md#removing-a-profile)).
- **A switch inside the account's menu in the chat.** The switch sheet's rows
  carry Use; renaming and removing are Settings' job.
