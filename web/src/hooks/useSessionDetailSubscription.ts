import { useCallback } from "react";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { useWSStore } from "../lib/wsStore";
import type {
	SessionDetailChangedNotification,
	SessionDetailSubscribeResult,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Follows one session's metadata into `sessionDetailStore`.
 *
 * @param enabled Subscribe only once `sessionId` is known to belong to the
 * worktree the connection is bound to — the server has no such session before
 * that, and would refuse the subscription.
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
	const clear = useSessionDetailStore((s) => s.clear);

	const subscribe = useCallback(
		(onNotification: (params: SessionDetailChangedNotification) => void) =>
			sessionDetailSubscribe(sessionId, onNotification),
		[sessionDetailSubscribe, sessionId],
	);

	const handleNotification = useCallback(
		(params: SessionDetailChangedNotification) => {
			// A deleted session has no metadata to show. Navigating away from it is
			// not this hook's call: the session list drives that, and it is the one
			// that knows where to go instead.
			setDetail(sessionId, params.deleted ? null : params.session);
		},
		[setDetail, sessionId],
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
		// A failed subscribe clears the detail, and no error is surfaced: the way
		// this one fails is "session not found", which happens when the session was
		// deleted between the list naming it and this asking about it. The
		// controls going dead is the whole of the story, and the list is already
		// navigating away from a session that is not there.
		onReset: clear,
	});
}
