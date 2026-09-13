import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type {
	Comment,
	Work,
	WorkDetailChangedNotification,
	WorkDetailSubscribeResult,
	WorkUsage,
} from "../types/work";
import { useSubscription } from "./useSubscription";

export function useWorkDetailSubscription(workId: string) {
	const workDetailSubscribe = useWSStore((s) => s.actions.workDetailSubscribe);
	const workDetailUnsubscribe = useWSStore(
		(s) => s.actions.workDetailUnsubscribe,
	);

	const [work, setWork] = useState<Work | null>(null);
	const [comments, setComments] = useState<Comment[]>([]);
	// Null only before the first snapshot: the server always sends a usage, so a
	// work item that spent nothing carries an empty aggregate rather than none.
	const [usage, setUsage] = useState<WorkUsage | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Reset state when workId changes so stale data is never shown
	const prevWorkIdRef = useRef(workId);
	useEffect(() => {
		if (prevWorkIdRef.current !== workId) {
			prevWorkIdRef.current = workId;
			setWork(null);
			setComments([]);
			setUsage(null);
			setLoading(true);
			setError(null);
		}
	}, [workId]);

	const subscribe = useCallback(
		(onNotification: (params: WorkDetailChangedNotification) => void) =>
			workDetailSubscribe(workId, onNotification),
		[workDetailSubscribe, workId],
	);

	const handleNotification = useCallback(
		(params: WorkDetailChangedNotification) => {
			setWork(params.work);
			setComments(params.comments);
			setUsage(params.usage);
		},
		[],
	);

	const handleSubscribed = useCallback((initial: WorkDetailSubscribeResult) => {
		setWork(initial.work);
		setComments(initial.comments);
		setUsage(initial.usage);
		setLoading(false);
		setError(null);
	}, []);

	const handleReset = useCallback(() => {
		setWork(null);
		setComments([]);
		setUsage(null);
		setLoading(true);
		setError(null);
	}, []);

	const handleError = useCallback((err: unknown) => {
		setError(err instanceof Error ? err.message : "Failed to load work detail");
		setLoading(false);
	}, []);

	useSubscription<WorkDetailChangedNotification, WorkDetailSubscribeResult>(
		subscribe,
		workDetailUnsubscribe,
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
		() => ({ work, comments, usage, loading, error }),
		[work, comments, usage, loading, error],
	);
}
