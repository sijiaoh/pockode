import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Activity, normalizeActivity } from "../lib/activity";
import { useWSStore } from "../lib/wsStore";
import type {
	Comment,
	Work,
	WorkDetailChangedNotification,
	WorkDetailSubscribeResult,
	WorkListItem,
	WorkUsage,
} from "../types/work";
import { useSubscription } from "./useSubscription";

export function useWorkDetailSubscription(workId: string) {
	const workDetailSubscribe = useWSStore((s) => s.actions.workDetailSubscribe);
	const workDetailUnsubscribe = useWSStore(
		(s) => s.actions.workDetailUnsubscribe,
	);

	const [work, setWork] = useState<Work | null>(null);
	// Beside the work rather than on it, because it is not the record's: it is
	// derived from the turn of the work's session, which the stored item knows
	// nothing about (docs/lifecycle-ui.md §1.3). Normalised here because this
	// hook is the wire boundary for the detail, the way the store is for rows.
	const [activity, setActivity] = useState<Activity>("idle");
	const [comments, setComments] = useState<Comment[]>([]);
	// Null only before the first snapshot: the server always sends a usage, so a
	// work item that spent nothing carries an empty aggregate rather than none.
	const [usage, setUsage] = useState<WorkUsage | null>(null);
	// The two relations the page draws. They arrive with the detail rather than
	// being read out of the work list, which is the `Current` segment and holds
	// no closed work (docs/list-paging-ui.md §2.2).
	const [children, setChildren] = useState<WorkListItem[]>([]);
	const [parent, setParent] = useState<WorkListItem | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Reset state when workId changes so stale data is never shown
	const prevWorkIdRef = useRef(workId);
	useEffect(() => {
		if (prevWorkIdRef.current !== workId) {
			prevWorkIdRef.current = workId;
			setWork(null);
			setActivity("idle");
			setComments([]);
			setUsage(null);
			setChildren([]);
			setParent(null);
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
			setActivity(normalizeActivity(params.activity));
			setComments(params.comments);
			setUsage(params.usage);
			setChildren(params.children ?? []);
			setParent(params.parent ?? null);
		},
		[],
	);

	const handleSubscribed = useCallback((initial: WorkDetailSubscribeResult) => {
		setWork(initial.work);
		setActivity(normalizeActivity(initial.activity));
		setComments(initial.comments);
		setUsage(initial.usage);
		setChildren(initial.children ?? []);
		setParent(initial.parent ?? null);
		setLoading(false);
		setError(null);
	}, []);

	const handleReset = useCallback(() => {
		setWork(null);
		setActivity("idle");
		setComments([]);
		setUsage(null);
		setChildren([]);
		setParent(null);
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
		() => ({
			work,
			activity,
			comments,
			usage,
			children,
			parent,
			loading,
			error,
		}),
		[work, activity, comments, usage, children, parent, loading, error],
	);
}
