import type { ServerZone } from "../types/schedule";

/**
 * A schedule's period as the presets write it. The server knows only cron, so
 * this is a way of writing a cron expression, never a second kind of period
 * (docs/schedule-ui.md §6). `toCron` and `parsePeriod` live together so the
 * expression a preset writes and the one it recognises cannot drift.
 *
 * Days are cron's numbering: 0 is Sunday, 6 Saturday.
 */
export type Period =
	| { kind: "hourly"; every: HourlyEvery; minute: number }
	| { kind: "daily"; hour: number; minute: number }
	| { kind: "weekly"; days: number[]; hour: number; minute: number };

/**
 * Only divisors of 24: `*\/5` fires at 00, 05, 10, 15, 20 and then 00 again,
 * a four-hour gap once a day that "every 5 hours" does not describe.
 */
export const HOURLY_EVERY = [1, 2, 3, 4, 6, 8, 12] as const;
export type HourlyEvery = (typeof HOURLY_EVERY)[number];

/** Monday first everywhere, whatever the locale, so the toggles never move. */
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PLURAL = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

export const dayShortName = (day: number) => DAY_SHORT[day];

// The day-of-week names the server's parser takes (server/schedule/cron.go).
// A Map, not an object literal: `constructor` must not read as a day.
const DAY_NAMES = new Map([
	["sun", 0],
	["mon", 1],
	["tue", 2],
	["wed", 3],
	["thu", 4],
	["fri", 5],
	["sat", 6],
]);

const pad2 = (n: number) => String(n).padStart(2, "0");
export const formatClock = (hour: number, minute: number) =>
	`${pad2(hour)}:${pad2(minute)}`;

/** What a new schedule starts on (docs/schedule-ui.md §5). */
export const DEFAULT_CRON = "0 9 * * *";

/** A cron field's whitespace split, the same split the server makes. */
export const cronFields = (cron: string) => cron.trim().split(/\s+/);

/**
 * The expression a period is saved as. A weekly period with all seven days is
 * written as daily, so one period has one spelling; one with no days is not a
 * period, and the caller must not ask for it.
 */
export function toCron(period: Period): string {
	switch (period.kind) {
		case "hourly":
			return period.every === 1
				? `${period.minute} * * * *`
				: `${period.minute} */${period.every} * * *`;
		case "daily":
			return `${period.minute} ${period.hour} * * *`;
		case "weekly": {
			const days = [...new Set(period.days)].sort((a, b) => a - b);
			const dow = days.length === 7 ? "*" : days.join(",");
			return `${period.minute} ${period.hour} * * ${dow}`;
		}
	}
}

function plainInt(s: string, max: number): number | null {
	if (!/^\d+$/.test(s)) return null;
	const n = Number(s);
	return n <= max ? n : null;
}

function dayValue(s: string): number | null {
	const named = DAY_NAMES.get(s.toLowerCase());
	if (named !== undefined) return named;
	// 7 is the second spelling of Sunday, as on the server.
	return plainInt(s, 7);
}

/**
 * The days a day-of-week field names, for the shapes the weekly preset reads:
 * a list of values, ranges and names. Steps and `*` are not that shape.
 */
function parseDays(field: string): Set<number> | null {
	const days = new Set<number>();
	for (const part of field.split(",")) {
		const [a, b, ...rest] = part.split("-");
		if (rest.length > 0) return null;
		const lo = dayValue(a);
		const hi = b === undefined ? lo : dayValue(b);
		if (lo === null || hi === null || lo > hi) return null;
		for (let d = lo; d <= hi; d++) days.add(d % 7);
	}
	return days;
}

/**
 * The preset a stored cron is, or `null` when it is none of them — the field
 * then opens in Custom with the expression as stored. Recognising never
 * rewrites: `0 9 * * MON-FRI` reads as weekly, and stays spelled that way until
 * the user edits it.
 */
export function parsePeriod(cron: string): Period | null {
	const fields = cronFields(cron);
	if (fields.length !== 5) return null;
	const [m, h, dom, month, dow] = fields;
	if (dom !== "*" || month !== "*") return null;
	const minute = plainInt(m, 59);
	if (minute === null) return null;

	if (dow === "*") {
		if (h === "*") return { kind: "hourly", every: 1, minute };
		const step = /^\*\/(\d+)$/.exec(h);
		if (step) {
			const every = Number(step[1]);
			const preset = HOURLY_EVERY.find((n) => n === every && n !== 1);
			return preset ? { kind: "hourly", every: preset, minute } : null;
		}
	}

	const hour = plainInt(h, 23);
	if (hour === null) return null;
	if (dow === "*") return { kind: "daily", hour, minute };

	const days = parseDays(dow);
	if (days === null) return null;
	if (days.size === 7) return { kind: "daily", hour, minute };
	return {
		kind: "weekly",
		days: [...days].sort((a, b) => a - b),
		hour,
		minute,
	};
}

const joinAnd = (items: string[]) =>
	items.length <= 1
		? items.join("")
		: `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function describeDays(days: number[]): string {
	const key = [...days].sort((a, b) => a - b).join(",");
	if (key === "1,2,3,4,5") return "Weekdays";
	if (key === "0,6") return "Weekends";
	if (days.length === 1) return DAY_PLURAL[days[0]];
	return WEEK_DAYS.filter((d) => days.includes(d))
		.map((d) => DAY_SHORT[d])
		.join(", ");
}

/** A preset period in words, server wall-clock time, 24-hour. */
export function describePreset(period: Period): string {
	switch (period.kind) {
		case "hourly": {
			const { every, minute } = period;
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
			return `Daily at ${formatClock(period.hour, period.minute)}`;
		case "weekly":
			// Every day is saved as daily (`toCron`), so it reads as what is saved.
			if (new Set(period.days).size === 7) {
				return describePreset({
					kind: "daily",
					hour: period.hour,
					minute: period.minute,
				});
			}
			return `${describeDays(period.days)} at ${formatClock(period.hour, period.minute)}`;
	}
}

export const CUSTOM_PERIOD_LABEL = "Custom";

/**
 * A stored cron in words. Only the presets are described: a general
 * cron-to-English would be a second interpreter of cron, and the expression
 * itself is exact. The screens draw the same rule with the expression in mono
 * (`PeriodWords`); this is it as one string.
 */
export function describePeriod(cron: string): string {
	const period = parsePeriod(cron);
	return period
		? describePreset(period)
		: `${CUSTOM_PERIOD_LABEL} · ${cron.trim()}`;
}

/** `UTC+9`, `UTC−3:30`, `UTC` — an offset east of UTC, never ambiguous. */
export function formatUtcOffset(offsetSeconds: number): string {
	const totalMinutes = Math.round(offsetSeconds / 60);
	if (totalMinutes === 0) return "UTC";
	const sign = totalMinutes > 0 ? "+" : "−";
	const abs = Math.abs(totalMinutes);
	const hours = Math.floor(abs / 60);
	const minutes = abs % 60;
	return `UTC${sign}${hours}${minutes ? `:${pad2(minutes)}` : ""}`;
}

/** The device's current offset east of UTC, in the server's units. */
export const deviceOffsetSeconds = (now: Date = new Date()) =>
	-now.getTimezoneOffset() * 60;

/**
 * What a list row appends to a period: the server's offset, only when the
 * device is on another one — otherwise the period already reads in the
 * user's own time.
 */
export function periodZoneSuffix(
	zone: ServerZone,
	deviceOffset: number,
): string {
	return zone.offset_seconds === deviceOffset
		? ""
		: ` (${formatUtcOffset(zone.offset_seconds)})`;
}

/**
 * The line under the period in the editor and on the detail page. The zone's
 * abbreviation appears only here and only beside the offset, since one
 * abbreviation (`IST`) can name three zones; a numeric one (`+03`) or a
 * repeat of the offset adds nothing and is left out.
 */
export function periodZoneLine(zone: ServerZone, deviceOffset: number): string {
	const offset = formatUtcOffset(zone.offset_seconds);
	if (zone.offset_seconds === deviceOffset) return `Server time, ${offset}`;
	const name =
		zone.name && !/^[+-]/.test(zone.name) && zone.name !== offset
			? ` (${zone.name})`
			: "";
	return `Server time, ${offset}${name}. This device is on ${formatUtcOffset(deviceOffset)}.`;
}
