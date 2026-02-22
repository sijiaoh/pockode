import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type { Comment, WorkCommentChangedNotification } from "../types/work";
import { useSubscription } from "./useSubscription";

export function useWorkCommentSubscription(workId: string) {
	const workCommentSubscribe = useWSStore(
		(s) => s.actions.workCommentSubscribe,
	);
	const workCommentUnsubscribe = useWSStore(
		(s) => s.actions.workCommentUnsubscribe,
	);

	const [comments, setComments] = useState<Comment[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Reset state when workId changes so stale comments are never shown
	const prevWorkIdRef = useRef(workId);
	useEffect(() => {
		if (prevWorkIdRef.current !== workId) {
			prevWorkIdRef.current = workId;
			setComments([]);
			setLoading(true);
			setError(null);
		}
	}, [workId]);

	const subscribe = useCallback(
		(onNotification: (params: WorkCommentChangedNotification) => void) =>
			workCommentSubscribe(workId, onNotification),
		[workCommentSubscribe, workId],
	);

	const handleNotification = useCallback(
		(params: WorkCommentChangedNotification) => {
			if (params.operation === "sync") {
				setComments(params.comments);
				return;
			}
			setComments((old) => {
				if (old.some((c) => c.id === params.comment.id)) {
					return old.map((c) =>
						c.id === params.comment.id ? params.comment : c,
					);
				}
				return [...old, params.comment];
			});
		},
		[],
	);

	const handleSubscribed = useCallback((initial: Comment[]) => {
		setComments(initial);
		setLoading(false);
		setError(null);
	}, []);

	const handleReset = useCallback(() => {
		setComments([]);
		setLoading(true);
		setError(null);
	}, []);

	const handleError = useCallback((err: unknown) => {
		setError(err instanceof Error ? err.message : "Failed to load comments");
		setLoading(false);
	}, []);

	useSubscription<WorkCommentChangedNotification, Comment[]>(
		subscribe,
		workCommentUnsubscribe,
		handleNotification,
		{
			enabled: true,
			resubscribeOnWorktreeChange: false,
			onSubscribed: handleSubscribed,
			onReset: handleReset,
			onError: handleError,
		},
	);

	return useMemo(
		() => ({ comments, loading, error }),
		[comments, loading, error],
	);
}
