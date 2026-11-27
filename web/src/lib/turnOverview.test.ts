import { describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	PlanStep,
	ToolRun,
	ToolRunStatus,
} from "../types/message";
import {
	backgroundTaskRuns,
	currentPlan,
	overviewMessageId,
	planLineWords,
	statusLineLabel,
	topLevelAgentRuns,
} from "./turnOverview";

const call = (
	id: string,
	status: ToolRunStatus,
	{
		name = "Agent",
		children,
		parentToolUseId,
	}: {
		name?: string;
		children?: ContentPart[];
		parentToolUseId?: string;
	} = {},
): ContentPart => ({
	type: "tool_call",
	id: `part-${id}`,
	tool: { id, name, input: {}, status, children },
	parentToolUseId,
});

const reply = (
	id: string,
	parts: ContentPart[],
	status: AssistantMessage["status"] = "complete",
): Message => ({
	id,
	role: "assistant",
	parts,
	status,
	createdAt: new Date(),
});

const user = (id: string): Message => ({
	id,
	role: "user",
	content: "hi",
	status: "complete",
	createdAt: new Date(),
});

const ids = (runs: readonly ToolRun[]) => runs.map((run) => run.id);

describe("topLevelAgentRuns", () => {
	it("takes a reply's own subagent calls, in transcript order, of any status", () => {
		const messages = [
			reply("m1", [
				call("a", "success"),
				call("bash", "running", { name: "Bash" }),
			]),
			user("u"),
			reply("m2", [
				call("b", "background"),
				call("c", "running", { name: "Task" }),
			]),
		];
		expect(ids(topLevelAgentRuns(messages))).toEqual(["a", "b", "c"]);
	});

	// A subagent's own subagent is one step of its parent's, whether it is
	// filed under it or left flat naming it.
	it("leaves out a subagent's own subagents", () => {
		const messages = [
			reply("m", [
				call("outer", "running", { children: [call("inner", "running")] }),
				call("flat", "running", { parentToolUseId: "elsewhere" }),
			]),
		];
		expect(ids(topLevelAgentRuns(messages))).toEqual(["outer"]);
	});
});

describe("backgroundTaskRuns", () => {
	it("takes every backgrounded run of any tool, but not one under another", () => {
		const messages = [
			reply("m", [
				call("bash", "background", { name: "Bash" }),
				call("done", "success"),
				call("agent", "background", {
					children: [call("child", "background", { name: "Bash" })],
				}),
				// A foreground subagent's backgrounded step holds the turn too.
				call("fg", "running", {
					children: [call("step", "background", { name: "Bash" })],
				}),
			]),
		];
		expect(ids(backgroundTaskRuns(messages))).toEqual([
			"bash",
			"agent",
			"step",
		]);
	});

	it("keeps the runs a list holds after they settle", () => {
		const messages = [
			reply("m", [call("settled", "success"), call("live", "background")]),
		];
		expect(ids(backgroundTaskRuns(messages, new Set(["settled"])))).toEqual([
			"settled",
			"live",
		]);
	});
});

describe("overviewMessageId", () => {
	it("is the bubble the open turn is writing into", () => {
		const messages = [reply("m1", []), user("u"), reply("m2", [], "streaming")];
		expect(overviewMessageId(messages, true, false)).toBe("m2");
	});

	// Above the unread message, where the work is happening.
	it("stays on the open bubble when a message sent mid-turn is under it", () => {
		const messages = [reply("m1", [], "streaming"), user("u")];
		expect(overviewMessageId(messages, true, false)).toBe("m1");
	});

	it("is the placeholder before the server has said the turn opened", () => {
		const messages = [user("u"), reply("m", [], "sending")];
		expect(overviewMessageId(messages, false, false)).toBe("m");
	});

	// Before the subscribe-time settle has finalised it.
	it("does not take a reply left streaming by a turn that is over", () => {
		const messages = [reply("m1", [], "streaming"), reply("m2", [])];
		expect(overviewMessageId(messages, false, false)).toBeUndefined();
		expect(overviewMessageId(messages, false, true)).toBe("m2");
	});

	it("is the last assistant message after the turn while an agent outlives it", () => {
		const messages = [reply("m1", []), reply("m2", []), user("u")];
		expect(overviewMessageId(messages, false, true)).toBe("m2");
		expect(overviewMessageId(messages, false, false)).toBeUndefined();
	});
});

const step = (
	text: string,
	status: PlanStep["status"],
	activeText?: string,
): PlanStep => ({ text, status, ...(activeText ? { activeText } : {}) });

const planned = (
	id: string,
	order: number,
	steps: PlanStep[] = [step(id, "pending")],
	parentToolUseId?: string,
): ContentPart => ({
	type: "tool_call",
	id: `part-${id}`,
	tool: {
		id,
		name: "TodoWrite",
		input: {},
		status: "success",
		plan: { steps, order },
	},
	parentToolUseId,
});

const firstStep = (messages: Message[], open = true) =>
	currentPlan(messages, open)?.steps[0]?.text;

describe("currentPlan", () => {
	it("is the newest record, not the latest call", () => {
		const messages = [
			reply("m", [planned("a", 7), planned("b", 5)], "streaming"),
		];
		expect(firstStep(messages)).toBe("a");
	});

	// A read point closes the bubble above it; that bubble is still this turn's.
	it("reaches back across read points, and no further", () => {
		const cut = (id: string, parts: ContentPart[]): AssistantMessage => ({
			id,
			role: "assistant",
			parts,
			status: "streaming",
			createdAt: new Date(),
			openedAtReadPoint: true,
		});
		const messages = [
			reply("earlier", [planned("earlier", 1)]),
			user("u1"),
			reply("first", [planned("first", 3)]),
			user("u2"),
			cut("second", []),
		];
		expect(firstStep(messages)).toBe("first");
		// The earlier turn's plan never shows in a new one.
		expect(
			firstStep([...messages.slice(0, 2), reply("new", [], "streaming")]),
		).toBeUndefined();
	});

	// A resumed Claude subagent's work, its Task-tool plans with it, is filed
	// under the call that first spawned it, in an earlier turn's reply.
	it("counts a record written this turn on an earlier turn's run", () => {
		const opener = (anchorSeq?: number): Message => ({
			...user("u"),
			...(anchorSeq !== undefined ? { anchorSeq } : {}),
		});
		const resumed = (order: number) =>
			reply("earlier", [planned("old", 2), planned("spawn", order)]);
		const open = reply("now", [], "streaming");
		expect(firstStep([resumed(12), opener(10), open])).toBe("spawn");
		// Written before the turn opened: an earlier turn's plan.
		expect(firstStep([resumed(4), opener(10), open])).toBeUndefined();
		// No seq to tell the two apart by: only the turn's own replies.
		expect(firstStep([resumed(12), opener(), open])).toBeUndefined();
	});

	it("is the main agent's only", () => {
		const messages = [
			reply(
				"m",
				[
					planned("main", 1),
					planned("flat", 2, undefined, "elsewhere"),
					call("agent", "running", { children: [planned("inner", 3)] }),
				],
				"streaming",
			),
		];
		expect(firstStep(messages)).toBe("main");
	});

	it("is none while no turn is open, or once the agent cleared its list", () => {
		const messages = [reply("m", [planned("a", 1)], "streaming")];
		expect(currentPlan(messages, false)).toBeUndefined();
		expect(
			currentPlan(
				[reply("m", [planned("a", 1), planned("b", 2, [])], "streaming")],
				true,
			),
		).toBeUndefined();
	});
});

describe("planLineWords", () => {
	it("names the first item in progress by its active words, and counts the rest", () => {
		const words = planLineWords([
			step("Write tests", "completed"),
			step("Fix retry", "in_progress", "Fixing retry"),
			step("Fix sender", "in_progress"),
			step("Update docs", "pending"),
		]);
		expect(words).toEqual({
			done: 1,
			total: 4,
			label: "Now",
			item: "Fixing retry",
			more: 1,
		});
	});

	it("says what is next by the item's own words when nothing is in progress", () => {
		const words = planLineWords([
			step("Write tests", "completed"),
			step("Update docs", "pending", "Updating docs"),
		]);
		expect(words).toMatchObject({ label: "Next", item: "Update docs" });
	});

	it("says all done when every item is", () => {
		const words = planLineWords([
			step("a", "completed"),
			step("b", "completed"),
		]);
		expect(words).toMatchObject({ done: 2, total: 2, label: "All done" });
	});
});

describe("statusLineLabel", () => {
	// Never the free text, which moves while it is live.
	it("names the stable facts only, leaving out what is absent", () => {
		expect(
			statusLineLabel({
				phase: "Working",
				plan: { done: 3, total: 7 },
				agents: 2,
			}),
		).toBe("Working, plan 3 of 7, 2 agents running, details");
		expect(statusLineLabel({ plan: { done: 1, total: 2 } })).toBe(
			"Plan 1 of 2, details",
		);
		expect(statusLineLabel({ agents: 0 })).toBe("No agents running, details");
	});
});
