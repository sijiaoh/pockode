import {
	CUSTOM_PERIOD_LABEL,
	describePreset,
	parsePeriod,
} from "../../lib/schedulePeriod";

/**
 * A stored cron in words, as every schedule screen shows it: a preset
 * described, anything else `Custom ·` and the expression in mono — the
 * expression is exact, and a user who wrote it reads it (docs/schedule-ui.md
 * §6.4).
 */
export default function PeriodWords({ cron }: { cron: string }) {
	const period = parsePeriod(cron);
	if (period) return <>{describePreset(period)}</>;
	return (
		<>
			{CUSTOM_PERIOD_LABEL} · <span className="font-mono">{cron.trim()}</span>
		</>
	);
}
