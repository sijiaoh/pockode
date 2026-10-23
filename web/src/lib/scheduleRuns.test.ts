import { describe, expect, it } from "vitest";
import { makeRun } from "../test/scheduleFixtures";
import type { ScheduleRunItem } from "../types/schedule";
import type { Activity } from "./activity";
import { appendOlderPage, mergeNewestPage, NO_RUNS } from "./scheduleRuns";

/** A run made at 03:00 on day `day` of October, so a higher day is newer. */
const runOn = (day: number, overrides: Partial<ScheduleRunItem> = {}) =>
	makeRun({
		id: `run-${String(day).padStart(2, "0")}`,
		created_at: `2026-10-${String(day).padStart(2, "0")}T03:00:00Z`,
		...overrides,
	});

const ids = (runs: { items: ScheduleRunItem[] }) => runs.items.map((r) => r.id);

describe("mergeNewestPage", () => {
	it("takes the first page and the cursor after it", () => {
		const loaded = mergeNewestPage(NO_RUNS, {
			items: [runOn(3), runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["run-03", "run-02"]);
		expect(loaded.nextCursor).toBe("c2");
	});

	// A new run pushes the oldest row off the first page; it was loaded, and a
	// list that dropped it would lose a run between two pages.
	it("keeps a loaded run the newest page has pushed off", () => {
		const first = mergeNewestPage(NO_RUNS, {
			items: [runOn(3), runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		const loaded = mergeNewestPage(first, {
			items: [runOn(4), runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["run-04", "run-03", "run-02"]);
	});

	it("drops a run deleted from inside the page's span, and keeps the older ones it does not cover", () => {
		let loaded = mergeNewestPage(NO_RUNS, {
			items: [runOn(5), runOn(4)],
			next_cursor: "c4",
			has_more: true,
		});
		loaded = appendOlderPage(loaded, {
			items: [runOn(3), runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		// run-04 deleted: the page now reaches down to run-03.
		loaded = mergeNewestPage(loaded, {
			items: [runOn(5), runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["run-05", "run-03", "run-02"]);
	});

	it("drops every run it does not hold when nothing comes after it", () => {
		const first = mergeNewestPage(NO_RUNS, {
			items: [runOn(3), runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		const loaded = mergeNewestPage(first, { items: [runOn(3)] });

		expect(ids(loaded)).toEqual(["run-03"]);
		expect(loaded.nextCursor).toBeNull();
	});

	// Every run held, then one more made: the run pushed off the page is still
	// held, so nothing is left to fetch and no pager may be offered.
	it("offers no more when it already held every run", () => {
		const first = mergeNewestPage(NO_RUNS, { items: [runOn(3), runOn(2)] });

		const loaded = mergeNewestPage(first, {
			items: [runOn(4), runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["run-04", "run-03", "run-02"]);
		expect(loaded.nextCursor).toBeNull();
	});

	it("refreshes a run it holds rather than keeping the copy loaded before", () => {
		const first = mergeNewestPage(NO_RUNS, {
			items: [runOn(3, { status: "active", activity: "running" })],
		});

		const loaded = mergeNewestPage(first, { items: [runOn(3)] });

		expect(loaded.items[0].status).toBe("closed");
	});

	// Go writes nanoseconds and `Date` keeps milliseconds: two runs made in the
	// same millisecond must still be told apart in the server's order.
	it("tells apart runs made in the same millisecond", () => {
		const at = (ns: string, id: string) =>
			makeRun({ id, created_at: `2026-10-23T03:00:00.123${ns}Z` });
		let loaded = mergeNewestPage(NO_RUNS, {
			items: [at("900", "newest"), at("800", "deleted")],
			next_cursor: "c1",
			has_more: true,
		});
		loaded = appendOlderPage(loaded, {
			items: [at("100", "older")],
		});

		loaded = mergeNewestPage(loaded, {
			items: [at("900", "newest"), at("500", "edge")],
			next_cursor: "c2",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["newest", "edge", "older"]);
	});

	it("folds an activity this build does not know", () => {
		const loaded = mergeNewestPage(NO_RUNS, {
			items: [runOn(3, { activity: "from_the_future" as Activity })],
		});

		expect(loaded.items[0].activity).toBe("idle");
	});
});

describe("appendOlderPage", () => {
	it("appends below, without repeating a run already held", () => {
		const first = mergeNewestPage(NO_RUNS, {
			items: [runOn(4), runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});

		const loaded = appendOlderPage(first, {
			items: [runOn(3), runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		expect(ids(loaded)).toEqual(["run-04", "run-03", "run-02"]);
		expect(loaded.nextCursor).toBe("c2");
	});

	// A run pushed off the newest page is sent nothing more, so reading its page
	// again is the only way its copy catches up.
	it("takes the page's copy of a run it already holds, where it stands", () => {
		const first = mergeNewestPage(NO_RUNS, {
			items: [runOn(4), runOn(3, { status: "stopped", activity: "stopped" })],
			next_cursor: "c3",
			has_more: true,
		});

		const loaded = appendOlderPage(first, {
			items: [runOn(3, { status: "active", activity: "running" }), runOn(2)],
		});

		expect(ids(loaded)).toEqual(["run-04", "run-03", "run-02"]);
		expect(loaded.items[1].activity).toBe("running");
	});

	// The newest page arriving again must not send the pager back to where the
	// first page ended, which would load the same rows twice.
	it("keeps its cursor through later newest pages", () => {
		let loaded = mergeNewestPage(NO_RUNS, {
			items: [runOn(4), runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});
		loaded = appendOlderPage(loaded, {
			items: [runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		loaded = mergeNewestPage(loaded, {
			items: [runOn(5), runOn(4)],
			next_cursor: "c4",
			has_more: true,
		});

		expect(loaded.nextCursor).toBe("c2");
	});

	it("lets go of its cursor once the newest page holds every run", () => {
		let loaded = mergeNewestPage(NO_RUNS, {
			items: [runOn(3)],
			next_cursor: "c3",
			has_more: true,
		});
		loaded = appendOlderPage(loaded, {
			items: [runOn(2)],
			next_cursor: "c2",
			has_more: true,
		});

		loaded = mergeNewestPage(loaded, { items: [runOn(3)] });

		expect(loaded.nextCursor).toBeNull();
	});

	it("has nothing more to load after the last page", () => {
		const loaded = appendOlderPage(
			mergeNewestPage(NO_RUNS, {
				items: [runOn(3)],
				next_cursor: "c3",
				has_more: true,
			}),
			{ items: [runOn(2)] },
		);

		expect(loaded.nextCursor).toBeNull();
	});
});
