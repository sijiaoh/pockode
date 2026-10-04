import { describe, expect, it } from "vitest";
import type { Thought } from "../types/message";
import { spokenThoughtLabel, thoughtLabel } from "./thinking";

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
