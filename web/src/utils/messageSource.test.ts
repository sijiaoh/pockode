import { describe, expect, it } from "vitest";
import type { Message } from "../types/message";
import { isTypedByUser } from "./messageSource";

const userMessage = (
	overrides: Partial<Extract<Message, { role: "user" }>> = {},
): Message => ({
	id: "m1",
	role: "user",
	content: "hello",
	status: "complete",
	createdAt: new Date(),
	...overrides,
});

// Three things arrive as `role: "user"` and only one of them is a person
// typing. The two that are not must not follow the transcript to the tail or
// claim the delivery receipt, which are both about the person at the keyboard.
describe("isTypedByUser", () => {
	it("is true for a typed message, which carries no source", () => {
		expect(isTypedByUser(userMessage())).toBe(true);
	});

	it("is false for Pockode's own automation", () => {
		expect(isTypedByUser(userMessage({ source: "system" }))).toBe(false);
	});

	it("is false for an answer another agent gave", () => {
		expect(isTypedByUser(userMessage({ source: "agent" }))).toBe(false);
	});

	it("is false for anything the agent said", () => {
		expect(
			isTypedByUser({
				id: "a1",
				role: "assistant",
				parts: [],
				status: "complete",
				createdAt: new Date(),
			}),
		).toBe(false);
	});
});
