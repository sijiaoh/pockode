import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type {
	SessionDetailChangedNotification,
	SessionDetailSubscribeResult,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Another session's title, read from its own detail rather than from the list,
 * which often has no row for it (a work session with task sessions hidden, or
 * one on a page not loaded yet). Null until it arrives, and when it cannot be
 * read — the caller says what it may call such a session.
 *
 * Followed live for a session of the bound worktree, so a rename shows through;
 * read once for one of another worktree (`session_view.get`), which pushes
 * nothing. A detail subscription marks nothing read, so following one costs
 * the session nothing.
 *
 * @param worktree Null for the bound worktree.
 */
export function useSessionTitleOf(
	sessionId: string | undefined,
	worktree: string | null,
): string | null {
	const live = useLiveSessionTitle(
		sessionId ?? "",
		!!sessionId && worktree === null,
	);
	const sessionViewGet = useWSStore((s) => s.actions.sessionViewGet);
	const viewed = useQuery({
		queryKey: ["session-view-detail", worktree, sessionId],
		queryFn: () => sessionViewGet(worktree ?? "", sessionId ?? ""),
		enabled: !!sessionId && worktree !== null,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	if (!sessionId) return null;
	if (worktree === null) return live;
	return viewed.data?.title ?? null;
}

function useLiveSessionTitle(sessionId: string, enabled: boolean) {
	const sessionDetailSubscribe = useWSStore(
		(s) => s.actions.sessionDetailSubscribe,
	);
	const sessionDetailUnsubscribe = useWSStore(
		(s) => s.actions.sessionDetailUnsubscribe,
	);
	// Keyed by the session it describes, so a switch never shows the previous
	// session's title for the round trip before the new one lands.
	const [held, setHeld] = useState<{ id: string; title: string } | null>(null);

	const subscribe = useCallback(
		(onNotification: (params: SessionDetailChangedNotification) => void) =>
			sessionDetailSubscribe(sessionId, onNotification),
		[sessionDetailSubscribe, sessionId],
	);
	const handleNotification = useCallback(
		(params: SessionDetailChangedNotification) => {
			setHeld(
				params.deleted ? null : { id: sessionId, title: params.session.title },
			);
		},
		[sessionId],
	);
	const handleSubscribed = useCallback(
		(initial: SessionDetailSubscribeResult) => {
			setHeld({ id: sessionId, title: initial.session.title });
		},
		[sessionId],
	);
	const handleReset = useCallback(() => setHeld(null), []);

	useSubscription<
		SessionDetailChangedNotification,
		SessionDetailSubscribeResult
	>(subscribe, sessionDetailUnsubscribe, handleNotification, {
		enabled,
		onSubscribed: handleSubscribed,
		onReset: handleReset,
		// A session that is not there has no title; the caller's fallback says so.
		onError: handleReset,
	});

	return held?.id === sessionId ? held.title : null;
}
