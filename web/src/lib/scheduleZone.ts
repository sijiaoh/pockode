/**
 * A schedule's IANA zone as the screens name and compare it
 * (docs/schedule-ui.md §6.5). Every name the browser cannot resolve is handled
 * here, so no surface has to catch `Intl`'s `RangeError` itself.
 */

/** `UTC+9`, `UTC−3:30`, `UTC` — an offset east of UTC, never ambiguous. */
export function formatUtcOffset(offsetSeconds: number): string {
	const totalMinutes = Math.round(offsetSeconds / 60);
	if (totalMinutes === 0) return "UTC";
	const sign = totalMinutes > 0 ? "+" : "−";
	const abs = Math.abs(totalMinutes);
	const hours = Math.floor(abs / 60);
	const minutes = abs % 60;
	return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/**
 * The zone as this browser resolves it, or `null` for a zone it does not
 * know. Before Temporal this also folds aliases (`Asia/Calcutta`,
 * `Asia/Kolkata`) together; with it, the name comes back as given.
 */
function resolveZone(iana: string): string | null {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: iana,
		}).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

export const isKnownZone = (iana: string) => resolveZone(iana) !== null;

// The slice of Temporal used here; TypeScript's lib does not declare it yet.
interface TemporalZones {
	ZonedDateTime: new (
		epochNanoseconds: bigint,
		timeZone: string,
	) => { equals(other: unknown): boolean };
}

/**
 * Whether two zones are one, by name. Never by current offset: London and
 * Abidjan agree in winter and not in summer. A zone the browser does not know
 * is never the same as anything.
 */
export function sameZone(a: string, b: string): boolean {
	if (!isKnownZone(a) || !isKnownZone(b)) return false;
	// Where Temporal exists, `resolvedOptions` stops canonicalising, and
	// `ZonedDateTime#equals` is what still treats an alias as its zone.
	const { Temporal } = globalThis as { Temporal?: TemporalZones };
	if (Temporal) {
		return new Temporal.ZonedDateTime(0n, a).equals(
			new Temporal.ZonedDateTime(0n, b),
		);
	}
	return resolveZone(a) === resolveZone(b);
}

/** The zone's offset east of UTC at `at`, or `null` when it cannot be read. */
export function zoneOffsetSeconds(
	iana: string,
	at: Date = new Date(),
): number | null {
	let name: string | undefined;
	try {
		name = new Intl.DateTimeFormat("en-US", {
			timeZone: iana,
			timeZoneName: "longOffset",
		})
			.formatToParts(at)
			.find((part) => part.type === "timeZoneName")?.value;
	} catch {
		return null;
	}
	// `GMT`, `GMT+09:00`, `GMT-03:30`.
	if (name === "GMT") return 0;
	const match = name && /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
	if (!match) return null;
	const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
	return match[1] === "-" ? -seconds : seconds;
}

// Names that are an offset rather than a place. `Etc/GMT-9` is UTC+9 — the
// `Etc` signs are inverted — so they are written from `Intl`, never the name.
const UTC_NAMES = new Set(["UTC", "GMT", "UCT", "Universal", "Zulu"]);
const isOffsetName = (iana: string) =>
	iana.startsWith("Etc/") || UTC_NAMES.has(iana);

/**
 * The short form, beside a period or an instant: the city (`Tokyo`,
 * `Buenos Aires`), the offset for a name that is not a place (`UTC`, `UTC+9`),
 * a legacy name without a `/` as it is, and an unknown zone as its raw name.
 */
export function zoneLabel(iana: string): string {
	if (!isKnownZone(iana)) return iana;
	if (isOffsetName(iana)) {
		const offset = zoneOffsetSeconds(iana);
		return offset === null ? iana : formatUtcOffset(offset);
	}
	return iana.slice(iana.lastIndexOf("/") + 1).replaceAll("_", " ");
}

/** `Tokyo time (UTC+9)`; the bracket is left out when it would repeat the label or cannot be read. */
export function zoneName(iana: string, at: Date = new Date()): string {
	const label = zoneLabel(iana);
	const offset = zoneOffsetSeconds(iana, at);
	if (offset === null) return `${label} time`;
	const formatted = formatUtcOffset(offset);
	return formatted === label ? `${label} time` : `${label} time (${formatted})`;
}

/**
 * The line under a period whose zone is not the device's:
 * `Tokyo time (UTC+9). This device is on London time (UTC+1).`
 */
export function zoneLine(
	scheduleZone: string,
	deviceZone: string,
	at: Date = new Date(),
): string {
	const schedule = !isKnownZone(scheduleZone)
		? `${scheduleZone} time, which this device cannot show times in`
		: zoneName(scheduleZone, at);
	return `${schedule}. This device is on ${zoneName(deviceZone, at)}.`;
}

/**
 * The label a schedule's instant carries: none while the zones are the same,
 * and none for a zone the browser cannot draw in — its instants fall back to
 * the device's zone, and those are the device's times.
 */
export function instantZoneLabel(
	scheduleZone: string,
	deviceZone: string,
): string | null {
	if (sameZone(scheduleZone, deviceZone)) return null;
	if (!isKnownZone(scheduleZone)) return null;
	return zoneLabel(scheduleZone);
}

/** The label a schedule's period carries: none while the zones are the same. */
export function periodZoneLabel(
	scheduleZone: string,
	deviceZone: string,
): string | null {
	return sameZone(scheduleZone, deviceZone) ? null : zoneLabel(scheduleZone);
}

export interface WallClock {
	year: number;
	/** 0-based, as `Date`'s. */
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const WALL_CLOCK: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "numeric",
	hourCycle: "h23",
};

/**
 * `date` on the wall clock of `timeZone` — the device's when absent, or when
 * the browser does not know the zone (docs/schedule-ui.md §11).
 */
export function wallClock(date: Date, timeZone: string | undefined): WallClock {
	// Built per call, never cached: a format made without a zone keeps the
	// device's zone of that moment, and a traveller's device moves.
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-US", { ...WALL_CLOCK, timeZone });
	} catch {
		format = new Intl.DateTimeFormat("en-US", WALL_CLOCK);
	}
	const parts = Object.fromEntries(
		format.formatToParts(date).map((part) => [part.type, part.value]),
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month) - 1,
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
	};
}

/** A one-time period's `YYYY-MM-DDTHH:MM`, or `null` when it is not one. */
export function parseWallClock(at: string): WallClock | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at);
	if (!match) return null;
	const [year, month, day, hour, minute] = match.slice(1).map(Number);
	const wall = { year, month: month - 1, day, hour, minute };
	// `Date.UTC` rolls 31 February over into March; a real date survives it.
	const back = new Date(Date.UTC(year, month - 1, day, hour, minute));
	return back.getUTCFullYear() === year &&
		back.getUTCMonth() === month - 1 &&
		back.getUTCDate() === day &&
		hour <= 23 &&
		minute <= 59
		? wall
		: null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The instant (epoch milliseconds) a wall-clock `YYYY-MM-DDTHH:MM` names in
 * `timeZone`, by the server's rule for a DST change: a time the clocks skip is
 * the moment they jump, a time they repeat is its first occurrence
 * (docs/projects/api.md#schedule-periods). `null` for a malformed `at` or a
 * zone the browser does not know.
 */
export function zonedInstant(at: string, timeZone: string): number | null {
	const wall = parseWallClock(at);
	if (!wall || !isKnownZone(timeZone)) return null;
	const asUtc = Date.UTC(
		wall.year,
		wall.month,
		wall.day,
		wall.hour,
		wall.minute,
	);
	const offsetAt = (t: number) =>
		(zoneOffsetSeconds(timeZone, new Date(t)) ?? 0) * 1000;

	// No zone moves its clocks by a day, so the offsets a day either side are
	// every offset that can be in effect at this wall clock.
	const offsets = new Set([
		offsetAt(asUtc - 24 * HOUR_MS),
		offsetAt(asUtc),
		offsetAt(asUtc + 24 * HOUR_MS),
	]);
	const instants = [...offsets]
		.map((offset) => asUtc - offset)
		.filter((t) => asUtc - t === offsetAt(t));
	if (instants.length > 0) return Math.min(...instants);

	// Skipped: the jump lies between the instants the two offsets give.
	let lo = asUtc - Math.max(...offsets);
	let hi = asUtc - Math.min(...offsets);
	const before = offsetAt(lo);
	while (hi - lo > 1000) {
		const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
		if (offsetAt(mid) === before) lo = mid;
		else hi = mid;
	}
	return hi;
}
