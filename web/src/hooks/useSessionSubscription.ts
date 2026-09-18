import { useCallback, useRef } from "react";
import { prependSession, useSessionStore } from "../lib/sessionStore";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import type {
	SessionListChangedNotification,
	SessionListSubscribeResult,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Manages WebSocket subscription to the session list, and the paging on top of
 * it.
 *
 * The list arrives one page at a time and grows downwards, which is
 * `MessageList`'s pattern inverted — and inverting it deletes its hardest part:
 * rows are appended below the fold, so no page that lands here needs a scroll
 * measurement (docs/list-paging-ui.md §3.1).
 *
 * @param excludeWorkSessions Whether to ask the server for the list without the
 * sessions that belong to work items. The filter lives on the subscription, so
 * flipping it resubscribes; the list already on screen stays there until the new
 * snapshot replaces it, which is what keeps the sidebar from blanking.
 */
export function useSessionSubscription(
	enabled: boolean,
	excludeWorkSessions: boolean,
) {
	const sessionListSubscribe = useWSStore(
		(s) => s.actions.sessionListSubscribe,
	);
	const sessionListUnsubscribe = useWSStore(
		(s) => s.actions.sessionListUnsubscribe,
	);
	const sessionListPage = useWSStore((s) => s.actions.sessionListPage);

	const setSessions = useSessionStore((s) => s.setSessions);
	const updateSessions = useSessionStore((s) => s.updateSessions);
	const setHasUnread = useSessionStore((s) => s.setHasUnread);
	const beginLoadMore = useSessionStore((s) => s.beginLoadMore);
	const appendSessions = useSessionStore((s) => s.appendSessions);
	const failLoadMore = useSessionStore((s) => s.failLoadMore);
	const reset = useSessionStore((s) => s.reset);
	const beginReload = useSessionStore((s) => s.beginReload);

	// The subscription the pages belong to. `useSubscription` owns the lifecycle
	// and does not hand the id back, so it is caught on the way through. An id
	// the server has already dropped is refused as invalid params, which
	// `loadMore` below recovers from rather than reporting.
	const subscriptionIdRef = useRef<string | null>(null);
	// Which subscribe call is the current one. Two can be in flight — a refresh
	// racing a filter change — and they can resolve in either order, so the id
	// kept is the one the last call asked for rather than the one that answered
	// last. `useSubscription` makes the same judgement about the subscription
	// itself; this is the same judgement about its id.
	const attemptRef = useRef(0);

	const subscribe = useCallback(
		async (
			onNotification: (params: SessionListChangedNotification) => void,
		) => {
			const attempt = ++attemptRef.current;
			const result = await sessionListSubscribe(
				onNotification,
				excludeWorkSessions,
			);
			if (attempt === attemptRef.current) subscriptionIdRef.current = result.id;
			return result;
		},
		[sessionListSubscribe, excludeWorkSessions],
	);

	const applySnapshot = useCallback(
		(initial: SessionListSubscribeResult) => {
			setSessions({
				sessions: initial.sessions,
				nextCursor: initial.has_more ? (initial.next_cursor ?? null) : null,
				hasUnread: initial.has_unread,
			});
		},
		[setSessions],
	);

	const handleNotification = useCallback(
		(params: SessionListChangedNotification) => {
			if (params.operation === "sync") {
				// A resync carries back as much of the list as this client had, so it
				// replaces the list rather than extending it (docs/list-paging-ui.md
				// §3.4).
				setSessions(
					{
						sessions: params.sessions,
						nextCursor: params.has_more ? (params.next_cursor ?? null) : null,
						hasUnread: params.has_unread ?? false,
					},
					true,
				);
				return;
			}
			if (params.has_unread !== undefined) setHasUnread(params.has_unread);
			updateSessions((old) => {
				switch (params.operation) {
					case "create":
						// At the top, where it genuinely belongs. Nothing scrolls: the
						// browser's own scroll anchoring absorbs the shift, which is why
						// this list must not copy the transcript's `overflow-anchor: none`
						// (docs/list-paging-ui.md §3.2).
						return prependSession(old, params.session);
					case "update":
						// In place, and only if it is loaded. A row never moves on an
						// event; recency is recomputed on a load.
						return old.map((s) =>
							s.id === params.session.id ? params.session : s,
						);
					case "delete":
						return old.filter((s) => s.id !== params.sessionId);
				}
			});
		},
		[setSessions, setHasUnread, updateSessions],
	);

	const handleReset = useCallback(() => {
		subscriptionIdRef.current = null;
		reset();
	}, [reset]);

	const { refresh } = useSubscription<
		SessionListChangedNotification,
		SessionListSubscribeResult
	>(subscribe, sessionListUnsubscribe, handleNotification, {
		enabled,
		onSubscribed: applySnapshot,
		onReset: handleReset,
		// Keep the previous worktree's sessions visible during a switch; the new
		// list swaps in via onSubscribed. Avoids blanking the whole app shell.
		onWorktreeSwitch: beginReload,
	});

	/**
	 * Fetches the rows after the last one held. One page per call, and one call
	 * at a time: the sentinel re-arms on the page that lands.
	 */
	const loadMore = useCallback(async () => {
		const { nextCursor, isLoadingMore, generation } =
			useSessionStore.getState();
		const subscriptionId = subscriptionIdRef.current;
		if (!nextCursor || isLoadingMore || !subscriptionId) return;

		beginLoadMore();
		try {
			const page = await sessionListPage(subscriptionId, nextCursor);
			appendSessions(
				generation,
				page.sessions,
				page.has_more ? (page.next_cursor ?? null) : null,
			);
		} catch (error) {
			// Invalid params is the one failure that Retry cannot fix: the
			// subscription this page belongs to is gone, or the cursor is not one
			// this server handed out. Both mean the list being paged no longer
			// exists, so the answer is a fresh one — a first page, at the cost of
			// the reader's depth, which is the same cost a reconnect already pays
			// (docs/list-paging-ui.md §3.2). A button offering to ask again for
			// something that cannot be asked for is the worse of the two.
			if (isInvalidParamsRejection(error)) {
				refresh();
				return;
			}
			// Silence here would read as "that is the whole list", which is the one
			// thing the user must not conclude from a failure.
			const reason =
				error instanceof Error && error.message
					? error.message
					: "Unknown error";
			failLoadMore(
				generation,
				`Failed to load earlier conversations: ${reason}`,
			);
		}
	}, [sessionListPage, beginLoadMore, appendSessions, failLoadMore, refresh]);

	return { refresh, loadMore };
}
