import { useCallback } from "react";
import { useScheduleStore } from "../lib/scheduleStore";
import { useWSStore } from "../lib/wsStore";
import type {
	ScheduleListChangedNotification,
	ScheduleListSubscribeResult,
} from "../types/schedule";
import { useSubscription } from "./useSubscription";

/**
 * Every schedule, app-wide: the Project tab's attention dot reads it, not just
 * the schedules screen (docs/schedule-ui.md §9).
 */
export function useScheduleSubscription(enabled: boolean) {
	const scheduleListSubscribe = useWSStore(
		(s) => s.actions.scheduleListSubscribe,
	);
	const scheduleListUnsubscribe = useWSStore(
		(s) => s.actions.scheduleListUnsubscribe,
	);

	const setSchedules = useScheduleStore((s) => s.setSchedules);
	const updateSchedules = useScheduleStore((s) => s.updateSchedules);
	const setError = useScheduleStore((s) => s.setError);
	const reset = useScheduleStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: ScheduleListChangedNotification) => {
			if (params.operation === "sync") {
				setSchedules(params.schedules);
				return;
			}
			updateSchedules((old) => {
				switch (params.operation) {
					case "create":
					case "update":
						// Upsert for both: a create may already be in the store from the
						// create reply (`addCreatedSchedule`).
						if (old.some((s) => s.id === params.schedule.id)) {
							return old.map((s) =>
								s.id === params.schedule.id ? params.schedule : s,
							);
						}
						return [...old, params.schedule];
					case "delete":
						return old.filter((s) => s.id !== params.scheduleId);
				}
			});
		},
		[setSchedules, updateSchedules],
	);

	const handleError = useCallback(
		(err: unknown) => {
			setError(err instanceof Error ? err.message : "Failed to load schedules");
		},
		[setError],
	);

	const applyInitial = useCallback(
		(initial: ScheduleListSubscribeResult) => {
			setSchedules(initial.items);
		},
		[setSchedules],
	);

	const { refresh } = useSubscription<
		ScheduleListChangedNotification,
		ScheduleListSubscribeResult
	>(scheduleListSubscribe, scheduleListUnsubscribe, handleNotification, {
		enabled,
		resubscribeOnWorktreeChange: false,
		onSubscribed: applyInitial,
		onReset: reset,
		onError: handleError,
	});

	return { refresh };
}
