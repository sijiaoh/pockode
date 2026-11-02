import { createContext, useContext } from "react";
import type { HtmlActionInput } from "../../lib/rpc";

/**
 * How a page drawn in the transcript sends to the session's agent
 * (docs/tool-call-ui.md § Sending to the agent). Given by `ChatPanel` around
 * the transcript and its full-screen viewer, so a card and its full-screen
 * view send through the same session.
 */
export interface PageSender {
	/** `useChatMessages(...).sendHtmlAction`. */
	send: (input: HtmlActionInput) => Promise<void>;
	/**
	 * The turn waits on a permission request, which owns the agent's next
	 * input: a send is refused at once rather than after a round trip.
	 */
	awaitingPermission: boolean;
}

export const PageSendContext = createContext<PageSender | null>(null);

export function usePageSender(): PageSender | null {
	return useContext(PageSendContext);
}
