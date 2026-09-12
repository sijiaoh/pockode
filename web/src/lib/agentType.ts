import { Bot, Terminal } from "lucide-react";
import type { AgentType } from "../types/settings";

export interface AgentTypeInfo {
	label: string;
	description: string;
	icon: typeof Bot;
}

export const AGENT_TYPE_INFO: Record<AgentType, AgentTypeInfo> = {
	claude: {
		label: "Claude",
		description: "Anthropic Claude",
		icon: Bot,
	},
	codex: {
		label: "Codex",
		description: "OpenAI Codex",
		icon: Terminal,
	},
};

export const AGENT_TYPES = Object.keys(AGENT_TYPE_INFO) as AgentType[];

/**
 * The agent a session runs on when nothing names one. Mirrors
 * `session.DefaultAgentType` in Go: the server stamps it onto a session created
 * without an agent, and judges the global default model against it, so a user who
 * never touched the agent setting is really on this one.
 */
export const DEFAULT_AGENT_TYPE: AgentType = "claude";
