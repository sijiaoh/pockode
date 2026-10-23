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
