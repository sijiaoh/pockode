# Schedules UI

The screens for schedules: the Project tab's entries, the list of schedules,
the sheet that makes one, the detail page a row opens, the period input, and
the path from a job run's chat back to the schedule that made it. Engineers
implement from this document, so every control here has one place and every
rule has one owner.

It does **not** restate what it borrows. A run is a work, and everything a work
row and a work detail page are — the slots, the glyphs, the lifecycle buttons,
the contrast budget — is [project-ui.md](project-ui.md) and
[lifecycle-ui.md](lifecycle-ui.md). The weight ladder is
[sidebar-ui.md](sidebar-ui.md#visual-weight), the 44px floor is
[responsive-ui.md](responsive-ui.md), and the screens that set a role apart for
jobs are [agent-roles-ui.md §8](agent-roles-ui.md#8-which-kind-of-work-a-role-runs).
How the scheduler fires, skips and fails is
[code/work-system.md](code/work-system.md#schedules); the wire is
[projects/api.md](projects/api.md#schedule).

> **A schedule is a setting, its runs are work.** The schedule screens are
> shaped like the agent-role screens, because a schedule is a standing piece
> of configuration that a person edits a few times ever. Every run is drawn and
> handled by the work components unchanged, because a run *is* a work — it is
> stopped, answered, reopened and chatted with exactly as a story is.

This has landed, and these are the screens: what follows describes what was
built. The components themselves are described in
[projects/frontend.md](projects/frontend.md#schedulelistoverlay); this document
is the why.

That sentence decides most of what follows: where delete lives, why the list
holds still, and why nothing about a run gets a component of its own.

## 1. The Project tab

```
┌ Project tab ───────────────────┐
│ ☑ Stories                   ●  │  ListChecks — was "Project"
│ ⏰ Schedules                 ●  │  CalendarClock — new
│ 👤 Agent Roles                  │  UserCog
└────────────────────────────────┘
```

- **The first entry is `Stories`, no longer `Project`.** The entry opens the
  story list, and with a second list of work beside it, "Project" no longer
  said which one. The tab itself is still called Project: it is the place, the
  entries are what is in it. The list's header title is `Stories` too, and the
  work detail's Back label `Back to stories`. Nothing else about that screen
  changed.
- **`Schedules` sits second**, between the two because it is used more than
  Agent Roles (runs ask questions; roles are set up once) and less than
  Stories.
- **Each entry carries its own dot.** `Stories` keeps `useWorkNeedsAttention`.
  `Schedules` gets `useScheduleNeedsAttention`: some schedule's `last_run`
  satisfies `needsAttention` ([lifecycle-ui.md §4](lifecycle-ui.md#4-attention-dots)
  — the same predicate, run on the row the schedule carries, §9 A).
- **The tab's bit is the OR of the two**, so a job asking a question lights
  the tab, which the work list's dot alone could not: jobs are kept out of the
  work list. The OR is one hook, `useProjectNeedsAttention()` in
  `lib/scheduleStore.ts`, and `useSidebarAttention` reads it where it read
  `useWorkNeedsAttention`, so the tab badge, its tone and the header button
  that brings the sidebar back all move together. `ProjectTab` reads the two
  halves separately, one per entry.
  - Only the latest run is read. That covers every run being *driven*: a firing
    is skipped and Run now refused while the previous run is `active`
    ([work-system.md](code/work-system.md#schedules)), and §9 D refuses every
    other start of a job beside an active run, so at most one run per schedule
    is `active` — with one exception nothing can refuse, an older run woken by
    a message in its chat (§11). It does not cover an older run left `stopped`
    with a question unanswered, which drops out of `last_run` at the next
    firing; that is §11's too, and accepted.
  - A failed firing (`last_failure`) does not light a dot, for the reason
    `stopped` does not: it needs a person whenever they get to it, not now.
    The row's error edge says it (§3).

## 2. Routes and navigation

| Screen | Route | Overlay state |
|---|---|---|
| Schedules | `/schedules` | `{ type: "schedule-list" }` |
| Schedule detail | `/schedules/$scheduleId` | `{ type: "schedule-detail"; scheduleId }` |
| A run | `/works/$workId` — the existing work detail | unchanged |

Both new routes have the `/w/$worktree` variants (`WT_ROUTES.schedules`,
`WT_ROUTES.scheduleDetail`) and the shared `overlaySearchSchema`, exactly as
`agentRoles` / `agentRoleDetail` do, and in every place those do:
`lib/routes.ts`; `router.tsx`, detail route registered before list route, as
the role pair is; the URL→overlay matching in `hooks/useRouteState.ts`;
the `NavToOverlay` union (`NavTarget`) and `buildNavigation` in `lib/navigation.ts`; and the
`OverlayState` union in `types/overlay.ts`. The list is global across
worktrees either way.

`AppShell` owns every navigation, as it does for work and roles
([project-ui.md §4](project-ui.md#4-creating-work-lands-you-on-its-detail-page)):
`handleOpenScheduleList` and `handleOpenScheduleDetail(id)` beside
`handleOpenAgentRoleList`, built with `overlayToNavigation`. No schedule
component routes itself.

```
ProjectTab
  ├── "Stories"     → WorkListOverlay …                    (unchanged)
  ├── "Schedules"   → ScheduleListOverlay
  │                     ├── (tap row)       → ScheduleDetailOverlay
  │                     │                       ├── (tap run row)  → WorkDetailOverlay (job)
  │                     │                       └── (run chat icon)→ Chat session
  │                     └── "New Schedule"  → CreateScheduleSheet → ScheduleDetailOverlay
  └── "Agent Roles" → AgentRoleListOverlay …               (unchanged)

Chat session → session panel "Work" row → WorkDetailOverlay (job)
                                            └── schedule link → ScheduleDetailOverlay
```

**Back**, one rule per screen:

| From | Back goes to | Label |
|---|---|---|
| Schedules | the chat | the app's own, as every list over the chat |
| Schedule detail | `/schedules` | `Back to schedules` |
| A job's detail, its schedule exists | that schedule's detail | `Back to schedule` |
| A job's detail, its schedule deleted | `/schedules` | `Back to schedules` |

The job rule is the task rule (`Back to parent story`) applied to the other
kind of parent: Back is decided by what the work belongs to, read off the data,
never by where the user came from. So a job opened from its chat goes Back to
its schedule as well — which is the way to the schedule §8 is about.

## 3. The schedules list

```
┌ app header: ← "Schedules" ─────────────────────┐
├ scroll region (max-w-2xl) ─────────────────────┤
│ ┌──────────────────────────────────────────┐   │
│ ▌ Nightly dependency audit          [◯━]  │   │  line 1: title, switch
│ ▌ Daily at 03:00 · Next in 5h            │   │  line 2: period · next
│ ▌ ⏵ Running · 2h ago                     │   │  line 3: latest run
│ └──────────────────────────────────────────┘   │
│ ┌──────────────────────────────────────────┐   │
│ ▌ Weekly changelog draft            [━◯]  │   │
│ ▌ Fridays at 17:00 · Off                 │   │
│ ▌ ⚠ Last run failed · 3d ago             │   │  error edge
│ └──────────────────────────────────────────┘   │
│ ┌──────────────────────────────────────────┐   │
│ ▌ Release notes for v2            ✓ Done  │   │  one-time, done (§6.6)
│ ▌ Once on Mon 3 Nov at 09:00             │   │
│ ▌ ◦ Closed · 2d ago                      │   │
│ └──────────────────────────────────────────┘   │
├ bottom action bar ─────────────────────────────┤
│ [ +  New Schedule ]                            │
└────────────────────────────────────────────────┘
```

One column at every width, content `mx-auto max-w-2xl`, the scroll container
unpadded with the padding on the content inside it — the agent-role list's
frame ([agent-roles-ui.md §1](agent-roles-ui.md#1-one-column-four-regions)).
`New Schedule` is the accent button in a `BottomActionBar`, where `New Story`
and `New Role` are.

### 3.1 The row

The card idiom of a work row: `bg-th-bg-secondary`, `border-th-border`
hairline, `hover:bg-th-bg-tertiary`, 8px between cards (`space-y-2`), and
**the 2px left edge**, which a role card drops because a role has no state. A
schedule does — its latest run's — so the edge is kept and carries:

| Edge | When |
|---|---|
| `border-l-th-error` | `last_failure` is set |
| the latest run's own edge | otherwise, when there is a `last_run`: warning when it satisfies `needsAttention`, error when it is `stopped`, neutral else — `WorkRow`'s rule, in `WorkRow`'s order |
| `border-l-th-border` | no run and no failure |

The failure goes first because while it is set it is the schedule's current
state, and the latest run is then an older attempt. The run half is not
restated: `WorkRow`'s inline `edgeClass` was extracted as
`workEdgeClass(work)`, exported from `WorkRow.tsx`, and `scheduleEdgeClass`
calls it — one predicate for both surfaces.

**The card opens the detail, and holds one control: the switch** — none at
all once a one-time schedule is done (§6.6). The title is
a `<button>` covering the card with the `after:inset-0` overlay `WorkRow` uses;
the switch lifts itself above it with `relative z-10`. The title states
`min-h-[44px]`. The card is `h2`-headed (the page's `h1` is the header, and
there are no groups between).

**Line 1** — the title, truncated; the switch at the end (§3.2), or `Done`
in its place for a one-time schedule that is done (§6.6).

**Line 2** — one line, never wrapped, clipped from the right, two slots:

| Slot | Tier | Content |
|---|---|---|
| Period | `text-th-text-secondary` | `PeriodWords` (§6.4), followed by the schedule's zone label (`(Tokyo)`) only when it is not the device's zone (§6.5) |
| Next | `text-th-text-muted` | Done (§6.6): nothing — the slot and its ` · ` are left out. Enabled: `Next in 5h` (`formatRelativeFuture(next_run_at)`, beside `formatRelativeDate` in `utils/relativeTime.ts`, with its steps: `in 1m`, `in 5h`, `in 3d` — never "now", and hours and days rounded rather than floored, so 47h is `in 2d`); nothing while no next firing is known. Disabled: `Off` |

The period is first because it is the one fact that says what this schedule
*is*; "next" is derived from it.

**Line 3** — the latest run, and the only line that moves on its own:

| Case | Line 3 |
|---|---|
| `last_failure` set | `AlertCircle` (error tone) + `Last run failed` + `· {age of last_failure.at}` |
| `last_run` present | `ActivityIcon` of the run + its activity label + `· {age of last_run_at}`. `1 to answer` follows the label when the run owes answers, as slot 2b does on a work row |
| done because it passed while off (§6.6), no `last_run_at` | `Did not run: it was off`, muted — the user turned it off, so it is a fact, not a warning |
| neither, `last_run_at` set | `Latest run deleted · {age}`, muted |
| neither, no `last_run_at` | `No runs yet`, muted |

A failure wins over the run because while it is set it is the schedule's
current state ([data-model](projects/data-model.md#schedule): the next started
run clears it). The message itself is on the detail page; the row says only
that one exists — a sentence in a line that clips arrives as its first two
words. The label is untinted and the glyph carries the tone, the row rule from
[project-ui.md §3](project-ui.md#3-the-row).

**No Chat or Stop control for the run on this row.** The run's own row, with
both, is one tap away on the detail page. Two more icons on a settings card
would be a second copy of the work row's controls that drifts from the first.

### 3.2 The switch

`ui/Switch.tsx` is a `<button role="switch" aria-checked>` with a 36 × 20
track (`h-5 w-9`), accent when on and `bg-th-border` when off (set apart from
a card's fill, hovered or not), and the `touch-target` utility for its hit
area (36px under a fine pointer, 44px under a coarse one). The thumb carries the contrast against the track. The same
component is the detail page's (§4), and so is the request behind it:
`hooks/useScheduleEnabledToggle.ts`, one hook for both places.

- **It applies on tap** with `schedule.update {id, enabled}`. There is nothing
  to save: turning a schedule off and on is reversible and costs nothing.
- **The position is the server's record, not the tap.** While the request is in
  flight the switch is `aria-busy` (with `cursor-wait`) and ignores presses;
  the store's notification moves it. Busy is never `disabled`, which would
  drop keyboard focus, and never dimmed, which would take the thumb under 3:1.
  A refusal leaves it where it was and prints the
  server's message as line 4 of the card, `text-th-error`, `role="alert"`,
  with the switch `aria-describedby` it — `WorkRow`'s line 3, with its three
  clearing rules (retry, the value changing under it, leaving the screen). The
  hook keeps the refusal together with the value it refused, so the message
  shows only while the stored value is still that one — whichever of the
  refusal and the notification arrives first.
- Its accessible name is `Run "<title>" on schedule`; `aria-checked` says
  whether it does.
- **A done one-time schedule has no switch** (§6.6): there is nothing left to
  turn on. Before its time it has the switch like any schedule, and off means
  it will not run at that time. A refusal printed under a switch that then
  gives way to `Done` goes with it, since no retry could clear it.
- **Turning a schedule off does not stop a run in progress.** Off means "do not
  fire again", and a running agent is stopped where runs are stopped — the
  run's own row. The switch is not the place to guess which the user meant.

### 3.3 Order

**Newest created first, and never re-sorted by state.** Unlike the story list,
this is not a triage list: it is a handful of standing settings, like roles,
and a user finds a setting by where it always is. Sorting by next firing would
move a row every time it fired; sorting enabled before disabled would move the
row out from under the finger that just flipped its switch. The edge and line 3
are what say "look at this one". The order is `created_at` desc, ties to the
higher id, sorted on the client from the store with `compareNewestFirst`
(`lib/scheduleRuns.ts`) — the comparator the Runs list uses, which compares to
the nanosecond as the server does, since a `Date` keeps only milliseconds.

### 3.4 Empty, loading, failed

| State | Scroll region |
|---|---|
| Loading | Spinner. The bottom bar is already there and usable |
| Subscription failed | The error text in the error colour. The bottom bar stays |
| No schedules | `No schedules yet.` and one muted line: `A schedule starts an agent on the same prompt on a timetable. Add one with the button below.` |

## 4. The schedule detail

```
┌ app header: ← "Schedule" ──────────────────────────────┐
├ scroll region (max-w-2xl) ─────────────────────────────┤
│ Nightly dependency audit                          ✎   │  title, inline edit
│ [◯━] On · Next run today 03:00 (in 5h)                │  switch + next
│                                                        │  (done one-time: ✓ Done · Was due Mon 3 Nov 09:00)
│ ┌ ⚠ The run at today 03:00 could not be started.   ┐  │  notice (only when set)
│ │ start run …: …                    Open the run  › │  │
│ └───────────────────────────────────────────────────┘  │
│ RUNS                                                   │
│  ◦ Nightly dependency audit                   💬 ⏹    │  WorkRow, unchanged
│    Running · main · Auditor                  2h ago    │
│  ◦ Nightly dependency audit                   💬 ↺    │
│    Closed · main · Auditor                yesterday    │
│  … (5 rows)                                            │
│  [ Show more runs ]                                    │
│ PROMPT                                            ✎   │  markdown
│ PERIOD                                            ✎   │  "Daily at 03:00"
│ ROLE                                                   │  RoleSelect (job)
│ WORKTREE                                               │  select
│ ────────────────────────────────────────────────────── │
│ 🗑 Delete schedule                                     │
├ bottom action bar ─────────────────────────────────────┤
│ [ ▶  Run now ]                                         │
└────────────────────────────────────────────────────────┘
```

Fed by `schedule.detail.subscribe` (`useScheduleDetailSubscription`), keyed by
schedule id inside the component (`ScheduleDetailOverlay` renders
`ScheduleDetailPage key={scheduleId}`), for the reason `WorkDetailOverlay` is:
a reused page would carry one schedule's half-edited prompt onto the next.
The heading levels are the work detail's: the title `h2`, each section heading
an `h3` (`text-xs font-medium uppercase text-th-text-muted`), and so the run
rows `headingLevel={4}`, as a story's Tasks rows are.

**What changes goes above what does not** — the work detail's rule
([projects/frontend.md](projects/frontend.md#workdetailoverlay)). A user opens a
schedule to see how its runs are going far more often than to edit it, so the
state and the runs come first, the settings after, and deleting at the end.

### 4.1 The head

- **Title** — `ui/InlineEditableHeading`, the one page-title editor the work,
  role and schedule pages share: Enter saves, Escape cancels. Editing it changes
  the title of future runs; past runs keep the title they were made with.
- **Switch line** — the `Switch` from §3.2, then `On · Next run today 03:00
  (in 5h)` (plain `On` while no next firing is known), or `Off · Runs only
  when you press Run now`. A one-time schedule before its time says `Runs` for
  `Next run` (`On · Runs Mon 3 Nov 09:00 (in 2d)`) — there is no run after it
  to make this one the "next" — and is otherwise the same. A done one-time
  schedule has a `Done · Was due …` line instead of the switch line (§6.6). The absolute time is
  `formatNextRun(next_run_at, now, schedule.time_zone)` (`utils/relativeTime.ts`)
  in the **schedule's** zone (§6.5): `today 03:00`, `tomorrow 03:00`,
  `Mon 27 Oct 03:00` beyond that (24-hour, the period's own format). When that
  zone is not the device's, the zone label follows the time and the relative
  half leaves its brackets: `On · Next run tomorrow 09:00 (Tokyo) · in 5h`.
- **Notice** — at most one, in this order of precedence:

| Case | Notice |
|---|---|
| `last_failure` set | An error-toned block (`border-th-error`, `role="alert"`): `The run at {at} could not be made.` (no `work_id`) or `The run at {at} could not be started.` (with one), the server's `error` verbatim under it, and — when `work_id` is set — `Open the run`, which opens that job (left `open`, so the user can start it there) |
| the latest run is `active` — the row with id `last_run_work_id` on the loaded run page, the newest-first page it is on | Muted: `A run is going now. Run now is refused until it ends.` Said ahead and not enforced, the agent-role delete rule ([agent-roles-ui.md §5](agent-roles-ui.md#5-deleting-lives-on-the-detail-page)): the server decides, and the button stays enabled |
| `last_skipped_at` is later than `last_run_at`, or there is no `last_run_at` | Muted: `Skipped the run at {at}: the previous one was still going.` — on a done one-time, `Did not run at {at}: a run started earlier was still going.` |
| done because it passed while off (§6.6) | Muted: `It was off at {at}, so it did not run.` |

`{at}` is `formatNextRun`'s format applied to a past instant (`today 03:00`,
`yesterday 03:00`, `Mon 27 Oct 03:00`), in the schedule's zone and with its
label when that is not the device's (`today 09:00 (Tokyo)`), as the switch
line's time is.

### 4.2 Runs

**A run is a work, so a run is a `WorkRow`.** Same glyph, same edge, same
slots, the same Chat and lifecycle controls — Stop, Restart, Reopen, by status
— with the same line 3 when a command fails. Tapping a row opens
`WorkDetailOverlay` on the job; its Chat icon opens the run's session in the
run's worktree. Nothing about a run is re-implemented here; the screen hands
`WorkRow` the `ScheduleRunItem` (a `WorkListItem` plus `created_at`), the role
name from `useRoleNameMap`, and `headingLevel={4}`.

One change to `WorkRow`, and it is to a prop, not a branch:
**`showUpdatedAt?: boolean` became `dateAt?: string`**, the timestamp slot 7
prints. The stories list passes `updated_at`, the Runs list `created_at`, a
story's Tasks section nothing. Slot 7's rule is "show the sort key", and the
runs are sorted by when they were made
([api.md](projects/api.md#schedule-runs)), so the run list dates them by it. The
screen decides which key, as it already decides whether.

**Every run's title is the schedule's.** That repetition is accepted: the row is
the work row, and a run's title is a work's title that the user may still edit
on that run. What tells two runs apart is slot 7, at the right edge where every
row has it.

**How many are shown.** The newest **5** at first, so that on a phone the Prompt
heading is still in reach below them; `Show more runs` reveals 20 more each
press, calling `schedule.detail.runs` with `next_cursor` once the loaded rows
run out, and is removed when every loaded row is shown and `has_more` is false.
While a page loads it is `aria-busy` and ignores presses, never disabled, so a
keyboard user's focus stays on it.
The newest page arrives with every notification and is merged into what was
loaded **by id** — the API's contract, so a run pushed off the first page is
not lost. A loaded run inside the span the new page covers (made at or after
its oldest row's `created_at`) that the page no longer holds has been deleted,
and is dropped; a run older than that span is kept as loaded, which is the
API's accepted staleness for older pages. The rows are normalised on arrival
with `normalizeWorkRow` (`lib/workStore.ts`), as the work store does, because
`WorkRow` indexes its activity table directly and an activity this build does
not know must not blank a row. The button is a 44px full-width text button with its own 8px
clearance from the last card (project-ui.md §2.3's rule for `Show earlier
work`), `aria-busy` with a spinner while a page is on its way. A failure to
fetch prints `Failed to load earlier runs: {reason}` with `Retry` in its
place — except a refusal of the page as `InvalidParams` (the subscription is
gone, or the cursor is not one the server issued), on which the hook
subscribes afresh instead: a retry of the same request would be refused again.

Empty: `No runs yet. The first is due {formatNextRun}.` (in the schedule's
zone, with its label when it differs, §6.5) — `It is due {…}.` for a one-time —
or, when off, done, or no next firing is known, `No runs yet. Press Run now
to make one.` A schedule whose runs were all
deleted is not one with none yet: with `last_run_at` set the line is
`Its runs have been deleted.`, as the row says `Latest run deleted` (§11).

### 4.3 The settings

Each is edited in place and saved on its own — no page-wide Save, as on the
work and role pages.

| Section | Control |
|---|---|
| **Prompt** | The work detail's Description interaction: `MarkdownContent` in an `overflow-x-auto` box, a pencil opening a textarea with Save / Cancel. Never empty (the server requires it), so it has no empty state. Muted line under the heading: `Every run starts with this prompt.` |
| **Period** | Read-only, `PeriodWords`; when the schedule's zone is not the device's, the zone line and the `Use {city} time` switch under it (§6.5). A pencil opens the `PeriodField` (§6) with Save / Cancel; Save sends `period` only if it differs from the stored one (`samePeriod`), and otherwise just closes; it never sends `time_zone`, so editing keeps the schedule's zone. On a done one-time schedule Save also sends `enabled: true` and reads `Save and turn on` (§6.6). While the save is in flight the field sits in a `<fieldset disabled>`, so an edit made during the request cannot be dropped silently when the editor closes on success |
| **Role** | `RoleSelect workType="job"`, applied on change like the work detail's Role. A kept role that no longer takes jobs is shown with its suffix and the work detail's kind of muted line, `{name} only takes {kind}. Runs keep using it until you change it.` — that is what the server does: the kind is judged when the role is assigned, and nothing on the run path judges it again. A role that has been **deleted** shows as `Unknown role` (`RoleSelect`'s rule) with a muted line `This role has been deleted. Runs will fail until you pick another.` — muted like the page's other lines, since `text-th-error` does not clear AA in the light themes and the failure, when it comes, is the notice's to state in error — those runs are refused at start (`agent role not found`) and become the notice |
| **Worktree** | Drawn only when `isGitRepo === true`: outside a git repository the server takes no worktree but main, so there is nothing to choose. A `<select>` of the worktrees that exist (`useWorktreeList`, the read-only hook for naming one), `main` first, applied on change. A stored worktree that no longer exists stays selected as `{name} (deleted)` with the muted line `Runs will fail until you pick a worktree that exists.` |

The "will fail" lines exist because this page is where the cause is: the
failure itself only appears after the next firing, in the notice. Each waits
for its list: while the role list is loading or has failed the deleted-role
line says nothing, and a worktree counts as deleted only once the worktree
list has arrived — until then the stored name is offered as itself.

### 4.4 Run now and Delete

- **`Run now`** is the bottom bar's primary button (`Play`). It sends
  `schedule.run`, is busy while in flight, and on success **stays on the page**:
  the new run appears at the top of Runs as the detail's notification arrives,
  with its Chat icon right there. Unlike creating, running is not the start of
  an interaction with a different page; jumping away would make a press that
  is often a quick check feel like a navigation. A refusal prints the server's
  sentence in the bar's `role="alert"` line, as the work detail's action bar
  does. It works on a disabled schedule — the server allows it, and the
  disabled line says so.
- **`Delete schedule`** closes the scroll region under a `border-t`, `Trash2`
  and `text-th-error`, as `Delete role` does: deleting is rare and weight
  follows frequency. A `danger` `ConfirmDialog`:
  `Delete "<title>"?` / `It will not run again. The runs it already made stay,
  each with its chat, and a run in progress keeps going.` On success, navigate
  to `/schedules`. The last sentence is there because it is true and
  surprising: the server deletes the schedule alone. A refusal closes the
  dialog and prints `Failed to delete: {message}` under the button,
  `role="alert"`.

**Loading and missing** follow the role page: skeletons while the detail
subscription is loading, and the error in the error colour if it fails.
`Schedule not found` (muted, header Back as the way out) is shown when the
subscribe is refused with `schedule not found` or resolves with no schedule,
or when the schedule store has loaded without error and no longer holds the
id — which is how a deletion reaches an open page, since the detail
subscription sends nothing on delete
([api.md](projects/api.md#real-time-subscription-system)). The last trigger
applies even while the detail is still loading.

## 5. Creating a schedule

`New Schedule` opens `CreateScheduleSheet`, a shared `Sheet` modelled on
`CreateStorySheet`: **the fields the server requires, and no others.** For a
schedule that is four, because a schedule — unlike a story — runs without
anyone pressing Start, so it cannot be made half-written:

```
New Schedule
──────────────────────────────────────
Title    [ Nightly dependency audit  ]
Prompt   [ textarea, 4 rows, grows    ]
Role     [ Auditor                  ▾ ]
Period   [ Daily                     ▾ ]
         At [ 03:00 ]
         Daily at 03:00
Runs in  main
──────────────────────────────────────
[ Cancel ]                  [ Create ]
```

- **Role** — `RoleSelect workType="job"`, preselected by
  `resolveInitialJobRole(roles)` in `lib/initialRole.ts`, beside the story rule:
  if exactly one role takes jobs, it; else if exactly one role is *restricted*
  to jobs (the seeded job role), it; else `Select role...`. There is no default
  job role setting, and none is added (§12).
- **Period** — the `PeriodField` (§6), starting on `Daily` at `09:00`. The
  sheet holds `DEFAULT_PERIOD` (`lib/schedulePeriod.ts`) as its period until
  the field is touched, because the field reports nothing on mount. Daily stays
  the start, not Once: most schedules are made to repeat, and a one-time is one
  tap away with the next 09:00 already filled in (§6.1).
- **Worktree** — not asked: the schedule is made in the worktree the user is in
  (`useCurrentWorktree()`, `""` for main), stated as the muted line `Runs in {name}` so it
  is not a surprise. It is changed on the detail page.
- **Time zone** — not asked and not shown: the sheet sends the device's zone
  (`useDeviceTimeZone()`, §6.5) as `time_zone`, as it is when Create is pressed. A
  schedule made on this device is in this device's zone, so the period the user
  just typed means what it says on their clock, and nothing on the sheet needs
  to say so. `PeriodField` is given no zone here, and so draws no zone line.
- **Enabled** — not asked, sent absent (the server's `true`). A schedule made is
  a schedule meant to run; the switch is one tap on the page the user lands on.
- `Create` is disabled until title and prompt have non-blank text, a role is
  picked, and the period is complete (§6.2 — for a one-time, a date and time
  still ahead).

The rest is `CreateStorySheet`'s behaviour, unchanged: focus lands on the
sheet; a refusal keeps the sheet open with everything typed and the server's
error under the fields; `dismissible={false}` while in flight, with every
field held still — the period too, in a `<fieldset disabled>` as on the detail
page (§4.3) — so what was sent is what is shown; on success
the sheet adds the schedule from the reply to the schedule store and hands
the id to `onCreated`, and `AppShell` navigates to its detail. The store write
is needed for the store's not-found trigger (§4.4): without it, the list
notification landing after the reply would leave a loaded store without the id
for a moment, and the page would call the schedule it was just made for
missing. Its role-list states are
the story sheet's four, drawn by the one `NoEligibleRoleSheet` both sheets use,
with the job wording for the fourth:
`No agent role takes jobs.` / `Set a role to take jobs in Agent Roles first.`

One thing differs from the story sheet. A reconnect empties the role store, and
swapping the form for `NoEligibleRoleSheet` while the roles reload would
remount `PeriodField` on its default period while the sheet still held the
user's period — Create would send a period other than the one shown. So once
the form has been shown it stays up through a role reload; if the swap happens
anyway (the reload failed), the period goes back to `DEFAULT_PERIOD` with the
field.

## 6. The period

**A period is one of five kinds, and nothing else.** `Once`, `Hourly`, `Daily`,
`Weekly`, `Monthly` — each a handful of plain inputs, each read back in plain
words. There is no rule language, no expression to type and no `Custom` mode:
a period the five cannot say is deliberately unsupported (§12). Nothing on any
screen shows, asks for or mentions cron. Whatever the server stores a recurring
period as is the server's business; the client holds, sends and receives the
period as the kind and its values (§9 E), so the words on a screen are read off
the values and never off a stored string.

**A one-time run is not a recurring period that happens to fire once.** It is a
date and a time, it fires once, and then the schedule is *done* (§6.6) — a state
the recurring kinds never reach.

### 6.1 The field

`PeriodField` (`components/Project/PeriodField.tsx`) is the one editor, in the
sheet and on the detail page. Its contract:

- **`initial: Period | null`** (the stored period, or `null` for a new
  schedule) is read **once, on mount**, to pick the mode and fill the inputs.
  After that the mode and every input are the field's own state. The mode is
  never re-derived from what the inputs write: ticking the seventh day writes a
  daily period, and must not swap the day toggles out from under the user.
- **`onChange(period: Period | null)`**, called on every edit with the period
  the inputs now spell, or `null` when they spell nothing yet (§6.2's hints).
  The caller disables Save / Create on `null`.
- **"Changed" is the caller's comparison with the stored period** (`samePeriod`,
  `lib/schedulePeriod.ts`, by value), and only after the user has touched an
  input — the field calls nothing on mount. So a weekday schedule opened and
  saved untouched sends nothing.

A native `<select>` picks the mode — `Once`, `Hourly`, `Daily`, `Weekly`,
`Monthly`, in that order: from the smallest commitment to the longest rhythm,
with the one that is not a rhythm at the start rather than wedged between two
that are. It is the field's first row, full width, `min-h-[44px]`, styled as the
detail page's Worktree select. **Not a `ToggleGroup`, as the field had with
four modes:** a segment there is `px-3`, so five equal segments in a 320px
sheet leave about 29px for a label and `Monthly` needs about 52px — it does not
fit even at 390px. A select holds any number of kinds at any width, opens the
platform's own picker on a phone, and is what a calendar's "repeat" choice
already is everywhere a user has set one. The inputs under it follow:

```
Once      On [ 2026-11-03 ] at [ 09:00 ]
Hourly    Every [ 1 hour ▾ ] at minute [ 00 ]
Daily     At [ 09:00 ]
Weekly    [Mon][Tue][Wed][Thu][Fri][Sat][Sun]
          At [ 09:00 ]
Monthly   On the [ 1st ▾ ] at [ 09:00 ]
```

| Mode | Inputs | Period |
|---|---|---|
| **Once** | `On [date] at [time]` — `<input type="date">` and `<input type="time">`, side by side in a wrapping row, so on the narrowest phones the time drops under the date rather than either shrinking | `{kind: "once", at: "2026-11-03T09:00"}` — a wall-clock date and time in the schedule's zone, no seconds, no offset |
| **Hourly** | `Every [1 hour ▾] at minute [00]` — a `<select>` of `1 hour`, `2 hours`, `3 hours`, `4 hours`, `6 hours`, `8 hours`, `12 hours`, and a two-digit text input (`inputMode="numeric"`) taking 0–59 | `{kind: "hourly", every, minute}`, both always sent though the server defaults them |
| **Daily** | `At [09:00]` | `{kind: "daily", time: "09:00"}` |
| **Weekly** | Seven day toggles, Mon to Sun, and `At [09:00]` | `{kind: "weekly", weekdays, time}` — `0` Sunday … `6` Saturday, ascending; all seven days is `daily` |
| **Monthly** | `On the [1st ▾] at [09:00]` — a `<select>` of `1st` … `30th` and then `Last day` | `{kind: "monthly", day, time}`, `day` 1–30, and `Last day` is `31` |

Every time input is the native `<input type="time">`, 24-hour in its value;
the platform draws it as it likes, which on phones is its own wheel or clock.

- **Hourly offers only divisors of 24.** Every 5 hours from midnight fires at
  00, 05, 10, 15, 20 and then 00 again: a gap of four hours once a day that
  "every 5 hours" does not describe. The select's options name the unit
  (`1 hour`, `6 hours`) rather than a bare number beside a fixed `hour(s)`, so
  the line reads as a sentence in every option.
- **Weekly with all seven days is written as daily**, so one period has one
  spelling (the server stores it so too), and reads as daily. **Weekly with
  none** is `null` (§6.2).
- **The day toggles** are `aria-pressed` buttons labelled `Mon` … `Sun` — filled
  with the accent when on, only bordered when off, since a fill would vanish on
  the sheet's own ground — 44 × 44,
  `gap-2`, in a wrapping row: seven take 356px, so they sit on one row in a
  column that wide (a phone of about 390px and up) and wrap to two below it —
  wrapping is what keeps every one of them at the floor. The week starts on
  Monday everywhere; a locale-dependent first day would move the buttons
  under a user who changes language.
- **Monthly's day list stops at 30 and then says `Last day`.** That is where a
  user looking for the 31st looks, and it is what the 31st means to anyone who
  picks it: the end of the month. So `31st` is not offered under that name — it
  is `Last day`, which is what the server's `day: 31` does — and the two days
  that some months lack — the 29th and the 30th — are the only ones that need a
  rule (§6.3). The select's options are ordinals (`1st`, `2nd`, `3rd`, `4th` …
  `21st`, `22nd`, `23rd` … `30th`), English, as every other word here is.
- **Switching mode keeps what carries.** The time of day carries between Once,
  Daily, Weekly and Monthly; Hourly takes its minute from it and gives back
  hour `09` with that minute. The days a Weekly held, the day of month a Monthly
  held and the date a Once held each survive a look at another mode, so a user
  comparing two modes loses nothing. A mode never opened before fills the rest
  with its defaults — every `1 hour`, `Mon`, the `1st` — and for Once the date
  of the **next occurrence of the carried time** — today in
  the schedule's zone if that time is still ahead, else tomorrow — so switching
  a `Daily at 09:00` to Once offers the next 09:00, and Save is ready at once.
- **Picking the mode already shown is not an edit**: nothing is reported, so
  an untouched schedule cannot be made to look changed.
- Under the inputs, always: the description (§6.4) of what would be saved, one
  muted line, or the hint (§6.2) while the inputs spell nothing; on Monthly with
  the 29th or the 30th, the short-month line (§6.3) under it.
- **`timeZone?: string`** — the schedule's zone, passed by the detail page and
  not by the create sheet. When it is given and is not the device's zone
  (`sameZone`, §6.5), the zone line follows the description on a line of its
  own: `Tokyo time (UTC+9). This device is on London time (UTC+1).` — the
  zone every input, the date included, is typed in. The field never sends a
  zone: it only writes the period. Without `timeZone` (the create sheet, whose
  schedule will be in the device's zone, §5) the field takes
  `useDeviceTimeZone()` for Once's default date and its "passed" check.

### 6.2 What the client checks

Every input is a plain value now, so **the client checks all of it** and the
caller disables Save / Create while the period is `null`. One muted hint names
the first thing missing, in place of the description:

| Inputs | Hint |
|---|---|
| Weekly, no day ticked | `Pick at least one day.` |
| A minute outside 0–59, or empty | `Enter a minute from 0 to 59.` |
| A time cleared | `Pick a time.` |
| Once, the date cleared | `Pick a date.` |
| Once, the date and time are not ahead of now in the schedule's zone | `That time has passed. Pick a later one.` |

**"Passed" is judged on the client** by turning the wall-clock date and time in
the schedule's zone into an instant (`zonedInstant(at, zone)` — `at` in the
period's own `YYYY-MM-DDTHH:MM` form — in `lib/scheduleZone.ts`, read through `Intl` as the offsets already are) and
comparing it with now. It is judged on each edit and again when that minute
arrives, so a field left open across its own time goes to the hint rather than
offering a Save that would be refused. The server judges it once more on
receipt — a time a few seconds ahead can pass in flight — and its refusal is
printed under the field as any refusal is. A zone the browser does not know
(§11) cannot be converted, so the client skips this one check there and the
server's refusal is what the user sees.

**A time that a DST change skips or repeats is not checked.** 02:30 on the
night the clocks go forward does not exist and 01:30 on the night they go back
happens twice; the server runs the first at the moment the clock jumps to and
the second at its first occurrence, one-time runs included
([api.md](projects/api.md#schedule-periods)),
and the next-run line (§4.1) shows the instant it chose. A warning in the
editor for two nights a year, in the zones that have them, would be louder than
the problem.

### 6.3 Short months

**The 29th and the 30th run on the last day of a month that lacks them.**
`Monthly on the 30th` runs on 28 February (29 in a leap year), and on the 30th
everywhere else. The alternative, skipping the month, is what a calendar does
for a meeting and is wrong for work: a monthly report that quietly does not
happen in February is the failure a schedule exists to prevent. With the 31st
replaced by `Last day` (§6.1), this rule touches only two choices, so it is said
right where they are made — one muted line under the description, shown only
for them:

> `In shorter months, runs on the last day.`

The words (§6.4) do not repeat it: `Monthly on the 30th at 09:00` is read on a
row many times and chosen once, and the next-run line shows the date it
actually picks.

### 6.4 Periods in words

`describePeriod(period)` (`lib/schedulePeriod.ts`) writes the words, 24-hour
times, the minute always two digits. Every screen draws a period through
`components/Project/PeriodWords.tsx`, which is that string and the zone
label (§6.5) and nothing else:

| Period | Words |
|---|---|
| Once | `Once on Mon 3 Nov at 09:00` — weekday, day, month; the year is added when it is not the current year in the schedule's zone (`Once on Fri 1 Jan 2027 at 09:00`) |
| Hourly, 1 | `Every hour at :15` |
| Hourly, N ≤ 4 | `Every 2 hours at :15` |
| Hourly, N ≥ 6 | `Every 6 hours, at 00:15, 06:15, 12:15 and 18:15` — four firings or fewer a day are named, because "every 6 hours" does not say which six |
| Daily | `Daily at 09:00` |
| Weekly, Mon–Fri | `Weekdays at 09:00` |
| Weekly, Sat and Sun | `Weekends at 09:00` |
| Weekly, one day | `Mondays at 09:00` |
| Weekly, other sets | `Mon, Wed, Fri at 09:00` — Monday-first, as the toggles |
| Monthly, a day | `Monthly on the 1st at 09:00` |
| Monthly, 31 | `Monthly on the last day at 09:00` |
| A kind this build does not know | `Unsupported period` — a newer server's kind on an older page (§11) |

**Once is written as an absolute date, never `tomorrow`.** The words are the
period, and a period's words do not count down; "when, for me" is the next-run
slot's (`Next in 5h`, §3.1), as it is for every kind. The
date format is `formatNextRun`'s beyond-tomorrow form (§4.1), so the period and
the next run read alike.

### 6.5 Time zones

**Every schedule carries its own IANA zone** (`time_zone`, e.g. `Asia/Tokyo`;
[data-model](projects/data-model.md#schedule)), and the server evaluates its
period in that zone, DST included, against the tz database built into the
server binary, so a host without one (Windows, a minimal container) resolves
every zone too ([api.md](projects/api.md#schedule-time-zones)). The client sets
it without asking: the create sheet sends the device's zone (§5), and the only
other way it changes is the switch below. There is no zone setting, picker or field anywhere.

**The zone is invisible while it is the device's**, which is the normal case:
the schedule was made on this phone, in this place. It appears only when the
device viewing the schedule is in another zone — the user is travelling, or
opened the server's Pockode from a second device elsewhere — and then it is on
every wall-clock time the schedule shows, with one way to make it the device's.

#### Which zone is "the device's", and when two are the same

- **The device's zone** is `Intl.DateTimeFormat().resolvedOptions().timeZone`,
  read by one hook, `useDeviceTimeZone()` (`hooks/useDeviceTimeZone.ts`), which
  reads it again on `visibilitychange` and `focus`: a phone that landed in
  another zone while the app was in the background shows the change the moment
  it is brought back, not at the next reconnect. Every surface below takes the
  device's zone from this hook and never calls `Intl` for it itself, so they
  all change together.
- **Two zones are the same when their names are**, after both are canonicalised
  by the device — `Temporal.ZonedDateTime#equals` where the browser has
  Temporal, whose `resolvedOptions()` then returns a name as given; otherwise
  `new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone` —
  so an alias (`Asia/Calcutta`, `Asia/Kolkata`) is not a difference. It is
  **not** a comparison of current offsets: `Europe/London` and `Africa/Abidjan`
  agree in January and disagree in July, and a schedule that silently moves an
  hour twice a year is the bug this design removes. Two zones that happen to
  follow the same rules (`Asia/Seoul` beside `Asia/Tokyo`) count as different
  — the label is then true and harmless, and one tap on the switch clears it.
- A zone the device's `Intl` does not know (it throws a `RangeError`) is never
  the same as the device's; §11 says how it is drawn.
- `sameZone(a, b)` is the one predicate; every surface below asks it, none
  compares strings itself.

#### How a zone is named

| Where | Form | Example |
|---|---|---|
| The **short label**, beside a period or an instant | the city: the IANA name's last segment, `_` read as a space | `(Tokyo)`, `(Buenos Aires)`, `(Indianapolis)` |
| The **zone line** (below) | the city and its offset now | `Tokyo time (UTC+9)` |

- **A city, not an offset or an abbreviation.** A city is the zone's identity
  and is what the user picked by being there; an offset changes with DST and
  names many zones; an abbreviation (`IST`) names three. The offset is added
  where there is room, because it is what lets a user compare two zones at a
  glance.
- **Names that are not places** are written as what they mean: `UTC`,
  `Etc/UTC`, `Etc/GMT`, `GMT` → `UTC`; `Etc/GMT-9` → `UTC+9` (`Etc` signs are
  inverted, so the offset is read with `Intl`, never from the name); a legacy
  name without a `/` (`Japan`, `EST5EDT`) is printed as it is. Where the city
  form *is* an offset, the zone line does not repeat it: `UTC+9 time`.
- **The offset** is `formatUtcOffset` (`UTC+9`, `UTC−3:30`, `UTC`) of the zone's
  offset at the moment of drawing, read through `Intl` (`timeZoneName:
  "longOffset"`). It is never stored or sent.
- These rules live in `lib/scheduleZone.ts`, pure functions with no React:
  `sameZone`, `isKnownZone`, `zoneLabel`, `zoneOffsetSeconds`, `zoneName` (the
  city with its offset), `zoneLine` (below), `formatUtcOffset`, and
  `periodZoneLabel` / `instantZoneLabel`, which hold §11's rule for a zone the
  browser does not know. `lib/schedulePeriod.ts` keeps only the period's own
  rules.

#### A schedule's times are in the schedule's zone

- **A period is wall-clock time in the schedule's zone.** `Daily at 09:00`
  means 09:00 in Tokyo, and `Once on Mon 3 Nov at 09:00` means 09:00 on 3
  November in Tokyo — the date is Tokyo's date too. The period's words, the editor's inputs and its
  description are all in that zone.
- **A schedule's instants are shown in the schedule's zone too**: the next run,
  the instant in a failure or skip notice, and the empty Runs list's `The first
  is due …`. They are the period's firings, so they are drawn in the period's
  clock — `Daily at 09:00 (Tokyo)` and `Next run tomorrow 09:00 (Tokyo)` agree on
  sight, where a device-zone `tomorrow 01:00` beside it would read as a bug the
  user has to work out. The *day* words (`today`, `tomorrow`, `Mon 27 Oct`) are
  that zone's days too. `formatNextRun(iso, now, timeZone)` takes the zone.
- **"When, for me" is said relatively, where it matters**: the next run is
  `in 5h` on the row and in the head, and the latest run is `· 2h ago` on the
  row. Those need no zone, so a traveller never has to convert the one time
  they act on. The notices name a past firing by its clock time on purpose
  (§4.1: the age alone would not say which firing it was), and the clock that
  names it is the period's.
- **Everything that is a work's is the work's**: a run's `WorkRow`, its age on
  line 3, its detail page — drawn as every work is, in the device's zone. A run
  is a work (the rule at the top of this document).

Because instants are always formatted in the schedule's zone, the rule needs no
branch when the zones are the same — then it *is* the device's — and only the
label is conditional.

#### Where it shows when the zones differ

| Surface | Same zone | Zone differs |
|---|---|---|
| List row, line 2 (§3.1) | `Daily at 09:00 · Next in 5h` | `Daily at 09:00 (Tokyo) · Next in 5h` |
| List row, one-time | `Once on Mon 3 Nov at 09:00 · Next in 2d` | `Once on Mon 3 Nov at 09:00 (Tokyo) · Next in 2d` |
| Detail head, switch line (§4.1) | `On · Next run tomorrow 09:00 (in 5h)` | `On · Next run tomorrow 09:00 (Tokyo) · in 5h` — the relative half moves out of brackets so the line has one pair |
| Detail head, notice `{at}` (§4.1) | `The run at today 09:00 could not be started.` | `The run at today 09:00 (Tokyo) could not be started.` — the skip notice the same |
| Runs, empty line (§4.2) | `No runs yet. The first is due tomorrow 09:00.` | `No runs yet. The first is due tomorrow 09:00 (Tokyo).` |
| Detail **Period**, read (§4.3) | `Daily at 09:00` and nothing under it | `Daily at 09:00`, the zone line, the switch |
| Detail **Period**, editing (§6.1) | the description line only | the description line, then the zone line |
| Create sheet (§5) | `Daily at 09:00` | never differs: a new schedule is made in the device's zone |
| A run's page, its row, its chat | — | unchanged: work, in the device's zone |

The short label is the period's and the instant's own suffix, `(Tokyo)` with a
leading space, `text-th-text-muted` inside the slot's tier. It is part of the
text, so a screen reader reads `Daily at 09:00 Tokyo`, which is what it says.

On the Period section the label is **not** appended to the words: the zone line
directly under them says it at length, and saying it twice in two lines is
noise.

#### The zone line

One muted `text-xs` line, `zoneLine(scheduleZone, deviceZone)`, drawn only when
the zones differ:

> `Tokyo time (UTC+9). This device is on London time (UTC+1).`

The same line in the read state and in the editor, so a user who opens the
editor sees the zone they were already told about, in the same words. In the
editor it is the answer to "what zone am I typing in": it sits directly under
the description (§6.1), on its own line rather than joined with ` · `, because
a phone wraps the joined form mid-sentence.

When the two offsets happen to agree (`Asia/Seoul` on the device, `Asia/Tokyo`
on the schedule) the line still prints both, `Tokyo time (UTC+9). This device
is on Seoul time (UTC+9).` — which tells the user, truthfully, that the
difference costs them nothing today.

#### Editing keeps the zone

Saving the period sends `period` and never `time_zone` (§4.3), whatever zone the
device is in. A user editing while travelling writes 09:00 in the zone the line
names, and the schedule stays there: following the device on edit would move a
home schedule to every hotel. The zone line is how the editor makes that
visible, and it is why the line is in the editor at all.

#### The switch

**One action, on the detail page's Period section, in the read state, under the
zone line:** a text button `Use London time` (the device's city; `Use UTC+9
time` for a non-place name), `text-th-accent`, `min-h-[44px]`, left-aligned
with the words. It is not drawn while the zones are the same, nor while the
editor is open (the editor is for the period; the switch is not part of a
period edit, and a Save that also moved the zone would be the silent follow
this design forbids), nor while the device's own zone is one its browser does
not know (§11: there is no zone to switch to).

- **Not on the row.** The row holds one control, the switch to turn it off
  (§3.1); the `(Tokyo)` label tells the user there is something to look at, and
  the detail is one tap.
- **Not in the head.** The head says what will happen; changing a setting is
  the settings' job, and Period is the setting it changes.

**What it does:** `schedule.update { id, time_zone: <device zone> }` — the zone
only, the period as stored. The wall-clock period is kept and re-read in the new
zone: `Daily at 09:00` in Tokyo becomes `Daily at 09:00` in London, and `Once on
Mon 3 Nov at 09:00` stays 09:00 on 3 November, now London's. A one-time whose
wall-clock time has already passed in the device's zone is refused by the
server, and the dialog prints that refusal as it prints any (below); the user
then sets a new time first. That is what
"run it on my time" means, and the instants follow from the server's next
notification (`next_run_at` is the server's to compute — the client evaluates
no recurring period).

**It confirms**, with a non-`danger` `ConfirmDialog`, because from here it
cannot be undone: there is no zone picker, so only a device in Tokyo can put
the schedule back in Tokyo.

> **Run on London time?**
> "Daily at 09:00" will run on London time (UTC+1) instead of Tokyo time
> (UTC+9). Only a device on Tokyo time can switch it back.
>
> [ Cancel ] [ Use London time ]

The quoted period is `describePeriod(period)`, so the sentence holds for every
period, an hourly or a one-time one (`"Once on Mon 3 Nov at 09:00" will run on
…`) included — it never claims a clock time the period does not have. It is not
offered on a done schedule (§6.6). The names and
offsets are the zone line's, and a zone whose offset cannot be read drops its
bracket, as there.

`onConfirm` returns the request's promise, so the dialog does what it already
does for an async confirm: busy and not cancellable while the request is in
flight, and a refusal printed inside the dialog, which can be confirmed again or
cancelled. On success it closes. The label, the zone line and the button vanish
together when the notification brings the new `time_zone` — not on the reply,
so the page never shows a zone the store does not hold (for that moment the
button is still there, and a second press only opens the dialog again).

#### Why not the server's clock

Schedules used to be read on the server's clock, which the client annotated
with the server's offset (`Server time, UTC+9`). That clock belongs to a
machine, not to the person who wrote `09:00`, and a client reaching it through
the relay is often somewhere else. Comparing offsets also went wrong twice a
year, since two zones that agree in winter part in summer. With the zone on the
schedule, nothing on these screens depends on where the server is, so none of
them mentions the server's clock. The offsets on the zone line are computed
when it is drawn, so they cannot go stale across a DST change.

### 6.6 Done

A one-time schedule is **done** once its time has gone by. `isDone(schedule,
now)` (`lib/schedulePeriod.ts`) is the one predicate, and it has two halves:

- **Fired** — `kind` is `once`, `enabled`, and no `next_run_at`. That is the
  server's fact ([api.md](projects/api.md#schedule-periods)): it clears
  `next_run_at` when it handles the time, whether the run started, failed to
  start or was skipped, and a recurring schedule that is on always has a
  `next_run_at`. The client never declares a schedule that is *on* done from
  its own clock, so a page left open across the time keeps saying `Runs today
  09:00` until the server has fired it.
- **Passed while off** — `kind` is `once`, not `enabled`, and its `at` is
  behind now in the schedule's zone (`zonedInstant`, §6.2). The server does
  nothing at an off schedule's time and refuses to turn one on once its time has
  passed, so a switch here would be a control that only ever fails. This half
  reads the clock because nothing is waiting on the server: an off schedule
  fires nothing, so the client cannot run ahead of an event. An open page
  re-judges it when that instant arrives (`useHasPassed`, one wake-up at the
  instant rather than `useSecondsUntil`'s one a second), so the switch gives
  way to `Done` on the minute rather than at the next notification, which an
  off schedule's time never sends. In a zone the browser does not know (§11)
  it cannot be judged, and the schedule is drawn as off, with the switch;
  turning it on is then refused with the server's words.

**A one-time missed while Pockode was not running is run when it starts again.**
Recurring firings missed while the server was down are skipped
([work-system.md](code/work-system.md#schedules)), because the next one is
coming; a one-time has no next one, and skipping it would be the silent failure
a schedule exists to prevent. So the run is late rather than lost, and the
Runs list says how late: it is dated by when it was made (§4.2), beside a head
that says when it was due. Nothing else on the screens marks it — a run made
late is an ordinary run.

**What a done schedule looks like**, surface by surface:

| Surface | Before its time | Done |
|---|---|---|
| Row, line 1 (§3.1) | title, switch | title, and `Done` with a `CircleCheck` glyph (`text-th-text-muted`, `text-xs`) where the switch was — text, not a control |
| Row, line 2 | `Once on Mon 3 Nov at 09:00 · Next in 5h`, or `· Off` | `Once on Mon 3 Nov at 09:00` alone — `Done` is on line 1, and there is no next run to state |
| Row, line 3 | the latest run, or `No runs yet` | the latest run as always; passed while off with no run, `Did not run: it was off` (§3.1) |
| Detail head (§4.1) | the switch line | `CircleCheck` + `Done · Was due Mon 3 Nov 09:00`, and under it the muted `To run it again, set a new time under Period.` |
| Detail notice | as for any schedule | as for any schedule — a failed start or a skip at its time shows as it would on any firing; passed while off, its own muted notice |
| Period section (§4.3) | the words, the pencil | the same: the pencil is the way back |
| `Use {city} time` (§6.5) | offered when the zones differ | not offered: nothing more will run in either zone |
| Run now (§4.4) | works; the one time still fires | works, and leaves the schedule done — a run by hand is not its one time |
| Order (§3.3) | — | stays where it was: newest created first, never re-sorted by state |

- **`Was due`, not `Ran`.** A done schedule's latest run may be one made by Run
  now after its time, or there may be none (it failed to start, it was skipped,
  it was off); the head says the one thing that is true of all of them, and the
  notice and the Runs list say the rest. Its `{at}` is the period's own `at` —
  a done schedule has no `next_run_at` to draw — turned into an instant with
  `zonedInstant` and drawn as the notices' `{at}` is (§4.1): `today 09:00`,
  `yesterday 09:00`, `Mon 3 Nov 09:00`, with the zone label when the zones
  differ. In a zone the browser does not know, the wall clock is printed as
  stored, `Mon 3 Nov 09:00 (America/Ciudad_Juarez)` — it is the schedule's time
  as written, so unlike §11's instants it keeps the raw label. The off notice's
  `{at}` (§4.1) is the same.
- **No switch on a done schedule, not a disabled one.** A switch is a promise
  that flipping it does something; a done one-time has nothing to turn on. A
  disabled switch would also be a control drawn under 3:1 on every done row.
  `Done` in its place is text: the card's overlay button (§3.1) still covers it
  and opens the detail, and the switch's accessible name is not left behind for
  a screen reader to find. The server would still take `enabled: false` on a
  fired one-time; the screens just do not offer it, since it would only move the
  schedule from one kind of done to the other.
- **Doing it again is setting a new time.** Saving a new period on a done
  schedule — a later date and time, or any recurring kind — re-arms it, and the
  save **turns it on**: it sends `enabled: true` beside the period (§4.3), so a
  schedule that passed while off comes back on in the same write, and Save reads
  `Save and turn on` so the user sees that before pressing it. A user who picks
  a new time for a finished one-time means it to run then. On a schedule that is
  not done, saving the period never touches `enabled` — an off schedule given a
  new time stays off.
- **The editor opens on the stored date and time**, which has passed, so Save
  waits behind `That time has passed. Pick a later one.` until the user picks
  another — rather than quietly proposing one. What a done schedule is waiting
  for is the user's choice of when, and an editor that pre-filled tomorrow
  would turn a glance at the pencil into a scheduled run.
- **Nothing deletes a done schedule by itself.** It is the record of a one-time
  run and the way to its run, its chat and its prompt; deleting is the user's,
  on the detail page, as for any schedule.

## 7. A run's own page

The job's detail is `WorkDetailOverlay`, which already handles `type: "job"`
(header `Job`). Two additions, both read off `schedule` on the `work.detail`
result (§9 C):

- **The schedule link**, where a task shows its parent story, and drawn by the
  same element: the parent-story button became one `BelongsToLink` taking a
  `kind`, a glyph, a label and an `onClick`, so the two cannot drift. The kind
  names it for a screen reader (`Story: {title}`, `Schedule: {title}`), the
  glyph is `aria-hidden`, and a task's link gained the `ListChecks` glyph the
  Stories entry carries. It stays a local
  component in `WorkDetailOverlay.tsx`, so the parent link's entry in the
  control register ([responsive-ui.md](responsive-ui.md#outside-the-floor-today)),
  which is keyed by that file, still holds it; the entry's prose is widened from
  "the parent story" to "the story or schedule the work belongs to" rather than
  a second exception being added. For a job: a `CalendarClock` glyph and the
  schedule's current title, opening the schedule detail. When the schedule
  has been deleted it is replaced by the muted, non-interactive
  `Its schedule has been deleted.`
- **A muted line under the Description heading**: `This run's copy of its
  schedule's prompt: editing it changes this run only.` It says nothing of the
  schedule, so it stays true once the schedule is deleted, and it is left out
  once the body has been cleared, there being no copy left to speak of. The run's body
  stays editable — it is the brief this run's agent reads, and the work page
  already edits briefs — but a user editing it to "fix the job" needs to know
  it fixes one run.

Back follows §2's table, and so does **Delete**. The header and the action bar
used to be handed different callbacks — the header went to the parent, the
action bar's Delete called the raw `onBack` — so deleting a task landed on the
list rather than on its story. The page now works its Back target out
**once** (`backTarget`: parent story, schedule, or `/schedules`, by §2's
table, else the list) and hands the same callback to both. That changed tasks
as well, deliberately: deleting a task lands on its story, where Back would
have gone — a behaviour change, covered by check 18.
Everything else on the page — lifecycle bar, questions,
usage, comments, Open Chat, Delete — is the work page unchanged, which is what
"a run behaves exactly like a work" means.

## 8. From a run's chat to its schedule

The chat already links to its work: the session panel's `Work` row
(`SessionWorkSection`) and a work message's `Details` open the work's detail.
For a job that page now carries the schedule link and Backs to the schedule
(§7, §2). So the path is **chat → Work → schedule**, two taps, and the chat
gains nothing.

That is deliberate. `SessionWorkSection` is pure navigation to the one thing
the session runs, and a second `Schedule` row there would be the chat starting
to describe the work's context — the drift that section's comment rules out.
The job's page is where a job's context lives.

## 9. What the server and the wire added

Three facts these screens draw were not on the wire when the backend landed
(A–C), one piece of bookkeeping was missing (D), and periods without cron
needed the period itself and a one-time's end (E). Each went where the data
already was, and none is a new RPC method. The wire shapes and the full rule
are [api.md](projects/api.md#schedule); here is why each exists.

**A. `last_run` on each `schedule.list` item.** The row's line 3, its edge and
the Schedules dot need the latest run's activity, status and unanswered count,
and nothing else on the client holds a job row: the work list leaves jobs out.
So `schedule.list.subscribe` items are
`ScheduleListItem = Schedule & { last_run?: WorkListItem }` — the row of
`last_run_work_id`, absent when there is none or the work is deleted — and the
list watcher re-sends a schedule when that row changes, on the triggers the
detail watcher uses for its run page (the work changing, its session's turn
moving), de-duplicated against the last row it sent. `Schedule` itself stays
the stored record; `last_run` is beside it, derived, the way `Activity` rides
beside a work detail.

**B. Each schedule's zone.** `time_zone` (an IANA name) on `Schedule`,
required by `schedule.create` and accepted by `schedule.update` alone or with
other fields; the server refuses a missing or unknown zone at the boundary
([api.md](projects/api.md#schedule-time-zones)). With the zone on the
schedule, the schedule itself is all a screen needs, and the subscriptions
carry nothing beside it.

**C. `schedule` on `work.detail`.** For a job, `schedule?: { id, title }` on
`WorkDetailSubscribeResult`, beside `parent` and for the same reason: the page
must name what the work belongs to without a second subscription. Absent when
the schedule is gone. A rename of the schedule reaches an open job page on the
job's next notification; the title is a label, and that staleness is accepted.

On the web side these are `types/schedule.ts`, the RPC creators in
`lib/rpc/schedule.ts`, the subscribe actions in `wsStore`, and `scheduleStore`
filled by `useScheduleSubscription` mounted app-wide in `AppShell` beside
`useAgentRoleSubscription` — app-wide because the Project tab's dot reads it
(§1), and a user has a handful of schedules. A new global store is an *Ask
First* in `web/AGENTS.md`; this one was asked for and approved.

**D. Every start of a job keeps "one run going", and records itself.** A run
that failed to start is left `open` "where a person can start it by hand"
([work-system.md](code/work-system.md#schedules)), but `work.start` on it used
never to reach the schedule store: `last_failure` stayed set and
`last_run_work_id` kept naming the previous run. The notice would have gone on
saying the run could not be started while it ran, the row and the dot could
not see it, and the next firing could start a second run beside it.
Restarting an older, `stopped` run had the same hole. So, on the server:

- **Starting or reopening a job is refused while another run of its schedule
  is `active`**, on every path — `work.start`, `work.reopen`, a firing, Run
  now — with `work.ErrRunActive`. The check reads every run of the schedule,
  not only `last_run_work_id`, since a run can be active without being the
  latest.
- **A job that starts is recorded as its schedule's latest run in exactly one
  place**: the shared start path, through the `work.RunRecorder` the
  scheduler implements. A fired run is recorded once, and a job started by
  hand clears `last_failure` and becomes `last_run_work_id`. A reopen is
  checked but not recorded: the record is of the latest run *started*.
- **The check, the start and the recording are one critical section**, a
  per-schedule guard in `work.Operations` that every caller goes through, so a
  hand start cannot race a firing into two active runs. A firing that a hand
  start overtook while it waited for the guard stands down rather than
  recording a skip — the hand-started run is that firing's run.
- **The one way round it** is an older `stopped` run woken by a message in its
  chat, which nothing can refuse. The check still reads it, so the next firing
  skips beside it (§11).

A refused Restart or Reopen prints on the run's row as line 3, as any refused
lifecycle command does.

**E. The period as values.** The server keeps no cron: the stored format is
the period itself ([api.md](projects/api.md#schedule-periods) is the authority
on the shapes). What the screens rely on:

- **`period` replaces `cron`** on `Schedule`, `schedule.create` and
  `schedule.update` (given whole, or left out to keep it): the shapes of §6.1's
  table. Values, so no screen ever parses or prints a stored expression, and a
  one-time is a date and time rather than an expression that happens to match
  once. Fields that do not belong to the kind are refused, so one period has one
  spelling and `samePeriod` can compare values — reading an hourly `every` or
  `minute` left out as the server's defaults (`1`, `0`), so a stored period the
  server echoes without them is still the one the field writes.
- **A one-time's time must be ahead** when it is set, and an off one-time whose
  time has passed cannot be turned on without a new one; both refusals name the
  time. The client checks the same thing first (§6.2), so the server's words
  are the race's, not the normal path's.
- **Done is read off fields that were already there** — `enabled` and
  `next_run_at`, and for an off one-time the period's own `at` (§6.6) — so
  nothing was added for it. The outcome of the one
  time is said by what every firing already records: the run, `last_failure`,
  `last_skipped_at`.
- **A one-time missed while the server was down is run on startup**; recurring
  firings are still skipped.
- **Saving a period with `enabled: true` beside it** re-arms a done schedule in
  one write; it is `schedule.update` with two fields.

## 10. Mobile and desktop

One layout at every width, as the role and story screens have
([project-ui.md §7](project-ui.md#7-deliberately-not-done) on the master-detail
split): one column, `max-w-2xl`, bottom bar under the thumb.

- **Coarse pointer.** Every control meets 44 × 44 with 8px between neighbours:
  the switch's hit area, the run rows' icons (unchanged `WorkRow`), the day
  toggles (wrapping, §6.1), `Show more runs`. The date and time inputs are the
  native pickers, which on phones is the platform's own wheel or clock; nothing is
  drawn over it.
- **Keyboard on the sheet.** The prompt textarea sits in a `Sheet`, which the
  viewport meta's `interactive-widget=resizes-content` already keeps above the
  soft keyboard; the sheet's body scrolls, the footer stays.
- **Fine pointer.** Hover fills on cards and rows as elsewhere; nothing is
  hover-only. The switch toggles with Space and Enter, the day toggles are
  buttons in tab order.

## 11. Edge cases

| Case | Behaviour |
|---|---|
| A run that failed to start, left `open`, is started by hand | §9 D records it as the latest run: the failure clears, `last_run` names it, and the next firing sees it as the active run it is |
| An older `stopped` run is restarted while the latest one is `active` | Refused (§9 D); the message is the row's line 3. Once nothing else is active, the restart is allowed and becomes `last_run` |
| An older run is reopened while another is `active` | Refused, as the restart is. Once allowed, it is active without being `last_run`; firings skip beside it |
| An older `stopped` run is woken by a message in its chat | Nothing refuses it (§9 D). It is not `last_run`, so it is neither on the row nor in the dot; it shows active on the Runs list, and the firings it causes to be skipped show as the skip notice |
| A firing is overtaken by a run started by hand | No skip is recorded: the hand-started run is that firing's run (§9 D) |
| An older run left `stopped` with a question unanswered, after a newer run was made | Not on the row and not in the dot, which read `last_run` only. It is on the detail's Runs list with its warning edge. Accepted: reading every run for the dot means pushing every schedule's history, and a stopped run has been handed back already |
| The latest run is deleted | `last_run` absent while `last_run_at` is set: line 3 reads `Latest run deleted · {age of last_run_at}`, muted. `No runs yet` is only for a schedule with no `last_run_at` at all. The Runs list shows the rest |
| A schedule is deleted while its detail is open | The detail subscription goes quiet; the list notification removes it from the store and the page shows `Schedule not found` |
| A period kind this build does not know (a newer server) | `Unsupported period` wherever words go; the pencil opens the editor on `Daily 09:00` with the muted line `This period was set by a newer version of Pockode. Saving replaces it.` Nothing is sent until the user saves |
| A period with no kind (a schedule stored as cron before periods, which the server does not migrate) | `Unsupported period`, as above, but the editor's line is `This period could not be read. Saving replaces it.` — it did not come from a newer version |
| A one-time's time passes while its detail is open, the schedule on | The head keeps `Runs today 09:00` until the server's notification drops `next_run_at`; the client never declares an on schedule done from its own clock (§6.6). An open editor goes to `That time has passed.` on the minute (§6.2) |
| An off one-time's time passes while its detail is open | It becomes done on the minute: the switch gives way to `Done` (§6.6) |
| A one-time saved for a time seconds away, which passes in flight | Refused by the server; the refusal prints under the field and the inputs stay (§6.2) |
| Run now on a one-time before its time | A run like any; the one time still fires. If that run is still going then, the one time is skipped — the skip notice — and the schedule is done (§6.6) |
| Pockode is not running at a one-time's time | Run when it starts again (§6.6, §9 E): an ordinary run, dated later than the head's `Was due` |
| A one-time turned off and left off past its time | Done; no switch; `Did not run: it was off`; a new time turns it on (§6.6) |
| Monthly on the 29th or 30th in a shorter month | Runs on that month's last day (§6.3) |
| A wall-clock time a DST change skips or repeats | The server's rule (§6.2); the next-run line shows the instant it chose |
| A role that stops taking jobs | §4.3's line; runs carry on with it |
| The role is deleted (or replaced by Reset to defaults) | §4.3's line; the next firing fails to start and becomes the notice and the error edge. Deleting a role does not count schedules today (§12) |
| The schedule's worktree is deleted | §4.3's line; same |
| Disabled schedule | `Off` on the row, no next run, Run now still works |
| The device is in another zone than the schedule | The label on its times, the zone line and `Use {city} time` (§6.5). Editing the period keeps the schedule's zone |
| The device moves to another zone while the app is open or backgrounded | `useDeviceTimeZone()` re-reads on `visibilitychange` and `focus`; the labels and the switch appear or vanish then |
| The schedule's zone is an alias of the device's (`Asia/Calcutta`, `Asia/Kolkata`) | The same zone: both are canonicalised before comparing (§6.5) |
| The device's browser does not know the schedule's zone (its tz data is older than the server's) | `Intl` throws for it, so nothing can be drawn in it. The zones count as different (§6.5). The period's label is the raw IANA name, `Daily at 09:00 (America/Ciudad_Juarez)`; the instants fall back to the device's zone and so carry **no** label, since they are the device's times; the zone line reads `America/Ciudad_Juarez time, which this device cannot show times in. This device is on London time (UTC+1).`; the switch is offered as usual |
| The device reports no real zone (`Etc/Unknown`, as some locked-down browsers do) | Sent as it is on Create; the server refuses an unknown zone and the sheet prints that refusal under the fields (§5). Not papered over with `UTC`, which would make the user's 09:00 silently mean someone else's. An existing schedule shows its zone as for any other device, but no `Use … time`: there is no zone to switch to |
| Two devices in different zones view one schedule | Each sees it from its own zone: the one in the schedule's zone sees nothing, the other sees the label. Either may switch it; the switch is a write like any setting, and the last write wins |

## 12. Deliberately not done

- **A rule language, or any way to type a period.** The five kinds (§6) cover
  what schedules are made for; a period they cannot say is unsupported until
  someone needs it, and then it is a sixth kind with its own inputs, not an
  expression field.
- **Every N minutes.** An agent run usually takes longer than a quarter of an
  hour, so every 15 minutes would mostly be skips beside a run still going
  (§9 D); hourly is the fastest rhythm that means what it says.
- **The nth weekday of a month** (`first Monday`), **every other week**, and
  **every N days.** Each is a calendar idiom more than a work one; the last two
  also need an anchor date the other kinds do not, which is a second input with
  its own rules. Add one as a kind when someone asks.
- **Hours windows** (`every hour from 9 to 17 on weekdays`) and **several
  times a day** (`09:00 and 17:00`). Two kinds combined, or one kind with a list
  where it has one value; the same answer — and two schedules on one prompt do
  it today.
- **Yearly.** A once-a-year job is rare enough that a one-time, set again after
  it runs, covers it.
- **Marking a one-time run as late.** It is run on startup when it was missed
  (§6.6); the Runs list's date beside the head's `Was due` already says so.
- **Deleting a done one-time by itself.** §6.6.
- **Choosing a zone.** This used to say a schedule had no zone of its own:
  every schedule ran on the server machine's clock. That decision is reversed
  ([why](#why-not-the-servers-clock)), but there is still no picker, field or
  setting for it: the device's zone at creation, and the switch to the viewing
  device's zone, are the only two ways it is set. A zone is where the user is,
  and the device knows that better than a 400-entry list. A user who wants a
  schedule in a zone they are not in has no way to do it — accepted until
  someone asks.
- **Showing a schedule's instants in the device's zone.** §6.5: they are the
  period's firings and read in its clock; the relative half already says when,
  for the user.
- **Counting schedules in a role's references.** `agent_role.delete` refuses a
  role that work items name and ignores schedules, so a role can be deleted
  from under a schedule (§4.3 says so where it shows). Whether a schedule should
  block the delete is the role screens' question, with its own wording to
  write; it is left to them.
- **A default job role setting.** One seeded role, and §5's preselect, cover it;
  revisit if users keep several job roles.
- **Grouping or sorting schedules by state.** §3.3.
- **Bulk enable/disable, duplicate.** Rare; the detail page has room if wanted.
- **A run timeline or calendar view.** The Runs list is the history.
- **Rewording the server's `previous run is still active` refusal**, which names
  ids. The notice says it in words ahead of the press (§4.1); the refusal's own
  wording is a server change for its own story.

## 13. What the implementation has to get right

| # | Check | Where |
|---|---|---|
| 1 | The Project tab reads `Stories`, `Schedules`, `Agent Roles` in that order, and the stories list is headed `Stories` | `ProjectTab.test.tsx`, `WorkListOverlay.test.tsx` |
| 2 | The Schedules dot lights exactly when some `last_run` satisfies `needsAttention` — a failure alone lights nothing; the tab badge is the OR of the two entries' dots | `ProjectTab.test.tsx`, `SessionSidebar.test.tsx` |
| 3 | All seven days is Daily; `samePeriod` compares by value, the weekly days in any order | `schedulePeriod.test.ts` |
| 4 | `describePeriod` writes §6.4's table, including the named firings for N ≥ 6, Once's year only outside the current year in the schedule's zone, the ordinals, and `Unsupported period` | `schedulePeriod.test.ts` |
| 5 | An unchanged period sends nothing; a done one-time's Save sends `enabled: true` and reads `Save and turn on`, any other Save never sends `enabled` | `ScheduleDetailOverlay.test.tsx` |
| 5a | `zonedInstant` turns a wall-clock date and time into the right instant in a zone with DST on both sides of a change; the field shows `That time has passed.` for a past one-time, in the schedule's zone and not the device's | `lib/scheduleZone.test.ts`, `PeriodField.test.tsx` |
| 5b | `isDone`: on, once, no `next_run_at` → done; off, once, `at` past in the schedule's zone → done; on with `next_run_at` in the past → not done. A done schedule: `Done` and no switch on its row and head, `Was due`, no `Use {city} time`, Run now still offered; before its time, the switch and `Runs …` | `schedulePeriod.test.ts`, `ScheduleListOverlay.test.tsx`, `ScheduleDetailOverlay.test.tsx` |
| 5c | Nothing a user sees says cron: `PeriodWords`, `PeriodField` and `describePeriod` take a `Period`, never a string, so no expression can reach a screen — held by the type check, with no string-period prop or export left in `lib/schedulePeriod.ts` | `tsc -b` (`web`'s `build`) |
| 6 | `sameZone` treats aliases as one zone and `Europe/London` / `Africa/Abidjan` as two; `zoneLabel` writes §6.5's forms (`Buenos Aires`, `UTC`, `UTC+9` for `Etc/GMT-9`); the zone line drops a repeated offset | `lib/scheduleZone.test.ts` |
| 6a | With the device's zone the schedule's, no surface shows a label, a zone line or the switch; with another, the row, the head's next run, the notices and the empty Runs line carry `(City)`, and instants and day words are in the schedule's zone | the row's and the detail's tests, with a fixed device zone (`TZ` / a mocked `resolvedOptions`) |
| 6b | Saving a period sends no `time_zone`; the switch confirms, sends `time_zone` alone, and the label stays until the notification carries the new zone; Create sends the device's zone | `ScheduleDetailOverlay.test.tsx`, `CreateScheduleSheet.test.tsx` |
| 7 | The switch shows the server's value, not the tap, and a refusal leaves it with the message as its description | `ScheduleListOverlay.test.tsx` |
| 8 | Runs are `WorkRow`s dated by `created_at` at heading level 4, the stories list still by `updated_at`, Tasks not at all | `WorkRow.test.tsx` (the `dateAt` prop), `ScheduleDetailOverlay.test.tsx` |
| 9 | A notification replacing the newest page keeps older loaded runs (merge by id) | `lib/scheduleRuns.test.ts`; paging against the subscription in `useScheduleDetailSubscription.test.ts` |
| 10 | Create lands on the new schedule's detail; a refusal keeps the sheet and what was typed; the four role-list states | `CreateScheduleSheet.test.tsx` |
| 11 | A job's detail links to its schedule and Backs to it; with the schedule gone, the muted line and Back to `/schedules` | `WorkDetailOverlay.test.tsx` |
| 12 | Both new routes resolve with and without `/w/<worktree>` | `navigation.test.ts`, `AppShell.test.tsx` |
| 13 | Every new icon-only or small control meets the floor | `web/tests/touchTarget.test.ts` (the register regenerated, not silenced) |
| 14 | `last_run`, `time_zone` and `schedule` arrive as §9 says, and `last_run` is re-sent when the run's row moves | `server/watch/schedule_list_test.go`, `server/watch/work_detail_test.go`, `server/ws/rpc_schedule_test.go`, `server/ws/rpc_work_test.go` |
| 14a | A period is refused outside its kind's fields and stored in one spelling; `Next` keeps month ends, hourly spacing and §6.2's DST rule; a one-time is refused once passed (on create, on a new period or zone, on turning back on), fires once and is then done, survives a Run now before its time, and is run on startup when missed while recurring firings are skipped (§9 E) | `server/schedule/period_test.go`, `server/schedule/store_test.go`, `server/schedule/scheduler_test.go` |
| 15 | Starting a failed-to-start job by hand clears `last_failure` and makes it `last_run_work_id`, so the next firing is skipped while it runs; restarting or reopening a run while another is active is refused; a fired run is recorded once; a firing overtaken by a hand start records no skip; a hand start racing Run now leaves exactly one active run (§9 D) | `server/schedule/scheduler_test.go`, `server/ws/rpc_work_test.go` |
| 16 | A run deleted from the newest page's span disappears from the loaded list; an older loaded run does not | `lib/scheduleRuns.test.ts` |
| 17 | `PeriodField` keeps Weekly when all seven days are ticked, carries the time, days, day of month and date across modes as §6.1 says, starts Once on the next occurrence of the carried time, reports `null` with §6.2's hints, and calls nothing on mount | `PeriodField.test.tsx` |
| 18 | Deleting a job from its page lands on its schedule, and deleting a task on its story — wherever the header's Back goes | `WorkDetailOverlay.test.tsx` |
