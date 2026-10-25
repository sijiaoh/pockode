# Time Display

How `web` writes a date or a time on the screen: one module writes every one
of them, in a fixed shape, on the device's clock.

## The rule

Every displayed date and time goes through `web/src/utils/dateTime.ts`.
Nothing else in `web/src` turns a `Date` into text or reads its fields — not
`toLocaleTimeString()`, not an `Intl.DateTimeFormat` of its own, not a
`getHours()` padded by hand.

Ages and waits (`4m ago`, `in 5h`) are durations, not wall-clock times, and
stay in `web/src/utils/relativeTime.ts` (`formatRelativeDate`,
`formatRelativeFuture`). A surface that shows both — the schedule head's
`Next run today 03:00 (in 5h)` — takes one half from each.

**Why one module.** Each screen used to format its own times, so the session
list said `02:02 PM` in the browser's locale, the commit view said whatever
`toLocaleString()` gave, and a schedule said `14:02` — three shapes for one
kind of fact. Nothing about that renders wrong enough to be
noticed in review, which is why the rule is held by a test and not by habit.

## The shapes

Every shape is 24-hour and spelled out (`Mon 3 Nov`), never localised, so a
time reads the same in every locale and matches a schedule's period words
([schedule-ui.md §6.4](schedule-ui.md#64-periods-in-words)). The year appears only
when it is not the current one, except in `formatDateTime`, whose instant is
the record itself.

| Function | Reads | For |
| --- | --- | --- |
| `formatTime` | `14:02` | a time shown without its day, as the surface's doc specifies — a question's asked time, a wait's start |
| `formatCompactDateTime` | `14:02` today, `Mon 3 Nov 14:02` otherwise | a list where most entries are recent — sessions, comments |
| `formatDateTime` | `Mon 3 Nov 2025 14:02` | where the instant is the thing being shown — a commit |
| `formatRelativeDay` | `today 03:00`, `tomorrow 03:00`, `Mon 27 Oct 03:00` | a schedule's firings, past and next |
| `formatWallDate` / `formatWallDateTime` | `Mon 3 Nov`, `Mon 3 Nov 07:05` | a wall-clock value that is not an instant — a one-time period's `at` |
| `formatClock`, `dayShortName`, `pad2` | `09:00`, `Mon`, `05` | the parts a period's words and its time inputs are built from |

The exact behaviour of each — the boundaries of "today", the year rule — is the
function's own comment and `dateTime.test.ts`; this table is only for choosing
one. A new shape is added to the module, not written at the call site.

A value that is not an instant comes back unchanged. A surface that should drop
a missing or unreadable time instead of showing it raw checks `isInstant` first
([lifecycle-ui.md](lifecycle-ui.md) asks this of the attention strip's
`since`).

## Whose clock

Times are drawn in **the device's zone**, and there is no time-zone setting.
The zone is where the user is, which the device already knows; a setting could
only disagree with it, and a user who travels would have to remember to change
it.

The one exception is a schedule's own instants — its next run, its notices —
which are drawn in the schedule's zone, because that is the zone its period is
written in ([schedule-ui.md §6.5](schedule-ui.md#65-time-zones)). Those callers
pass the zone as the `timeZone` argument. A run of that schedule is ordinary
work and is drawn in the device's zone like any other.

## Enforcement

`web/tests/dateFormatting.test.ts` scans `web/src` and fails on any other file
that formats a date or reads its fields, naming the line and the module to use
instead. It exempts the module itself and the few zone-reading functions in
`web/src/lib/scheduleZone.ts` that the module is built on; each exemption fails
once it is no longer needed. Why it is a typed scan rather than a lint rule,
and what it cannot see, is the test file's header.
