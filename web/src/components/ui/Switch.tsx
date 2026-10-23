interface Props {
	/** What is stored — never the press that is still on its way. */
	checked: boolean;
	onToggle: () => void;
	/**
	 * A change is in flight: the switch says so and ignores presses, but stays
	 * focusable — `disabled` would drop the focus of the keyboard that pressed it.
	 */
	busy?: boolean;
	label: string;
	describedBy?: string;
}

/**
 * An on/off setting applied the moment it is pressed. The caller owns the
 * request: the switch moves when `checked` does, so it shows what the server
 * stored rather than what the user hoped for (docs/schedule-ui.md §3.2).
 *
 * The track is the box and `touch-target` the hit area, so it reaches 36px for
 * a mouse and 44px for a thumb without the track growing. The thumb carries the
 * contrast — the off track is the border colour, only set apart from a card's
 * fill, hovered or not — which is also why busy is not drawn by dimming, which
 * would take the thumb under the 3:1 a control's state owes.
 */
export default function Switch({
	checked,
	onToggle,
	busy = false,
	label,
	describedBy,
}: Props) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-busy={busy || undefined}
			aria-label={label}
			aria-describedby={describedBy}
			onClick={() => {
				if (!busy) onToggle();
			}}
			className={`touch-target inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
				checked ? "bg-th-accent" : "bg-th-border"
			}${busy ? " cursor-wait" : ""}`}
		>
			<span
				aria-hidden="true"
				className={`size-4 rounded-full transition-transform ${
					checked
						? "translate-x-4 bg-th-accent-text"
						: "translate-x-0 bg-th-text-muted"
				}`}
			/>
		</button>
	);
}
