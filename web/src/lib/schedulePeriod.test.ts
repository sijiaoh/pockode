import { describe, expect, it } from "vitest";
import type { Period } from "../types/schedule";
import { describePeriod, isDone, ordinal, samePeriod } from "./schedulePeriod";

describe("samePeriod", () => {
	it("reads hourly fields left out as the server's defaults", () => {
		expect(
			samePeriod({ kind: "hourly" }, { kind: "hourly", every: 1, minute: 0 }),
		).toBe(true);
		expect(
			samePeriod(
				{ kind: "hourly", every: 6 },
				{ kind: "hourly", every: 6, minute: 15 },
			),
		).toBe(false);
	});

	it("compares weekly days in any order, and all seven as daily", () => {
		expect(
			samePeriod(
				{ kind: "weekly", weekdays: [5, 1, 3], time: "09:00" },
				{ kind: "weekly", weekdays: [1, 3, 5], time: "09:00" },
			),
		).toBe(true);
		expect(
			samePeriod(
				{ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], time: "09:00" },
				{ kind: "daily", time: "09:00" },
			),
		).toBe(true);
		expect(
			samePeriod(
				{ kind: "weekly", weekdays: [1], time: "09:00" },
				{ kind: "weekly", weekdays: [1, 2], time: "09:00" },
			),
		).toBe(false);
	});

	it("tells kinds and values apart", () => {
		expect(
			samePeriod(
				{ kind: "daily", time: "09:00" },
				{ kind: "monthly", day: 1, time: "09:00" },
			),
		).toBe(false);
		expect(
			samePeriod(
				{ kind: "once", at: "2026-11-03T09:00" },
				{ kind: "once", at: "2026-11-03T09:30" },
			),
		).toBe(false);
	});

	it("never matches a kind this build does not know", () => {
		const yearly = { kind: "yearly" } as unknown as Period;
		expect(samePeriod(yearly, yearly)).toBe(false);
	});
});

describe("describePeriod", () => {
	const NOW = new Date("2026-10-25T12:00:00Z");

	it.each<[Period, string]>([
		[{ kind: "hourly", every: 1, minute: 15 }, "Every hour at :15"],
		[{ kind: "hourly" }, "Every hour at :00"],
		[{ kind: "hourly", every: 2, minute: 15 }, "Every 2 hours at :15"],
		[
			{ kind: "hourly", every: 6, minute: 15 },
			"Every 6 hours, at 00:15, 06:15, 12:15 and 18:15",
		],
		[
			{ kind: "hourly", every: 12, minute: 0 },
			"Every 12 hours, at 00:00 and 12:00",
		],
		[{ kind: "daily", time: "09:00" }, "Daily at 09:00"],
		[
			{ kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" },
			"Weekdays at 09:00",
		],
		[{ kind: "weekly", weekdays: [0, 6], time: "10:05" }, "Weekends at 10:05"],
		[{ kind: "weekly", weekdays: [1], time: "09:00" }, "Mondays at 09:00"],
		// Monday-first, as the toggles.
		[
			{ kind: "weekly", weekdays: [0, 1, 3], time: "09:00" },
			"Mon, Wed, Sun at 09:00",
		],
		[
			{ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], time: "09:00" },
			"Daily at 09:00",
		],
		[{ kind: "monthly", day: 1, time: "09:00" }, "Monthly on the 1st at 09:00"],
		[
			{ kind: "monthly", day: 22, time: "09:00" },
			"Monthly on the 22nd at 09:00",
		],
		[
			{ kind: "monthly", day: 31, time: "09:00" },
			"Monthly on the last day at 09:00",
		],
		[{ kind: "once", at: "2026-11-03T09:00" }, "Once on Tue 3 Nov at 09:00"],
		[
			{ kind: "once", at: "2027-01-01T09:00" },
			"Once on Fri 1 Jan 2027 at 09:00",
		],
		[{ kind: "yearly" } as unknown as Period, "Unsupported period"],
	])("%j reads %s", (period, words) => {
		expect(describePeriod(period, "UTC", NOW)).toBe(words);
	});

	it("judges Once's year on the schedule's calendar", () => {
		// Already 2027 in Tokyo, still 2026 in London.
		const eve = new Date("2026-12-31T20:00:00Z");
		const period: Period = { kind: "once", at: "2027-01-01T09:00" };
		expect(describePeriod(period, "Asia/Tokyo", eve)).toBe(
			"Once on Fri 1 Jan at 09:00",
		);
		expect(describePeriod(period, "Europe/London", eve)).toBe(
			"Once on Fri 1 Jan 2027 at 09:00",
		);
	});
});

describe("ordinal", () => {
	it.each([
		[1, "1st"],
		[2, "2nd"],
		[3, "3rd"],
		[4, "4th"],
		[11, "11th"],
		[12, "12th"],
		[13, "13th"],
		[21, "21st"],
		[22, "22nd"],
		[23, "23rd"],
		[30, "30th"],
	])("%i is %s", (n, text) => {
		expect(ordinal(n)).toBe(text);
	});
});

describe("isDone", () => {
	const NOW = Date.parse("2026-11-03T10:00:00Z");
	const once = (at: string): Period => ({ kind: "once", at });

	it("is done once the server has handled an on one-time", () => {
		expect(
			isDone(
				{ period: once("2026-11-03T09:00"), enabled: true, time_zone: "UTC" },
				NOW,
			),
		).toBe(true);
	});

	it("waits for the server while an on one-time still has a next run, even past it", () => {
		expect(
			isDone(
				{
					period: once("2026-11-03T09:00"),
					enabled: true,
					next_run_at: "2026-11-03T09:00:00Z",
					time_zone: "UTC",
				},
				NOW,
			),
		).toBe(false);
	});

	it("judges an off one-time by the clock, in the schedule's zone", () => {
		const period = once("2026-11-03T18:00");
		// 18:00 in Tokyo was 09:00 UTC; 18:00 in London is still ahead.
		expect(
			isDone({ period, enabled: false, time_zone: "Asia/Tokyo" }, NOW),
		).toBe(true);
		expect(
			isDone({ period, enabled: false, time_zone: "Europe/London" }, NOW),
		).toBe(false);
	});

	it("cannot judge an off one-time in a zone the browser does not know", () => {
		expect(
			isDone(
				{
					period: once("2020-01-01T09:00"),
					enabled: false,
					time_zone: "Mars/Olympus_Mons",
				},
				NOW,
			),
		).toBe(false);
	});

	it("never calls a recurring schedule done", () => {
		expect(
			isDone(
				{
					period: { kind: "daily", time: "09:00" },
					enabled: true,
					time_zone: "UTC",
				},
				NOW,
			),
		).toBe(false);
	});
});
