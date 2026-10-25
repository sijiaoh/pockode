import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatUtcOffset,
	instantZoneLabel,
	periodZoneLabel,
	sameZone,
	zoneLabel,
	zoneLine,
	zoneName,
} from "./scheduleZone";

const JANUARY = new Date("2026-01-15T12:00:00Z");
const JULY = new Date("2026-07-15T12:00:00Z");

describe("formatUtcOffset", () => {
	it.each([
		[9 * 3600, "UTC+9"],
		[-(3 * 3600 + 30 * 60), "UTC−3:30"],
		[5 * 3600 + 45 * 60, "UTC+5:45"],
		[0, "UTC"],
	])("%i reads %s", (seconds, text) => {
		expect(formatUtcOffset(seconds)).toBe(text);
	});
});

describe("sameZone", () => {
	it("treats an alias as the zone it names", () => {
		expect(sameZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
	});

	it("compares names, not offsets", () => {
		// The same offset in January, an hour apart in July.
		expect(sameZone("Europe/London", "Africa/Abidjan")).toBe(false);
		expect(sameZone("Asia/Seoul", "Asia/Tokyo")).toBe(false);
	});

	// Such a browser's `resolvedOptions` hands a name back as given, so only
	// Temporal's equality still folds an alias: it has to be the one asked.
	describe("in a browser with Temporal", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("asks Temporal's equality", () => {
			const ALIASES: Record<string, string> = {
				"Asia/Calcutta": "Asia/Kolkata",
			};
			class ZonedDateTime {
				zone: string;
				constructor(_: bigint, zone: string) {
					this.zone = ALIASES[zone] ?? zone;
				}
				equals(other: ZonedDateTime) {
					return this.zone === other.zone;
				}
			}
			const equals = vi.spyOn(ZonedDateTime.prototype, "equals");
			vi.stubGlobal("Temporal", { ZonedDateTime });

			expect(sameZone("Asia/Calcutta", "Asia/Kolkata")).toBe(true);
			expect(sameZone("Asia/Seoul", "Asia/Tokyo")).toBe(false);
			expect(equals).toHaveBeenCalledTimes(2);
		});

		it("still never matches a zone the browser does not know", () => {
			vi.stubGlobal("Temporal", {
				ZonedDateTime: class {
					equals() {
						return true;
					}
				},
			});
			expect(sameZone("Mars/Olympus_Mons", "Asia/Tokyo")).toBe(false);
		});
	});

	it("never matches a zone the browser does not know", () => {
		expect(sameZone("Mars/Olympus_Mons", "Mars/Olympus_Mons")).toBe(false);
	});
});

describe("zoneLabel", () => {
	it.each([
		["Asia/Tokyo", "Tokyo"],
		["America/Argentina/Buenos_Aires", "Buenos Aires"],
		["UTC", "UTC"],
		["Etc/UTC", "UTC"],
		["Etc/GMT", "UTC"],
		["GMT", "UTC"],
		// `Etc` signs are inverted.
		["Etc/GMT-9", "UTC+9"],
		["Japan", "Japan"],
		["Mars/Olympus_Mons", "Mars/Olympus_Mons"],
	])("%s reads %s", (iana, label) => {
		expect(zoneLabel(iana)).toBe(label);
	});
});

describe("zoneName", () => {
	it("adds the offset at the moment given", () => {
		expect(zoneName("Europe/London", JANUARY)).toBe("London time (UTC)");
		expect(zoneName("Europe/London", JULY)).toBe("London time (UTC+1)");
	});

	it("does not repeat an offset that is the label", () => {
		expect(zoneName("Etc/GMT-9", JULY)).toBe("UTC+9 time");
		expect(zoneName("UTC", JULY)).toBe("UTC time");
	});
});

describe("zoneLine", () => {
	it("names both zones", () => {
		expect(zoneLine("Asia/Tokyo", "Europe/London", JULY)).toBe(
			"Tokyo time (UTC+9). This device is on London time (UTC+1).",
		);
	});

	it("prints both even when the offsets agree", () => {
		expect(zoneLine("Asia/Tokyo", "Asia/Seoul", JULY)).toBe(
			"Tokyo time (UTC+9). This device is on Seoul time (UTC+9).",
		);
	});

	it("says when the device cannot show times in the schedule's zone", () => {
		expect(zoneLine("Mars/Olympus_Mons", "Europe/London", JULY)).toBe(
			"Mars/Olympus_Mons time, which this device cannot show times in. This device is on London time (UTC+1).",
		);
	});
});

describe("labels", () => {
	it("are absent while the zones are the same", () => {
		expect(periodZoneLabel("Asia/Calcutta", "Asia/Kolkata")).toBeNull();
		expect(instantZoneLabel("Asia/Calcutta", "Asia/Kolkata")).toBeNull();
	});

	it("name the schedule's zone when it differs", () => {
		expect(periodZoneLabel("Asia/Tokyo", "Europe/London")).toBe("Tokyo");
		expect(instantZoneLabel("Asia/Tokyo", "Europe/London")).toBe("Tokyo");
	});

	it("leave an unknown zone's instants unlabelled: they are the device's", () => {
		expect(periodZoneLabel("Mars/Olympus_Mons", "Europe/London")).toBe(
			"Mars/Olympus_Mons",
		);
		expect(instantZoneLabel("Mars/Olympus_Mons", "Europe/London")).toBeNull();
	});
});
