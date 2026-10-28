import { Check, Loader2, type LucideIcon } from "lucide-react";

/**
 * One full-bleed row of a menu sheet: 48px tall, flush to the sheet's edges
 * because `Sheet` gives its body no padding of its own.
 */
const menuRowClass =
	"flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm transition-colors";

/** Kept apart from the hover fill: an unavailable row still takes focus. */
const focusClass =
	"focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset";

interface Props {
	icon: LucideIcon;
	label: string;
	/** Reserved for destructive rows, which render in the error colour. */
	danger?: boolean;
	/**
	 * Why this action cannot run right now, as one sentence under the label.
	 * Rendered inside the button, so it joins the row's accessible name on its
	 * own — and, unlike a `title`, a finger can read it (docs/responsive-ui.md).
	 */
	description?: string;
	/**
	 * Unavailable, but still here: an action that could have applied is never
	 * dropped from the menu, because a control that is not there teaches the
	 * user nothing.
	 *
	 * `aria-disabled` rather than the native attribute. A natively disabled
	 * button cannot take focus and screen readers routinely skip past it — which
	 * would hide the `description` that is the whole reason for saying no in
	 * words.
	 */
	disabled?: boolean;
	/**
	 * Its action is running: the icon turns into a spinner. The row stays
	 * pressable, so whatever pressing it again means — such as cancelling —
	 * is the caller's `label` to say.
	 */
	busy?: boolean;
	/**
	 * Set when the rows sit in a `role="menu"` rather than a sheet. The menu
	 * then moves focus between rows with the arrow keys, so a row is not a
	 * Tab stop of its own.
	 */
	role?: "menuitem";
	/**
	 * The current choice of a sheet that picks one of its rows, as the range
	 * picker does: a check at the row's end, and `aria-current` for a screen
	 * reader. Undefined on rows that are actions rather than choices.
	 */
	checked?: boolean;
	onClick: () => void;
}

function MenuRow({
	icon: Icon,
	label,
	danger,
	description,
	disabled,
	busy,
	role,
	checked,
	onClick,
}: Props) {
	return (
		<button
			type="button"
			role={role}
			tabIndex={role === "menuitem" ? -1 : undefined}
			onClick={disabled ? undefined : onClick}
			aria-disabled={disabled || undefined}
			aria-busy={busy || undefined}
			aria-current={checked || undefined}
			className={`${menuRowClass} ${focusClass} ${
				danger ? "text-th-error" : "text-th-text-primary"
			} ${
				disabled ? "cursor-not-allowed opacity-50" : "hover:bg-th-bg-tertiary"
			}`}
		>
			{busy ? (
				<Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
			) : (
				<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
			)}
			<span className={checked === undefined ? "min-w-0" : "min-w-0 flex-1"}>
				{label}
				{description && (
					<span className="block text-xs text-th-text-muted">
						{description}
					</span>
				)}
			</span>
			{checked && (
				<Check className="h-4 w-4 shrink-0 text-th-accent" aria-hidden="true" />
			)}
		</button>
	);
}

export default MenuRow;
