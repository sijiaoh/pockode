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
