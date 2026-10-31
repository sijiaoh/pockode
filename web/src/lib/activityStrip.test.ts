import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, SessionTurn } from "../types/message";
import { stripReplyIndex } from "./activityStrip";

const AT = new Date("2026-01-02T14:00:00Z");

const turn = (phase: SessionTurn["phase"]): SessionTurn => ({
	phase,
	open: phase !== "idle",
	since: "",
});

const reply = (
	id: string,
	status: AssistantMessage["status"],
): AssistantMessage => ({
	id,
	role: "assistant",
	parts: [],
	status,
	createdAt: AT,
});

describe("stripReplyIndex", () => {
	// The tail line's reply, not position: a reply left settled below the one
	// the turn writes into is not what the agent is doing.
	it("takes the reply being written over a later settled one", () => {
		const messages: Message[] = [
			reply("open", "streaming"),
			reply("b", "complete"),
		];
		expect(stripReplyIndex(messages, turn("running"))).toBe(0);
	});

	it("takes the last reply once none is being written", () => {
		const messages: Message[] = [
			reply("a", "complete"),
			reply("b", "interrupted"),
		];
		expect(stripReplyIndex(messages, turn("idle"))).toBe(1);
	});

	it("takes none while the agent works with no reply open yet", () => {
		const messages: Message[] = [reply("a", "interrupted")];
		expect(stripReplyIndex(messages, turn("running"))).toBe(-1);
	});
});
