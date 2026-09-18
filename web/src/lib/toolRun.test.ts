import { describe, expect, it } from "vitest";
import type { ToolRun } from "../types/message";
import { formatDuration, toolSecondLine } from "./toolRun";

const run = (overrides: Partial<ToolRun> = {}): ToolRun => ({
	id: "t1",
	name: "Bash",
	input: { command: "npm run build" },
	status: "running",
	...overrides,
});

describe("toolSecondLine", () => {
	it("prefers what the engine says the call is doing", () => {
		expect(
			toolSecondLine(run({ activity: "Compiling", output: "vite v7" })),
		).toEqual({ text: "Compiling", mono: false, live: true });
	});

	it("falls back to the last line the command actually printed", () => {
		expect(toolSecondLine(run({ output: "one\ntwo\n\n" }))).toEqual({
			text: "two",
			mono: true,
			live: true,
		});
	});

	it("says nothing for a call that has not reported anything", () => {
		expect(toolSecondLine(run())).toBeNull();
	});

	// What a later call fetched of the task is the newer word on the same
	// machine output, and unlike the output it stands still — so it is the one
	// line on a live row that is allowed into the row's accessible name.
	it("prefers what a later call fetched over the output so far", () => {
		expect(
			toolSecondLine(
				run({
					status: "background",
					output: "tick 1\ntick 2\n",
					fetches: [{ id: "f1", result: "tick 417\ntick 418\n" }],
				}),
			),
		).toEqual({ text: "tick 418", mono: true, live: false });
	});

	it("keeps the newest fetch when there are several", () => {
		expect(
			toolSecondLine(
				run({
					status: "background",
					fetches: [
						{ id: "f1", result: "tick 1" },
						{ id: "f2", result: "tick 418" },
					],
				}),
			)?.text,
		).toBe("tick 418");
	});

	// The engine's own progress line is the newer of the two: it says what the
	// task is doing now, while a fetch is the tail of what it has printed.
	it("still lets the engine's progress line come first", () => {
		expect(
			toolSecondLine(
				run({
					activity: "Running tests",
					fetches: [{ id: "f1", result: "ok" }],
				}),
			),
		).toEqual({ text: "Running tests", mono: false, live: true });
	});

	// A fetch that failed is news about the call that did the fetching, not
	// about this run, and this line is this run's latest word.
	it("ignores a fetch that failed or came back empty", () => {
		expect(
			toolSecondLine(
				run({
					status: "background",
					output: "tick 2\n",
					fetches: [
						{ id: "f1", result: "boom", isError: true },
						{ id: "f2", result: "" },
					],
				}),
			),
		).toEqual({ text: "tick 2", mono: true, live: true });
	});

	// Both fields absent: the fetch never returned, so there is no line to take
	// and the row falls back to what it had.
	it("ignores a fetch that never returned", () => {
		expect(
			toolSecondLine(run({ status: "background", fetches: [{ id: "f1" }] })),
		).toBeNull();
	});

	// What a fetch answers with, verbatim from claude 2.1.263: a small document
	// whose last line is the closing tag. Taking the answer's own last line put
	// the string `</output>` on the row of every backgrounded shell call.
	const envelope = (output: string) =>
		`<retrieval_status>not_ready</retrieval_status>\n\n<task_id>bg8vvcr1k</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>running</status>\n\n<output>\n${output}\n</output>`;

	it("reads the task's output out of the envelope it came in", () => {
		expect(
			toolSecondLine(
				run({
					status: "background",
					fetches: [{ id: "f1", result: envelope("tick 11\ntick 12") }],
				}),
			),
		).toEqual({ text: "tick 12", mono: true, live: false });
	});

	// The task has started but printed nothing yet. The envelope is not empty —
	// it still states a status — but the run has no latest word to show.
	it("ignores a fetch whose envelope carries no output", () => {
		expect(
			toolSecondLine(
				run({
					status: "background",
					fetches: [{ id: "f1", result: envelope("") }],
				}),
			),
		).toBeNull();
	});

	// The row must not change height when a background call settles: it is by
	// definition not at the tail of the transcript, and a row that grows or
	// shrinks above a reader shifts what they are reading.
	it("hands the line over to the outcome when a background call settles", () => {
		expect(
			toolSecondLine(
				run({
					status: "success",
					fromBackground: true,
					result: "Build succeeded in 4m12s\nsee the log",
				}),
			),
		).toEqual({ text: "Build succeeded in 4m12s", mono: false, live: false });
	});

	// That row is at the tail by construction, so losing the line moves nothing.
	it("drops the line when a foreground call settles", () => {
		expect(
			toolSecondLine(run({ status: "success", result: "done" })),
		).toBeNull();
	});

	// The border and the glyph say a call failed; nothing else on a collapsed row
	// says how. The last non-empty line rather than the first: it is the one the
	// live line was already showing a moment earlier, and a build's verdict is at
	// the end while the head is noise.
	it("ends a failed run with the last line it printed", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						"> vite build\nsrc/main.ts:3:1 - error TS2304\nmake: *** [build] Error 1\n",
				}),
			),
		).toEqual({ text: "make: *** [build] Error 1", mono: true, live: false });
	});

	// Order matters: the notification's own summary sentence says more than the
	// tail of a log the user never asked for.
	it("prefers a backgrounded failure's outcome over its last line", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					fromBackground: true,
					result: "Build failed after 4m12s\nmake: *** [build] Error 1",
				}),
			),
		).toEqual({ text: "Build failed after 4m12s", mono: false, live: false });
	});

	// Replay carries no activity — it is never persisted — and the row is still
	// correct, because the spinner and the badge come from the status.
	it("leaves a replayed background call with no line at all", () => {
		expect(toolSecondLine(run({ status: "background" }))).toBeNull();
	});
});

describe("formatDuration", () => {
	it("uses one unit below a minute and two above", () => {
		expect(formatDuration(1200)).toBe("1.2s");
		expect(formatDuration(47_000)).toBe("47s");
		expect(formatDuration(252_000)).toBe("4m 12s");
		expect(formatDuration(4_320_000)).toBe("1h 12m");
	});
});
