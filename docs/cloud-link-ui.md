# Cloud Link UI

How a user sees whether this machine is linked to their cloud account, links
it, and unlinks it, from Pockode's Settings — on a phone, or on a desktop with
the phone doing the approving. What each status reads as, the link sheet and
its phases, what unlinking costs and how that is said before the press.

The process side — the device flow it runs for the UI, the status it reports
and the `cloud_link.*` RPCs — is
[code/cloud-account.md](code/cloud-account.md#linking-from-the-ui). This
document is what the user sees of it.

Related: [cli-login-ui.md](cli-login-ui.md) for the sign-in flow whose rules
this one follows, [cli-update-ui.md](cli-update-ui.md#where-it-lives-settings--ai-clis)
for the row box (`CliRow`) and notice this card is built from,
[responsive-ui.md](responsive-ui.md) for the width ladder and pointer gates,
[answering-ui.md](answering-ui.md#who-owns-escape) for the conventions `Sheet`
and `ConfirmDialog` already follow.

## The rules

**"Link", "Unlink", "Linked as".** Each account keeps its own words: Pockode's
own password account has "Logout" (Settings → Account), the AI CLIs have "Sign
in" / "Sign out" (Settings → AI CLIs). The cloud link is neither, and never
borrows them — not even "Log in", though the terminal command is
`pockode login`.

**Two subjects, never blurred.** The link belongs to the **machine** — one OS
user on one host, `ada@studio-mac` — and covers every Pockode it runs: this one,
other projects, a cluster and its nodes. Whether *this* Pockode shows in the
account's list is a separate fact, which can be false while the machine is
linked. The card gives each its own row, and every place that changes the link
names the machine.

**Only Cancel cancels.** As in [cli-login-ui.md](cli-login-ui.md#the-rules):
the flow belongs to the server process, so closing the sheet, Escape, the
backdrop, Back, being covered, a reload and a dropped socket all leave it
running. The card then says *Linking* with **Continue**.

**The server is the clock.** Every countdown is drawn from the flow's
`expires_at`; at zero it stops counting and the server ends the flow. The
client starts no timer of its own — not for the flow, and not for the relay
catching up.

**The code and the link live in memory only.** The user code and
`verification_url` come from the status and stay in the component state that
renders them. They never go into a route, `localStorage`, a log, or anything
that outlives the page. The QR code is drawn from them in the page and kept
nowhere.

**Resume, never compete.** One flow per process: Link while one runs opens the
sheet on that one, and a flow started on another screen — or before a reload —
is the user's own and is picked up, never offered as "another flow is running".

**Status is state, a flow's ending is an event.** The card is drawn from the
live status only; it never reads the link back out of a flow. How a flow ended
is told once, in the past tense — by the sheet, or by the card's *Last attempt*
notice when the sheet was closed.

**Green means listed.** The success colour is for the one fully good state: the
machine linked *and* this Pockode in the list. A link the relay has not
confirmed is not drawn as success: the cloud checks an instance before its
token, so "not listed" says nothing about whether the link is good.

## Where it lives: Settings → Cloud

A new built-in section, registered in `web/src/extensions/builtin/index.ts`:

| id | label | priority |
|----|-------|----------|
| `cloud-link` | Cloud | 60 — right after AI CLIs (50), the other machine-wide sign-in, and before Pockode (80) and Account (90) |

The section body is an intro and one card:

```
CLOUD
Open every Pockode on this machine — this one, other
projects and cluster nodes — from your cloud account.
┌───────────────────────────────────────────────────┐
│ ●  Linked as ada@example.com              Unlink  │  machine
│    ada@studio-mac                                 │
│ ✓  This Pockode is listed                Open ↗   │  this instance
│    cloud.pockode.com                              │
└───────────────────────────────────────────────────┘
```

```
CLOUD
Open every Pockode on this machine — this one, other
projects and cluster nodes — from your cloud account.
┌───────────────────────────────────────────────────┐
│ ○  Not linked                           [ Link ]  │
│    ada@studio-mac                                 │
└───────────────────────────────────────────────────┘
```

- **The intro** is `text-xs text-th-text-muted`, wraps, and is always there. It
  carries the scope — the whole machine — because a row's one-line subtitle
  would truncate it on a phone, and it says what the link is *for*, which no
  status line does.
- **The card** is the AI CLIs card's surface (`rounded-lg border border-th-border
  bg-th-bg-secondary px-4 py-3`), and its rows are `CliRow` with `CliRowNotice`:
  icon, one-line title, one-line subtitle, at most one action, colour on the
  icon only. The rows' box does not change height between ordinary states;
  attention states add a notice. A truncated email or machine name carries
  its full value in a `title` attribute. Every warning, error and *Linked to
  another cloud* row sets `CliRow`'s `wrap`: on a 320 px phone the text column
  beside a primary button is about 140 px, and a cut-off title is the one
  thing an attention state cannot afford.
- **The machine row** is always there, its subtitle the machine name
  (`machine_name`, *What the UI needs to read*). The machine is named on the
  card itself so the user can tell which machine this is before they link it.
- **The instance row** is there only while the machine is linked to this cloud
  (`credential: linked`, `relay` not `link_invalid`). Unlinked, "this Pockode is
  not listed" says nothing the machine row has not.
- **Open ↗** is an `<a target="_blank" rel="noopener noreferrer">` to
  `cloud_url`, styled `textButtonClass`; its subtitle is the cloud's host, so a
  self-hosted cloud names itself. It is the payoff of linking, and the one place
  in Pockode that leads to the list.
- **Unlink** is `cardTextButtonClass` with `text-th-error`, as **Sign out** is
  in `CliAccountRow`.
- **No Refresh button.** The status is a subscription
  (`cloud_link.subscribe`); a link or unlink of this cloud's token made by
  another process or a terminal reaches it through the relay. What the relay
  does not watch ([Known Limits](code/cloud-account.md#known-limits)) — any
  change while the relay is disabled, a link to another cloud appearing or
  going, a damaged file quarantined — is caught by subscribing again whenever
  the page becomes visible, as the AI CLIs section re-reads. The read is local
  and cheap.
- **The card is focusable** (`tabIndex={-1}`, as `PockodeSection`'s): when the
  sheet or a dialog closes into a state whose row no longer has the button that
  opened it — Link became Continue, Unlink became Link — focus goes to the
  card, never to `body`.

Desktop gets the same layout: Settings is `max-w-2xl`, and the action belongs
next to the line it acts on.

**While disconnected** the card keeps the last status it had (the app's
`ReconnectBanner` already says the connection is down) and its actions are
disabled; on reconnect the snapshot replaces it. Before the first status ever
arrives, the rows are skeletons.

### The machine row

A running flow wins; otherwise `credential` decides; `relay` only refines a
`linked` credential.

| State | When | Icon | Title / subtitle | Action | Notice |
|-------|------|------|------------------|--------|--------|
| Reading | before the first status | skeleton | skeleton / skeleton | — | — |
| Linking | the flow is `starting`, `waiting` or `finishing` | Spinner | "Linking…" / "Expires in m:ss" (`waiting`), "Approved, saving the link…" (`finishing`), "Starting…" (`starting`); followed by " · started earlier" when this page did not start the flow, so a cut on a narrow phone takes that and keeps the countdown | **Continue** — primary, opens the sheet | — |
| Not linked | `credential: none` | `○` `text-th-text-muted` | "Not linked" / {machine} | **Link** — primary | — |
| Linked, listed | `credential: linked`, `relay: attached` | `●` `text-th-success` | "Linked as {email}" / {machine} | **Unlink** | — |
| Linked | `credential: linked`, `relay` is `pending`, `not_attached`, `guest` or `disabled` | `●` `text-th-text-muted` | "Linked" / {machine} | **Unlink** | — |
| Link no longer valid | `credential: linked`, `relay: link_invalid` | `AlertTriangle` `text-th-warning` | "Link no longer valid" / {machine} | **Link again** — primary | below |
| Linked to another cloud | `credential: other_cloud` | `Info` `text-th-text-muted` | "Linked to another cloud" / {host of `other_cloud_url`} | **Link** — primary, behind a confirm | below |
| Unavailable | `cloud_link.subscribe` answered `-32013` | `Info` `text-th-text-muted`, row dimmed | "Linking unavailable" / "This Pockode can't store a cloud link" | — | below |
| Status unavailable | the subscribe failed otherwise | `AlertTriangle` `text-th-error` | "Couldn't read the link status" / "Retry, or reload" | **Retry** — primary | the server's error |

**Linked carries no email** unless the relay is attached. The email is what the
cloud answered the relay with, and nothing else on this side knows it *now*. A
flow's email is history: by the time the relay is pending, disabled or refused,
a terminal may have linked the machine to another account, and the card would
name the wrong one. Right after linking, the title reads "Linked" for the
seconds the relay takes, then "Linked as …"; the sheet has already named the
account.

"started earlier" and not "on another screen", for the reason
[cli-login-ui.md](cli-login-ui.md#the-card-states) gives: after a reload this
page is new, and nothing tells it apart from a second device. "This page
started it" is the set of flow ids this section's `start` calls returned.

"Status unavailable" exists so a failed read is never drawn as "Not linked"
(*No silent failures*): the benign guess would send the user into a link that
cannot fix what is wrong.

Notices, `text-xs`, under the row:

- **Link no longer valid**: "Your cloud account no longer accepts this
  machine's link — it was unlinked or revoked there, or the account was deleted.
  Every Pockode on this machine keeps running; none is listed until you link
  again." Footer: **Unlink**, for a user who wants the stale link gone rather
  than renewed — revoking it there answers 401 and the file goes, quietly.
- **Linked to another cloud**: "This machine is linked to {other host}, a
  different cloud from the one this Pockode uses ({host}). Every Pockode on it
  that uses {other host} is listed there." Footer: **Unlink**, which revokes the
  link at {other host}. Someone who sees this runs Pockode against more than one
  cloud — self-hosted, or development — and needs both names before changing
  anything.
- **Unavailable**: "The OS user running Pockode has no configuration directory
  — on Linux and macOS `$HOME` is unset, on Windows `%AppData%` — so there is
  nowhere to keep the link. Set it and restart Pockode." Muted, with no Retry:
  nothing short of a restart changes it.

#### Linking over another cloud's link

**Link** in *Linked to another cloud* asks first, with a `ConfirmDialog`,
`variant="danger"`:

> **Link to {host} instead?**
> This machine stays linked to {other host} only until the new link is
> approved. Then every Pockode on ada@studio-mac that uses {other host} leaves
> its list there, and the machine's entry stays in that account until you
> remove it on {other host}. To remove it cleanly, unlink first.
>
> Cancel · **Link**

The flow replaces the other cloud's credential without revoking it
([Known Limits](code/cloud-account.md#known-limits)), so the cost is the user's
to accept, and Unlink — which does revoke — is named as the clean way.

### The instance row

Only while the machine is linked to this cloud.

| `relay` | Icon | Title / subtitle | Action | Notice |
|---------|------|------------------|--------|--------|
| `attached` | `CheckCircle2` `text-th-success` | "This Pockode is listed" / the cloud's host | **Open ↗** | — |
| `pending` | Spinner | "Adding this Pockode…" / "Waiting for the cloud to list it" | — | — |
| `not_attached` | `AlertTriangle` `text-th-warning` | "This Pockode isn't listed" / "Linking again won't fix this" | — | below |
| `guest` | `AlertTriangle` `text-th-warning` | "This Pockode isn't listed" / "The server log says why" | — | — |
| `disabled` | `Info` `text-th-text-muted` | "This Pockode isn't listed" / "Remote access is off" | **Open ↗** — the machine's other instances may be | below |

- **`pending` promises no duration.** It usually settles in seconds, but a relay
  that cannot reach the cloud, or whose own token was refused, can leave it
  there ([Known Limits](code/cloud-account.md#known-limits)); a "few seconds"
  that never ends would be a lie, and a client timer would break *the server is
  the clock*.
- **`not_attached`** notice: "Your cloud account didn't accept this Pockode's
  entry — its folder name or path may contain characters the cloud doesn't
  allow, or the cloud had a problem. Restarting Pockode tries again; the server
  log names the reason. Other Pockode on this machine aren't affected." The
  status does not carry `account_error`, and the two causes need different
  words, so this one sentence covers both and points at the log, which has the
  value ([Why an Instance Is Not Attached](code/cloud-account.md#why-an-instance-is-not-attached)).
- **`guest`** with a linked credential is the oversized-request fallback
  ([Known Limits](code/cloud-account.md#known-limits)). It is rare and the
  status gives no reason, so the row says where the reason is and no more.
- **`disabled`** notice: "This Pockode runs with `-relay=false`, so it can't be
  listed. Other Pockode on this machine with remote access can." Linking is
  still offered with the relay off: the link is the machine's, and the user may
  be setting it up for the others.

### Last attempt

A flow this page saw running can end while the sheet is closed — the code
expires while the user is elsewhere. The card then shows, under the machine
row, a one-off notice in the past tense, and the row itself shows the live
state as usual:

| How it ended | Notice |
|--------------|--------|
| `failed`, `expired` | "Your last link code expired before it was approved." |
| `failed`, `declined` | "Your last link was declined on the approval page." |
| `failed`, `other` | "Your last attempt to link failed." and **Details** with the `detail` |
| The process restarted ([*Leaving the app*](#closing-and-cancelling)) | "Pockode restarted, so your last attempt to link stopped." |
| `canceled` | — (a cancel is somebody's deliberate act) |
| `linked`, `already_linked` without `left_behind` | — (the row already says it) |

`left_behind` — only ever on `already_linked` or `failed` — adds the *Left
behind* sentence to the same notice, in warning style, with **Open {host} ↗**:
one notice per attempt, never two. Every notice ends with **Dismiss** in its
footer.

It is shown only for a flow this page watched running, so a reload never brings
it back, and it is gone on **Dismiss**, on leaving Settings, and when a new flow
starts. It is an event told once, not state: the card never draws the link
from it.

## The link sheet

`CloudLinkSheet`, on the shared `Sheet`: a bottom drawer on a phone, the
`max-w-md` modal from the expanded tier up. It already locks the page, counts as
covering it, claims Escape and the dismissing click, and closes when its
surface is covered. Title: **"Link this machine"**, `subtitle` the machine name:
the sheet's first line says what is being linked.

It is opened by **Link**, **Link again** and **Continue**, and only from this
section; it lives inside it, like `CliLoginSheet` inside the AI CLIs section.

### Which flow it shows

The section keeps one copy of the latest flow, fed by the subscription's
snapshot, `cloud_link.changed`, and the replies of `start` and `cancel`. Within
one subscription, the copy with the higher `revision` wins whatever its `id` —
the process's revision counter is shared by all its flows, so a higher revision
is always the newer news (a contract change, *What the UI needs to read*). A new
snapshot (after a reconnect) replaces the copy outright: revisions restart with
the process.

- **Continue** opens the sheet on the running flow; `start` is not called.
- **Link** calls `cloud_link.start` and opens the sheet at once on *Starting*.
  Until the reply lands, a running flow in the copy is shown (another screen
  started it a moment earlier; the reply will be that same flow), and an
  *ended* flow is ignored: it is an earlier attempt, not this one.
- After that the sheet shows the copy. A flow started elsewhere while the sheet
  is up replaces the one it showed: it is still the user's own.
- **`start` rejected**: the sheet stays on *Starting*'s layout with the error
  under it (`text-xs text-th-error role="alert"`) and **Try again** · Close. A
  `-32013` here closes the sheet into the card's *Unavailable*.

### Phases

```
starting ──► waiting ──► finishing ──► linked
   │            │             │
   │            │             └──────► already_linked / failed
   │            └────────────────────► failed / canceled
   └─────────────────────────────────► already_linked / failed / canceled
```

One `role="status"` region, mounted with the sheet and empty, sits outside the
phase layouts; each phase writes its title into it, so a screen reader hears
each transition once — a live region mounted together with its text is often
not read at all. The countdown is never in it.

### Starting

Spinner, "Starting…". The footer has **Cancel**, disabled with a spinner until
the flow's id is known — `cloud_link.cancel` needs it, and the id comes with the
`start` reply or the notification that carries the new flow. The server checks
an existing link here, so this can end straight in *Already linked*.

### Waiting for approval

The approval page wants a browser signed in to the cloud. On a phone, that is
usually the phone's own browser; on a desktop, it is often the phone in the
user's pocket. So the order differs by pointer (`useHasFinePointer`), and the
rest is the same.

Phone (coarse pointer):

```
Link this machine                                 ✕
ada@studio-mac
───────────────────────────────────────────────────
Every Pockode on this machine — this one, other
projects and cluster nodes — will be listed in the
account you approve with.

      ┌─────────────────────────┐
      │       BCDF-GHJK         │
      └─────────────────────────┘
   Approve only if the page shows this code.

   [   Open approval page  ↗   ]      [ Copy link ]
   cloud.pockode.com/device…

   ◌ Waiting for approval…
     Expires in 9:32
───────────────────────────────────────────────────
                                          Cancel
```

Desktop (fine pointer; QR and code side by side from the expanded tier up, the
QR above the code below it, where a narrow window would not fit both):

```
Link this machine                                 ✕
ada@studio-mac
───────────────────────────────────────────────────
Every Pockode on this machine — this one, other
projects and cluster nodes — will be listed in the
account you approve with.

   ┌─────────┐   Scan with your phone
   │ ▓▓ ▓ ▓▓ │   Use a phone signed in to your
   │ ▓ ▓▓ ▓  │   cloud account.
   │ ▓▓ ▓ ▓▓ │
   └─────────┘   ┌───────────────┐
                 │  BCDF-GHJK    │
                 └───────────────┘
                 Approve only if the page
                 shows this code.

   [ Open on this computer ↗ ]        [ Copy link ]
   cloud.pockode.com/device…

   ◌ Waiting for approval…
     Expires in 9:32
───────────────────────────────────────────────────
                                          Cancel
```

- **The scope sentence first.** The one place the user commits to the link is
  where it has to say it covers the whole machine. `text-sm
  text-th-text-secondary`.
- **The code is for checking, not typing.** `verification_url` already carries
  it, so the page arrives filled in; the code is there so the user can see the
  page is approving *this* flow (RFC 8628 §5.4, remote phishing). It is
  `font-mono text-2xl tracking-widest`, centered, in a `bg-th-bg-tertiary` box,
  as the Codex device code is — but with no Copy button: nothing asks for it,
  and every copy is one more place a secret goes. It is shown exactly as
  `pockode login` prints it: an eight-character code split in two
  (`BCDF-GHJK`), any other left as it is; "Approve only if the page shows this
  code" is the CLI's sentence too. The visible box is `aria-hidden`, and an
  `sr-only` text beside it spells the characters out ("Code: B C D F, G H J
  K"), so a screen reader does not read the code as a word — an `aria-label`
  on a plain box is ignored by most of them.
- **The approval link** is `SignInLink`'s layout with its own label: an `<a
  target="_blank" rel="noopener noreferrer">`, **Copy link** beside it
  (`useCopyToClipboard`, its failed state showing the link in full), the host
  and path under it. `SignInLink` gains a `label` prop and a `primary` flag
  rather than being copied. On a phone it is **Open approval page**, primary.
  On a desktop it is **Open on this computer**, secondary: the QR is the path
  most likely to work there, and leads. Nothing is copied on open: there is
  nothing to paste on the other side.
- **The QR code** encodes `verification_url`, beside the code on a desktop, and
  is not rendered on a phone, where it would ask the user to scan the screen
  they are holding. It is drawn dark on a white tile with a four-module quiet
  zone in light and dark theme alike — scanners need the contrast, not the
  theme — at a whole number of pixels per module (4 px; a typical link comes
  out near 150 px with the quiet zone), `shape-rendering="crispEdges"`, with
  `role="img" aria-label="QR code for the approval page"`. The CLI draws the
  same link as a QR code in the terminal
  ([`pockode login`](code/cloud-account.md#pockode-login)).
- **Waiting**: spinner, "Waiting for approval…", and `ExpiryLine` under it.
- **Cloud unreachable** (`cloud_unreachable`): the spinner line becomes
  `AlertTriangle` `text-th-warning` "Can't reach the cloud. Still trying until
  the code expires." The flow carries on and so does the sheet; the user may
  approve, and the approval lands when the cloud answers.

The sheet moves on by itself when the server sees the approval. The user does
nothing in Pockode after the browser.

### Finishing

Spinner, "Approved, saving the link…". The footer drops **Cancel**: a flow that
holds a token can no longer be cancelled, and a button that does nothing would
lie. The sheet stays closable — closing leaves the flow to finish, as always.

### Linked

```
   ✓  This machine is linked
      Linked as ada@example.com

      ◌ Adding this Pockode…
───────────────────────────────────────────────────
            Open cloud.pockode.com ↗        Done
```

- `CheckCircle2` `text-th-success`, "This machine is linked", then "Linked as
  {the flow's `email`}" when the cloud gave it — left out, never "unknown",
  when it did not. Here the flow's email is right: it is this flow's own
  outcome, told as it happens. The machine is already the sheet's subtitle; a
  "Listed as …" line next to the instance line would read as "this Pockode is
  listed" before it is.
- Under it, the **instance row's line for the live `relay`**, the same words as
  the card: *Adding this Pockode…* → *This Pockode is listed*, or why it is
  not. Linking succeeded either way; this says whether this Pockode is in the
  list the user is about to open.
- Footer: **Open {host} ↗** (secondary, a link) and **Done** (primary). The
  sheet does not close by itself: this is the only confirmation.

### Already linked

`Info` `text-th-text-muted`, "Already linked", "This machine is linked as
{email}." and "To use another account, unlink first." **Done**. "Nothing
changed" is not said: with `left_behind` something did.

### Failed

One layout, as in [cli-login-ui.md](cli-login-ui.md#failed): `AlertTriangle`, a
title that says what happened, a body that says what to do, the actions, and —
for `other` — a collapsed **Details** (`Details`) with the server's `detail`.

| `failure.reason` | Title | Body | Actions |
|------------------|-------|------|---------|
| `expired` | "This code expired" | "Codes work for a few minutes. Start again for a new one." | **Start again** · Close |
| `declined` | "Linking was declined" | "It was declined on the approval page. Start again if that was a mistake." | **Start again** · Close |
| `other` | "Linking failed" | "Try again, or link from a terminal on the machine with `pockode login`." | **Try again** · Close · Details |

### Canceled

"Linking was cancelled" / "It was cancelled here or on another screen." —
**Start again** · Close. The user who pressed Cancel here does not see it:
Cancel closes the sheet. It is for a screen that was following the flow.

### Left behind

`left_behind` on *Already linked* or *Failed* adds a warning block under the
body: "An extra entry for this machine may be left in your cloud account.
Remove it on {host} ↗." The approval created a link nothing on this machine
uses, and only the web can remove it.

### Closing and cancelling

**Cancel** calls `cloud_link.cancel` with the shown flow's id. It needs no
confirm: a new flow is one tap away. While the request is out, Cancel shows a
spinner and the sheet is `dismissible={false}` — the server can take up to 10
seconds to stop the flow. The reply decides what happens:

- **`canceled`** — the sheet closes.
- **Any other phase** — the approval landed first (`finishing`, `linked`, …):
  the sheet stays open on that phase. Closing would hide a link the user had
  just approved.
- **Invalid params** — a newer flow replaced this one: the sheet follows the
  newer flow, as it would on its notification.
- **Any other failure** — the sheet stays open with the error under the footer
  (`text-xs text-th-error role="alert"`): the flow may still be running, and
  the user must not be told otherwise.

Every other way of closing only closes — the flow keeps running and the card
says *Linking* with **Continue**.

**Leaving the app closes nothing.** On a phone the user is in the browser while
the flow waits, and the PWA loses its socket. While there is no connection the
sheet keeps the flow it showed, with "Reconnecting…" in place of the waiting
line; the countdown carries on from `expires_at`, and Cancel is disabled. On
reconnect the snapshot is the process's current copy, and the sheet picks up in
whatever phase it reports — including *Linked* while the user was away.

A restart ends a flow, and the snapshot shows it only by what is missing. So:
when the sheet shows a flow that has **not ended** and the snapshot has no flow,
or a flow with another id, the process restarted. With no flow, the sheet says
"Pockode restarted, so linking stopped." with **Start again** · Close; with
another id — a screen that started a new flow since — it follows that one. A
sheet already on an ended phase keeps it: that is how the flow ended, whatever
happened to the process after.

## Unlink

**Unlink** opens a `ConfirmDialog`, `variant="danger"`:

> **Unlink this machine?**
> Every Pockode on ada@studio-mac — this one, other projects and cluster nodes —
> leaves ada@example.com's list. They keep running, and their URLs keep working.
> You can link again at any time.
>
> Cancel · **Unlink**

- The machine is `machine_name`; the account is the card's email, or "your
  cloud account's list" without one. On a link to another cloud it is "the list
  at {other host}".
- On *Link no longer valid* nothing is listed to leave, so the message is
  instead: "This removes the link ada@studio-mac no longer uses. Every Pockode
  on it keeps running, and their URLs keep working."
- It asks, where the sheet's Cancel does not, because it reaches every Pockode
  on the machine — far more than the screen it was pressed on — and getting
  back is a full link with a browser. It still says what is *not* lost: a user
  unlinking from a phone over the remote URL fears losing that URL, and they
  do not.
- `onConfirm` returns the request's promise, so the dialog shows it is working
  and refuses a second press and a cancel until it settles; a rejection is
  shown in the dialog. This is where it differs from **Sign out** in
  [cli-login-ui.md](cli-login-ui.md#sign-out), which closes at once and puts
  a spinner on the card: an unlink can leave something behind on the cloud,
  and the dialog is where the user is looking when it says so.
- **A timeout is not a failure.** The request has its own long timeout
  (*Timeouts*); if even that passes, the dialog says "No answer yet. The card
  will show whether it went through." rather than the client's timeout error,
  so the user does not press Unlink again into an unlink already done. Whenever
  the status shows `credential: none` while the dialog is up — answered or not
  — the dialog closes.

What the reply says:

| `unlinked` | What the user sees |
|------------|-------------------|
| `was_linked`, no `revoke_error` | The dialog closes; the card follows the status to *Not linked* |
| `was_linked`, `revoke_error` | The dialog closes; under *Not linked* a warning notice: "Unlinked here, but {host of `unlinked.cloud_url`} couldn't be told: {revoke_error}. Remove {machine} there so it isn't left in your list." with **Open {host} ↗**. Kept until the user leaves Settings or starts a link |
| not `was_linked` | The dialog closes; the status already says *Not linked* — another process or a terminal got there first. Nothing more to say |

The host in the revoke notice is the reply's, not the status's: unlinking a
link to another cloud revokes it there.

## Timeouts

`cloud_link.unlink` can take up to the cloud client's 30 seconds, and as long
again while an approved flow saves
([The `cloud_link` RPC](code/cloud-account.md#the-cloud_link-rpc)). The default
30-second client timeout would report a failure the server is about to turn
into success, so unlink gets a requester of its own, as `server.update` and
`git.commit.draft` do: `CLOUD_UNLINK_RPC_TIMEOUT_MS = 2 × 30 s + 15 s`, in
`wsStore` beside the others, with the derivation in its comment. `cancel` waits
at most 10 seconds on the server and keeps the default with the other methods.

## Cluster

Nodes serve this UI: they run `web`. The cluster frontend (`web-cluster`) gets
none of it in this change. The link is the OS user's, so linking from any
node's Settings links the cluster and every node with it.

## Components

| Piece | Where | What |
|-------|-------|------|
| `useCloudLinkSubscription` | `web/src/hooks/` | `cloud_link.subscribe` over `useSubscription` (`resubscribeOnWorktreeChange: false` — the status is the process's, not a worktree's); the latest-flow copy and its revision rule; the flow ids this page started; re-subscribes on page visibility. No global store: nothing outside this section reads the link, and the flow comes back with the snapshot |
| `cloudLink` RPC actions | `web/src/lib/rpc/cloudLink.ts` | `subscribe`, `unsubscribe`, `start`, `cancel`, `unlink` (long requester); `-32013` surfaced as its own error kind |
| `CloudLinkSection` | `web/src/components/Settings/sections/` | The intro, the card (machine row, instance row, *Last attempt*, the two confirms and the revoke notice), the sheet |
| `CloudLinkSheet` | `web/src/components/CloudLink/` | Every phase above |
| `QrCode` | `web/src/components/ui/` | An SVG drawn from a module matrix; knows nothing about links |

Reused: `CliRow` / `CliRowNotice`, `ExpiryLine`, `Details`, the button classes
in `CliLogin/loginParts.tsx`, `useCopyToClipboard`, `Sheet`, `ConfirmDialog`,
`useHasFinePointer`. `SignInLink` gains `label` and `primary` props. The card's
countdown ("Expires in m:ss" in a subtitle) and `ExpiryLine` share one
`useExpiryText(expiresAt)`, moved out of `ExpiryLine`, so there is one
countdown. `CliRow` and the button classes are by now shared by three sections
and two sheets; moving them to `components/ui/` is a fair follow-up, not part of
this change.

None of it goes into `@pockode/shared`: `web-cluster` does not use it.

### The QR code library

`web` has none today. Use **`uqr`** — no dependencies, ESM, a few kB, and
`encode()` returns the module matrix, so `QrCode` draws its own SVG with the
theme-proof colours above instead of styling a library's markup or a canvas.
`qrcode` (canvas and data-URL oriented, with Node-only dependencies) and
`qrcode.react` (a component with its own markup) are the usual alternatives and
give less for more.

## What the UI needs to read

Everything in [The Status](code/cloud-account.md#the-status), plus two fields
it does not have yet, both read locally like the rest, and one promise it does
not make yet:

- **`machine_name`** — `os_user@hostname` as the device flow sends it
  (`currentMachine`): this machine's name as it would be linked now. The card,
  the sheet's subtitle and both confirms are drawn from it; today it arrives
  only on a flow that ended `linked` or `already_linked`. The cloud named the
  machine when it was linked, so after a hostname change the two can differ;
  the UI names the machine the user is looking at, which is the one that
  matters for what Link and Unlink do. Absent when it cannot be computed; the
  copy then says "this machine".
- **`other_cloud_url`** — `cloud.json`'s `cloud_url`, with `credential:
  other_cloud`. The other cloud is named on the card and in the confirm before
  the user replaces its link; today it arrives only in the unlink reply, after
  the fact.
- **`revision` comparable across flows.** The process already keeps one
  counter for all its flows, but `Flow.Revision`'s comment and
  [The Status](code/cloud-account.md#the-status) promise only that copies with
  the same id compare. *Which flow it shows* needs the stronger promise —
  within one process, any two copies compare — written into both, so a later
  change to the server cannot quietly break it.

## Privacy policy

The privacy policy names `pockode login` as the way a machine is linked in three
places — what linking sends, what a never-linked machine sends, and how long a
link request is kept. Linking from Settings sends and keeps exactly the same,
so all three have to name it too, in the same change
([What an Instance Reports](code/cloud-account.md#what-an-instance-reports)).

## What to test

- Each machine-row and instance-row state renders its row of the tables;
  *Status unavailable* is never drawn as *Not linked*, `-32013` is drawn as
  *Unavailable* with no Retry, and only `relay: attached` is green or carries an
  email.
- Link with a flow running opens the sheet on it without calling `start`; while
  `start` is out an ended flow in the status is not shown; a rejected `start`
  shows its error with Try again.
- The copy with the higher revision wins regardless of the order a reply and a
  notification arrive in; a new snapshot replaces it.
- Only Cancel cancels: close, Escape, backdrop and being covered close the sheet
  and leave the flow; the card then shows *Linking* with **Continue**. Cancel is
  absent in `finishing`; a cancel answered with another phase keeps the sheet
  open on it; a failed cancel keeps it open with the error.
- Cancel is disabled until the flow's id is known.
- A dropped socket keeps the sheet on its flow; the reconnect snapshot resumes
  it in the server's phase, including *Linked*. A running flow missing from the
  snapshot reads as a restart; an ended phase on screen is kept.
- A flow this page watched that fails while the sheet is closed leaves a *Last
  attempt* notice; a reload does not bring it back.
- Link over another cloud's link asks first, naming both clouds.
- The QR code renders with a fine pointer only.
- Each failure reason renders its title, body and actions; `left_behind` adds
  its block.
- Unlink: the dialog names the machine and account, stays up while the request
  runs, closes when the status turns *Not linked*, and a `revoke_error` leaves
  its notice on the card.
- No user code or link reaches `localStorage` or the route.

## Considered and not done

- **One row for the link.** "Linked as ada@example.com" with a footnote for this
  instance hides the one case users will ask about — linked, but this Pockode
  is not in the list.
- **The email from the last flow while the relay catches up.** It reads state
  out of an event, and goes wrong as soon as a terminal links another account.
  A few seconds of "Linked" is the honest cost.
- **Hiding Link when the relay is off.** The link is the machine's; refusing it
  here would send the user to a terminal for something this Pockode can do.
- **The QR code on phones**, and **a Copy button on the user code** — see
  *Waiting for approval*.
- **Closing cancels.** A stray backdrop tap after approving in the browser would
  throw away a link the user just approved — and once approved it cannot be
  cancelled anyway.
- **Auto-closing on success.** The success phase is the only confirmation, and
  it is where the user learns whether this Pockode made it into the list.
- **An account switcher.** Switching is Unlink, then Link; doing it in one step
  would hide that every Pockode on the machine leaves the first account.
