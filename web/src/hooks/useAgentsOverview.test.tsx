import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContentPart, Message } from "../types/message";
import { useAgentsOverview } from "./useAgentsOverview";

const agentPart: ContentPart = {
	type: "tool_call",
	id: "part-a",
	tool: {
		id: "a",
		name: "Agent",
		input: { description: "Find it", subagent_type: "Explore" },
		status: "running",
	},
};

const reply = (parts: ContentPart[]): Message => ({
	id: "m",
	role: "assistant",
	parts,
	status: "streaming",
	createdAt: new Date(0),
});

describe("useAgentsOverview", () => {
	// The overview goes into the tail context every bubble reads; a new value
	// per streamed record would re-render all of them.
	it("hands back the same overview for a record that changes no agent", () => {
		const { result, rerender } = renderHook(
			({ messages }) => useAgentsOverview(messages, true, "s"),
			{ initialProps: { messages: [reply([agentPart])] } },
		);
		const before = result.current;
		rerender({
			messages: [
				reply([agentPart, { type: "text", id: "t", content: "Still going" }]),
			],
		});
		expect(result.current).toBe(before);

		rerender({
			messages: [
				reply([
					{ ...agentPart, tool: { ...agentPart.tool, status: "success" } },
				]),
			],
		});
		expect(result.current).not.toBe(before);
		expect(result.current.liveCount).toBe(0);
	});

	// Running again under the call that resumed it, as its row draws it.
	it("counts a resumed subagent as live", () => {
		const settled: ContentPart = {
			...agentPart,
			tool: {
				...agentPart.tool,
				status: "success",
				subagent: { agentId: "agent-1" },
			},
		};
		const resume: ContentPart = {
			type: "tool_call",
			id: "part-r",
			tool: {
				id: "r",
				name: "SendMessage",
				input: { to: "agent-1", message: "Go on" },
				status: "running",
			},
		};
		const { result } = renderHook(() =>
			useAgentsOverview([reply([settled, resume])], true, "s"),
		);
		expect(result.current.liveCount).toBe(1);
		expect(result.current.named?.status).toBe("running");
	});
});
