import { isDone } from "../lib/schedulePeriod";
import { zonedInstant } from "../lib/scheduleZone";
import type { Schedule } from "../types/schedule";
import { useHasPassed } from "./useHasPassed";

/**
 * `isDone`, judged again the moment an off one-time's time arrives: nothing
 * from the server marks that moment, since an off schedule fires nothing, so
 * the switch would otherwise stay up until some unrelated notification
 * (docs/schedule-ui.md §6.6). An on schedule waits for the server's word.
 * `null` (a schedule still loading) is not done.
 */
export function useIsScheduleDone(
	schedule: Pick<
		Schedule,
		"period" | "enabled" | "next_run_at" | "time_zone"
	> | null,
): boolean {
	const period = schedule?.period;
	useHasPassed(
		schedule && period?.kind === "once" && !schedule.enabled
			? zonedInstant(period.at, schedule.time_zone)
			: null,
	);
	return schedule !== null && isDone(schedule);
}
