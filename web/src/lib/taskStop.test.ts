import { describe, expect, it } from "vitest";
import type { ContentPart, Message } from "../types/message";
import { loadedStopTargets, parseStopResult, stopResultText } from "./taskStop";

describe("parseStopResult", () => {
	// claude 2.1.330's answer to TaskStop.
	it("reads the sentence and the command stopped", () => {
		expect(
			parseStopResult(
				JSON.stringify({
					message: "Successfully stopped task: b1 (sleep 40)",
					task_id: "b1",
					task_type: "local_bash",
					command: "sleep 40",
				}),
			),
		).toEqual({
			message: "Successfully stopped task: b1 (sleep 40)",
			command: "sleep 40",
		});
	});

	// What its copy, its count and its full screen read, so they say what the
	// body draws rather than the JSON it came in.
	it("is the text the body shows", () => {
		expect(stopResultText({ message: "Stopped b1", command: "sleep 40" })).toBe(
			"Stopped b1\nsleep 40",
		);
		expect(stopResultText({ message: "Stopped b1" })).toBe("Stopped b1");
	});

	// KillShell's, which named no command.
	it("reads a sentence alone", () => {
		expect(
			parseStopResult(
				'{"message":"Successfully killed shell: b1","shell_id":"b1"}',
			),
		).toEqual({ message: "Successfully killed shell: b1" });
	});

	it.each([
		"Stopped.",
		"{not json",
		'{"task_id":"b1"}',
		"[]",
	])("leaves %s to be drawn as it came", (result) => {
		expect(parseStopResult(result)).toBeNull();
	});
});

describe("loadedStopTargets", () => {
	const run = (
		id: string,
		name: string,
		extra: Record<string, unknown> = {},
	): ContentPart => ({
		type: "tool_call",
		id: `part-${id}`,
		tool: { id, name, input: {}, status: "success", ...extra },
	});
	const turn = (parts: ContentPart[]): Message =>
		({
			id: `m-${parts.length}`,
			role: "assistant",
			parts,
			status: "complete",
		}) as Message;

	it("holds the stopped calls whose rows are loaded, in any bubble", () => {
		const targets = loadedStopTargets([
			turn([run("bash1", "Bash")]),
			turn([
				run("s1", "TaskStop", { originToolUseId: "bash1" }),
				// On a page not loaded.
				run("s2", "TaskStop", { originToolUseId: "gone" }),
			]),
		]);
		expect([...targets]).toEqual(["bash1"]);
	});
});
