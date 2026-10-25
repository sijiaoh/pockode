/**
 * The one place an instant becomes wall-clock text. Every shape is 24-hour and
 * written out rather than localised, so a time reads the same in every locale.
 * Instants are drawn on the device's clock unless a `timeZone` is given (a
 * schedule's own), and a value that is not an instant is returned as it came.
 *
 * Ages and waits ("4m ago", "in 5h") are not wall-clock times; they are in
 * `relativeTime.ts`.
 *
 * `web/tests/dateFormatting.test.ts` fails any other file that formats a date
 * or reads its fields itself, but for the zone helpers this module is built on.
 */

import { type WallClock, wallClock } from "../lib/scheduleZone";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** `Mon` for `1`, as `Date#getDay` counts. */
export const dayShortName = (day: number) => DAY_SHORT[day];

/** `05` — a minute or an hour, always two digits. */
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** `03:05`. */
export const formatClock = (hour: number, minute: number) =>
	`${pad2(hour)}:${pad2(minute)}`;

function parseInstant(iso: string): Date | null {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whether `value` is an instant these shapes can draw — for a time that is
 * left out rather than shown raw when it is missing or unreadable.
 */
export const isInstant = (value: string | undefined): value is string =>
	value !== undefined && parseInstant(value) !== null;

// Calendar days, counted in UTC so no DST change lengthens one.
const calendarDays = (from: WallClock, to: WallClock) =>
	Math.round(
		(Date.UTC(to.year, to.month, to.day) -
			Date.UTC(from.year, from.month, from.day)) /
			DAY_MS,
	);

function formatDate(at: WallClock, withYear: boolean): string {
	const weekday = new Date(Date.UTC(at.year, at.month, at.day)).getUTCDay();
	const date = `${DAY_SHORT[weekday]} ${at.day} ${MONTH_SHORT[at.month]}`;
	return withYear ? `${date} ${at.year}` : date;
}

/**
 * `Mon 3 Nov`, and `Mon 3 Nov 2025` when the year is not the current one on
 * `timeZone`'s calendar.
 */
export function formatWallDate(
	at: WallClock,
	now: Date = new Date(),
	timeZone?: string,
): string {
	return formatDate(at, at.year !== wallClock(now, timeZone).year);
}

/** `Mon 3 Nov 14:02`, the year as `formatWallDate` puts it. */
export function formatWallDateTime(
	at: WallClock,
	now: Date = new Date(),
	timeZone?: string,
): string {
	return `${formatWallDate(at, now, timeZone)} ${formatClock(at.hour, at.minute)}`;
}

/** `14:02`, with no day. */
export function formatTime(iso: string, timeZone?: string): string {
	const date = parseInstant(iso);
	if (!date) return iso;
	const at = wallClock(date, timeZone);
	return formatClock(at.hour, at.minute);
}

/** `Mon 3 Nov 2025 14:02`, the year always — where the instant is the record. */
export function formatDateTime(iso: string, timeZone?: string): string {
	const date = parseInstant(iso);
	if (!date) return iso;
	const at = wallClock(date, timeZone);
	return `${formatDate(at, true)} ${formatClock(at.hour, at.minute)}`;
}

/**
 * `14:02` today, `Mon 3 Nov 14:02` on another day — for a list where most
 * entries are recent and the date is noise until it is not.
 */
export function formatCompactDateTime(
	iso: string,
	now: Date = new Date(),
	timeZone?: string,
): string {
	const date = parseInstant(iso);
	if (!date) return iso;
	const at = wallClock(date, timeZone);
	return calendarDays(wallClock(now, timeZone), at) === 0
		? formatClock(at.hour, at.minute)
		: formatWallDateTime(at, now, timeZone);
}

/**
 * `today 03:00`, `tomorrow 03:00`, `yesterday 03:00`, `Mon 27 Oct 03:00`
 * further out — on the clock of `timeZone`, whose days `today` and `tomorrow`
 * are too. For a schedule's firings, past and next, where the age alone would
 * not say which firing it was (docs/schedule-ui.md §4.1, §6.5).
 */
export function formatRelativeDay(
	iso: string,
	now: Date = new Date(),
	timeZone?: string,
): string {
	const date = parseInstant(iso);
	if (!date) return iso;
	const at = wallClock(date, timeZone);
	const time = formatClock(at.hour, at.minute);
	switch (calendarDays(wallClock(now, timeZone), at)) {
		case 0:
			return `today ${time}`;
		case 1:
			return `tomorrow ${time}`;
		case -1:
			return `yesterday ${time}`;
		default:
			return formatWallDateTime(at, now, timeZone);
	}
}
