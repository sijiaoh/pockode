import { MessageSquare, PanelsTopLeft } from "lucide-react";

/** What a session is: a transcript, or a page the agent draws (docs/canvas-ui.md §1). */
export type SessionKind = "chat" | "canvas";

export const SESSION_KINDS: readonly SessionKind[] = ["chat", "canvas"];

export interface SessionKindInfo {
	label: string;
	description: string;
	icon: typeof MessageSquare;
}

// The glyphs the header uses for the chat and the session list for a canvas
// row, so the choice looks like what it chooses (docs/new-session-ui.md §3.2).
const SESSION_KIND_INFO: Record<SessionKind, SessionKindInfo> = {
	chat: {
		label: "Chat",
		description: "You and the agent talk in a transcript.",
		icon: MessageSquare,
	},
	canvas: {
		label: "Canvas",
		description: "The agent draws a page and you work in it.",
		icon: PanelsTopLeft,
	},
};

export function getSessionKindInfo(kind: SessionKind): SessionKindInfo {
	return SESSION_KIND_INFO[kind];
}

export function sessionKindOf(canvas: boolean | undefined): SessionKind {
	return canvas ? "canvas" : "chat";
}
