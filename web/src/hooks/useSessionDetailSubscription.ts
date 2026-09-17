import { useCallback } from "react";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import type {
	SessionDetailChangedNotification,
	SessionDetailSubscribeResult,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Follows one session's metadata into `sessionDetailStore`.
 *
 * It is also what decides whether the open session exists at all — the store's
 * `status`. That is why `enabled` is not gated on the session being resolved:
 * this subscription is how it gets resolved.
 *
 * @param enabled Subscribe only once the connection is bound to the worktree
 * the route names. Before that the server is answering for a different
 * worktree, where a refusal would say nothing about the session.
 */
export function useSessionDetailSubscription(
	sessionId: string,
	enabled = true,
) {
	const sessionDetailSubscribe = useWSStore(
		(s) => s.actions.sessionDetailSubscribe,
	);
	const sessionDetailUnsubscribe = useWSStore(
		(s) => s.actions.sessionDetailUnsubscribe,
	);

	const setDetail = useSessionDetailStore((s) => s.setDetail);
	const setMissing = useSessionDetailStore((s) => s.setMissing);
	const clear = useSessionDetailStore((s) => s.clear);

	const subscribe = useCallback(
		(onNotification: (params: SessionDetailChangedNotification) => void) =>
			sessionDetailSubscribe(sessionId, onNotification),
		[sessionDetailSubscribe, sessionId],
	);

	const handleNotification = useCallback(
		(params: SessionDetailChangedNotification) => {
			// A deleted session has no metadata to show, and recording that is how
			// the route learns to move on: the session list cannot tell a deleted
			// session from one its filter hides, so this is the one report of it
			// that means only one thing.
			setDetail(sessionId, params.deleted ? null : params.session);
		},
		[setDetail, sessionId],
	);

	// Reached when the subscribe fails, which is not by itself news about the
	// session. Only the server refusing this request is: for this subscription
	// that means "session not found" — deleted between the route naming it and
	// this asking about it, or a URL that named one which never existed.
	//
	// Anything else leaves the question open. A socket that dies with the request
	// still in flight rejects it just the same, and reading that as "gone" would
	// take the user off the conversation they are in every time the connection
	// blinks; a server that could not read the session is asking to be asked
	// again, not answering. Both clear what is held — the subscription is down
	// either way — without claiming there is nothing there.
	const handleError = useCallback(
		(err: unknown) => {
			console.error("Failed to subscribe to session detail:", err);
			if (isInvalidParamsRejection(err)) {
				setMissing(sessionId);
				return;
			}
			clear();
		},
		[setMissing, clear, sessionId],
	);

	const handleSubscribed = useCallback(
		(initial: SessionDetailSubscribeResult) => {
			setDetail(sessionId, initial.session);
		},
		[setDetail, sessionId],
	);

	useSubscription<
		SessionDetailChangedNotification,
		SessionDetailSubscribeResult
	>(subscribe, sessionDetailUnsubscribe, handleNotification, {
		enabled,
		// A session belongs to its worktree, so switching does end this
		// subscription server-side — but it ends the session with it, and `enabled`
		// has already gone false by then. Resubscribing on switch would only ask
		// the new worktree about a session id it has never heard of; the new
		// session subscribes on its own once the list resolves it.
		resubscribeOnWorktreeChange: false,
		onSubscribed: handleSubscribed,
		// Nothing is known any more, which is not the same as "it is not there":
		// this fires on disable, disconnect and worktree switch, none of which are
		// news about the session. Going back to `loading` is what keeps a dropped
		// connection from navigating the user off the session they were on.
		onReset: clear,
		onError: handleError,
	});
}
