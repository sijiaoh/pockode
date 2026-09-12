import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, UserMessage } from "../types/message";
import { isForkableMessage, resolveForkAnchor } from "./forkAnchor";

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
	return {
		id: "u1",
		role: "user",
		content: "Hello",
		status: "complete",
		createdAt: new Date(),
		anchorSeq: 1,
		...overrides,
	};
}

function assistantMessage(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		id: "a1",
		role: "assistant",
		parts: [{ type: "text", content: "Hi" }],
		status: "complete",
		createdAt: new Date(),
		anchorSeq: 2,
		...overrides,
	};
}

// Only the reasons fork adds on top of `hasMessageActions`, which has its own
// tests — a settled turn is the premise here, not the subject.
describe("isForkableMessage", () => {
	it("accepts a settled user or assistant message", () => {
		expect(isForkableMessage(userMessage())).toBe(true);
		expect(isForkableMessage(assistantMessage())).toBe(true);
	});

	it("rejects a message the server never gave a seq for", () => {
		expect(isForkableMessage(userMessage({ anchorSeq: undefined }))).toBe(
			false,
		);
	});

	it("rejects a message holding a request nobody has answered", () => {
		const pending = assistantMessage({
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "r1",
						toolName: "Bash",
						toolInput: {},
						toolUseId: "t1",
					},
					status: "pending",
				},
			],
		});
		expect(isForkableMessage(pending)).toBe(false);

		const answered = assistantMessage({
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "r1",
						toolName: "Bash",
						toolInput: {},
						toolUseId: "t1",
					},
					status: "allowed",
				},
			],
		});
		expect(isForkableMessage(answered)).toBe(true);
	});

	it("rejects a message that carries no action row at all", () => {
		expect(isForkableMessage(userMessage({ source: "system" }))).toBe(false);
	});
});

describe("resolveForkAnchor", () => {
	it("counts the messages that stay behind an agent message", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
			userMessage({ id: "u2", anchorSeq: 3 }),
			assistantMessage({ id: "a2", anchorSeq: 4 }),
		];

		expect(resolveForkAnchor(messages, "a1", false)).toMatchObject({
			anchorSeq: 2,
			droppedCount: 2,
		});
		expect(resolveForkAnchor(messages, "a2", false)?.droppedCount).toBe(0);
	});

	// The two anchor roles differ in what the new session starts with: a user
	// anchor hands its prompt back for re-sending, an agent anchor is kept and
	// has nothing to hand back.
	it("hands back the words of a user anchor only", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
			userMessage({ id: "u2", anchorSeq: 3, content: "Try again" }),
		];

		expect(resolveForkAnchor(messages, "u2", false)?.droppedText).toBe(
			"Try again",
		);
		expect(
			resolveForkAnchor(messages, "a1", false)?.droppedText,
		).toBeUndefined();
	});

	// A fork returns to before the anchor was sent, so a message the user typed
	// is one of the things left behind rather than the last thing kept.
	it("counts a user anchor itself as staying behind", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
			userMessage({ id: "u2", anchorSeq: 3 }),
			assistantMessage({ id: "a2", anchorSeq: 4 }),
		];

		expect(resolveForkAnchor(messages, "u2", false)).toMatchObject({
			// The seq goes back to the server untouched; which side of it the cut
			// falls on is the server's rule, not arithmetic done here.
			anchorSeq: 3,
			droppedCount: 2,
		});
	});

	// Same refusal the server makes: returning to before the opening prompt
	// leaves no conversation, and an empty session is not a fork of one.
	it("is null for a user message that opens the transcript", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
		];

		expect(resolveForkAnchor(messages, "u1", false)).toBeNull();
		// The agent's first answer still has that prompt behind it to keep.
		expect(resolveForkAnchor(messages, "a1", false)?.droppedCount).toBe(0);
	});

	// History pages in from the bottom, so the top of what is loaded is only the
	// start of the session once there is nothing left above it to read.
	it("allows a user anchor at the top when older pages remain", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
		];

		expect(resolveForkAnchor(messages, "u1", true)).toMatchObject({
			anchorSeq: 1,
			droppedCount: 2,
		});
	});

	// A bubble the agent never wrote into is not a message the user can see, so
	// a fork cannot claim to leave it behind.
	it("does not count an empty placeholder as left behind", () => {
		const messages: Message[] = [
			assistantMessage({ id: "a1" }),
			assistantMessage({ id: "a2", parts: [], status: "streaming" }),
		];

		expect(resolveForkAnchor(messages, "a1", false)?.droppedCount).toBe(0);
	});

	it("is null for a message that cannot anchor a fork", () => {
		// Something ahead of it, so the missing seq is what this rejects rather
		// than the opening-message rule tested above.
		const messages: Message[] = [
			assistantMessage({ id: "a0" }),
			userMessage({ anchorSeq: undefined }),
		];

		expect(resolveForkAnchor(messages, "u1", false)).toBeNull();
		expect(resolveForkAnchor(messages, "gone", false)).toBeNull();
	});
});
