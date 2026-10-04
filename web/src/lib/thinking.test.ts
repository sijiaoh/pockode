import { describe, expect, it } from "vitest";
import type { Thought } from "../types/message";
import {
	applyThinkingDelta,
	latestLine,
	spokenThoughtLabel,
	thoughtLabel,
} from "./thinking";

const timed = (...durations: number[]): Thought[] =>
	durations.map((durationMs) => ({
		content: "",
		fullReasoning: "",
		redacted: false,
		durationMs,
	}));

describe("thoughtLabel", () => {
	// A think that happened is never `0s`, and whole seconds are the format.
	it("rounds the sum up to whole seconds", () => {
		expect(thoughtLabel(timed(1))).toBe("Thought for 1s");
		expect(thoughtLabel(timed(400, 700))).toBe("Thought for 2s");
		expect(thoughtLabel(timed(59_001))).toBe("Thought for 1m 0s");
	});

	it("reads the same aloud, in words", () => {
		expect(spokenThoughtLabel(timed(1000))).toBe("Thought for 1 second");
		expect(spokenThoughtLabel(timed(80_000))).toBe(
			"Thought for 1 minute 20 seconds",
		);
		expect(thoughtLabel(timed(2 * 3_600_000 + 60_000))).toBe(
			"Thought for 2h 1m",
		);
		expect(spokenThoughtLabel(timed(2 * 3_600_000 + 60_000))).toBe(
			"Thought for 2 hours 1 minute",
		);
	});
});

describe("applyThinkingDelta", () => {
	const delta = (content: string, fullReasoning = "") => ({
		content,
		fullReasoning,
	});

	it("accumulates both texts in arrival order", () => {
		const live = [
			delta(""),
			delta("**Plan**\n\n", "a"),
			delta("Read it", "b"),
		].reduce(
			applyThinkingDelta,
			null as ReturnType<typeof applyThinkingDelta> | null,
		);
		expect(live).toMatchObject({
			content: "**Plan**\n\nRead it",
			fullReasoning: "ab",
			joinedLate: false,
		});
	});

	// Codex opens every reasoning item with an empty delta, so text in the first
	// one this client sees means the beginning went by before it subscribed.
	it("marks a thinking first seen mid-text as joined late", () => {
		expect(applyThinkingDelta(null, delta("half a thought")).joinedLate).toBe(
			true,
		);
	});
});

describe("latestLine", () => {
	it("is the last non-empty line, Markdown markers stripped", () => {
		expect(
			latestLine("**Checking the sender**\n\nIt retries on `429`\n\n"),
		).toBe("It retries on 429");
		expect(latestLine("intro\n### **Checking how the sender retries**")).toBe(
			"Checking how the sender retries",
		);
		expect(latestLine("- first\n  2. second")).toBe("second");
	});

	// Reasoning about code names code: only paired delimiters are emphasis.
	it("keeps the underscores and asterisks that are not emphasis", () => {
		expect(latestLine("Checking handle_reasoning_delta and a * b")).toBe(
			"Checking handle_reasoning_delta and a * b",
		);
		expect(latestLine("an *important* and _quiet_ step")).toBe(
			"an important and quiet step",
		);
		expect(latestLine("*a* and **b**, _x_ y _z_")).toBe("a and b, x y z");
		expect(latestLine("Reading `__init__` in **setup**")).toBe(
			"Reading __init__ in setup",
		);
	});

	it("is empty before there is text", () => {
		expect(latestLine("")).toBe("");
		expect(latestLine("\n\n")).toBe("");
	});
});
