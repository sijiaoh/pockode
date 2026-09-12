import type {
	AssistantMessage,
	HistorySeq,
	Message,
	UserMessage,
} from "../types/message";
import { hasMessageActions } from "./messageActions";

/**
 * Whether a message can be the point a fork cuts at.
 *
 * Narrower than `hasMessageActions`: on top of being a settled conversation
 * turn, a message the server never gave a seq for cannot be named at all (see
 * `Message.anchorSeq`), and one holding a request nobody has answered is not a
 * settled transcript to cut at. Neither is the message's permanent state, which
 * is why they disable the fork action rather than remove it — but neither is on
 * a clock: the request waits as long as the user leaves it unanswered, and a
 * missing seq lasts until a reload. A missing seq is rare now that the server
 * tells a sender where its own message landed (`MessageResult`), leaving only a
 * server too old to answer with one and a record that could not be persisted —
 * and that last one no reload can name, because the message does not survive it
 * either.
 *
 * A turn in flight does not make the messages above it unforkable: everything a
 * fork anchored there keeps is already final, and everything still arriving
 * falls after the anchor and is dropped anyway.
 *
 * Asked of the message alone, so it cannot answer the one question that needs
 * the transcript: a user message that opens the session has nothing behind it
 * to keep. `resolveForkAnchor` is where that is decided.
 */
export function isForkableMessage(
	message: Message,
): message is UserMessage | AssistantMessage {
	if (!hasMessageActions(message)) return false;
	if (message.anchorSeq === undefined) return false;
	// Only an assistant turn can be holding one: the requests are the agent's.
	if (message.role === "user") return true;

	return !message.parts.some(
		(part) =>
			(part.type === "permission_request" ||
				part.type === "ask_user_question") &&
			part.status === "pending",
	);
}

/**
 * True for an assistant bubble the agent has not written into. Nothing the user
 * can see, so not something a fork can claim to leave behind.
 *
 * Deliberately wider than `messageReducer`'s own notion of a placeholder, which
 * only counts a settled one: a bubble the agent is still filling is invisible
 * to the user right now, which is what this count is about.
 */
function isBlankBubble(message: Message): boolean {
	return message.role === "assistant" && message.parts.length === 0;
}

export interface ForkAnchor {
	message: UserMessage | AssistantMessage;
	anchorSeq: HistorySeq;
	/**
	 * Messages that stay in the source session — everything after the anchor,
	 * plus the anchor itself when the user sent it, since a fork returns to
	 * before they said it.
	 */
	droppedCount: number;
	/**
	 * The anchor's own words, present exactly when the fork drops them. Meant to
	 * be restored into the new session's input box: the user wrote that prompt
	 * and the fork returns to before they sent it, so it belongs where an unsent
	 * prompt lives, not in the transcript. Absent on an assistant anchor, which
	 * the fork keeps.
	 */
	droppedText?: string;
}

/**
 * Locates the message a fork would cut at, together with what forking there
 * costs. The count is exact however far back the user has scrolled: history
 * pages in from the bottom, so every message after the anchor is loaded by
 * definition, and the sentence in the fork sheet claims to describe the
 * session.
 *
 * Null when the message is gone, cannot be forked at, or is the session's own
 * opening message and was sent by the user — the transcript can move on while
 * the sheet is opening, and a fork returning to before the opening message
 * would keep no conversation at all. The server refuses that one; this only
 * keeps the user out of a sheet that could not have worked.
 *
 * `hasMoreHistory` is what tells the top of the loaded transcript apart from
 * the start of the session: with pages still unread above it, the first loaded
 * message has conversation behind it and forking there is fine.
 */
export function resolveForkAnchor(
	messages: Message[],
	messageId: string,
	hasMoreHistory: boolean,
): ForkAnchor | null {
	const index = messages.findIndex((m) => m.id === messageId);
	if (index === -1) return null;

	const message = messages[index];
	if (!isForkableMessage(message)) return null;
	// Narrowed but not proven: `isForkableMessage` checks this too, and the type
	// system cannot carry that across the call.
	const anchorSeq = message.anchorSeq;
	if (anchorSeq === undefined) return null;

	// The seq goes back to the server untouched: which side of the anchor the
	// cut falls on is the server's rule, and a client doing arithmetic on a seq
	// would be inventing an address it was never given.
	const dropsAnchor = message.role === "user";
	if (dropsAnchor && index === 0 && !hasMoreHistory) return null;

	const droppedCount =
		messages.slice(index + 1).filter((m) => !isBlankBubble(m)).length +
		(dropsAnchor ? 1 : 0);

	return {
		message,
		anchorSeq,
		droppedCount,
		// The same question `dropsAnchor` asked, asked again: a boolean does not
		// carry the narrowing that reaching `content` needs.
		droppedText: message.role === "user" ? message.content : undefined,
	};
}
