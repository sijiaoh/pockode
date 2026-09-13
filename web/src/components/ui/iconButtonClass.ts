interface Options {
	/** Dims the icon and marks it unavailable while an operation is in flight. */
	busy?: boolean;
	/**
	 * Whether the box itself may grow to 44px under a thumb. False keeps the box
	 * at 36px and lays the hit area over it instead — for the places where the
	 * box is a layout decision (a slot beside a chat bubble is 36px of the row's
	 * width whatever the pointer is) and the extra pixels have somewhere to go.
	 */
	grow?: boolean;
}

/**
 * An inline icon action inside a list row, a group header or the slot beside a
 * chat bubble: 36px of box, no border, no fill, muted until hovered.
 *
 * One definition rather than one per call site, because the whole point of the
 * rung is that stage, unstage, discard, amend, a file entry's `…` and a
 * message's `…` all read as the same weight — a copy of the string per feature
 * is a chance for one of them to drift louder.
 *
 * 36px is the visual rung and the floor for a mouse; a coarse pointer needs
 * 44px. `grow` picks which way that is paid: growing the box (the default,
 * right wherever the row can absorb 8px) or overlaying `touch-target`, which
 * reaches outside a box that has to stay 36px. Either way the weight stays put
 * on a desktop and a thumb still gets its target. Rows that hold two of these
 * need 8px between them once grown — see docs/responsive-ui.md.
 *
 * An options object rather than a second positional flag: most callers care
 * about exactly one of the two, and `iconButtonClass(false, { grow: false })`
 * would make every one of them say something about the other.
 */
export function iconButtonClass({
	busy = false,
	grow = true,
}: Options = {}): string {
	return `flex shrink-0 items-center justify-center rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
		grow
			? "min-h-[36px] min-w-[36px] pointer-coarse:min-h-11 pointer-coarse:min-w-11"
			: "size-9 touch-target"
	} ${
		busy
			? "opacity-50 cursor-not-allowed text-th-text-muted"
			: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
	}`;
}
