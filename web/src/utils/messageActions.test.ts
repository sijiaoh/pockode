import { describe, expect, it } from "vitest";
import { hasMessageActions } from "./messageActions";

describe("hasMessageActions", () => {
	it("gives a row to a settled user or assistant turn", () => {
		expect(
			hasMessageActions({
				id: "u1",
				role: "user",
				content: "Hello",
				status: "complete",
				createdAt: new Date(),
			}),
		).toBe(true);
		expect(
			hasMessageActions({
				id: "a1",
				role: "assistant",
				parts: [{ type: "text", content: "Hi" }],
				status: "complete",
				createdAt: new Date(),
			}),
		).toBe(true);
	});

	// A missing seq or an unanswered request is fork's problem, not the row's:
	// the row still appears, and fork alone goes quiet on it.
	it("keeps the row on a turn no fork could anchor at", () => {
		expect(
			hasMessageActions({
				id: "u1",
				role: "user",
				content: "Hello",
				status: "complete",
				createdAt: new Date(),
				anchorSeq: undefined,
			}),
		).toBe(true);
	});

	it("gives no row to a message still being written", () => {
		expect(
			hasMessageActions({
				id: "a1",
				role: "assistant",
				parts: [],
				status: "streaming",
				createdAt: new Date(),
			}),
		).toBe(false);
	});

	it("gives no row to a system-driven message", () => {
		expect(
			hasMessageActions({
				id: "u1",
				role: "user",
				content: "Step 1 of 2",
				source: "system",
				status: "complete",
				createdAt: new Date(),
			}),
		).toBe(false);
	});
});
