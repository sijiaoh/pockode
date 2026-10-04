import { Bot, CircleHelp, Terminal } from "lucide-react";
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

/**
 * The agent's own name, or the id itself when this build has no entry for it.
 * Shown as itself rather than rewritten to a known agent: the record really is
 * set to it, and drawing Codex as Claude would be a lie about a stored value.
 */
export function getAgentLabel(agentType: string): string {
	return AGENT_TYPE_INFO[agentType as AgentType]?.label ?? agentType;
}

/** The agent's entry, or one naming the id itself — see `getAgentLabel`. */
export function getAgentInfo(agentType: string): AgentTypeInfo {
	return (
		AGENT_TYPE_INFO[agentType as AgentType] ?? {
			label: agentType,
			description: "Not a known agent on this server",
			icon: CircleHelp,
		}
	);
}

export interface AgentCliInfo {
	/** The command a user installs and runs on the server. */
	command: string;
	/** Signs in from a terminal on the server: the way out when Pockode can't. */
	loginCommand: string;
	installUrl: string;
}

/** The CLI behind each agent, for telling a user how to install it. */
export const AGENT_CLI_INFO: Record<AgentType, AgentCliInfo> = {
	claude: {
		command: "claude",
		loginCommand: "claude auth login",
		installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
	},
	codex: {
		command: "codex",
		loginCommand: "codex login",
		installUrl: "https://github.com/openai/codex",
	},
};
