import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeFuture } from "./relativeTime";

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
