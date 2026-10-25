import { describe, expect, it } from "vitest";
import {
	formatCompactDateTime,
	formatDateTime,
	formatRelativeDay,
	formatTime,
	formatWallDate,
	formatWallDateTime,
	isInstant,
} from "./dateTime";

// Every case names its zone: without one the shapes are on the device's
// clock, which is whatever the machine running the test is on.

describe("isInstant", () => {
	it.each([
		["2026-10-23T05:02:00Z", true],
		["", false],
		["soon", false],
		[undefined, false],
	])("%s is %s", (value, expected) => {
		expect(isInstant(value)).toBe(expected);
	});
});

describe("formatTime", () => {
	it.each([
		["2026-10-23T05:02:00Z", "UTC", "05:02"],
		["2026-10-23T15:02:00Z", "Asia/Tokyo", "00:02"],
		["2026-10-23T12:30:00Z", "America/St_Johns", "10:00"],
	])("%s in %s reads %s", (iso, zone, expected) => {
		expect(formatTime(iso, zone)).toBe(expected);
	});

	it("returns a value that is not an instant as it came", () => {
		expect(formatTime("soon", "UTC")).toBe("soon");
	});
});

describe("formatDateTime", () => {
	it("writes the year even for this year", () => {
		expect(formatDateTime("2026-10-23T22:05:00Z", "UTC")).toBe(
			"Fri 23 Oct 2026 22:05",
		);
	});

	it("dates the instant on the zone's calendar", () => {
		expect(formatDateTime("2026-12-31T22:05:00Z", "Asia/Tokyo")).toBe(
			"Fri 1 Jan 2027 07:05",
		);
	});
});

describe("formatCompactDateTime", () => {
	const now = new Date("2026-10-23T12:00:00Z");

	it.each([
		["2026-10-23T00:10:00Z", "00:10"],
		["2026-10-22T23:59:00Z", "Thu 22 Oct 23:59"],
		["2025-12-31T09:00:00Z", "Wed 31 Dec 2025 09:00"],
	])("%s reads %s", (iso, expected) => {
		expect(formatCompactDateTime(iso, now, "UTC")).toBe(expected);
	});

	it("counts today on the zone's calendar", () => {
		// 23:59 UTC on the 22nd is already the 23rd in Tokyo, as is `now`.
		expect(
			formatCompactDateTime("2026-10-22T23:59:00Z", now, "Asia/Tokyo"),
		).toBe("08:59");
	});
});

describe("formatRelativeDay", () => {
	// 2026-10-23 20:00 UTC is already the 24th in Tokyo (UTC+9).
	const now = new Date("2026-10-23T20:00:00Z");

	it.each([
		["2026-10-23T03:05:00Z", "UTC", "today 03:05"],
		["2026-10-24T03:00:00Z", "UTC", "tomorrow 03:00"],
		["2026-10-22T23:59:00Z", "UTC", "yesterday 23:59"],
		["2026-10-27T17:00:00Z", "UTC", "Tue 27 Oct 17:00"],
		["2026-10-20T09:00:00Z", "UTC", "Tue 20 Oct 09:00"],
		["2027-01-05T09:00:00Z", "UTC", "Tue 5 Jan 2027 09:00"],
		["2026-10-24T00:00:00Z", "Asia/Tokyo", "today 09:00"],
		["2026-10-25T15:00:00Z", "Asia/Tokyo", "Mon 26 Oct 00:00"],
		["2026-10-23T14:00:00Z", "Asia/Tokyo", "yesterday 23:00"],
	])("%s in %s reads %s", (iso, zone, expected) => {
		expect(formatRelativeDay(iso, now, zone)).toBe(expected);
	});

	it("counts days across a DST change as calendar days", () => {
		// London leaves summer time on 25 Oct 2026, so 23:30 on the 24th to
		// 00:10 on the 26th is 25h40m: one day by elapsed time, two by the
		// calendar.
		const before = new Date("2026-10-24T22:30:00Z");
		expect(
			formatRelativeDay("2026-10-26T00:10:00Z", before, "Europe/London"),
		).toBe("Mon 26 Oct 00:10");
	});

	it("falls back to the device's zone for a zone the browser does not know", () => {
		const iso = "2026-10-24T00:00:00Z";
		expect(formatRelativeDay(iso, now, "Mars/Olympus_Mons")).toBe(
			formatRelativeDay(iso, now),
		);
	});
});

describe("formatWallDate / formatWallDateTime", () => {
	const now = new Date("2026-06-01T12:00:00Z");
	const wall = { year: 2026, month: 10, day: 3, hour: 7, minute: 5 };

	it("leaves out the current year", () => {
		expect(formatWallDate(wall, now, "UTC")).toBe("Tue 3 Nov");
		expect(formatWallDateTime(wall, now, "UTC")).toBe("Tue 3 Nov 07:05");
	});

	it("writes any other year", () => {
		expect(formatWallDateTime({ ...wall, year: 2027 }, now, "UTC")).toBe(
			"Wed 3 Nov 2027 07:05",
		);
	});
});
