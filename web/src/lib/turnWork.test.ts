import { describe, expect, it } from "vitest";
import type { AssistantMessage, ContentPart } from "../types/message";
import { turnWork } from "./turnWork";

const call = (
	id: string,
	status: "success" | "error" | "running" = "success",
	parentToolUseId?: string,
): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: { id, name: "Read", input: {}, status },
	parentToolUseId,
});
const card = (
	toolUseId: string,
	partId = `card-${toolUseId}`,
): ContentPart => ({
	type: "permission_request",
	id: partId,
	request: {
		requestId: `r-${toolUseId}`,
		toolName: "Bash",
		toolInput: {},
		toolUseId,
	},
	status: "denied",
});
const text = (id: string): ContentPart => ({
	type: "text",
	id: `text-${id}`,
	content: "words",
});
const message = (
	parts: ContentPart[],
	times: Partial<AssistantMessage> = {},
): AssistantMessage => ({
	id: "m",
	role: "assistant",
	parts,
	status: "complete",
	createdAt: new Date(),
	...times,
});

describe("turnWork", () => {
	it("is nothing for a reply that made no call", () => {
		expect(turnWork(message([text("1")]))).toBeUndefined();
	});

	it("counts every call made, once, whatever became of it", () => {
		const work = turnWork(
			message([
				call("1"),
				call("2", "error"),
				// A card that outlived its call, and one whose row stands too.
				card("3"),
				card("1"),
				text("1"),
			]),
		);
		expect(work?.calls).toBe(3);
	});

	it("counts a subagent's flat steps as its call's", () => {
		const work = turnWork(message([call("1"), call("2", "success", "task-9")]));
		expect(work).toEqual({ calls: 1 });
	});

	it("counts nothing on a reply whose only calls are flat steps", () => {
		const work = turnWork(
			message([call("2", "success", "task-9")], {
				openedAt: 0,
				endedAt: 5000,
			}),
		);
		expect(work).toEqual({});
	});

	it("takes the span from the two stamped ends, from a second up", () => {
		const at = (openedAt?: number, endedAt?: number) =>
			turnWork(message([call("1")], { openedAt, endedAt }))?.durationMs;
		expect(at(1_000, 134_000)).toBe(133_000);
		expect(at(1_000, 1_999)).toBeUndefined();
		expect(at(undefined, 134_000)).toBeUndefined();
		expect(at(1_000, undefined)).toBeUndefined();
	});

	it("counts nothing on a reply whose start is not loaded", () => {
		const parts = [call("1"), call("2")];
		expect(
			turnWork(message(parts, { startNotLoaded: true, endedAt: 9_000 })),
		).toEqual({});
		expect(
			turnWork(message(parts, { openedAt: 1_000, endedAt: 9_000 })),
		).toEqual({ calls: 2, durationMs: 8_000 });
	});
});
