import type { Message } from "../types/message";

export interface PendingQuestion {
	/** Index into the `messages` array the question was found in. */
	messageIndex: number;
	requestId: string;
}

/**
 * Unanswered questions in message order. Drives the pending-question pill:
 * the set is derived from `messages` on every render rather than tracked in a
 * store, so it can never drift from what the message stream actually says.
 */
export function findPendingQuestions(messages: Message[]): PendingQuestion[] {
	const pending: PendingQuestion[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant") return;
		for (const part of message.parts) {
			if (part.type === "ask_user_question" && part.status === "pending") {
				pending.push({ messageIndex, requestId: part.request.requestId });
			}
		}
	});
	return pending;
}
