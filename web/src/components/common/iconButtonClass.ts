/**
 * An inline icon action inside a list row, a group header or under a chat
 * bubble: 36px, no border, no fill, muted until hovered.
 *
 * One definition rather than one per call site, because the whole point of the
 * rung is that every action on it reads as the same weight — stage, unstage,
 * discard and amend sit side by side, and three copies of the string is three
 * chances for one of them to drift louder.
 */
export function iconButtonClass(busy = false): string {
	return `flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
		busy
			? "opacity-50 cursor-not-allowed text-th-text-muted"
			: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
	}`;
}
