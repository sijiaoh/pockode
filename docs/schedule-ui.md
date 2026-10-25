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

**The card opens the detail, and holds one control: the switch.** The title is
a `<button>` covering the card with the `after:inset-0` overlay `WorkRow` uses;
the switch lifts itself above it with `relative z-10`. The title states
`min-h-[44px]`. The card is `h2`-headed (the page's `h1` is the header, and
there are no groups between).

**Line 1** — the title, truncated; the switch at the end (§3.2).

**Line 2** — one line, never wrapped, clipped from the right, two slots:

| Slot | Tier | Content |
|---|---|---|
| Period | `text-th-text-secondary` | `PeriodWords` (§6.4), followed by the schedule's zone label (`(Tokyo)`) only when it is not the device's zone (§6.5). A cron that matches no preset reads `Custom ·` and the expression in `font-mono` |
| Next | `text-th-text-muted` | Enabled: `Next in 5h` (`formatRelativeFuture(next_run_at)`, beside `formatRelativeDate` in `utils/relativeTime.ts`, with its steps: `in 1m`, `in 5h`, `in 3d` — never "now", and hours and days rounded rather than floored, so 47h is `in 2d`); nothing while no next firing is known. Disabled: `Off` |

The period is first because it is the one fact that says what this schedule
*is*; "next" is derived from it.

**Line 3** — the latest run, and the only line that moves on its own:

| Case | Line 3 |
|---|---|
| `last_failure` set | `AlertCircle` (error tone) + `Last run failed` + `· {age of last_failure.at}` |
| `last_run` present | `ActivityIcon` of the run + its activity label + `· {age of last_run_at}`. `1 to answer` follows the label when the run owes answers, as slot 2b does on a work row |
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
  when you press Run now`. The absolute time is
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
| `last_skipped_at` is later than `last_run_at`, or there is no `last_run_at` | Muted: `Skipped the run at {at}: the previous one was still going.` |

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
zone, with its label when it differs, §6.5), or, when off or no
next firing is known, `No runs yet. Press Run now to make one.` A schedule whose runs were all
deleted is not one with none yet: with `last_run_at` set the line is
`Its runs have been deleted.`, as the row says `Latest run deleted` (§11).

### 4.3 The settings

Each is edited in place and saved on its own — no page-wide Save, as on the
work and role pages.

| Section | Control |
|---|---|
| **Prompt** | The work detail's Description interaction: `MarkdownContent` in an `overflow-x-auto` box, a pencil opening a textarea with Save / Cancel. Never empty (the server requires it), so it has no empty state. Muted line under the heading: `Every run starts with this prompt.` |
| **Period** | Read-only, `PeriodWords`; when the schedule's zone is not the device's, the zone line and the `Use {city} time` switch under it (§6.5). A pencil opens the `PeriodField` (§6) with Save / Cancel; Save sends `cron` only if it differs from the stored string, and otherwise just closes; it never sends `time_zone`, so editing keeps the schedule's zone. While the save is in flight the field sits in a `<fieldset disabled>`, so an edit made during the request cannot be dropped silently when the editor closes on success |
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
Period   [ Hourly | Daily | Weekly | Custom ]
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
  sheet holds `DEFAULT_CRON` (`lib/schedulePeriod.ts`, `0 9 * * *`) as its cron
  until the field is touched, because the field reports nothing on mount.
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
  picked, and the period is complete (a weekly period with at least one day;
  a custom cron with five fields — the count only, everything else is the
  server's to judge, §6.3).

The rest is `CreateStorySheet`'s behaviour, unchanged: focus lands on the
sheet; a refusal keeps the sheet open with everything typed and the server's
error under the fields (an invalid cron's message names the field, which is
why it is printed as it is); `dismissible={false}` while in flight, with every
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
user's cron — Create would send a period other than the one shown. So once the
form has been shown it stays up through a role reload; if the swap happens
anyway (the reload failed), the cron goes back to `DEFAULT_CRON` with the
field.

## 6. The period

**Always stored as cron.** The presets are a way of writing a cron expression,
not a second kind of period: the server knows only `cron`, and the client turns
an expression into a preset when it can and shows it raw when it cannot.

### 6.1 The field

`PeriodField` (`components/Project/PeriodField.tsx`) is the one editor, in the
sheet and on the detail page. Its contract:

- **`initial: string`** (a cron, or `""` for a new schedule) is read **once, on
  mount**, to pick the mode and fill the inputs (§6.2). After that the mode and
  every input are the field's own state. The mode is never re-derived from the
  cron being written: ticking the seventh day writes a daily cron, and typing a
  preset-shaped expression in Custom writes one the presets would recognise,
  and neither may swap the inputs out from under the user.
- **`onChange(cron: string | null)`**, called on every edit with the cron the
  inputs now spell, or `null` when they spell nothing yet (no weekday ticked, an
  empty or out-of-range minute or time, a custom text without five fields).
  The caller disables Save / Create on `null`.
- **"Changed" is the caller's comparison with the stored string**, and only
  after the user has touched an input — the field calls nothing on mount. So a
  `0 9 * * MON-FRI` opened as Weekly and saved untouched sends nothing; once a
  day is toggled it is rewritten in the canonical spelling, which is the
  user's edit.

A `ToggleGroup` picks the mode — used for a draft value here, as
`CreateAgentRoleSheet`'s Runs choice already uses it, though its own comment
describes a stored one — and the inputs under it follow:

| Mode | Inputs | Writes |
|---|---|---|
| **Hourly** | `Every [1 ▾] hour(s) at minute [00]` — a `<select>` of 1, 2, 3, 4, 6, 8, 12 and a two-digit text input (`inputMode="numeric"`) taking 0–59; `hour` agrees with N | `M * * * *` for 1, `M */N * * *` otherwise |
| **Daily** | `At [09:00]` — `<input type="time">` | `M H * * *` |
| **Weekly** | Seven day toggles, Mon to Sun, and `At [09:00]` | `M H * * d,d,…` — days ascending, Sunday as `0`, so Mon/Wed/Fri at 09:00 is `0 9 * * 1,3,5` |
| **Custom** | One `font-mono` text input, placeholder `minute hour day month weekday`, with the muted hint `Standard 5-field cron, e.g. 0 9 1 * * for 09:00 on the 1st.` | the text, trimmed |

- **Hourly offers only divisors of 24.** `*/5` fires at 00, 05, 10, 15, 20 and
  then 00 again: a gap of four hours once a day that "every 5 hours" does not
  describe. A user who wants that writes it in Custom.
- **Weekly with all seven days is written as daily** (`M H * * *`), so one
  period has one spelling. **Weekly with none** keeps Save/Create disabled with
  the muted line `Pick at least one day.`; a minute outside 0–59 says
  `Enter a minute from 0 to 59.` and a cleared time `Pick a time.`
- **The day toggles** are `aria-pressed` buttons labelled `Mon` … `Sun` — filled
  with the accent when on, only bordered when off, since a fill would vanish on
  the sheet's own ground — 44 × 44,
  `gap-2`, in a wrapping row: seven take 356px, so they sit on one row in a
  column that wide (a phone of about 390px and up) and wrap to two below it —
  wrapping is what keeps every one of them at the floor. The week starts on
  Monday everywhere; a locale-dependent first day would move the buttons
  under a user who changes language.
- **Switching mode keeps what carries.** Daily ↔ Weekly keep the time; Hourly
  takes the minute from it and Daily takes it back with hour `09`. Any preset →
  Custom fills the text with the cron the preset would write, so Custom is also
  how a user learns the syntax (inputs that spell nothing yet leave the Custom
  text as it was). Custom → a preset parses the text (§6.2): if it is some
  preset, its values fill the inputs and then carry by the rules above (a
  daily text ticks all seven days in Weekly), and inputs the text does not
  name keep what they held, so days survive a look at Custom; if it is no
  preset, the preset starts at its defaults (`Daily 09:00`, `Every 1 hour at
  :00`, `Mon at 09:00`).
- **Re-tapping the lit mode is not an edit**: nothing is reported, so an
  untouched `MON-FRI` schedule cannot be made to look changed.
- Under the inputs, always: the description (§6.4) of what would be saved, one
  muted line. In Custom mode the description is shown only when the
  text happens to match a preset; otherwise the line says
  `Checked by the server when you save.` rather than nothing.
- **`timeZone?: string`** — the schedule's zone, passed by the detail page and
  not by the create sheet. When it is given and is not the device's zone
  (`sameZone`, §6.5), the zone line follows the description on a line of its
  own: `Tokyo time (UTC+9). This device is on London time (UTC+1).` — the
  zone every input is typed in. The field never sends a zone: it only writes
  `cron`.

### 6.2 Reading a cron back

`parsePeriod(cron): Period | null` in `lib/schedulePeriod.ts`, with
`toCron(period)` and the describers (§6.4) beside it — one module, so the
expression a preset writes and the one it recognises cannot drift. It returns a
preset only for these shapes, after splitting on whitespace:

| Shape | Preset |
|---|---|
| `M * * * *` | Hourly, every 1 |
| `M */N * * *`, N ∈ {2,3,4,6,8,12} | Hourly, every N |
| `M H * * *` | Daily |
| `M H * * D`, D a list of day values, ranges and names (`1-5`, `MON-FRI`, `sun`, `7`) that expands to 1–6 distinct days | Weekly |
| `M H * * D` where D expands to all 7 | Daily |

`M` and `H` must be plain integers in range (`0`–`59`, `0`–`23`; leading zeros
allowed). Day names are read case-insensitively and `7` is Sunday, as the
server's parser reads them. Anything else — a step on the minute, `*/1` on the
hour, a day-of-month, a month, a list of hours, a backwards day range
(`FRI-MON`, which the server refuses too) — is `null`, and the field opens in **Custom** with the expression
as stored.

Recognising an expression never rewrites it: recognition picks the inputs,
and only an edit to them writes (§6.1).

### 6.3 What the client does not check

The client checks the field count of a custom cron (so Create is not offered
for half an expression) and nothing more. Ranges, names, steps and the dates
that never occur are the server's parser's
(`server/schedule/cron.go`), whose refusal already names the field and the
range (`minute field "61": 61 is out of range 0-59`). A second validator here
would be a second definition of cron that disagrees with the one that runs —
and the server's message is printed under the field either way.

### 6.4 Periods in words

`describePreset(period)` writes the words for a preset, 24-hour times, the
minute always two digits; a weekly period with all seven days reads as daily.
Every screen draws a cron through `components/Project/PeriodWords.tsx`, which
parses it and prints the preset's words, or `Custom ·` (`CUSTOM_PERIOD_LABEL`)
and the expression in mono. `describePeriod(cron)` is the same as one plain
string:

| Period | Words |
|---|---|
| Hourly, 1 | `Every hour at :15` |
| Hourly, N ≤ 4 | `Every 2 hours at :15` |
| Hourly, N ≥ 6 | `Every 6 hours, at 00:15, 06:15, 12:15 and 18:15` — four firings or fewer a day are named, because "every 6 hours" does not say which six |
| Daily | `Daily at 09:00` |
| Weekly, Mon–Fri | `Weekdays at 09:00` |
| Weekly, Sat and Sun | `Weekends at 09:00` |
| Weekly, one day | `Mondays at 09:00` |
| Weekly, other sets | `Mon, Wed, Fri at 09:00` — Monday-first, as the toggles |
| no preset | `Custom` and the expression, mono: `Custom · 0 9 1 * *` |

**No general cron-to-English.** Describing every cron (`at 09:00 on day 1 of
the month`, the Vixie OR between day-of-month and day-of-week) is a library's
worth of rules and a second interpreter of cron; the expression itself is
exact, and a user who wrote it reads it.

### 6.5 Time zones

**Every schedule carries its own IANA zone** (`time_zone`, e.g. `Asia/Tokyo`;
[data-model](projects/data-model.md#schedule)), and the server evaluates its
cron in that zone, DST included, against the tz database built into the
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
  means 09:00 in Tokyo. The period's words, the editor's inputs and its
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
| List row, custom cron | `Custom · 0 9 1 * *` | `Custom · 0 9 1 * * (Tokyo)` — the label in the line's own font, not mono |
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

Saving the period sends `cron` and nothing else (§4.3), whatever zone the
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
only, the cron as stored. The wall-clock period is kept and re-read in the new
zone: `Daily at 09:00` in Tokyo becomes `Daily at 09:00` in London. That is what
"run it on my time" means, and the instants follow from the server's next
notification (`next_run_at` is the server's to compute — the client evaluates
no cron, §6.3).

**It confirms**, with a non-`danger` `ConfirmDialog`, because from here it
cannot be undone: there is no zone picker, so only a device in Tokyo can put
the schedule back in Tokyo.

> **Run on London time?**
> "Daily at 09:00" will run on London time (UTC+1) instead of Tokyo time
> (UTC+9). Only a device on Tokyo time can switch it back.
>
> [ Cancel ] [ Use London time ]

The quoted period is `describePeriod(cron)`, so the sentence holds for every
period, an hourly or a custom one (`"Custom · 0 9 1 * *" will run on …`)
included — it never claims a clock time the period does not have. The names and
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
(A–C), and one piece of bookkeeping was missing (D). Each went where the data
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

## 10. Mobile and desktop

One layout at every width, as the role and story screens have
([project-ui.md §7](project-ui.md#7-deliberately-not-done) on the master-detail
split): one column, `max-w-2xl`, bottom bar under the thumb.

- **Coarse pointer.** Every control meets 44 × 44 with 8px between neighbours:
  the switch's hit area, the run rows' icons (unchanged `WorkRow`), the day
  toggles (wrapping, §6.1), `Show more runs`. The time input is the native
  picker, which on phones is the platform's own wheel or clock; nothing is
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
| A cron that is legal but never matches a preset (`*/15 9-17 * * 1-5`) | Custom everywhere: row `Custom · */15 9-17 * * 1-5`, editor opens in Custom |
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

- **A general cron describer and a client-side cron validator.** §6.3, §6.4.
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
| 3 | `parsePeriod` / `toCron` round-trip every preset; the shapes in §6.2 map as listed; anything else is `null`; all seven days are Daily | `schedulePeriod.test.ts` |
| 4 | `describePeriod` writes §6.4's table, including the named firings for N ≥ 6 and `Custom ·` | `schedulePeriod.test.ts` |
| 5 | An unchanged period sends no `cron`, including one stored in a spelling the preset would not write (`MON-FRI`) | `ScheduleDetailOverlay.test.tsx` |
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
| 15 | Starting a failed-to-start job by hand clears `last_failure` and makes it `last_run_work_id`, so the next firing is skipped while it runs; restarting or reopening a run while another is active is refused; a fired run is recorded once; a firing overtaken by a hand start records no skip; a hand start racing Run now leaves exactly one active run (§9 D) | `server/schedule/scheduler_test.go`, `server/ws/rpc_work_test.go` |
| 16 | A run deleted from the newest page's span disappears from the loaded list; an older loaded run does not | `lib/scheduleRuns.test.ts` |
| 17 | `PeriodField` keeps its mode when the cron it writes would read back as another (seven days ticked; a preset-shaped custom text), reports `null` while incomplete, and calls nothing on mount | `PeriodField.test.tsx` |
| 18 | Deleting a job from its page lands on its schedule, and deleting a task on its story — wherever the header's Back goes | `WorkDetailOverlay.test.tsx` |
