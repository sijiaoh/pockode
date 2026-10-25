import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	appendOlderPage,
	type LoadedRuns,
	mergeNewestPage,
	NO_RUNS,
} from "../lib/scheduleRuns";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import type {
	Schedule,
	ScheduleDetailChangedNotification,
	ScheduleDetailSubscribeResult,
} from "../types/schedule";
import { useSubscription } from "./useSubscription";

/**
 * One schedule, live, and the runs its page has loaded: the newest page with
 * every notification, merged by id with the older pages `loadMore` has read
 * (docs/schedule-ui.md §4.2).
 */
export function useScheduleDetailSubscription(scheduleId: string) {
	const scheduleDetailSubscribe = useWSStore(
		(s) => s.actions.scheduleDetailSubscribe,
	);
	const scheduleDetailUnsubscribe = useWSStore(
		(s) => s.actions.scheduleDetailUnsubscribe,
	);
	const scheduleDetailRuns = useWSStore((s) => s.actions.scheduleDetailRuns);

	const [schedule, setSchedule] = useState<Schedule | null>(null);
	const [runs, setRuns] = useState<LoadedRuns>(NO_RUNS);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

	// The older pages belong to the subscription they were read against, which
	// `useSubscription` does not hand back, so its id is caught on the way
	// through — the session list's arrangement. `attemptRef` keeps the id of the
	// last subscribe asked for, whichever answers last.
	const subscriptionIdRef = useRef<string | null>(null);
	const attemptRef = useRef(0);
	// Bumped whenever the loaded runs are thrown away, so a page still in
	// flight from before cannot land on the runs that replaced them.
	const generationRef = useRef(0);
	const isLoadingMoreRef = useRef(false);

	const clear = useCallback(() => {
		generationRef.current++;
		isLoadingMoreRef.current = false;
		setSchedule(null);
		setRuns(NO_RUNS);
		setLoading(true);
		setError(null);
		setIsLoadingMore(false);
		setLoadMoreError(null);
	}, []);

	// Reset state when scheduleId changes so stale data is never shown
	const prevScheduleIdRef = useRef(scheduleId);
	useEffect(() => {
		if (prevScheduleIdRef.current !== scheduleId) {
			prevScheduleIdRef.current = scheduleId;
			clear();
		}
	}, [scheduleId, clear]);

	const subscribe = useCallback(
		async (
			onNotification: (params: ScheduleDetailChangedNotification) => void,
		) => {
			const attempt = ++attemptRef.current;
			const result = await scheduleDetailSubscribe(scheduleId, onNotification);
			if (attempt === attemptRef.current) subscriptionIdRef.current = result.id;
			return result;
		},
		[scheduleDetailSubscribe, scheduleId],
	);

	const apply = useCallback((detail: ScheduleDetailSubscribeResult) => {
		setSchedule(detail.schedule);
		setRuns((loaded) => mergeNewestPage(loaded, detail.runs));
	}, []);

	const handleSubscribed = useCallback(
		(initial: ScheduleDetailSubscribeResult) => {
			// A fresh subscription starts the run list over: older pages read
			// against the one it replaces may be out of date in ways no
			// notification will correct.
			generationRef.current++;
			isLoadingMoreRef.current = false;
			setIsLoadingMore(false);
			setLoadMoreError(null);
			setRuns(mergeNewestPage(NO_RUNS, initial.runs));
			setSchedule(initial.schedule);
			setLoading(false);
			setError(null);
		},
		[],
	);

	const handleReset = useCallback(() => {
		subscriptionIdRef.current = null;
		clear();
	}, [clear]);

	const handleError = useCallback((err: unknown) => {
		setError(err instanceof Error ? err.message : "Failed to load schedule");
		setLoading(false);
	}, []);

	const { refresh } = useSubscription<
		ScheduleDetailChangedNotification,
		ScheduleDetailSubscribeResult
	>(subscribe, scheduleDetailUnsubscribe, apply, {
		enabled: true,
		resubscribeOnWorktreeChange: false,
		onSubscribed: handleSubscribed,
		onReset: handleReset,
		onError: handleError,
	});

	/** Reads the page of runs after the oldest one loaded. One call at a time. */
	const loadMore = useCallback(async () => {
		const subscriptionId = subscriptionIdRef.current;
		const cursor = runs.nextCursor;
		if (!cursor || !subscriptionId || isLoadingMoreRef.current) return;

		const generation = generationRef.current;
		isLoadingMoreRef.current = true;
		setIsLoadingMore(true);
		setLoadMoreError(null);
		try {
			const page = await scheduleDetailRuns(subscriptionId, cursor);
			if (generation !== generationRef.current) return;
			setRuns((loaded) => appendOlderPage(loaded, page));
		} catch (err) {
			if (generation !== generationRef.current) return;
			// The subscription the page belongs to is gone, or the cursor is not
			// one this server handed out: asking again cannot succeed, so the
			// answer is a fresh subscription (docs/projects/api.md#schedule-runs).
			if (isInvalidParamsRejection(err)) {
				refresh();
				return;
			}
			const reason =
				err instanceof Error && err.message ? err.message : "Unknown error";
			setLoadMoreError(`Failed to load earlier runs: ${reason}`);
		} finally {
			if (generation === generationRef.current) {
				isLoadingMoreRef.current = false;
				setIsLoadingMore(false);
			}
		}
	}, [runs.nextCursor, scheduleDetailRuns, refresh]);

	return useMemo(
		() => ({
			schedule,
			runs: runs.items,
			hasMoreRuns: runs.nextCursor !== null,
			loadMore,
			isLoadingMore,
			loadMoreError,
			loading,
			error,
		}),
		[schedule, runs, loadMore, isLoadingMore, loadMoreError, loading, error],
	);
}
