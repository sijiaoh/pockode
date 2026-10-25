import { formatClock, formatDayDate } from "../lib/schedulePeriod";
import { wallClock } from "../lib/scheduleZone";

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

/**
 * An instant as a day and a 24-hour time — `today 03:00`, `tomorrow 03:00`,
 * `yesterday 03:00`, `Mon 27 Oct 03:00` further out — on the clock of
 * `timeZone` (the device's when absent), whose days `today` and `tomorrow`
 * are too. For a schedule's firings, past and next, where the age alone would
 * not say which firing it was (docs/schedule-ui.md §4.1, §6.5).
 */
export function formatNextRun(
	isoDate: string,
	now: Date = new Date(),
	timeZone?: string,
): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) {
		return isoDate;
	}

	const at = wallClock(date, timeZone);
	const today = wallClock(now, timeZone);
	const time = formatClock(at.hour, at.minute);
	// Calendar days, counted in UTC so no DST change lengthens one.
	const calendarDay = Date.UTC(at.year, at.month, at.day);
	const days = Math.round(
		(calendarDay - Date.UTC(today.year, today.month, today.day)) /
			(1000 * 60 * 60 * 24),
	);
	if (days === 0) return `today ${time}`;
	if (days === 1) return `tomorrow ${time}`;
	if (days === -1) return `yesterday ${time}`;
	return `${formatDayDate(at)} ${time}`;
}
