import { describe, expect, it } from "vitest";
import type { ToolRun } from "../types/message";
import { formatDuration, shownResult, toolSecondLine } from "./toolRun";

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
	// says how. Read from the end, because that is where a build states its
	// verdict while the head is noise.
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

	// A test runner ends on its timing, which says nothing about the failure.
	it("skips trailing lines that name no failure", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						" Test Files  1 failed (1)\n      Tests  2 failed | 2 passed (4)\n   Duration  1.31s\n",
				}),
			)?.text,
		).toBe("Tests  2 failed | 2 passed (4)");
	});

	// Node ends on a stack frame — which may well name a failure itself.
	it("skips stack frames", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						"Error: Cannot find module '@acme/slack-mock'\n    at failResolve (node:internal/modules:1)\n    at packageResolve (node:internal/modules:2)",
				}),
			)?.text,
		).toBe("Error: Cannot find module '@acme/slack-mock'");
	});

	// tsc closes a failure in several files with a table whose header names
	// errors and says nothing; the line above it is the verdict.
	it("skips tsc's summary table", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						"src/a.ts(3,1): error TS2304: Cannot find name 'x'.\n\nFound 3 errors in 2 files.\n\nErrors  Files\n     2  src/a.ts:3\n     1  src/b.ts:5\n",
				}),
			)?.text,
		).toBe("Found 3 errors in 2 files.");
	});

	it("skips Go and Python frames whose file names a failure", () => {
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						"panic: runtime error: index out of range [3]\n\ngoroutine 1 [running]:\n\t/usr/local/go/src/runtime/panic.go:770 +0x132",
				}),
			)?.text,
		).toBe("panic: runtime error: index out of range [3]");
		expect(
			toolSecondLine(
				run({
					status: "error",
					result:
						'ValueError: bad input\n  File "/usr/lib/python3/errors.py", line 12, in raise_error',
				}),
			)?.text,
		).toBe("ValueError: bad input");
	});

	it("falls back to the last line when none names a failure", () => {
		expect(
			toolSecondLine(run({ status: "error", result: "one\ntwo\n" }))?.text,
		).toBe("two");
	});

	// What claude answers an Edit with when old_string is not in the file: a
	// sentence whose first line is the reason and whose rest quotes the input.
	it("reads a refused call by its first line, without the envelope", () => {
		expect(
			toolSecondLine(
				run({
					name: "Edit",
					status: "error",
					result:
						"<tool_use_error>String to replace not found in file.\nString: import { send }</tool_use_error>",
				}),
			),
		).toEqual({
			text: "String to replace not found in file.",
			mono: false,
			live: false,
		});
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

	// The quoted description is the command already on the row's first line,
	// and on a phone it pushed the conclusion off the end.
	it("cuts a background command's notification to its conclusion", () => {
		expect(
			toolSecondLine(
				run({
					status: "success",
					fromBackground: true,
					result: 'Background command "Run tick loop" completed (exit code 0)',
				}),
			)?.text,
		).toBe("Completed (exit code 0)");
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

describe("shownResult", () => {
	it("drops the envelope of a refused call", () => {
		expect(
			shownResult("<tool_use_error>File does not exist.</tool_use_error>\n"),
		).toBe("File does not exist.");
	});

	it("leaves any other result as it is", () => {
		expect(shownResult("see <tool_use_error> docs")).toBe(
			"see <tool_use_error> docs",
		);
	});
});
