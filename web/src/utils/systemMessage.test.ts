import { describe, expect, it } from "vitest";
import type { WorkTimelineEntry } from "../types/message";
import {
	groupTimelineEntries,
	systemActionLabel,
	timelineEntryLabel,
	timelineGroupLabel,
} from "./systemMessage";

const entry = (
	id: string,
	subtype: string,
	extra: Partial<WorkTimelineEntry> = {},
): WorkTimelineEntry => ({ id, subtype, content: "", ...extra });

describe("systemActionLabel", () => {
	it("names the subtype", () => {
		expect(systemActionLabel("kickoff")).toBe("Kickoff");
	});

	it("spells out the step for a step advance", () => {
		expect(
			systemActionLabel("step_advance", { step: { current: 2, total: 3 } }),
		).toBe("Next step (Step 2/3)");
	});

	it("falls back for an unknown subtype", () => {
		expect(systemActionLabel("something_new")).toBe("System Message");
	});
});

describe("timelineEntryLabel", () => {
	it("numbers a step advance", () => {
		expect(
			timelineEntryLabel(
				entry("1", "step_advance", { step: { current: 2, total: 3 } }),
			),
		).toBe("Next step 2");
	});

	it("names the child that finished", () => {
		expect(
			timelineEntryLabel(
				entry("1", "child_done", { child: { id: "c", title: "Sub task" } }),
			),
		).toBe("Child task done: Sub task");
	});
});

describe("groupTimelineEntries", () => {
	it("collapses a run of auto-continues into one counted row", () => {
		const groups = groupTimelineEntries([
			entry("1", "kickoff"),
			entry("2", "auto_continue"),
			entry("3", "auto_continue"),
			entry("4", "auto_continue"),
			entry("5", "step_advance", { step: { current: 2, total: 3 } }),
		]);

		expect(groups.map(timelineGroupLabel)).toEqual([
			"Kickoff",
			"Auto-continue ×3",
			"Next step 2",
		]);
	});

	it("keeps runs separate when something happens between them", () => {
		const groups = groupTimelineEntries([
			entry("1", "auto_continue"),
			entry("2", "reopen"),
			entry("3", "auto_continue"),
		]);

		expect(groups.map(timelineGroupLabel)).toEqual([
			"Auto-continue",
			"Reopen",
			"Auto-continue",
		]);
	});

	it("keys a group by its first entry, so appending does not remount it", () => {
		const entries = [entry("1", "auto_continue"), entry("2", "auto_continue")];
		expect(groupTimelineEntries(entries)[0].id).toBe("1");
		expect(
			groupTimelineEntries([...entries, entry("3", "auto_continue")])[0].id,
		).toBe("1");
	});
});
