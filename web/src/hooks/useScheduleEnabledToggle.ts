import { useCallback, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type { Schedule } from "../types/schedule";

/**
 * `schedule.update {enabled}` for one switch. The switch reads the server's
 * record — the list's store, or the detail subscription — not this: a refusal leaves it where the server has it, with the message beside
 * it, cleared by a retry, by the value changing under it, or by unmounting.
 */
export function useScheduleEnabledToggle(
	schedule: Pick<Schedule, "id" | "enabled">,
) {
	const updateSchedule = useWSStore((s) => s.actions.updateSchedule);
	const [busy, setBusy] = useState(false);
	// Kept with the value it was refused against and shown only while that is
	// still the value: the notification and the refusal can land in either
	// order, and an effect clearing on change would lose to a late refusal.
	const [failure, setFailure] = useState<{
		message: string;
		forEnabled: boolean;
	} | null>(null);

	const toggle = useCallback(async () => {
		setFailure(null);
		setBusy(true);
		try {
			await updateSchedule({ id: schedule.id, enabled: !schedule.enabled });
		} catch (err) {
			setFailure({
				message:
					err instanceof Error ? err.message : "Failed to update schedule",
				forEnabled: schedule.enabled,
			});
		} finally {
			setBusy(false);
		}
	}, [updateSchedule, schedule.id, schedule.enabled]);

	// Dropped for good once the value has moved, so that moving back does not
	// bring an old refusal back with it.
	if (failure && failure.forEnabled !== schedule.enabled) setFailure(null);
	const error =
		failure && failure.forEnabled === schedule.enabled ? failure.message : null;
	return { busy, error, toggle };
}
