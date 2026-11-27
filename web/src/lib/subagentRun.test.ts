import { describe, expect, it } from "vitest";
import type { Message, ToolRun } from "../types/message";
import { liveResumes, resumedRun } from "./subagentRun";

const run = (overrides: Partial<ToolRun> & Pick<ToolRun, "id">): ToolRun => ({
	name: "Agent",
	input: { description: "draft" },
	status: "success",
	...overrides,
});

const sendMessage = (
	id: string,
	to: string,
	status: ToolRun["status"],
): ToolRun => ({
	id,
	name: "SendMessage",
	input: { to, summary: "revise", message: "Apply the review." },
	status,
});

const bubble = (...runs: ToolRun[]): Message => ({
	id: `m-${runs[0]?.id}`,
	role: "assistant",
	status: "complete",
	createdAt: new Date(0),
	parts: runs.map((tool) => ({ id: `p-${tool.id}`, type: "tool_call", tool })),
});

describe("liveResumes", () => {
	// claude 2.1.330 names the subagent on the record; 2.1.286 only in the
	// hand-back's text, which history recorded then still holds.
	it("joins a live SendMessage to the subagent it names", () => {
		const byRecord = run({ id: "t1", subagent: { agentId: "a1" } });
		const byText = run({
			id: "t2",
			result:
				"[Subagent hand-back] The report follows:\n  Done.\nagentId: a2 (use SendMessage with to: 'a2')",
		});
		const resume1 = sendMessage("s1", "a1", "background");
		const resume2 = sendMessage("s2", "a2", "running");
		const resumes = liveResumes([
			bubble(byRecord, byText),
			bubble(resume1, resume2),
		]);
		expect(resumes.get("t1")).toBe(resume1);
		expect(resumes.get("t2")).toBe(resume2);
	});

	// The resumed subagent's outcome settles the SendMessage, and with it the
	// row: nothing was copied onto the subagent's run to be left behind.
	it("lets the subagent settle again with the call that resumed it", () => {
		const subagent = run({ id: "t1", subagent: { agentId: "a1" } });
		for (const status of ["success", "error", "interrupted"] as const) {
			expect(
				liveResumes([bubble(subagent), bubble(sendMessage("s1", "a1", status))])
					.size,
			).toBe(0);
		}
	});

	// A message to a subagent still at work is read by it; it did not stop.
	it("leaves a subagent that is still running alone", () => {
		const subagent = run({
			id: "t1",
			status: "background",
			placeholderResult: "Async agent launched successfully.\nagentId: a1",
		});
		expect(
			liveResumes([
				bubble(subagent),
				bubble(sendMessage("s1", "a1", "running")),
			]).size,
		).toBe(0);
	});

	it("finds a subagent spawned by a subagent", () => {
		const inner = run({ id: "t2", subagent: { agentId: "a2" } });
		const outer = run({
			id: "t1",
			children: [{ id: "p-t2", type: "tool_call", tool: inner }],
		});
		const resume = sendMessage("s1", "a2", "background");
		expect(liveResumes([bubble(outer), bubble(resume)]).get("t2")).toBe(resume);
	});
});

describe("resumedRun", () => {
	// The row's clock is the resumed run's; what it reported stays for the body.
	it("runs on the resuming call's clock and progress", () => {
		const seenAt = new Date("2026-01-01T00:01:00Z");
		const shown = resumedRun(
			run({
				id: "t1",
				result: "first report",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
			}),
			{
				...sendMessage("s1", "a1", "background"),
				startedAt: 60_000,
				seenAt,
				subagentProgress: { toolUses: 2, lastToolName: "Read" },
			},
		);
		expect(shown).toMatchObject({
			status: "running",
			result: "first report",
			startedAt: 60_000,
			seenAt,
			subagentProgress: { toolUses: 2, lastToolName: "Read" },
		});
		expect(shown.endedAt).toBeUndefined();
		expect(shown.durationMs).toBeUndefined();
	});
});
