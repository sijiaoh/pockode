# Cluster UI

Why the cluster frontend (`web-cluster/`) is shaped the way it is.

[cluster.md](cluster.md#frontend-ux) describes what it *does* — the screens, the
actions, the wording — and is the fact where the two disagree. This file holds
what that description leaves out: the rules the behaviour was derived from, the
alternatives that were weighed and rejected, and the work deliberately left
undone. Read it before changing this UI: several of the things that look like
obvious improvements here were considered and turned down for reasons the
finished screens no longer show.

## What the panel is for

A cluster is a machine with several project directories on it. The panel's whole
job is **see which projects are up, and get into one**. Everything else —
registering a directory, stopping a server, clearing leftovers — is housekeeping
that happens a handful of times a year. A change that improves the housekeeping
at the expense of that first sentence is going the wrong way.

It is a lightweight operations panel, not a second Pockode client. It borrows
`web`'s visual language and its overlay primitive, and deliberately borrows
nothing else: no router (there is one screen), no query cache (there is one
poll), no icon library (a handful of inline SVGs instead — see
[what it shares and what it does not](#what-is-shared-with-web-and-what-is-not)).

## The three rules

Stated once here; the code applies each in several places and gives its local
reason there. When a new action is added, these are what decide its shape.

**1. The primary action is the one the user wants, not the one that changes
most.** A running node's primary button is Open; Stop is a rare action with a
real cost and belongs in the overflow menu. Giving Stop a full-width accent
button one thumb-width from where people tap to get into a project — which is
what this panel used to do — is how the wrong node gets stopped.

**2. A confirmation is for a cost that cannot be taken back.** Applied honestly
this removes more dialogs than it adds: Clean Up lost the danger-styled confirm
that used to guard it, because it deletes a file describing a process that is
already gone. The confirmations that remain each name the *actual* cost — the AI
sessions that end, the orphaned server that can no longer be stopped — rather
than saying "this cannot be undone", which names neither the fear people
actually have (my files!) nor the real hazard.

The corollary is that nothing here offers an undo. Cleanup destroys nothing;
Stop and Delete are confirmed. An "Undo" for an operation that already ran on a
remote machine would be a promise this panel cannot keep.

**3. One overlay form, and nothing stacked on it.** Below the expanded tier a
bottom drawer, at and above it a centred modal — the shared `Sheet`, one
primitive for every interruption in the app. A second question is asked *inside*
the surface that raised it: same sheet, new title, new footer. Besides removing
a whole class of dismissal and focus bugs, it is the better mobile shape — the
question lands where the thumb already is instead of in the middle of the
screen.

## What was rejected, and why

**A password in the URL, so that a bookmark could sign you in.** The panel used
to accept `?password=` (and `?token=`, its pre-rename spelling), strip it back
out of the address bar and go straight to the node list. That was removed, and
the stripping is why: it cleans the one copy we can reach and none of the
others. By the time the page runs, the browser has already put the whole URL in
history and in address-bar autocomplete, the bookmark or shared link the visit
came from still holds it, and on a phone all of that syncs to the user's other
devices. Behind that password is arbitrary code execution on the host
([code/authentication.md](code/authentication.md#trust-model)); what the
shortcut bought was not typing it a second time. Something that expires and
can be revoked may be traded for that convenience — the session token is
exactly that, and is why a reload does not ask again — but the password itself
may not.

**A filter or a search field over the list.** The list groups instead. A filter
hides nodes behind a control and leaves a dead end whenever it matches nothing,
and the summary chips that used to sit above the flat list had the same failing
from the other side: they announced a stale node and then left it to be hunted
for. A group is always complete, always scannable, and carries its own count. Search is [left undone on
purpose](#left-undone-until-there-is-evidence).

**Repairing `web-cluster`'s own `ResponsivePanel` instead of deleting it.** Its
desktop form was a box pinned to the top-right corner, anchored to nothing —
because it was a fork of `web`'s panel that had dropped the `triggerRef`
anchoring that is the entire reason that component exists. Re-adding anchoring
and collision handling to a fork would have answered duplication with more
duplication. Cluster has no anchored-dropdown use case at all: none of its
overlays hangs off a toolbar, and a centred modal is the correct desktop form
for every one of them. The duplicate was removed rather than promoted.

**Keeping `ConfirmDialog` for the cluster's two confirmations.** It stays in
`@pockode/shared` and `web` still uses it, but both cluster call sites were
confirmations raised from inside an open sheet — exactly the stacking rule 3
exists to remove. The running-node Delete needs three actions besides, which a
confirm/cancel pair cannot express and a `Sheet` footer can.

**Remembering the node start password.** It was held in memory for the tab's
lifetime — one password for every node — so the first Start of a session opened
the sheet and every later one, on any node, was a single tap. That is gone:
every Start asks again. What it bought was one sheet per session; what it cost
was a second secret sitting in the frontend, and a UI whose most common path
started a server with a password nobody had in front of them — the same
password that server then asks for at sign-in. Persisting it to `localStorage`
is the same trade taken further and is rejected the harder for it: that storage
already holds the cluster's session token, so it adds no new *class* of
exposure, but it would make the node secret durable to buy back a convenience
that was not worth keeping even in memory.

**A `node.check_path` RPC to validate the path as the user types.** It was
specified and then dropped, and not because the payoff was small: it cannot buy
what it appears to. The same checks already exist in `resolveDir`
(`server/cluster/node/store.go`) and its messages are specific (`path does not
exist`, `path is not a directory`, `could not create directory`), so this would
be a second copy of one rule. Worse, its answer expires on the way back: the
directory can be created or removed between the check and the submit, so the
form has to handle the identical errors anyway and this replaces nothing. The
friction it was aimed at, "the directory doesn't exist yet", is instead resolved
inside the form by relabelling the submit button, which needed no backend change
at all.

## What is shared with `web`, and what is not

`web` is the larger, more featureful client. The temptation is to reach into it;
the rule is to promote only what genuinely has two consumers, and to let the
rest diverge.

| From `web` | Decision |
|---|---|
| `Sheet` | **Promoted.** The one genuine overlap — both projects want the same drawer/modal at the same width. Its `lucide-react` icon became an inline SVG on the way: `@pockode/shared` compiles into both bundles, so an icon library added for it would be paid for twice. |
| `ReconnectBanner` | **Presentational half promoted.** The escalation threshold and the copy are the same in both; *whether* the connection is down is not — the two stores answer it differently enough that a shared component reading either would have to know about both. Each project keeps a thin store-connected wrapper. |
| `Spinner`, `createAuthStore`, `getWebSocketUrl`, `useIsExpanded`, `BREAKPOINTS` | **Already shared, and used here** — some directly, the width ladder through `Sheet`. |
| `ConfirmDialog` | **Shared, but unused here.** Both of its cluster call sites became in-sheet confirmations (above); `web` is unaffected. |
| `ResponsivePanel` (anchored dropdown) | **Stays in `web`.** No cluster use case; do not promote it here later either. |
| `ActivityBadge` | **Not reused.** Typed to `Activity`, which is derived from a work and a session's turn — neither of which the cluster panel has. Cluster keeps its own three-state dot/pill. Its *contrast* reasoning — hue on the border, not on the letters — is worth copying; the component is not. |
| `PullToRefresh`, `BottomActionBar`, `PanelSection` | **Not reused.** They would drag `web`'s complexity, and one of them a dependency, into a panel whose whole argument is that it is small. |

Two obligations follow from anything living in `@pockode/shared` and are easy to
miss because both fail silently and can fail in one project while the other is
fine: each stylesheet must name the shared source in an `@source`, and must
declare every project-level `@utility` a shared component uses. Both are stated
and tested — see the root `AGENTS.md`.

## Left undone, until there is evidence

Each of these is a reasonable idea whose cost is known and whose need is not.
Listed with the signal that would justify it, so the next person adds it on
evidence rather than on taste.

| Deferred | Add it when |
|---|---|
| A search field over the list | A real cluster passes roughly 20 nodes. Groups plus sticky headers carry a few dozen fine. |
| Pull-to-refresh | Somebody asks. It needs `react-pull-to-refreshify`; the 5 s poll and the visibility catch-up cover the same ground for free. |
| `node.check_path` | The "I only find out at submit" friction is reported in real use — and then only with the duplicated rule and the check/submit gap above accepted openly. |
| Migrating `web`'s two remaining hand-rolled body-scroll locks (`web/src/components/Files/UploadConflictDialog.tsx`, `web/src/components/ui/ResponsivePanel.tsx`) to `useLockBodyScroll` | It is pure `web` work, not cluster work. Correct today only because neither has an overlay it can stack with — which is fragile, not safe. Whether the page is covered no longer rides on it: `ResponsivePanel` registers with `useCoverPage` in both tiers ([answering-ui.md](answering-ui.md#who-owns-escape)). |
