import { describe, expect, it } from "vitest";
import type { ContentPart, Message, ToolRun } from "../types/message";
import {
	liveResumes,
	recentSteps,
	resumedRun,
	stepWindowLines,
	subagentPath,
} from "./subagentRun";

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

// docs/subagent-transcript-ui.md#back-at-each-depth
describe("subagentPath", () => {
	const nested = (id: string, ...children: ToolRun[]): ToolRun =>
		run({
			id,
			children: children.map((tool) => ({
				id: `p-${tool.id}`,
				type: "tool_call",
				tool,
			})),
		});

	it("runs from the outermost subagent down to the one asked for", () => {
		const messages = [bubble(nested("t1", nested("t2", run({ id: "t3" }))))];
		expect(subagentPath(messages, "t3")).toEqual(["t1", "t2", "t3"]);
		expect(subagentPath(messages, "t1")).toEqual(["t1"]);
	});

	it("goes on up from a flat call through the run it belongs to", () => {
		const messages: Message[] = [
			bubble(nested("t1", run({ id: "t2" }))),
			{
				id: "m-flat",
				role: "assistant",
				status: "complete",
				createdAt: new Date(0),
				parts: [
					{
						id: "p-t5",
						type: "tool_call",
						tool: nested("t5", run({ id: "t6" })),
						parentToolUseId: "t2",
					},
				],
			},
		];
		expect(subagentPath(messages, "t6")).toEqual(["t1", "t2", "t5", "t6"]);
	});

	it("is the one subagent when its call is not loaded", () => {
		expect(subagentPath([], "t9")).toEqual(["t9"]);
	});
});

// docs/tool-call-ui.md#the-step-window
describe("stepWindowLines", () => {
	const live = (id: string, startedAt?: number) =>
		run({ id, status: "running", startedAt });
	const settled = (id: string, endedAt?: number) =>
		run({ id, status: "success", startedAt: 0, endedAt });

	// Parallel siblings stay skimmable on a phone: the more there are, the
	// fewer lines each gets, whatever their status.
	it("sizes a live row's window by how many subagent rows share its list", () => {
		expect(stepWindowLines([live("a")]).get("a")).toBe(3);
		expect(stepWindowLines([live("a"), settled("b")]).get("a")).toBe(2);
		expect(
			stepWindowLines([live("a"), live("b"), live("c"), live("d")]).get("a"),
		).toBe(1);
	});

	it("draws none for a settled row with no live sibling", () => {
		expect(stepWindowLines([settled("a", 10)]).get("a")).toBe(0);
		expect(stepWindowLines([settled("a", 10), settled("b", 20)]).get("a")).toBe(
			0,
		);
	});

	// The first sibling to finish holds its height above the ones still
	// running, and the list folds once, with the last of them.
	it("keeps a settled row's window while a sibling that ran beside it runs", () => {
		const lines = stepWindowLines([settled("a", 10), live("b", 5)]);
		expect(lines.get("a")).toBe(2);
		expect(lines.get("b")).toBe(2);
	});

	// A sibling resumed or added after the list folded regrows nobody's
	// window — and a reload, which has no memory, answers the same.
	it("does not regrow a window for a sibling that started after it settled", () => {
		expect(stepWindowLines([settled("a", 10), live("b", 20)]).get("a")).toBe(0);
	});

	it("folds when a time is missing", () => {
		expect(stepWindowLines([settled("a"), live("b", 5)]).get("a")).toBe(0);
		expect(stepWindowLines([settled("a", 10), live("b")]).get("a")).toBe(0);
	});
});

describe("recentSteps", () => {
	const call = (
		id: string,
		status: ToolRun["status"] = "success",
	): ContentPart => ({
		id: `p-${id}`,
		type: "tool_call",
		tool: { id, name: "Read", input: { file_path: `/${id}` }, status },
	});
	const card = (
		toolUseId: string,
		status: "pending" | "allowed" | "denied" | "expired",
	): ContentPart => ({
		id: `card-${toolUseId}`,
		type: "permission_request",
		request: {
			requestId: `r-${toolUseId}`,
			toolName: "Bash",
			toolInput: { command: "make" },
			toolUseId,
		},
		status,
	});
	const question = (
		askedAt: string,
		status: "pending" | "answered" | "declined" | "cancelled",
	): ContentPart => ({
		id: `q-${askedAt}`,
		type: "question_record",
		record: {
			requestId: `rq-${askedAt}`,
			question: {
				question: "Which one?",
				header: "Pick",
				options: [],
				multiSelect: false,
			},
			askedAt,
		},
		status,
	});
	const text: ContentPart = { id: "t", type: "text", content: "Thinking." };

	it("takes the newest steps, oldest first, and never a text", () => {
		const steps = recentSteps(
			[call("a"), call("b"), text, call("c"), call("d", "running"), text],
			3,
		);
		expect(steps.map((step) => [step.id, step.mark])).toEqual([
			["b", "success"],
			["c", "success"],
			["d", "running"],
		]);
	});

	// A card and the row that comes back for it are one step, where the card
	// first stood, drawn as whichever came last.
	it("draws a step by its newest form, in the place it first took", () => {
		const steps = recentSteps(
			[card("a", "allowed"), call("b"), call("a", "running")],
			3,
		);
		expect(steps.map((step) => [step.id, step.mark])).toEqual([
			["a", "running"],
			["b", "success"],
		]);
	});

	it("reads a card or a question as the user left it", () => {
		const marks = (part: ContentPart) => recentSteps([part], 1)[0].mark;
		expect(marks(card("a", "pending"))).toBe("waiting");
		expect(marks(card("a", "allowed"))).toBe("running");
		expect(marks(card("a", "denied"))).toBe("error");
		expect(marks(card("a", "expired"))).toBe("interrupted");
		expect(marks(question("1", "pending"))).toBe("waiting");
		expect(marks(question("1", "answered"))).toBe("success");
		expect(marks(question("1", "declined"))).toBe("interrupted");
		expect(recentSteps([question("1", "pending")], 1)[0].label).toEqual({
			kind: "question",
			text: "Pick",
		});
	});
});
