/**
 * An inline icon action inside a list row or a group header: 36px, no border,
 * no fill, muted until hovered.
 *
 * One definition rather than one per call site, because the whole point of the
 * rung is that stage, unstage, discard and amend all read as the same weight —
 * three copies of the string is three chances for one of them to drift louder.
 */
export function iconButtonClass(busy = false): string {
	return `flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
		busy
			? "opacity-50 cursor-not-allowed text-th-text-muted"
			: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
	}`;
}
