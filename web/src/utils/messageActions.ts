import type { AssistantMessage, Message, UserMessage } from "../types/message";

/**
 * Whether a message gets the thin action row under its bubble.
 *
 * Asked separately from "can this message be forked": the row is shared by
 * every per-message action, so a reason fork in particular does not apply —
 * a missing seq, an unanswered request — must not take the row, and with it
 * every other action, away.
 *
 * Work cards, step dividers and system-origin messages are Pockode's own
 * annotations rather than conversation turns, and a message still being written
 * is not yet a turn either. Nothing about them is a message the user said or
 * the agent answered, so there is no action to offer on one.
 */
export function hasMessageActions(
	message: Message,
): message is UserMessage | AssistantMessage {
	if (message.role !== "user" && message.role !== "assistant") return false;
	if (message.status === "sending" || message.status === "streaming") {
		return false;
	}
	if (message.role === "user") return message.source !== "system";
	return true;
}
