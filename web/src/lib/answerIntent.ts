/**
 * The one-shot intent to answer *this* question, handed from whatever navigated
 * to a chat to the chat itself.
 *
 * It no longer decides whether the panel opens — the panel opens by itself
 * wherever a question is waiting (docs/answering-ui.md §4). What is left is the
 * part arriving with a `request_id` still carries and arriving without one
 * cannot: **which question to scroll to, and that a person asked for it**, the
 * second being what lets the panel take focus. `Open Chat` leads to the same
 * place and names no question, so it sets nothing and the panel comes up on the
 * oldest one with the caret left alone.
 *
 * It is deliberately **not** a URL. A route carrying it would re-fire on every
 * reload and every share of that link, pointing at a question that may long
 * since have been answered.
 *
 * A module-level value rather than a store because nothing renders from it: it
 * is read exactly once, by the panel that has just mounted, and consumed in the
 * reading. It carries the session id so that a navigation that never arrives —
 * the work's session was deleted under it — cannot scroll some other
 * conversation to a question later on.
 */
interface AnswerIntent {
	sessionId: string;
	/** The question to scroll to. Absent anchors on the oldest. */
	requestId?: string;
}

let pending: AnswerIntent | null = null;

export function requestAnswerPanel(intent: AnswerIntent): void {
	pending = intent;
}

/** Reads the intent for this session and clears it. One shot, by construction. */
export function takeAnswerIntent(sessionId: string): AnswerIntent | null {
	if (!pending || pending.sessionId !== sessionId) return null;
	const intent = pending;
	pending = null;
	return intent;
}

/** Drops an intent that was never consumed. For tests, and for a failed navigation. */
export function clearAnswerIntent(): void {
	pending = null;
}
