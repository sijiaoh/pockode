import type { HistorySeq, Message, UserMessage } from "../types/message";
import { formatPockodeCommand } from "./pockodeCommand";

/**
 * The failed turn a sign-in was opened from. Its bubble's id alone does not
 * survive a history replay — a reconnect rebuilds every bubble under a new id,
 * and the user is off in a browser signing in, which is exactly when the socket
 * drops. The message that opened the turn names it too, by its place in
 * history: unlike the bubble's own place, that does not move when a turn still
 * retrying at the press goes on to fail.
 */
export interface SendAgainTarget {
	messageId: string;
	askedSeq?: HistorySeq;
}

/** The target for the turn `messageId` in `messages`. */
export function sendAgainTarget(
	messages: readonly Message[],
	messageId: string,
): SendAgainTarget {
	const index = messages.findIndex((message) => message.id === messageId);
	const asked = messages
		.slice(0, Math.max(index, 0))
		.findLast((message) => message.role === "user");
	return { messageId, askedSeq: asked?.anchorSeq };
}

/**
 * The message *Send again* puts back into the composer after signing in from
 * `target`, or undefined when it offers nothing
 * (docs/cli-login-ui.md#after-signing-in-send-again).
 *
 * Only once the turn has failed on its credentials: a notice on a turn still
 * retrying can be signed in from, but that turn may yet succeed, and its message
 * sent again would then run twice. Only the session's latest turn, whose message
 * a person typed: an older turn's message is one the conversation has moved
 * past, and a turn Pockode or another agent started holds words the user never
 * wrote. An answer to posted questions is left out too — its text is the answers
 * flattened for the agent, which is not what the user entered.
 */
export function sendAgainMessage(
	messages: readonly Message[],
	target: SendAgainTarget,
): UserMessage | undefined {
	const last = messages.at(-1);
	if (
		!last ||
		last.role !== "assistant" ||
		last.status !== "error" ||
		!last.authFailure
	) {
		return undefined;
	}
	const asked = messages.findLast((message) => message.role === "user");
	if (!asked || asked.role !== "user") return undefined;
	const isTarget =
		last.id === target.messageId ||
		(target.askedSeq !== undefined && asked.anchorSeq === target.askedSeq);
	if (!isTarget) return undefined;
	if ((asked.source && asked.source !== "user") || asked.answering) {
		return undefined;
	}
	return asked;
}

/** What `sendAgainMessage` gives back as text. A command comes back as typed. */
export function sendAgainText(
	messages: readonly Message[],
	target: SendAgainTarget,
): string | undefined {
	const asked = sendAgainMessage(messages, target);
	if (!asked) return undefined;
	return asked.command ? formatPockodeCommand(asked.command) : asked.content;
}
