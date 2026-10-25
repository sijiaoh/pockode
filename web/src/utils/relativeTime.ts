/**
 * Renders a past timestamp as an age ("4m ago"), the form the narrow git panel
 * has room for. Coarsens as it goes back: a commit from last year is not more
 * useful for being dated to the day.
 */
export function formatRelativeDate(isoDate: string): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) {
		return isoDate; // Fallback to raw string if parsing fails
	}

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays}d ago`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
	return `${Math.floor(diffDays / 365)}y ago`;
}

/**
 * Renders a future timestamp as a wait ("in 5h") — when a schedule fires next.
 * Never "now": an instant already due is a firing the scheduler is about to
 * make, and the minute it takes is the shortest wait there is to name.
 */
export function formatRelativeFuture(isoDate: string): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) {
		return isoDate;
	}

	const diffMs = date.getTime() - Date.now();
	const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
	// Rounded, not floored, above the minute: a wait of 47h read as "in 1d"
	// is a firing a whole day later than the row says.
	if (diffMins < 60) return `in ${diffMins}m`;
	const diffHours = Math.round(diffMins / 60);
	if (diffHours < 24) return `in ${diffHours}h`;
	return `in ${Math.round(diffHours / 24)}d`;
}
