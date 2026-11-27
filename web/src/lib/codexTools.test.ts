import { describe, expect, it } from "vitest";
import {
	agentControlDetail,
	agentControlInput,
	sleepRequestLine,
} from "./codexTools";

describe("sleepRequestLine", () => {
	it.each<[unknown, string | undefined]>([
		[{ duration_ms: 30000 }, "Asked to wait 30s"],
		[{ duration_ms: 90000 }, "Asked to wait 1m 30s"],
		[{ duration_ms: 250 }, "Asked to wait 250ms"],
		[{ duration_ms: "30000" }, undefined],
		[{}, undefined],
	])("words %j", (input, want) => {
		expect(sleepRequestLine(input)).toBe(want);
	});
});

describe("agentControlInput", () => {
	it("titles the action and names each agent by its path's last segment", () => {
		expect(
			agentControlInput({
				action: "sendMessage",
				agents: ["/root/file_reader", null],
				prompt: "keep going",
			}),
		).toEqual({
			title: "Message",
			agents: ["file_reader", null],
			prompt: "keep going",
		});
	});

	it("keeps Codex's name for an action it does not word", () => {
		expect(agentControlInput({ action: "teleport", agents: [] }).title).toBe(
			"teleport",
		);
		expect(agentControlInput({}).title).toBe("AgentControl");
	});
});

describe("agentControlDetail", () => {
	it.each<[Array<string | null>, string]>([
		[["file_reader", "writer"], "file_reader, writer"],
		[["file_reader", null], "file_reader +1"],
		[[null, null], "2 agents"],
		[[null], "1 agent"],
		[[], ""],
	])("names %j as %j", (agents, want) => {
		expect(agentControlDetail(agents)).toBe(want);
	});
});
