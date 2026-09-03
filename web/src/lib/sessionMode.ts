import { Shield, Zap } from "lucide-react";
import type { SessionMode } from "../types/message";
import type { AgentType } from "../types/settings";

export interface SessionModeInfo {
	label: string;
	description: string;
	icon: typeof Shield;
}

// label/icon identify the mode itself; they don't depend on which CLI runs it.
const SESSION_MODE_BASE: Record<
	SessionMode,
	Omit<SessionModeInfo, "description">
> = {
	default: { label: "Default", icon: Shield },
	yolo: { label: "YOLO", icon: Zap },
};

// "Default" is not the same contract on both CLIs: Claude prompts per edit and
// command, while Codex only prompts once it leaves its workspace sandbox.
// Spelled out per agent instead of falling back to a shared string, so one
// column reads as the full story for that agent.
const SESSION_MODE_DESCRIPTION: Record<
	AgentType,
	Record<SessionMode, string>
> = {
	claude: {
		default: "Asks before edits & commands",
		yolo: "Skips all permissions",
	},
	codex: {
		default: "Edits & runs in this project,\nasks only to go outside or online",
		yolo: "Skips all permissions",
	},
};

export function getSessionModeInfo(
	mode: SessionMode,
	agentType: AgentType,
): SessionModeInfo {
	const description = SESSION_MODE_DESCRIPTION[agentType];
	return {
		...(SESSION_MODE_BASE[mode] ?? SESSION_MODE_BASE.default),
		description: description[mode] ?? description.default,
	};
}

export const SESSION_MODES = Object.keys(SESSION_MODE_BASE) as SessionMode[];
