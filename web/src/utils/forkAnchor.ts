import type {
	AssistantMessage,
	HistorySeq,
	Message,
	UserMessage,
} from "../types/message";

/**
 * Whether a message can be the point a fork cuts at.
 *
 * Work cards, step dividers and system-origin messages are Pockode's own
 * annotations rather than conversation turns, and a message still being written
 * — or holding a request nobody has answered — is not a settled transcript to
 * cut at. A message the server never gave a seq for cannot be named at all
 * (see `Message.anchorSeq`).
 *
 * A turn in flight does not make the messages above it unforkable: everything a
 * fork anchored there keeps is already final, and everything still arriving
 * falls after the anchor and is dropped anyway.
 */
export function isForkableMessage(
	message: Message,
): message is UserMessage | AssistantMessage {
	if (message.role !== "user" && message.role !== "assistant") return false;
	if (message.anchorSeq === undefined) return false;
	if (message.status === "sending" || message.status === "streaming") {
		return false;
	}
	if (message.role === "user") return message.source !== "system";

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
	/** Messages after the anchor, which stay in the source session. */
	droppedCount: number;
}

/**
 * Locates the message a fork would cut at, together with what forking there
 * costs. Counted over the whole transcript rather than the window `MessageList`
 * happens to have rendered, because the sentence in the fork sheet claims to
 * describe the session.
 *
 * Null when the message is gone or cannot be forked at — the transcript can
 * move on while the menu is open.
 */
export function resolveForkAnchor(
	messages: Message[],
	messageId: string,
): ForkAnchor | null {
	const index = messages.findIndex((m) => m.id === messageId);
	if (index === -1) return null;

	const message = messages[index];
	if (!isForkableMessage(message)) return null;
	// Narrowed but not proven: `isForkableMessage` checks this too, and the type
	// system cannot carry that across the call.
	const anchorSeq = message.anchorSeq;
	if (anchorSeq === undefined) return null;

	const droppedCount = messages
		.slice(index + 1)
		.filter((m) => !isBlankBubble(m)).length;

	return { message, anchorSeq, droppedCount };
}
