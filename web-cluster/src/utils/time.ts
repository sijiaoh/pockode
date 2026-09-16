/**
 * How long a node has been up, as `2h 14m`.
 *
 * Uptime rather than a wall-clock start time: "Started 10:30" is ambiguous once
 * the node has been up past midnight, and makes the reader do the subtraction
 * that is the only thing they wanted. Recomputed on every render, so the poll
 * that refreshes the list also advances this.
 *
 * `now` is a parameter so the caller can pass the clock it is testing with.
 */
export function formatUptime(startedAt: string, now: number): string | null {
	const started = new Date(startedAt).getTime();
	if (Number.isNaN(started)) return null;

	const minutes = Math.floor((now - started) / 60_000);
	// A clock skew between this browser and the node can put the start in the
	// future; there is no honest duration to show, so show none.
	if (minutes < 0) return null;
	if (minutes < 1) return "<1m";

	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}
