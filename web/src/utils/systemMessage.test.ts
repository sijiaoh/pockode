import { describe, expect, it } from "vitest";
import { workEventWording } from "./systemMessage";

describe("workEventWording", () => {
	it("names what happened, in the past tense", () => {
		expect(workEventWording("kickoff", { title: "Ship it" })).toEqual({
			label: "Started",
			summary: "Ship it",
		});
	});

	it("makes the step itself the action word", () => {
		expect(
			workEventWording("step_advance", {
				title: "Ship it",
				step: { current: 2, total: 3 },
			}),
		).toEqual({ label: "Step 2/3", summary: "Ship it" });
	});

	it("falls back when a step advance recorded no step", () => {
		expect(workEventWording("step_advance", { title: "Ship it" }).label).toBe(
			"Next step",
		);
	});

	it("names the child rather than the work the message went to", () => {
		expect(
			workEventWording("child_done", {
				title: "Parent story",
				child: { id: "c1", title: "Sub task" },
			}),
		).toEqual({ label: "Subtask done", summary: "Sub task" });
	});

	it("leaves an auto-continue's summary blank", () => {
		expect(workEventWording("auto_continue", { title: "Ship it" })).toEqual({
			label: "Continued",
			summary: "",
		});
	});

	it("falls back for an unknown subtype", () => {
		expect(workEventWording("something_new", undefined).label).toBe(
			"System Message",
		);
	});
});
