import type { SessionCreateParams, SessionListItem } from "../types/message";
import { prependSession, useSessionStore } from "./sessionStore";
import { useWorktreeStore } from "./worktreeStore";
import { wsActions } from "./wsStore";

interface CreateRequest {
	worktree: string;
	session: Promise<SessionListItem>;
}

// One per kind, so a create of the other kind neither joins one in flight nor
// pushes it out of reach of the callers that should join it.
const inFlight: Record<"chat" | "canvas", CreateRequest | null> = {
	chat: null,
	canvas: null,
};

/**
 * Creates a session in the connection's worktree. Every entry point to session
 * creation goes through here, so a caller arriving while a create is in flight
 * joins that one instead of starting another: a double tap on "+", an effect
 * that re-runs mid-request, or a prefill handoff pressed beside them would
 * otherwise each leave a stray session behind.
 */
export function createSession(
	params: SessionCreateParams = {},
): Promise<SessionListItem> {
	// Joined only from the worktree it was asked in: a create sent before a
	// worktree switch lands in the worktree left behind, and is no answer for a
	// caller asking in the new one. Nor across kinds: a chat session is no
	// answer for a caller asking for a canvas, which cannot become one later.
	const worktree = useWorktreeStore.getState().current;
	const canvas = params.canvas === true;
	const kind = canvas ? "canvas" : "chat";
	const joined = inFlight[kind];
	if (joined?.worktree === worktree) return joined.session;
	const request: CreateRequest = {
		worktree,
		// Absent rather than false for a chat session, so it is asked exactly as
		// it was before the method took any params.
		session: wsActions
			.createSession(canvas ? { canvas } : {})
			.then((session) => {
				// Added before the subscription reports it, so a route pushed to the
				// new id does not find it missing and redirect away. The
				// notification deduplicates. Not once the connection has switched:
				// the list is the next worktree's then, and the shell would redirect
				// its route to its first row — this session, which it does not have.
				if (useWorktreeStore.getState().current === worktree) {
					useSessionStore
						.getState()
						.updateSessions((old) => prependSession(old, session));
				}
				return session;
			}),
	};
	inFlight[kind] = request;
	request.session
		.finally(() => {
			if (inFlight[kind] === request) inFlight[kind] = null;
		})
		.catch(() => {
			// The caller handles the rejection; this branch only tidies up.
		});
	return request.session;
}
