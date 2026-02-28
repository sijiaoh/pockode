import { Shield, Zap } from "lucide-react";
import type { SessionMode } from "../types/message";

export interface SessionModeInfo {
	label: string;
	description: string;
	icon: typeof Shield;
}

export const SESSION_MODE_INFO: Record<SessionMode, SessionModeInfo> = {
	default: {
		label: "Default",
		description: "Ask before actions",
		icon: Shield,
	},
	yolo: {
		label: "YOLO",
		description: "Skip all permissions",
		icon: Zap,
	},
};

export const SESSION_MODES = Object.keys(SESSION_MODE_INFO) as SessionMode[];
