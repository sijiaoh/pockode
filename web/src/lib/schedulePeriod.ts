import type { HourlyEvery, Period, Schedule } from "../types/schedule";
import {
	dayShortName,
	formatClock,
	formatWallDate,
	pad2,
} from "../utils/dateTime";
import { parseWallClock, zonedInstant } from "./scheduleZone";

/**
 * A schedule's period as the screens read, compare and describe it
 * (docs/schedule-ui.md §6). The period is values, as the server stores it, so
 * nothing here parses an expression: the words are read off the values.
 */

/**
 * Only divisors of 24: every 5 hours from midnight fires at 00, 05, 10, 15,
 * 20 and then 00 again, a four-hour gap once a day that "every 5 hours" does
 * not describe.
 */
export const HOURLY_EVERY: readonly HourlyEvery[] = [1, 2, 3, 4, 6, 8, 12];

/** Monday first everywhere, whatever the locale, so the toggles never move. */
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** The monthly `day` that means the last day of every month. */
export const LAST_DAY = 31;

const DAY_PLURAL = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

/** `1st`, `2nd`, `3rd`, `4th` … `11th`, `12th`, `13th` … `21st`. */
export function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
	return `${n}${suffix}`;
}

/** What a new schedule starts on (docs/schedule-ui.md §5). */
export const DEFAULT_PERIOD: Period = { kind: "daily", time: "09:00" };

const KNOWN_KINDS = new Set<string>([
	"once",
	"hourly",
	"daily",
	"weekly",
	"monthly",
]);

/**
 * Whether this build knows the period's kind. A newer server may send one it
 * does not; the type cannot say so, the wire can (docs/schedule-ui.md §11).
 */
export const isKnownPeriod = (period: Period) => KNOWN_KINDS.has(period.kind);

/**
 * The period in the one spelling the server stores: the hourly defaults
 * written out, the weekdays ascending without repeats, seven of them daily.
 */
function canonical(period: Period): Period {
	switch (period.kind) {
		case "hourly":
			return {
				kind: "hourly",
				every: period.every ?? 1,
				minute: period.minute ?? 0,
			};
		case "weekly": {
			const weekdays = [...new Set(period.weekdays)].sort((a, b) => a - b);
			return weekdays.length === 7
				? { kind: "daily", time: period.time }
				: { kind: "weekly", weekdays, time: period.time };
		}
		default:
			return period;
	}
}

/** Two periods are one when they fire alike, whatever spelling each came in. */
export function samePeriod(a: Period, b: Period): boolean {
	if (!isKnownPeriod(a) || !isKnownPeriod(b)) return false;
	const x = canonical(a);
	const y = canonical(b);
	switch (x.kind) {
		case "once":
			return y.kind === "once" && x.at === y.at;
		case "hourly":
			return (
				y.kind === "hourly" && x.every === y.every && x.minute === y.minute
			);
		case "daily":
			return y.kind === "daily" && x.time === y.time;
		case "weekly":
			return (
				y.kind === "weekly" &&
				x.time === y.time &&
				x.weekdays.join() === y.weekdays.join()
			);
		case "monthly":
			return y.kind === "monthly" && x.day === y.day && x.time === y.time;
	}
}

const joinAnd = (items: string[]) =>
	items.length <= 1
		? items.join("")
		: `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function describeDays(days: number[]): string {
	const key = days.join(",");
	if (key === "1,2,3,4,5") return "Weekdays";
	if (key === "0,6") return "Weekends";
	if (days.length === 1) return DAY_PLURAL[days[0]];
	return WEEK_DAYS.filter((d) => days.includes(d))
		.map(dayShortName)
		.join(", ");
}

export const UNSUPPORTED_PERIOD_LABEL = "Unsupported period";

/**
 * A period in words, 24-hour, the minute always two digits
 * (docs/schedule-ui.md §6.4). A one-time is an absolute date, with the year
 * only when it is not the current one on `timeZone`'s calendar (the device's
 * when absent): a period's words do not count down.
 */
export function describePeriod(
	period: Period,
	timeZone?: string,
	now: Date = new Date(),
): string {
	if (!isKnownPeriod(period)) return UNSUPPORTED_PERIOD_LABEL;
	const p = canonical(period);
	switch (p.kind) {
		case "once": {
			const wall = parseWallClock(p.at);
			if (!wall) return `Once at ${p.at}`;
			return `Once on ${formatWallDate(wall, now, timeZone)} at ${formatClock(wall.hour, wall.minute)}`;
		}
		case "hourly": {
			const every = p.every ?? 1;
			const minute = p.minute ?? 0;
			if (every === 1) return `Every hour at :${pad2(minute)}`;
			if (every <= 4) return `Every ${every} hours at :${pad2(minute)}`;
			// Four firings a day or fewer are named: "every 6 hours" does not say
			// which six.
			const times = [];
			for (let hour = 0; hour < 24; hour += every) {
				times.push(formatClock(hour, minute));
			}
			return `Every ${every} hours, at ${joinAnd(times)}`;
		}
		case "daily":
			return `Daily at ${p.time}`;
		case "weekly":
			return `${describeDays(p.weekdays)} at ${p.time}`;
		case "monthly":
			return p.day >= LAST_DAY
				? `Monthly on the last day at ${p.time}`
				: `Monthly on the ${ordinal(p.day)} at ${p.time}`;
	}
}

/**
 * A one-time schedule whose time has gone by (docs/schedule-ui.md §6.6). On,
 * it is done once the server has handled the time — it drops `next_run_at` —
 * and never by this device's clock, which may run ahead of the server's. Off,
 * the server will do nothing at the time and refuses to turn it on after, so
 * the clock decides; a zone the browser does not know cannot be judged, and
 * the schedule is then drawn as off.
 */
export function isDone(
	schedule: Pick<Schedule, "period" | "enabled" | "next_run_at" | "time_zone">,
	now: number = Date.now(),
): boolean {
	const { period } = schedule;
	if (period.kind !== "once") return false;
	if (schedule.enabled) return !schedule.next_run_at;
	const at = zonedInstant(period.at, schedule.time_zone);
	return at !== null && at <= now;
}
