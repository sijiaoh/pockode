/**
 * An inline icon action inside a list row or a group header: 36px of box, no
 * border, no fill, muted until hovered.
 *
 * One definition rather than one per call site, because the whole point of the
 * rung is that stage, unstage, discard, amend and a file entry's `…` all read
 * as the same weight — a copy of the string per feature is a chance for one of
 * them to drift louder.
 *
 * 36px is the visual rung and the floor for a mouse; a coarse pointer grows the
 * box to 44px instead, so the weight stays put on a desktop and a thumb still
 * gets its target. Rows that hold two of these need 8px between them once
 * grown — see docs/responsive-ui.md.
 */
export function iconButtonClass(busy = false): string {
	return `flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
		busy
			? "opacity-50 cursor-not-allowed text-th-text-muted"
			: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
	}`;
}
