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

	it("rejects a message that is still being written", () => {
		expect(isForkableMessage(assistantMessage({ status: "streaming" }))).toBe(
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

	it("rejects Pockode's own annotations", () => {
		expect(isForkableMessage(userMessage({ source: "system" }))).toBe(false);

		const workCard: Message = {
			id: "w1",
			role: "work",
			workId: "work-1",
			entries: [],
			createdAt: new Date(),
		};
		expect(isForkableMessage(workCard)).toBe(false);
	});
});

describe("resolveForkAnchor", () => {
	it("counts the messages that stay behind", () => {
		const messages: Message[] = [
			userMessage({ id: "u1" }),
			assistantMessage({ id: "a1" }),
			userMessage({ id: "u2", anchorSeq: 3 }),
			assistantMessage({ id: "a2", anchorSeq: 4 }),
		];

		expect(resolveForkAnchor(messages, "a1")).toMatchObject({
			anchorSeq: 2,
			droppedCount: 2,
		});
		expect(resolveForkAnchor(messages, "a2")?.droppedCount).toBe(0);
	});

	// A bubble the agent never wrote into is not a message the user can see, so
	// a fork cannot claim to leave it behind.
	it("does not count an empty placeholder as left behind", () => {
		const messages: Message[] = [
			assistantMessage({ id: "a1" }),
			assistantMessage({ id: "a2", parts: [], status: "streaming" }),
		];

		expect(resolveForkAnchor(messages, "a1")?.droppedCount).toBe(0);
	});

	it("is null for a message that cannot anchor a fork", () => {
		const messages: Message[] = [userMessage({ anchorSeq: undefined })];

		expect(resolveForkAnchor(messages, "u1")).toBeNull();
		expect(resolveForkAnchor(messages, "gone")).toBeNull();
	});
});
