import { Bot, Terminal } from "lucide-react";
import type { AgentType, ForkSupport } from "../types/settings";

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
 * Why forking is unavailable for an agent, or `undefined` when nothing blocks it.
 *
 * The row stays in the menu either way: a control that is not there teaches the
 * user nothing about why. The wording says the agent lacks the ability, which is
 * what is true — nothing has gone wrong with Pockode.
 *
 * A `null` declaration — the server has not answered yet — blocks nothing. There
 * is no reason to give, and the server refuses the request itself if it turns out
 * one applied.
 */
export function forkBlockedReason(
	agentType: AgentType,
	forkSupport: ForkSupport | null,
): string | undefined {
	if (forkSupport !== "none") return undefined;
	return `${AGENT_TYPE_INFO[agentType].label} cannot reopen an earlier conversation, so its sessions cannot be forked.`;
}
