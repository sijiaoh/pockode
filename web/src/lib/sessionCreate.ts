import type { SessionListItem } from "../types/message";
import { prependSession, useSessionStore } from "./sessionStore";
import { useWorktreeStore } from "./worktreeStore";
import { wsActions } from "./wsStore";

let inFlight: { worktree: string; session: Promise<SessionListItem> } | null =
	null;

/**
 * Creates a session in the connection's worktree. Every entry point to session
 * creation goes through here, so a caller arriving while a create is in flight
 * joins that one instead of starting another: a double tap on "+", an effect
 * that re-runs mid-request, or a prefill handoff pressed beside them would
 * otherwise each leave a stray session behind.
 */
export function createSession(): Promise<SessionListItem> {
	// Joined only from the worktree it was asked in: a create sent before a
	// worktree switch lands in the worktree left behind, and is no answer for a
	// caller asking in the new one.
	const worktree = useWorktreeStore.getState().current;
	if (inFlight?.worktree === worktree) return inFlight.session;
	const request = {
		worktree,
		session: wsActions.createSession().then((session) => {
			// Added before the subscription reports it, so a route pushed to the
			// new id does not find it missing and redirect away. The
			// notification deduplicates.
			useSessionStore
				.getState()
				.updateSessions((old) => prependSession(old, session));
			return session;
		}),
	};
	inFlight = request;
	request.session
		.finally(() => {
			if (inFlight === request) inFlight = null;
		})
		.catch(() => {
			// The caller handles the rejection; this branch only tidies up.
		});
	return request.session;
}
