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

/**
 * A short wait as a clock, `0:12` / `1:05`: the seconds are the news while a
 * node restarts, which takes a minute at most.
 */
export function formatElapsed(since: string, now: number): string | null {
	const start = new Date(since).getTime();
	if (Number.isNaN(start)) return null;
	const seconds = Math.max(0, Math.floor((now - start) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * How long ago a past moment was, as a phrase that ends a sentence:
 * "just now", "3 min ago", "2 h ago", "4 days ago" — for "Checked 3 min ago",
 * where the age of a cached answer is the point.
 */
export function formatAgo(at: string, now: number): string | null {
	const then = new Date(at).getTime();
	if (Number.isNaN(then)) return null;
	const minutes = Math.floor((now - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}
