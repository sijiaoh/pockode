# Agent Roles UI

The information architecture of the two agent-role screens — the list, its row,
the footer that acts on the whole set, and the detail page the row opens. It was
written to be implemented from and it has been: one control, one place.

It does **not** restate what it borrows. The contrast this project's palette can
spend, and the reason a card is separated by space rather than by a fill, are
[project-ui.md §3](project-ui.md#3-the-row) — that table is the only place those
numbers are written down. The weight ladder and "weight follows frequency" are
[sidebar-ui.md § Visual weight](sidebar-ui.md#visual-weight). The 44px hit-area
floor is [responsive-ui.md](responsive-ui.md). Why a control that is waiting on
the settings snapshot draws a `Skeleton` and refuses input, rather than showing
the value a missing snapshot resolves to, is
[code/subscription-system.md](code/subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)
— this page is two of the call sites that rule names. The components that draw
all of it are
[projects/frontend.md § UI Structure](projects/frontend.md#ui-structure), which
describes them rather than the architecture.

## The one thing this fixes

The list drew every role as a name, and a name is the one thing about a role that
does not tell you what it will do. Two roles called Engineer and Reviewer are two
identical rows: which agent each runs, which model, whether it has steps, whether
anything is using it — none of it was on screen until the detail page. Everything
else followed from having only that one line to work with:

- Deleting had a button on **every** row, 44px of the scarcest space on the
  screen, for something a user does a few times a year — drawn at the same weight
  as the star beside it, which changes a setting and is reversible in one tap.
- The header carried a `RotateCcw` that reset every role to the factory defaults.
  The most destructive action on the page wore no visible word, in the place a
  user reaches for navigation.
- The default role existed twice and was written down neither time: a star per
  row, and the create-work form's behaviour. Nothing on the screen said, in
  words, which role was the default — or that there was none.

## 1. Three regions, three jobs

```
┌ header ────────────────────────────────┐  Back + "Agent Roles", nothing else
├ scroll region ─────────────────────────┤  the roles, and only the roles
│  ┌ card ──────────────────────────┐    │
│  │ Engineer                    ★  │    │  line 1: name, and the default star
│  │ Claude · Opus · 2 steps · 3 …  │    │  line 2: what is true of it
│  └────────────────────────────────┘    │
├ footer ────────────────────────────────┤  fixed; does not scroll away
│  Default role  [ Engineer      ▾ ]     │  ① which one is the default
│  New stories and tasks start with…     │
│  + Add Role                            │  ② add one
│  Reset to defaults                     │  ③ put them all back
└────────────────────────────────────────┘
```

The three do not overlap. **The header navigates** — the one control that used to
be up there acted on the whole set of roles, which is what the footer is for.
**The scroll region holds roles.** **The footer holds the three things that are
about the set rather than about a member of it.**

The footer being outside the scroll region buys one property nothing else can:
**it is still on screen when the list is empty**, which is the state Reset to
defaults is the only way out of.

## 2. The row

Two lines: **line one is what you can do, line two is what is true.** The card is
the same idiom as a work row — `bg-th-bg-secondary` on the page, a
`border-th-border` hairline, one step to `bg-th-bg-tertiary` on hover — and what
separates one card from the next is the 8px between them, not the fill.

**Without that row's 2px left edge.** On a work row the edge carries the work's
state as hue. A role has no state, so the channel would be neutral on every row
forever, and a channel that always says the same thing says nothing. Copying it
to look alike would leave two screens disagreeing about what a coloured edge
means, for no gain.

**Line 1** is the name and one control:

| Slot | Position | Shape |
|---|---|---|
| Name | left, takes all the space the star leaves, truncated to one line | `<h2>` — the page's `h1` is the only heading above it and there are no group headings between |
| Default-role star | right, 44 × 44 | icon-only toggle |

**The whole card opens the detail, and the star is not swallowed by it.** The name
is the button, and an `::after` box at `inset-0` spreads its hit area over the
card — the padding and line 2 included, growing when the card grows — while
adding no second tab stop, because the overlay belongs to a button that is
already there. The star lifts itself above that overlay. The height is both
stated and covered: the overlay is the `::after` box, not the
button's own box, so it is the button's `min-h-[44px]` that answers to the floor
in [responsive-ui.md](responsive-ui.md).

**The star is at the end of the line, not the start.** It is a control, and this
project's row controls live at the end; a leading position in that idiom belongs
to decorative glyphs. It also makes DOM order the tab order — name, then star.

Its accessible name carries the role: `Set "Engineer" as the default role`. A
screen reader walking this list meets a column of identical verbs otherwise —
the same rule [project-ui.md §3](project-ui.md#3-the-row) states for the work
row's icon controls. It carries the role **while it is waiting, too**
(`Default role for "Engineer": loading`): there is one star per row, so a single
waiting label would be the very column of indistinguishable controls the rule
exists to prevent, and a wait is not a reason to stop saying which row you are
on.

**Line 2** is one line, never wrapped, clipped from the right, in fixed order:

| # | Slot | When | Why here |
|---|---|---|---|
| 1 | The engine, as one line | **every row** | It is the fact whose absence made two roles indistinguishable. Unconditional, so every card is exactly two lines tall and the list keeps one rhythm rather than growing and shrinking with the data |
| 2 | `{n} steps` | the role has steps | Whether a role runs once or in stages, which the list says nowhere else |
| 3 | `{n} work items` | the count is above zero | It decides whether deleting will be allowed (§5). Last, because it is the only fact here that is about something other than this role, and so the first thing worth losing when the line clips |

The separator belongs to the slot that follows it, so an absent slot takes its
separator with it. Nothing is right-aligned: there is no sort key on this list to
point at. Singular and plural are written out — `1 step`, `2 steps`,
`1 work item` — rather than left as `step(s)`.

Two tiers, not three equal ones: the engine rises to `text-th-text-secondary`
when the role names an agent, and everything else stays at the container's
`text-th-text-muted`. `Follow settings` stays muted too — it is the absence of an
engine, and the detail page's collapsed engine row already draws that same
one-tier drop.

**Zero is not written.** Both counts vanish at zero rather than reading `0 steps`;
the slot's presence *is* the claim, and most roles would otherwise spend the
line's width on something that has not happened. Same rule as the work row's
`{n} active`.

## 3. The engine is one sentence, written once

The line on the row is **word for word** the line the detail page's collapsed
engine row prints, minus its icon:

| `agent_type` | `model` | `effort` | On the row |
|---|---|---|---|
| unset | — | — | `Follow settings` |
| `claude` | unset | unset | `Claude · Auto` |
| `claude` | `opus` | unset | `Claude · Opus` |
| `claude` | `opus` | `high` | `Claude · Opus · High` |
| an agent this build has no name for (`foo`) | an id the server no longer lists (`bar`) | — | shown as itself: `foo · bar` |

Three rules the wording cannot break:

1. **An unset agent is not resolved against Settings.** The record says "follow
   settings", and that is what the row says. Resolving it would be worst exactly
   when the snapshot has not arrived, because the value it resolves to then is
   the most reassuring engine there is — Claude on Auto — which is the one answer
   a user on Codex must not be shown.
2. **An effort of Auto removes the segment** rather than printing `Auto`.
   Whichever level the CLI then picks is its own business, and the detail page
   drops it too; one extra word here would be the two screens saying different
   things.
3. **An id neither side has a name for is printed as itself**, not rewritten to
   Auto or to a known agent. The role really is still set to it, and presenting
   someone else's choice as Claude on Auto would be a lie about a stored value.
   This is not a gap needing a placeholder.

`describeEngine` in `web/src/lib/agentOptions.ts` is the single implementation,
and both surfaces call it. That is the point: one sentence joined in two places
is a sentence that starts disagreeing with itself, and no test would go red when
it did.

## 4. Nothing on line 2 waits

**There is no skeleton on line 2**, and that is a claim about where the data comes
from rather than a decision about how to draw a wait. Steps ride on the role
record itself, arriving with the list. The reference counts arrive **in the same
subscribe reply as the roles**, and are kept fresh by a notification of their own
([code/subscription-system.md](code/subscription-system.md#why-one-channel-carries-two-stores-changes)).
So a row that is on screen already holds both, and there is no state in which a
count is *missing* as opposed to zero — which is what makes the absence of a
skeleton honest rather than merely tidier. (The snapshot is applied as two
store writes, so a first paint can in principle land between them; the row reads
as zero for that frame, never as "loading". Merging them into one write would
close it and is left as an optional tidy-up.)

Two frontend constraints keep that true, and both are easy for a later change to
break:

1. **A `sync` notification must not clear the counts.** The counts live in the
   work store and move while no role changes, which is why they have their own
   notification; clearing them alongside a role sync would invent a row whose
   count has gone missing. `useAgentRoleSubscription.test.ts` holds it.
2. **A disconnect clears both**, and the list goes back to its own spinner.

**The whole screen has exactly two placeholders, and what they wait for is the
settings snapshot rather than the role list**: the star on each row, and the
footer's default-role field. Both use the shared `Skeleton` + `ValueState` idiom,
pulsing only while a value is still on its way
([why](code/subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)).

The field waits on one thing more, because it needs it: the list, to name its
options. It combines the two answers and **the less certain wins**, so a value
that is never coming does not pulse as though it were on its way.

**While the list is not there, the footer draws only that field: no Add Role, no
Reset to defaults.** Both act on a list that is not on screen, and Reset
especially would overwrite roles the user cannot see. This is not a control
dimmed without an explanation — the scroll region above is saying why the roles
are absent, in the place the user is looking.

Nor is it over-cautious. A corrupt role file does not fail the subscription (the
index is quarantined as `.corrupt`, the store starts empty and re-seeds the
defaults), so a failure here is
transport or server, and Reset is not a repair for that. A reconnect takes both
buttons away briefly along with the list; accepted, since both need the socket
anyway.

**The empty list names the way out.** It is reachable exactly one way — the user
deleted the last role, because an empty store seeds the defaults on startup — so
it says so:

```
No agent roles yet
Add one below, or reset to the defaults.
```

## 5. Deleting lives on the detail page

**There is no delete control on a row.** Deleting a role is a once-in-a-few-months
act, and weight follows frequency
([sidebar-ui.md](sidebar-ui.md#visual-weight)); it does not get 44px on every
row. It has one home, at the bottom of the detail page, behind a confirm dialog.
The row now carries `{n} work items`, so the user knows the answer to the
question the deletion is about to raise before they go looking for the button.

**The refusal is the server's sentence, printed as it stands.** One count serves
both jobs — the number on the row and the reason a delete is refused — so the
wording belongs where the refusal is decided:

> `Can't delete: 1 work item still uses this role. Change its role, or delete it, first.`
>
> `Can't delete: 3 work items still use this role. Change their role, or delete them, first.`

Four things follow from the wording living there:

- **No `Failed to delete: ` prefix.** The server's sentence is already whole, and
  a prefix makes it `Failed to delete: Can't delete: …`. Other failures — real
  internal errors — are still printed as they come.
- **A count above zero does not disable Delete Role, and the client does not
  refuse ahead of the server.** The count was pushed and has a small staleness
  window; refusing a delete the server would have allowed, on the strength of a
  number that may have moved, is worse than letting the server say no. Which
  also means a refusal is a thing the user is expected to come back from, so a
  refusal already on screen is cleared when the delete is tried again — the count
  it named is exactly what they went off to change.
- **The capitalisation is deliberate**, and the call site says so, because its
  neighbours are lowercase fragments (`agent role not found`) and the next reader
  would otherwise make it match them.
- **The way out that sentence points at exists**: the work detail page's Role
  field changes a work's role whatever its status, which is the path a user told
  to "change its role" actually walks.

**Closed work counts.** `CountRoleRefs` does not filter by status, so a role whose
three work items are all finished still reads `3 work items` while the list's
`Current` segment shows none of them. That is correct and deliberate: **it has to
be the same number that refuses the delete**, and two numbers that can disagree
would each make the other look broken. Whether finished work should stop blocking
a delete is a question about the server's delete rule, not about this screen, and
is not decided here.

## 6. The footer is three steps down

Top to bottom is most-touched to least-touched — the ladder in
[sidebar-ui.md](sidebar-ui.md#visual-weight) — which also puts the destructive one
last in reading order:

| | Control | Drawn as |
|---|---|---|
| ① | Default role | a labelled field: visible `<label>`, native `<select>`, 44px tall |
| ② | `+ Add Role` | full-width text button, `Plus` icon, muted until hover |
| ③ | `Reset to defaults` | full-width text button, **no icon**, muted |

**The missing icon is the step between ② and ③.** It separates the two rungs, and
it settles a second thing for free: there is no longer an icon here to collide
with the Restart and Reopen glyphs a work row wears, so no substitute for
`RotateCcw` had to be found.

**Muted, not `text-th-error`.** Either reason alone decides it: that token does
not clear AA 4.5 in the five light themes
([project-ui.md §3](project-ui.md#3-the-row) measures it), so colouring it red
says nothing at all in half of them; and the weight of a destructive act belongs to the
confirm dialog, which keeps its `danger` variant. An action that goes through a
dialog does not also need to be red at rest.

**The two failures have two places.** They used to share one paragraph under the
header, rendered as `resetError || defaultRoleError` — so a failed change of the
default role was invisible whenever a failed reset was also standing. Now a failed reset
is reported under Reset to defaults, and a failed change of the default role under
the default-role field. The settings-snapshot load error stays under the header:
it reports a third thing — that the snapshot cannot be read at all — and is the
partner of the field's placeholder, not of either of these.

The reset message is drawn **outside** the gate that hides ② and ③. A reset in
flight when the socket drops takes the list back to loading and the button with
it, and the message would have gone with them, leaving a failure with nowhere to
be read.

## 7. The default role, in words and on a row

The field is the only place on the screen that says what the default is:

```
Default role  [ Engineer            ▾ ]
New stories and tasks start with this role.
```

A **native `<select>`**, because that is already how this project asks for a role
in both of the other two places it asks. `None` plus one option per role, and
choosing `None` stores the empty string.

**The sentence underneath changes with the answer**, and it is a description of
what the create-work form will actually do:

| State | Sentence |
|---|---|
| The stored default is the one a new work would start on | `New stories and tasks start with this role.` |
| No default, and more than one role to choose between | `New stories and tasks ask which role to use.` |
| No default, and exactly one role | `New stories and tasks use <Name>, the only role.` |
| No roles at all | *nothing* |

**Which is why the rule is shared, not restated.** `resolveInitialRole` in
`web/src/lib/initialRole.ts` decides what the create sheet preselects, and this
sentence is read from the same call. A second copy of the rule here would be a
sentence that starts lying the day the form's preselection changes, with nothing
to turn red.

The last row is the edge that shared rule cannot answer on its own: its return
value says *which role to preselect*, so "there are none" and "there are several,
ask" both come back as the empty string. With no roles the form does not ask — it
refuses and sends the user back to this screen — so the footer says nothing, and
the empty-list message above is already saying it where the user is looking.

A stored id with no role behind it gets an `Unknown role` option of its own and
stays selected, rather than falling back to `None`: `None` is an assertion that
Settings holds no default, and it does hold one. The sentence, though, goes by
what the create form will do with an id it cannot resolve — ignore it — and not by
the fact that one is stored, so it reads from the table above as if there were no
default at all.

### Why both entries stay

The star and the field are two entries into one setting,
`settings.default_agent_role_id`, and four rules keep them from ever drawing a
contradiction:

1. **Both are controlled** — each reads the setting straight back, and neither
   keeps an optimistic local copy. "Star lit, footer says None" is not a state
   that can be drawn.
2. **Both write the same action.** The star toggles (its own id, or the empty
   string when it is already the default); the field writes what was chosen.
   Neither accepts input before the snapshot is known — the field also waits for
   the list, since it cannot offer options it has not been given.
3. **They do different jobs.** The star is *make it this one*, on the row already
   under the user's thumb, in one tap. The field is the only place the answer is
   written as words, and the only route to `None` — a star can clear the default,
   but then no row says that there is none. The original complaint was not that
   there were two entries; it was that neither of them said what the state was.
4. **Every failure to change the default lands under the field**, whichever
   control caused it. After a failure the star still shows the server's unchanged
   value, so the only thing needing an explanation is the sentence that claims to
   say what the default is — and the footer never scrolls away.

## 8. The detail page, and what did not change

The detail page keeps its shape: the name edited in place, the engine panel, the
role prompt, the steps editor, and Delete Role at the bottom. One thing in it
changed — the delete failure is printed without a prefix of its own (§5).

Deliberately not done:

- **A `RoleSelect` shared by all three role pickers.** There are now three nearly
  identical native selects — the create sheet, the work detail's Role field, and
  this footer — and the work detail's is the one of the three with no focus ring.
  Unifying them, and settling that difference with it, means editing two other
  screens, so it is a task of its own rather than something folded in here.
- **Steps edited row by row.** The editor stays *edit all, save, cancel*: the
  order is part of what is being edited, and inline per-row editing cannot
  express a drag.
- **A different engine control on the detail page.** This screen borrows that
  panel's wording (§3) and changes none of its interaction.
- **Anything about which work items count as references.** §5.
- **Grouping, sorting or filtering the list.** A user has a handful of roles;
  there is no axis worth spending a control on.

## 9. What the implementation had to get right

| # | Check | Held by |
|---|---|---|
| 1 | No row offers a delete control | `AgentRoleListOverlay.test.tsx` |
| 2 | The engine line for an unset agent, an unset model, and an unset effort — each printing what §3 says | `AgentRoleListOverlay.test.tsx` for the row, `AgentRoleEngineSelector.test.tsx` for the detail page, and `agentOptions.test.ts` for the two rules neither component can reach: `Follow settings` not being resolved, and an unlisted id printing as itself |
| 3 | Both counts absent at zero rather than written as `0` | `AgentRoleListOverlay.test.tsx` |
| 4 | The footer selects a default and can reach `None`; a dangling id stays visible | `AgentRoleListOverlay.test.tsx` |
| 5 | The sentence matches the create form in all four states of §7 — the three it writes, and the empty list where it writes nothing | `AgentRoleListOverlay.test.tsx`, in two tests; `resolveInitialRole` is the shared rule the sentence and the create sheet both read |
| 6 | A failed reset and a failed default-role change appear in their own places, and the reset message survives the list going back to loading | `AgentRoleListOverlay.test.tsx` |
| 7 | Add Role and Reset are absent while the list is not there | `AgentRoleListOverlay.test.tsx` |
| 8 | Before the settings snapshot, no star claims a default either way, each waiting star still names its own role in both waiting states, and nothing that does not depend on that snapshot is held up | `AgentRoleListOverlay.test.tsx`, in two tests |
| 9 | The server's refusal is worded exactly as §5 quotes it, in both plural forms; the client prints that sentence and nothing around it, does not refuse ahead of the server, and does not leave a stale refusal standing through a retry | `rpc_agent_role_test.go` holds the wording, table-driven, character for character. `AgentRoleDetailOverlay.test.tsx` holds the other end: it asserts the alert's whole text **equals** the server's sentence, which is the only shape of assertion a prefix cannot survive |
| 10 | The counts arrive with the snapshot and are replaced whole by `ref_counts` | `useAgentRoleSubscription.test.ts`, and `agent_role_list_test.go` on the server side |

**Why this file lives here.** `docs/` holds per-feature design documents and
`docs/projects/` describes the project-management system's implementation. A UI
design for two screens is the former, so it sits beside
[project-ui.md](project-ui.md) — which links here rather than covering these
screens itself — while
[projects/frontend.md](projects/frontend.md#ui-structure) keeps describing the
components.
