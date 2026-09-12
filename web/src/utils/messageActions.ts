import type { Message } from "../types/message";

/**
 * Whether a message gets the thin action row under its bubble.
 *
 * Asked separately from "can this message be forked": the row is shared by
 * every per-message action, so a reason fork in particular does not apply —
 * a missing seq, an unanswered request — must not take the row, and with it
 * every other action, away.
 *
 * A system-origin message is Pockode's own annotation rather than a
 * conversation turn, and a message still being written is not yet a turn
 * either. Neither is something the user said or the agent answered, so there is
 * no action to offer on one.
 */
export function hasMessageActions(message: Message): boolean {
	if (message.status === "sending" || message.status === "streaming") {
		return false;
	}
	if (message.role === "user") return message.source !== "system";
	return true;
}
