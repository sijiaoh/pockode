# Agent Roles UI

The information architecture of the two agent-role screens — the list, its card,
the one setting that is about the whole set, the sheet that adds a role, and the
detail page a card opens. It was written to be implemented from and it has been:
one control, one place.

It does **not** restate what it borrows. The contrast this project's palette can
spend, and the reason a card is separated by space rather than by a fill, are
[project-ui.md §3](project-ui.md#3-the-row) — that table is the only place those
numbers are written down. The weight ladder and "weight follows frequency" are
[sidebar-ui.md § Visual weight](sidebar-ui.md#visual-weight). The 44px hit-area
floor is [responsive-ui.md](responsive-ui.md). Why a control that is waiting on
the settings snapshot draws a `Skeleton` and refuses input, rather than showing
the value a missing snapshot resolves to, is
[code/subscription-system.md](code/subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)
— this page is one of the call sites that rule names. The components that draw
all of it are
[projects/frontend.md § UI Structure](projects/frontend.md#ui-structure), which
describes them rather than the architecture.

## What this fixes

The previous list drew each role as a name and a line of facts, with a star per
row and a fixed footer holding the default-role field, `Add Role` and
`Reset to defaults`. Three things were wrong with it:

- **Nothing said what a role is for.** The engine and the counts tell two roles
  apart, but not which one to hand a job to; that is the role prompt, and it was
  on the detail page only. Story roles and task roles were mixed in one column.
- **The default existed twice.** A star on every row and the footer's field
  wrote the same setting. A star cannot say `None`, it cost 44px on every row for
  a setting changed a few times ever, and — once the default became the default
  *story* role — it had to vanish from task-only rows, so the column of stars
  stopped lining up with anything.
- **The footer was heavy and the flow broke.** About 200px of a phone screen
  held three rarely-used controls permanently, and `Add Role` grew an inline
  form that, on success, left the user on the list to go and find the row they
  had just made in order to write its prompt.

The redesign: **group the list by what a role runs; say the default story role
once, in words; put the frequent action (creating) where the project page puts
its own; sink the rare and destructive one (resetting) to the end.**

## 1. One column, four regions

```
┌ app header ────────────────────────────┐  Back + "Agent Roles", nothing else
├ scroll region ─────────────────────────┤
│ DEFAULT STORY ROLE                     │  ① the one setting about the set
│ [ PM                              ▾ ]  │
│ New stories start with this role.      │
│                                        │
│ Story roles                        (1) │  ② the roles, grouped (sticky headings)
│ ┌ PM  Default                      › ┐ │
│ │ Plans the story and creates tasks… │ │
│ │ Claude · Opus · 2 steps · 12 work… │ │
│ └────────────────────────────────────┘ │
│ Task roles                         (4) │
│ …                                      │
│ ────────────────────────────────────── │
│ Reset to defaults                      │  ③ the rare, destructive one
│ Replaces every role with the built-in… │
├ bottom action bar ─────────────────────┤
│ [ +  New Role ]                        │  ④ the frequent one
└────────────────────────────────────────┘
```

**The header navigates and does nothing else.** It is the app's own, not a bar of
the page's: this page names itself in it with the way back to the chat, and a
role's detail page as `Agent Role` with the way back to this list, like every
page over the chat ([agent-chat.md](agent-chat.md#the-session-screen)).

**One column at every width**, its content `mx-auto max-w-2xl` like Settings, and
the bottom bar's button held to the same width. No master–detail split on a
desktop: the whole app is one navigation axis — list, page, Back — and this screen
does not get a second one.

**The scroll container carries no padding of its own**; the padding is on the
content `div` inside it. The group headings pin to the container's padding edge,
and rows would otherwise show through the strip above a pinned heading — the
same constraint as the work list (`ListGroupHeading` says so).

Top to bottom is the ladder in [sidebar-ui.md](sidebar-ui.md#visual-weight),
with one exception for reach: `New Role` is the most frequent action, so it is
pinned under the thumb in the place `New Story` has on the project page, the
same accent button, rather than in reading order.

## 2. The card

Three lines: **what it is, what it is for, what is true of it.** The card is the
same idiom as a work row — `bg-th-bg-secondary` on the page, a `border-th-border`
hairline, one step to `bg-th-bg-tertiary` on hover — and what separates one card
from the next is the 8px between them, not the fill.

**Without that row's 2px left edge.** On a work row the edge carries the work's
state as hue. A role has no state, so the channel would be neutral on every row
forever, and a channel that always says the same thing says nothing.

```
┌──────────────────────────────────────────┐
│ PM  Default                            › │  line 1: name, the Default tag
│ Plans the story and breaks it into tasks │  line 2: the prompt's first line
│ Claude · Opus · 2 steps · 12 work items  │  line 3: what is true of it
└──────────────────────────────────────────┘
```

**The whole card is one `<button>`, and it holds nothing else.** There is no
control left on a card — no star, no delete — so the card no longer needs the
`::after` overlay that spread a name's hit area over a card with a second control
in it. It states `min-h-[44px]` itself, so it answers to the floor in
[responsive-ui.md](responsive-ui.md) directly. A `ChevronRight` at the end says
"this opens a page", `aria-hidden`.

**It is read as it is drawn**, with no `aria-label` replacing the content: a
label would be a second wording of the card that the next change forgets. A
button holds phrasing content only, so everything inside is a `span`, and an
`sr-only` comma sits wherever a line break or a drawn `·` is all that parts two
runs of text — otherwise a screen reader reads three lines as one long word
salad. The card reads as `PM, Default story role, Plans the story…, Claude ·
Opus, 2 steps`.

**Line 1** is the name, truncated, and on the default story role a `Default`
tag (`ui/Tag.tsx`, the neutral pill the `Recommended` tag also uses —
[answering-ui.md](answering-ui.md) says why it is neutral rather than accent).
The tag's visible word is `Default`; ` story role` follows it for screen readers
only, since the field above already says *which* default. It is drawn only once
the settings snapshot has arrived and only for a role that can run stories
(`isDefaultStoryRole` in `web/src/lib/initialRole.ts`, the one rule the list and
the detail page share): before the snapshot no row is the default as far as
anything on screen knows, and a guess would be the reassuring one.

**Line 2 answers "what is this role for"** with the first line of the role
prompt that has words on it, markdown marks taken off (`markdownExcerpt` in
`web/src/lib/markdownExcerpt.ts`), one line, truncated. Headings, quote and list
markers, links and emphasis go; underscores inside words stay, because
`snake_case` in a prompt is far likelier than `_emphasis_` and eating it would
misquote the prompt. A role with no prompt says `No role prompt`, muted and
italic, rather than collapsing the line: it is a gap the user has to fill, and a
card one line shorter than its neighbours would hide it.

**Line 3** is one line, never wrapped, clipped from the right, in fixed order:

| # | Slot | When | Why here |
|---|---|---|---|
| 1 | The engine, as one line (§3) | **every card** | It is the fact whose absence makes two roles with similar prompts indistinguishable. Unconditional, so every card is exactly three lines tall and the list keeps one rhythm |
| 2 | `{n} steps` | the role has steps | Whether a role runs once or in stages, which the list says nowhere else |
| 3 | `{n} work items` | the count is above zero | It decides whether deleting will be allowed (§5). Last, because it is the only fact here about something other than this role, and so the first worth losing when the line clips |

There is **no `Stories only` / `Tasks only` slot**: the group heading already
says it (§1), and saying it twice spends the line's width on nothing.

The separator belongs to the slot that follows it, so an absent slot takes its
separator with it. Singular and plural are written out — `1 step`, `2 steps`,
`1 work item` (`countOf` in `web/src/utils/plural.ts`). **Zero is not written**:
both counts vanish at zero rather than reading `0 steps`; the slot's presence
*is* the claim, the same rule as the work row's `{n} active`.

Two tiers, not three equal ones: the engine rises to `text-th-text-secondary`
when the role names an agent, and everything else stays at `text-th-text-muted`.
`Follow settings` stays muted too — it is the absence of an engine, and the
detail page's collapsed engine row draws that same one-tier drop.

### The groups

`Story roles`, `Task roles`, then `Story & task roles` — the order `RUNS_CHOICES`
in `web/src/lib/roleWorkType.ts` gives, which is also the order the detail page's
Runs control offers them (§8). An empty group is not drawn. Each heading is
`ui/ListGroupHeading.tsx`, the work list's own sticky heading with its count
pill, so the two lists group alike. Roles are not sorted within a group: the
server's order is kept, and a user has a handful of roles.

## 3. The engine is one sentence, written once

The engine on line 3 is **word for word** the line the detail page's collapsed
engine row prints, minus its icon:

| `agent_type` | `model` | `effort` | On the card |
|---|---|---|---|
| unset | — | — | `Follow settings` |
| `claude` | unset | unset | `Claude · Auto` |
| `claude` | `opus` | unset | `Claude · Opus` |
| `claude` | `opus` | `high` | `Claude · Opus · High` |
| an agent this build has no name for (`foo`) | an id the server no longer lists (`bar`) | — | shown as itself: `foo · bar` |

Three rules the wording cannot break:

1. **An unset agent is not resolved against Settings.** The record says "follow
   settings", and that is what the card says. Resolving it would be worst exactly
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

`describeEngine` in `web/src/lib/agentOptions.ts` is the single implementation,
and both surfaces call it. One sentence joined in two places is a sentence that
starts disagreeing with itself, and no test would go red when it did.

## 4. Nothing on a card waits

**There is no skeleton on a card**, and that is a claim about where the data
comes from rather than a decision about how to draw a wait. The name, the prompt
and the steps ride on the role record itself, arriving with the list. The
reference counts arrive **in the same subscribe reply as the roles**, and are
kept fresh by a notification of their own
([code/subscription-system.md](code/subscription-system.md#why-one-channel-carries-two-stores-changes)).
So a card that is on screen already holds everything it draws, and there is no
state in which a count is *missing* as opposed to zero. (The snapshot is applied
as two store writes, so a first paint can in principle land between them; the
card reads as zero for that frame, never as "loading". Merging them into one
write would close it and is left as an optional tidy-up.)

Two frontend constraints keep that true, and both are easy for a later change to
break:

1. **A `sync` notification must not clear the counts.** The counts live in the
   work store and move while no role changes, which is why they have their own
   notification; clearing them alongside a role sync would invent a card whose
   count has gone missing. `useAgentRoleSubscription.test.ts` holds it.
2. **A disconnect clears both**, and the list goes back to its own spinner.

The one thing on a card that does depend on the settings snapshot — the `Default`
tag — is a claim rather than a value, so it is simply not made until the snapshot
is there (§2). **The only placeholder on the screen is the default story role
field** (§7), drawn with the shared `Skeleton` + `ValueState` idiom, pulsing only
while the snapshot is still on its way
([why](code/subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)).
The field is drawn only once the list is there, so it has nothing else to wait
for.

**While the list is not there — loading, or failed — neither the field nor
`Reset to defaults` is drawn.** The field would name options it has not been
given, and Reset especially would overwrite roles the user cannot see. This is
not a control hidden without an explanation: the scroll region is saying why the
roles are absent, in the place the user is looking. Nor is it over-cautious. A
corrupt role file does not fail the subscription (the index is quarantined as
`.corrupt`, the store starts empty and re-seeds the defaults), so a failure here
is transport or server, and Reset is not a repair for that.

**`New Role` stays**, through loading and failure alike, as `New Story` does on
the project page: creating does not depend on the list, and a failure is
reported inside the sheet.

**The empty list names both ways out.** It is reachable exactly one way — the
user deleted the last role, because an empty store seeds the defaults on startup
— so it says so, and offers the reset right there, since the end-of-list Reset is
gone with the list:

```
No agent roles
Create one with the button below, or reset to the built-in roles.
[ Reset to defaults ]
```

## 5. Deleting lives on the detail page

**There is no delete control on a card.** Deleting a role is a
once-in-a-few-months act, and weight follows frequency
([sidebar-ui.md](sidebar-ui.md#visual-weight)); it does not get 44px on every
card. It has one home, at the bottom of the detail page under a `border-t`,
`Delete role` in `text-th-error` with a `Trash2`, behind a `danger` confirm
dialog. The card carries `{n} work items`, so the user knows the answer to the
question the deletion is about to raise before going to look for the button.

**The page says it ahead, and does not enforce it.** When anything uses the role
a muted line above the button says how much (`12 work items use this role.
Change their role before deleting it.`). The button stays enabled and the client
does not refuse ahead of the server: the count was pushed and has a small
staleness window, and refusing a delete the server would have allowed, on the
strength of a number that may have moved, is worse than letting the server say
no.

**The refusal is the server's sentence, printed as it stands.** One count serves
both jobs — the number on the card and the reason a delete is refused — so the
wording belongs where the refusal is decided:

> `Can't delete: 1 work item still uses this role. Change its role, or delete it, first.`
>
> `Can't delete: 3 work items still use this role. Change their role, or delete them, first.`

Three things follow from the wording living there:

- **No `Failed to delete: ` prefix.** The server's sentence is already whole, and
  a prefix makes it `Failed to delete: Can't delete: …`. Other failures — real
  internal errors — are still printed as they come.
- **A refusal is something the user comes back from**, so one already on screen
  is cleared when the delete is tried again — the count it named is exactly what
  they went off to change.
- **The way out that sentence points at exists**: the work detail page's Role
  field changes a work's role whatever its status, which is the path a user told
  to "change its role" actually walks.

**Deleting the default story role is accepted, and clears the default**
([data-model.md](projects/data-model.md#work-type-field)). That is a second
setting changing as a side effect, so the confirm dialog says so: `Delete "PM"?
This cannot be undone. It's the default story role; deleting it clears that
default.`

**Closed work counts.** `CountRoleRefs` does not filter by status, so a role whose
three work items are all finished still reads `3 work items` while the work
list's `Current` segment shows none of them. That is correct and deliberate: **it
has to be the same number that refuses the delete**, and two numbers that can
disagree would each make the other look broken. Whether finished work should stop
blocking a delete is a question about the server's delete rule, not about this
screen, and is not decided here.

## 6. Creating a role, and resetting them all

**`New Role` opens a `Sheet`** (`CreateAgentRoleSheet`, the shared `Sheet` that
`CreateStorySheet` uses) asking for two things:

```
New Role
───────────────────────────────
Name   [ Role name              ]
Runs   [ Stories | Tasks | Both ]
       Picked by story agents for the tasks they create.
───────────────────────────────
[ Cancel ]            [ Create ]
```

- **Only what the role is and what it runs.** The prompt, the engine and the
  steps each have an editor on the detail page, and a second editor here would
  be two places to write one field — the same rule as the create-story sheet
  ([project-ui.md §4](project-ui.md#4-creating-work-lands-you-on-its-detail-page)).
- **On success the user lands on the new role's detail page**, where the prompt's
  empty state asks to be filled in. The sheet hands the new id to its caller,
  which navigates, because navigation belongs to `AppShell` as it does for the
  story sheet. Before handing it over, the sheet adds the role from the create
  reply to the role store: the detail page reads that store, and the list
  notification is sent from the server's watcher on its own schedule, so it can
  land after the reply — and the page would say `Agent role not found` about
  the role just made.
- **Runs starts on `Tasks`.** Nobody creates a task by hand and the default story
  role is usually already there, so a new role is almost always one for story
  agents to hand tasks to. The hint under the control changes with the choice
  (§8's table).
- `Create` is disabled until the name has non-blank text; a refusal keeps the
  sheet and what was typed, with the error under the fields. The footer keeps
  `Cancel` beside `Create`, like the story sheet.

**`Reset to defaults` closes the scroll region**: a full-width text button under a
`border-t`, followed by `Replaces every role with the built-in set.` It sits at the
end because it is the rarest thing on the page and the most destructive, and the
end of the list is where a user arrives having already seen everything it would
replace.

- **No icon, and muted rather than `text-th-error`.** Either reason alone
  decides it: that token does not clear AA 4.5 in the five light themes
  ([project-ui.md §3](project-ui.md#3-the-row) measures it), so red would say
  nothing in half of them; and the weight of a destructive act belongs to the
  confirm dialog, `Reset agent roles` / `Replace every role with the built-in
  set? Custom roles and edits will be lost.`, which keeps its `danger` variant.
- **Its failure is printed outside every branch of the scroll region**, at the end
  of the content. A reset in flight when the socket drops takes the list back to
  loading and the button with it, and a message drawn beside the button would
  have gone too, leaving a failure with nowhere to be read.

## 7. The default story role, in words

The field at the top of the list is **the only control for the default story
role**, and the only place the answer is written as words:

```
DEFAULT STORY ROLE
[ PM                              ▾ ]
New stories start with this role.
```

Its heading is the Settings page's section heading, and the `<label>` is inside
it. The control is `RoleSelect` (`web/src/components/Project/RoleSelect.tsx`),
the native `<select>` every role picker in this project uses — the create-story
sheet and the work detail's Role field are the other two — as the story picker
(`workType="story"`): `None` plus the roles that can run stories, because the
server refuses any other as the default
([data-model.md](projects/data-model.md#work-type-field)). Choosing `None` stores
the empty string. When no role can run stories the field is disabled — there is
nothing to pick but `None`.

The field is controlled: it reads the setting straight back and keeps no
optimistic copy, so a failed change leaves it on the server's value, with the
error under it.

**Why one entry.** The old screen had a star per row as well. The star could
make a role the default in one tap, but it could not say `None`, it could not
say anything in words, and once the default could only be a story role it had to
be missing from task-only rows. The setting is changed a few times ever; it does
not earn a control on every card. The cards carry a read-only `Default` tag
instead (§2), and the detail page a `Default story role` tag (§9) — neither is a
second way to set it.

**The sentence under the field describes what the create-story sheet will
actually do**, landing on one of six outcomes:

| Outcome | Sentence |
|---|---|
| The stored default can run stories, and is what the sheet starts on | `New stories start with this role.` |
| Exactly one role can run stories, and it is not the stored default | `New stories use PM, the only role that runs stories.` |
| Several can, and none is the default | `New stories ask which role to use.` |
| None can | `No role runs stories. Set a role to run Stories (or Both), or add one.` |
| The stored id names no role | `The saved default no longer exists. New stories ask which role to use.` |
| The stored id names a task-only role | `Engineer can't run stories, so new stories ignore it. Pick a story role.` |

The last two are reachable only through a hand-edited `settings.json`: the server
clears the default whenever its role stops running stories or is deleted. With
no roles at all the field is not drawn; the empty list (§4) is already saying it.

**The rule is shared, not restated.** `resolveInitialRole` in
`web/src/lib/initialRole.ts` decides what the create-story sheet preselects, and
this sentence is read from the same call. A second copy of the rule here would be
a sentence that starts lying the day the sheet's preselection changes, with
nothing to turn red. Note what it implies: a single role that can run stories
wins over whatever is stored, so the second outcome is what the field says even
while it shows `None`.

The return value only says *which role to preselect*, so "none can", "several,
ask" and the two hand-edited cases all come back as the empty string; the
sentence tells them apart with `roleAcceptsWorkType` (§8) and the stored id.

A stored id with no role behind it gets an `Unknown role` option of its own and
stays selected, rather than falling back to `None`: `None` is an assertion that
Settings holds no default, and it does hold one. A stored task-only role likewise
stays selected, named with its restriction — `Engineer — tasks only`. `RoleSelect`
does both for every picker (§8).

**Before the settings snapshot** the field and its sentence are two `Skeleton`s —
never `None` first, which says there is no default and the user may well have
one. If the snapshot cannot be had, `SettingsLoadError` sits under the heading in
the field's place.

## 8. Which kind of work a role runs

A role may be restricted to stories or to tasks (`work_type`; the server's side,
and why the field exists, is
[projects/data-model.md](projects/data-model.md#work-type-field)). The server
checks it only when an assignment changes, so a work keeps a role it was given
before the role was restricted — and every surface below is written around that
being a legal state, not an error.

**One rule.** `roleAcceptsWorkType` in `web/src/lib/roleWorkType.ts` is the
client's copy of the server's `AgentRole.AcceptsWorkType` — empty takes either —
and every filter and check here asks it. Beside it: `workTypeSuffix`, the one
wording of a restriction beside a role's name (`stories only` / `tasks only`)
in the pickers; `WORK_TYPE_PLURAL`, where the work detail's sentences below get
`stories` and `tasks` from; and `RUNS_CHOICES` / `RUNS_LABEL` / `RUNS_HINT`, the
choices, their order and their hints, shared by the detail page and the
New Role sheet.

**On the detail page the control is called `Runs`**, and it comes first after
the name — before the engine, and both before the role prompt, because one short
row after an arbitrarily long markdown block is off the first screen on a phone.
A segmented control (`components/ui/ToggleGroup.tsx`, the one Settings' Session
section uses), `Stories` / `Tasks` / `Both`, in the order the list groups by.
`Both` sends `work_type: ""`, which is how `agent_role.update` clears the
restriction. It applies on tap like the engine does; the lit segment is the
server's record, not the tap, and a refused write leaves it where it was with the
server's message under it, cleared on the next tap. The line under it says what
the value means:

| Value | Line |
|---|---|
| Stories | `Runs stories. Can be the default story role.` |
| Tasks | `Picked by story agents for the tasks they create.` |
| Both | `Can run stories and tasks.` |

Nothing here mentions a person creating a task, because none does
([project-ui.md §4](project-ui.md#4-creating-work-lands-you-on-its-detail-page)).
When the role is restricted and anything uses it (the card's `{n} work items`
count), the line adds `Work items already using it keep it.` That states the
rule, not a finding about those items, so it is true whatever kind they are.

**Making the default story role task-only asks first.** The server accepts it
and clears the default ([data-model.md](projects/data-model.md#work-type-field)) —
a second setting changing as a side effect of this one — so the tap opens a
confirm dialog, `Make PM task-only?` / `PM is the default story role. Making it
task-only clears that default.`, and sends nothing unless confirmed. Every other
change applies at once: it is reversible and takes nothing off existing work.

**In a picker tied to a kind**, `RoleSelect` is given `workType` and offers only
the roles that take it. A stored role that does not is still the stored one, so it
stays as the selected option, named with the reason it would not otherwise be
offered — `PM — stories only` — on the same principle as `Unknown role` (§7).

**The create-story sheet** makes stories only and preselects by
`resolveInitialRole`, so a default restricted to tasks is no default there: the
sheet opens on `Select role...`, without an error, and the list's field has
already said so. A pick that stops taking stories while the sheet is open
(restricted from another tab or by an agent) is dropped and the field resolved
again as on opening, rather than kept beside a disabled Create that explains
nothing. Roles that exist but all take tasks only get the sheet's message instead
of the fields — see [project-ui.md §4](project-ui.md#4-creating-work-lands-you-on-its-detail-page).

**The work detail's Role field** filters its picker by the work's kind; choosing
again a kept role that no longer fits is "unchanged" and sends nothing.
Read-only, a kept role that does not fit gets a muted line under its name —
muted, not the error colour, since the server holds it legal:

> `PM only takes stories. It stays on this task until you change it.`

and with roles listed but none taking the work's kind, the open picker says
where to go: `No role takes tasks. Set one to take tasks in Agent Roles.` An empty
list says nothing — it is what a reconnect looks like while roles reload.

Deliberately not done: moving or refusing existing work when a role is
restricted.

## 9. The detail page

```
┌ app header ─ Back ("Back to agent roles") + "Agent Role" ┐
├ scroll region (max-w-2xl) ───────────────────────────────┤
│ PM                                               ✎      │  name, edited in place
│ Default story role · Used by 12 work items              │  summary, read-only
│ RUNS      [ Stories | Tasks | Both ]                    │  §8
│ ENGINE    [ ◆ Claude · Opus · High                ▾ ]   │  §3
│ ROLE PROMPT                                      ✎      │
│ STEPS                                            ✎      │
│ ─────────────────────────────────────────────────────── │
│ 🗑 Delete role                                          │  §5
└─────────────────────────────────────────────────────────┘
```

The same `max-w-2xl` column as the list. Section headings are the work detail's
(`text-xs font-medium uppercase text-th-text-muted`).

- **Name** — `useInlineEdit`: Enter saves, Escape cancels.
- **Summary** — a `Default story role` tag (same `Tag`, here first on its line)
  and `Used by {n} work items`, joined by `·`; either is left out when it does not
  apply, and the line is not drawn when neither does. Read-only: there is no "make
  default" button here, because the list's field is the one control (§7). Like
  the card's tag, the tag waits for the settings snapshot and claims nothing
  before it.
- **Runs** — §8. **Engine** — `AgentRoleEngineSelector`, unchanged by this
  redesign; this screen borrows its wording (§3) and changes none of its
  interaction.
- **Role prompt** — the work detail's Description interaction: a pencil opens a
  textarea with Save / Cancel. Empty, it is a dashed button reading `Add a role
  prompt — it's what tells the agent how to act.`, which is where a role made in
  the New Role sheet lands. Read-only, it is `MarkdownContent` in a box with
  `overflow-x-auto`, so a wide code line scrolls inside the box instead of
  sliding the whole page. Not clamped: the description is not either.
- **Steps** — with steps, `Work on this role moves through these steps in order.`
  under the heading; without, an `Add steps` button and `Without steps, work
  finishes in one go.` The editor stays *edit all, save, cancel*: the order is
  part of what is being edited, and per-row inline editing cannot express a drag.
  The drag handle is for fine pointers only; Move up / Move down reach the same
  order everywhere ([responsive-ui.md](responsive-ui.md)).
- **Delete role** — §5.

**While the role list is loading** — a direct link, or a reconnect — the page
draws skeletons, not `Agent role not found`: that would be said of a role that is
merely on its way. A failed list prints its error in the error colour; only a
loaded list without the role says `Agent role not found`, with the header's Back
as the way out.

## 10. Deliberately not done

- **Searching, sorting or filtering the list.** A user has a handful of roles,
  and the groups are the one axis worth having.
- **Quick actions on a card** (delete, duplicate). Rare; the detail page has room.
- **A two-pane layout on a desktop.** §1.
- **A default role per kind of work.** Only stories are created by a person, so
  only stories need one.
- **Anything about which work items count as references.** §5.

## 11. What the implementation had to get right

| # | Check | Held by |
|---|---|---|
| 1 | No card offers a delete control; a card is one button that opens the detail page | `AgentRoleListOverlay.test.tsx` |
| 2 | Roles are grouped Story → Task → Story & task, empty groups left out | `AgentRoleListOverlay.test.tsx` |
| 3 | Line 2 is the prompt's first line without markdown, or `No role prompt` | `AgentRoleListOverlay.test.tsx`; `markdownExcerpt.test.ts` for the stripping rules |
| 4 | The card reads as it is drawn, with spoken separators and no `aria-label` | `AgentRoleListOverlay.test.tsx` |
| 5 | The engine line for an unset agent, an unset model, and an unset effort — each printing what §3 says | `AgentRoleListOverlay.test.tsx` for the card, `AgentRoleEngineSelector.test.tsx` for the detail page, and `agentOptions.test.ts` for the two rules neither component can reach: `Follow settings` not being resolved, and an unlisted id printing as itself |
| 6 | Both counts absent at zero; no work-type slot on a card | `AgentRoleListOverlay.test.tsx` |
| 7 | `Default` marks the default story role only, and not a task-only role a stale setting names | `AgentRoleListOverlay.test.tsx` |
| 8 | The field offers only roles that run stories, reaches `None`, keeps a dangling or task-only stored id visible, and reports a failed change under itself | `AgentRoleListOverlay.test.tsx`; the `Unknown role` and suffixed options themselves in `RoleSelect.test.tsx` |
| 9 | The sentence matches the create-story sheet (§7), in each outcome | `AgentRoleListOverlay.test.tsx`; `initialRole.test.ts` for `resolveInitialRole`, the shared rule the sentence and the sheet both read |
| 10 | Before the settings snapshot nothing claims a default either way; an unavailable snapshot says why | `AgentRoleListOverlay.test.tsx`, and `AgentRoleDetailOverlay.test.tsx` for the summary |
| 11 | `New Role` opens the sheet, stays available while the list loads, and lands on the role it made — already in the role store, whether or not the list notification has arrived; the sheet sends Tasks unless told otherwise, nothing for Both, needs a name, and keeps its input on a refusal | `AgentRoleListOverlay.test.tsx`, `CreateAgentRoleSheet.test.tsx` |
| 12 | Reset confirms first, is withheld while the list is not there, reports a failure on its own line, and the empty list offers it | `AgentRoleListOverlay.test.tsx` |
| 13 | The server's refusal is worded exactly as §5 quotes it, in both plural forms; the client prints that sentence and nothing around it, does not refuse ahead of the server, says the count ahead of time, and does not leave a stale refusal standing through a retry | `rpc_agent_role_test.go` holds the wording, table-driven, character for character. `AgentRoleDetailOverlay.test.tsx` holds the other end: it asserts the alert's whole text **equals** the server's sentence, which is the only shape of assertion a prefix cannot survive |
| 14 | Deleting or making task-only the default story role says it clears the default; the server does clear it | `AgentRoleDetailOverlay.test.tsx`; `TestAgentRole_LosingStoriesClearsTheDefault` on the server |
| 15 | Runs offers Stories, Tasks, Both in the list's order, sends `""` for Both, lights the server's record and keeps it through a refusal, and adds the keep-it line only for a restricted role in use | `AgentRoleDetailOverlay.test.tsx` |
| 16 | The detail page waits for the list instead of saying `not found` | `AgentRoleDetailOverlay.test.tsx` |
| 17 | The counts arrive with the snapshot and are replaced whole by `ref_counts` | `useAgentRoleSubscription.test.ts`, and `agent_role_list_test.go` on the server side |
| 18 | A picker for one kind offers only roles that take it and keeps a stored one that does not with its suffix | `RoleSelect.test.tsx` |
| 19 | The create-story sheet skips a default that cannot take stories, has a message for no role taking them, and drops a pick that stops fitting | `CreateStorySheet.test.tsx`; `initialRole.test.ts` for the rule and `roleAcceptsWorkType` |
| 20 | The work detail says a kept mismatch in words, not as an alert; its picker offers only roles that fit, and says where to go when none does — but not while the list is empty | `WorkDetailOverlay.test.tsx` |

**Why this file lives here.** `docs/` holds per-feature design documents and
`docs/projects/` describes the project-management system's implementation. A UI
design for two screens is the former, so it sits beside
[project-ui.md](project-ui.md) — which links here rather than covering these
screens itself — while
[projects/frontend.md](projects/frontend.md#ui-structure) keeps describing the
components.
