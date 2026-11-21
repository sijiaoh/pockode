import { Bot, CircleHelp, Shield, Zap } from "lucide-react";
import type { ReportedSessionMode, SessionMode } from "../types/message";

export interface SessionModeInfo {
	label: string;
	description: string;
	icon: typeof Shield;
	/**
	 * The glyph's colour. A mode without one is the calm default, and the
	 * header's second line draws no glyph for it.
	 */
	iconClassName?: string;
}

// Each mode means the same on every agent, so none of this depends on which CLI
// runs the session. The order is the order offered: ever more permissive.
const SESSION_MODE_INFO: Record<SessionMode, SessionModeInfo> = {
	default: {
		label: "Default",
		// Broken by hand: ChoiceRow descriptions never wrap, and one line of this
		// overflows a narrow phone.
		description: "Follows the agent's own\npermission settings",
		icon: Shield,
	},
	yolo: {
		label: "YOLO",
		description: "Skips all permissions",
		icon: Zap,
		iconClassName: "text-th-warning",
	},
	// Warning, not a calm colour: it is YOLO and more, never a safety feature
	// (docs/unattended-mode-ui.md).
	unattended: {
		label: "Unattended",
		description: "YOLO, and a reviewer agent\nanswers what YOLO still asks",
		icon: Bot,
		iconClassName: "text-th-warning",
	},
};

export const SESSION_MODES = Object.keys(SESSION_MODE_INFO) as SessionMode[];

export function isKnownSessionMode(
	mode: ReportedSessionMode,
): mode is SessionMode {
	return Object.hasOwn(SESSION_MODE_INFO, mode);
}

/**
 * A mode this build does not know keeps its own id rather than wearing
 * Default's name: a session with its gates down must never read as one that
 * keeps them.
 */
export function getSessionModeInfo(mode: ReportedSessionMode): SessionModeInfo {
	if (isKnownSessionMode(mode)) return SESSION_MODE_INFO[mode];
	return {
		label: mode,
		description: "A mode this version of Pockode doesn't know",
		icon: CircleHelp,
		iconClassName: "text-th-text-muted",
	};
}
