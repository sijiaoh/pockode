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
