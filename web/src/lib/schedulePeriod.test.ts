import { describe, expect, it } from "vitest";
import {
	describePeriod,
	describePreset,
	HOURLY_EVERY,
	type Period,
	parsePeriod,
	toCron,
} from "./schedulePeriod";

describe("toCron / parsePeriod", () => {
	const presets: [Period, string][] = [
		...HOURLY_EVERY.map((every): [Period, string] => [
			{ kind: "hourly", every, minute: 15 },
			every === 1 ? "15 * * * *" : `15 */${every} * * *`,
		]),
		[{ kind: "daily", hour: 9, minute: 0 }, "0 9 * * *"],
		[{ kind: "daily", hour: 23, minute: 59 }, "59 23 * * *"],
		[{ kind: "weekly", days: [1, 3, 5], hour: 9, minute: 0 }, "0 9 * * 1,3,5"],
		[{ kind: "weekly", days: [0], hour: 7, minute: 30 }, "30 7 * * 0"],
		[{ kind: "weekly", days: [0, 6], hour: 10, minute: 5 }, "5 10 * * 0,6"],
	];

	it.each(presets)("writes %j as %s and reads it back", (period, cron) => {
		expect(toCron(period)).toBe(cron);
		expect(parsePeriod(cron)).toEqual(period);
	});

	it("writes weekly days ascending with Sunday as 0", () => {
		expect(
			toCron({ kind: "weekly", days: [5, 0, 1], hour: 9, minute: 0 }),
		).toBe("0 9 * * 0,1,5");
	});

	it("writes a weekly period with every day as daily", () => {
		expect(
			toCron({
				kind: "weekly",
				days: [1, 2, 3, 4, 5, 6, 0],
				hour: 9,
				minute: 0,
			}),
		).toBe("0 9 * * *");
	});

	it.each([
		["0 9 * * MON-FRI", [1, 2, 3, 4, 5]],
		["0 9 * * mon,Wed,FRI", [1, 3, 5]],
		["0 9 * * sun", [0]],
		["0 9 * * 7", [0]],
		["0 9 * * 5-7", [0, 5, 6]],
		["0 9 * * 1-3,5", [1, 2, 3, 5]],
		["0 9 * * 1,1,2", [1, 2]],
		["0 9 * * sat-sat", [6]],
	])("reads the day field of %s as weekly", (cron, days) => {
		expect(parsePeriod(cron)).toEqual({
			kind: "weekly",
			days,
			hour: 9,
			minute: 0,
		});
	});

	it.each([
		"0 9 * * 0-6",
		"0 9 * * 1-7",
		"0 9 * * MON-SAT,SUN",
		"0 9 * * 0,1,2,3,4,5,6",
	])("reads %s, all seven days, as daily", (cron) => {
		expect(parsePeriod(cron)).toEqual({ kind: "daily", hour: 9, minute: 0 });
	});

	it("allows leading zeros and extra whitespace", () => {
		expect(parsePeriod("  05   09 * * *  ")).toEqual({
			kind: "daily",
			hour: 9,
			minute: 5,
		});
		expect(parsePeriod("07 */06 * * *")).toEqual({
			kind: "hourly",
			every: 6,
			minute: 7,
		});
	});

	it.each([
		"",
		"0 9 * *",
		"0 9 * * * *",
		"*/15 * * * *", // a step on the minute
		"0,30 * * * *",
		"60 * * * *",
		"0 24 * * *",
		"0 */5 * * *", // not a divisor of 24
		"0 */1 * * *",
		"0 */24 * * *",
		"0 1-5/2 * * *",
		"0 9,17 * * *", // a list of hours
		"0 9-17 * * *",
		"0 9 1 * *", // a day of the month
		"0 9 * 1 *", // a month
		"0 9 * * */2", // a step on the day
		"0 9 * * 5-1", // backwards
		"0 9 * * 8",
		"0 9 * * monday",
		"0 9 * * constructor", // not a day, though every object has one
		"0 9 * * 1-__proto__",
		"0 9 * * 1,",
		"0 9 * * 1-2-3",
		"0 9 * * MON-SUN", // backwards, as the server reads it
		"0 * * * 1", // every hour on Mondays
		"*/15 9-17 * * 1-5",
		"-1 9 * * *",
		"1.5 9 * * *",
	])("leaves %j to Custom", (cron) => {
		expect(parsePeriod(cron)).toBeNull();
	});
});

describe("describePeriod", () => {
	it.each([
		["15 * * * *", "Every hour at :15"],
		["0 * * * *", "Every hour at :00"],
		["15 */2 * * *", "Every 2 hours at :15"],
		["5 */4 * * *", "Every 4 hours at :05"],
		["15 */6 * * *", "Every 6 hours, at 00:15, 06:15, 12:15 and 18:15"],
		["0 */8 * * *", "Every 8 hours, at 00:00, 08:00 and 16:00"],
		["30 */12 * * *", "Every 12 hours, at 00:30 and 12:30"],
		["0 9 * * *", "Daily at 09:00"],
		["5 21 * * *", "Daily at 21:05"],
		["0 9 * * 0-6", "Daily at 09:00"],
		["0 9 * * 1-5", "Weekdays at 09:00"],
		["0 9 * * MON-FRI", "Weekdays at 09:00"],
		["0 9 * * 0,6", "Weekends at 09:00"],
		["0 9 * * sat,7", "Weekends at 09:00"],
		["0 9 * * 1", "Mondays at 09:00"],
		["0 9 * * 0", "Sundays at 09:00"],
		["0 9 * * 1,3,5", "Mon, Wed, Fri at 09:00"],
		// Monday first, as the toggles: Sunday comes last.
		["0 9 * * 0,1", "Mon, Sun at 09:00"],
		["0 9 * * 1-4", "Mon, Tue, Wed, Thu at 09:00"],
		["0 9 1 * *", "Custom · 0 9 1 * *"],
		["  */15 9-17 * * 1-5 ", "Custom · */15 9-17 * * 1-5"],
	])("describes %s as %j", (cron, words) => {
		expect(describePeriod(cron)).toBe(words);
	});
});

it("describes a weekly period with every day as what is saved: daily", () => {
	expect(
		describePreset({
			kind: "weekly",
			days: [0, 1, 2, 3, 4, 5, 6],
			hour: 9,
			minute: 0,
		}),
	).toBe("Daily at 09:00");
});
