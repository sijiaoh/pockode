/**
 * A schedule's zone beside one of its times, ` (Tokyo)`, muted inside the
 * surrounding tier. Nothing while there is no label to show: the caller asks
 * `periodZoneLabel` / `instantZoneLabel` whether the zones differ
 * (docs/schedule-ui.md §6.5).
 */
export default function ZoneLabel({ label }: { label: string | null }) {
	if (label === null) return null;
	return <span className="text-th-text-muted"> ({label})</span>;
}
