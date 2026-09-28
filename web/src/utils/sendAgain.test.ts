import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, UserMessage } from "../types/message";
import { sendAgainTarget, sendAgainText } from "./sendAgain";

function user(overrides: Partial<UserMessage> = {}): UserMessage {
	return {
		id: "u1",
		role: "user",
		content: "fix the build",
		status: "complete",
		createdAt: new Date(),
		...overrides,
	};
}

function failed(
	id = "a1",
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		id,
		role: "assistant",
		parts: [],
		status: "error",
		error: "Not logged in",
		authFailure: "claude",
		createdAt: new Date(),
		...overrides,
	};
}

describe("sendAgainText", () => {
	it("gives back the message the latest turn failed on", () => {
		expect(sendAgainText([user(), failed()], { messageId: "a1" })).toBe(
			"fix the build",
		);
	});

	it("gives back a command as typed, not the prompt it expanded to", () => {
		const command = user({
			content: "Lead the work just discussed.",
			command: { name: "pockode-lead", args: "backend first" },
		});
		expect(sendAgainText([command, failed()], { messageId: "a1" })).toBe(
			"/pockode-lead backend first",
		);
	});

	it("offers nothing on a turn the conversation has moved past", () => {
		const messages: Message[] = [
			user(),
			failed("a1"),
			user({ id: "u2" }),
			failed("a2"),
		];
		expect(sendAgainText(messages, { messageId: "a1" })).toBeUndefined();
		expect(sendAgainText(messages, { messageId: "a2" })).toBe("fix the build");
	});

	it("offers nothing for words the user never typed", () => {
		for (const source of ["system", "agent"] as const) {
			expect(
				sendAgainText([user({ source }), failed()], { messageId: "a1" }),
			).toBeUndefined();
		}
		expect(
			sendAgainText([user({ source: "user" }), failed()], { messageId: "a1" }),
		).toBe("fix the build");
		const answer = user({
			answering: [
				{
					request_id: "q1",
					question: "Which?",
					answers: ["A"],
					answered_at: "2026-09-28T10:00:00Z",
				},
			],
		});
		expect(
			sendAgainText([answer, failed()], { messageId: "a1" }),
		).toBeUndefined();
	});

	// A reconnect replays history into bubbles with new ids, typically while the
	// user is away in a browser signing in — and the turn may have been still
	// retrying when they pressed, its bubble's own place in history moving on
	// to the error since.
	it("still finds the turn after a replay gave it a new id", () => {
		const asked = user({ anchorSeq: 5 });
		const retrying = failed("a1", {
			status: "streaming",
			error: undefined,
			authFailure: undefined,
			anchorSeq: 6,
		});
		const target = sendAgainTarget([asked, retrying], "a1");

		const replayed = [asked, failed("replayed", { anchorSeq: 9 })];
		expect(sendAgainText(replayed, target)).toBe("fix the build");

		const later = [
			asked,
			failed("replayed"),
			user({ id: "u2", anchorSeq: 10, content: "next" }),
			failed("again"),
		];
		expect(sendAgainText(later, target)).toBeUndefined();
	});

	// Signed in from a retry's notice: the turn may yet succeed, and sending its
	// message again would run it twice.
	it("offers nothing until the turn has failed on its credentials", () => {
		const running = failed("a1", {
			status: "streaming",
			error: undefined,
			authFailure: undefined,
		});
		expect(
			sendAgainText([user(), running], { messageId: "a1" }),
		).toBeUndefined();
		const otherFailure = failed("a1", { authFailure: undefined });
		expect(
			sendAgainText([user(), otherFailure], { messageId: "a1" }),
		).toBeUndefined();
	});
});
