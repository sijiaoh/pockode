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
});
