/**
 * The one-shot intent to answer, handed from whatever navigated to a chat to
 * the chat itself.
 *
 * The rule the answer sheet opens by is *intent, not destination*: `Open Chat`
 * means "show me this conversation" and never opens the sheet, while the work
 * detail's `Answer` means "let me answer" and does. Only the second one sets
 * this.
 *
 * It is deliberately **not** a URL. A route that opens the sheet re-opens it on
 * every reload and every share of that link, which is auto-open wearing a route
 * (docs/answering-ui.md §4).
 *
 * A module-level value rather than a store because nothing renders from it: it
 * is read exactly once, by the panel that has just mounted, and consumed in the
 * reading. It carries the session id so that a navigation that never arrives —
 * the work's session was deleted under it — cannot open a sheet over some
 * other conversation later on.
 */
interface AnswerIntent {
	sessionId: string;
	/** The question to scroll to. Absent anchors on the oldest. */
	requestId?: string;
}

let pending: AnswerIntent | null = null;

export function requestAnswerSheet(intent: AnswerIntent): void {
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
