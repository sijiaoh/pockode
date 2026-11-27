/**
 * The calls only Codex makes, under the names the server gives them
 * (server/agent/codex/tool_items.go; docs/tool-call-model.md#codex-items-beyond-commands-patches-and-mcp).
 * A Codex web search and page open arrive as `WebSearch` / `WebFetch` and are
 * not here: they are Claude's calls and read as those.
 */

import { formatDuration } from "./toolRun";

export const GENERATE_IMAGE_TOOL = "GenerateImage";
export const SLEEP_TOOL = "Sleep";
export const AGENT_CONTROL_TOOL = "AgentControl";

function asObject(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

/** The prompt an image generation's start carried, when it carried one. */
export function generateImagePrompt(input: unknown): string | undefined {
	const prompt = asObject(input).prompt;
	return typeof prompt === "string" && prompt ? prompt : undefined;
}

/**
 * What a sleep's body says, from the wait it asked for — *Asked to*, never
 * *Waited*: a sleep cut short by Stop did not.
 */
export function sleepRequestLine(input: unknown): string | undefined {
	const ms = asObject(input).duration_ms;
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
	return `Asked to wait ${ms < 1000 ? `${ms}ms` : formatDuration(ms)}`;
}

const ACTION_TITLES = new Map<string, string>([
	["wait", "Wait"],
	["sendInput", "Send input"],
	["sendMessage", "Message"],
	["followupTask", "Follow up"],
	["resumeAgent", "Resume"],
	["interruptAgent", "Interrupt"],
	["closeAgent", "Close"],
	["listAgents", "List agents"],
]);

export interface AgentControlInput {
	/** Codex's own name for the call when it is one this does not word. */
	title: string;
	/**
	 * Each receiver by its path's last segment; null for one whose spawn named
	 * no path.
	 */
	agents: Array<string | null>;
	prompt?: string;
}

export function agentControlInput(input: unknown): AgentControlInput {
	const obj = asObject(input);
	const action = typeof obj.action === "string" ? obj.action : "";
	const agents = Array.isArray(obj.agents)
		? obj.agents.map((agent) =>
				typeof agent === "string" && agent
					? (agent.split("/").pop() ?? agent)
					: null,
			)
		: [];
	return {
		title: ACTION_TITLES.get(action) ?? (action || AGENT_CONTROL_TOOL),
		agents,
		prompt:
			typeof obj.prompt === "string" && obj.prompt ? obj.prompt : undefined,
	};
}

/**
 * The agents as the row names them: `file_reader, writer`, the unnamed ones
 * only counted — `file_reader +1`, or `2 agents` when none has a name.
 */
export function agentControlDetail(agents: Array<string | null>): string {
	const named = agents.filter((agent): agent is string => agent !== null);
	const unnamed = agents.length - named.length;
	if (named.length === 0) {
		if (unnamed === 0) return "";
		return unnamed === 1 ? "1 agent" : `${unnamed} agents`;
	}
	return unnamed > 0 ? `${named.join(", ")} +${unnamed}` : named.join(", ");
}
