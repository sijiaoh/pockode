import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatNextRun, formatRelativeFuture } from "./relativeTime";

describe("formatRelativeFuture", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["2026-10-23T12:00:30Z", "in 1m"],
		["2026-10-23T12:59:00Z", "in 59m"],
		["2026-10-23T17:20:00Z", "in 5h"],
		["2026-10-23T13:59:00Z", "in 2h"],
		["2026-10-25T11:00:00Z", "in 2d"],
		["2026-10-26T13:00:00Z", "in 3d"],
	])("%s reads %s", (iso, expected) => {
		expect(formatRelativeFuture(iso)).toBe(expected);
	});

	it("names a firing already due as the shortest wait", () => {
		expect(formatRelativeFuture("2026-10-23T11:59:00Z")).toBe("in 1m");
	});
});

describe("formatNextRun", () => {
	// Built in local time: the format is the device's zone, whatever the
	// machine running the test is on.
	const now = new Date(2026, 9, 23, 12, 0);
	const at = (day: number, hour: number, minute: number) =>
		new Date(2026, 9, day, hour, minute).toISOString();

	it.each([
		[at(23, 3, 5), "today 03:05"],
		[at(24, 3, 0), "tomorrow 03:00"],
		[at(22, 23, 59), "yesterday 23:59"],
		[at(27, 17, 0), "Tue 27 Oct 17:00"],
		[at(20, 9, 0), "Tue 20 Oct 09:00"],
	])("%s reads %s", (iso, expected) => {
		expect(formatNextRun(iso, now)).toBe(expected);
	});
});

describe("formatNextRun in a schedule's zone", () => {
	// 2026-10-23 20:00 UTC is already the 24th in Tokyo (UTC+9).
	const now = new Date("2026-10-23T20:00:00Z");

	it.each([
		["2026-10-24T00:00:00Z", "Asia/Tokyo", "today 09:00"],
		["2026-10-25T15:00:00Z", "Asia/Tokyo", "Mon 26 Oct 00:00"],
		["2026-10-24T00:00:00Z", "UTC", "tomorrow 00:00"],
		["2026-10-23T14:00:00Z", "Asia/Tokyo", "yesterday 23:00"],
	])("%s in %s reads %s", (iso, zone, expected) => {
		expect(formatNextRun(iso, now, zone)).toBe(expected);
	});

	it("counts days across a DST change as calendar days", () => {
		// London leaves summer time on 25 Oct 2026, so 23:30 on the 24th to
		// 00:10 on the 26th is 25h40m: one day by elapsed time, two by the
		// calendar.
		const before = new Date("2026-10-24T22:30:00Z");
		expect(formatNextRun("2026-10-26T00:10:00Z", before, "Europe/London")).toBe(
			"Mon 26 Oct 00:10",
		);
	});

	it("falls back to the device's zone for a zone the browser does not know", () => {
		const iso = "2026-10-24T00:00:00Z";
		expect(formatNextRun(iso, now, "Mars/Olympus_Mons")).toBe(
			formatNextRun(iso, now),
		);
	});
});
