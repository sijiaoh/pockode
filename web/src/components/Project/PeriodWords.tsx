import { useDeviceTimeZone } from "../../hooks/useDeviceTimeZone";
import { describePeriod } from "../../lib/schedulePeriod";
import { periodZoneLabel } from "../../lib/scheduleZone";
import type { Schedule } from "../../types/schedule";
import ZoneLabel from "./ZoneLabel";

/**
 * A schedule's period in words, as every schedule screen shows it, and the
 * zone's label when that is not the device's (docs/schedule-ui.md §6.4).
 * `withZone={false}` where a zone line under the words says it at length.
 */
export default function PeriodWords({
	schedule,
	withZone = true,
}: {
	schedule: Pick<Schedule, "period" | "time_zone">;
	withZone?: boolean;
}) {
	const deviceZone = useDeviceTimeZone();
	return (
		<>
			{describePeriod(schedule.period, schedule.time_zone)}
			{withZone && (
				<ZoneLabel label={periodZoneLabel(schedule.time_zone, deviceZone)} />
			)}
		</>
	);
}
