import type { Message } from "../types/message";

/**
 * Whether a person sitting at a keyboard produced this message.
 *
 * A `role: "user"` message is only sometimes one. Pockode's own automation
 * (kickoff, restart, a child's report) arrives as one, and so does an answer
 * another agent gave through `question_answer` — both are input to the session,
 * neither is anybody typing. Only a typed message carries no `source` at all.
 *
 * It is the question behind "did the reader just write at the bottom, so follow
 * the tail" and behind the delivery receipt, both of which are about the person
 * in front of the screen. It is deliberately *not* the question behind the fork
 * menu (`hasMessageActions`): a fork cuts around anything that entered the
 * conversation, whoever supplied it, which is the same line the server draws
 * (chat.isUserMessageRecord).
 */
export function isTypedByUser(message: Message): boolean {
	return message.role === "user" && message.source === undefined;
}
