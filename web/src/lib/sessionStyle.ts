import { AppWindow, MessageSquare } from "lucide-react";

/**
 * The two kinds of session the user can start — the value `html_first` stores,
 * named for the switch. The words live here alone: the switch, the session row
 * and the session panel all read them (docs/html-first-session-ui.md §2.2).
 */
export type SessionStyle = "chat" | "html_first";

export const SESSION_STYLES: readonly SessionStyle[] = ["chat", "html_first"];

export interface SessionStyleInfo {
	label: string;
	icon: typeof AppWindow;
	/** What the user will see, not how the agent is prompted. */
	hint: string;
}

// `AppWindow` is the page card's glyph (`HtmlRenderCard`): the switch, the row
// and the cards in the transcript all point at the same thing.
const SESSION_STYLE_INFO: Record<SessionStyle, SessionStyleInfo> = {
	chat: {
		label: "Chat",
		icon: MessageSquare,
		hint: "The agent answers in text, and draws a page when it helps.",
	},
	html_first: {
		label: "HTML first",
		icon: AppWindow,
		hint: "The agent answers with pages you can work in, and keeps its text short.",
	},
};

export function getSessionStyleInfo(style: SessionStyle): SessionStyleInfo {
	return SESSION_STYLE_INFO[style];
}

export function sessionStyleOf(htmlFirst: boolean | undefined): SessionStyle {
	return htmlFirst ? "html_first" : "chat";
}
