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
