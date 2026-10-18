import { Shield, Zap } from "lucide-react";
import type { SessionMode } from "../types/message";

export interface SessionModeInfo {
	label: string;
	description: string;
	icon: typeof Shield;
}

// Each mode means the same on every agent, so none of this depends on which CLI
// runs the session.
const SESSION_MODE_INFO: Record<SessionMode, SessionModeInfo> = {
	default: {
		label: "Default",
		// Broken by hand: ChoiceRow descriptions never wrap, and one line of this
		// overflows a narrow phone.
		description: "Follows the agent's own\npermission settings",
		icon: Shield,
	},
	yolo: { label: "YOLO", description: "Skips all permissions", icon: Zap },
};

export function getSessionModeInfo(mode: SessionMode): SessionModeInfo {
	return SESSION_MODE_INFO[mode] ?? SESSION_MODE_INFO.default;
}

export const SESSION_MODES = Object.keys(SESSION_MODE_INFO) as SessionMode[];
