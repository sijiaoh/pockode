import type { LucideIcon } from "lucide-react";

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
	onClick: () => void;
}

function MenuRow({
	icon: Icon,
	label,
	danger,
	description,
	disabled,
	onClick,
}: Props) {
	return (
		<button
			type="button"
			onClick={disabled ? undefined : onClick}
			aria-disabled={disabled || undefined}
			className={`${menuRowClass} ${focusClass} ${
				danger ? "text-th-error" : "text-th-text-primary"
			} ${
				disabled ? "cursor-not-allowed opacity-50" : "hover:bg-th-bg-tertiary"
			}`}
		>
			<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
			<span className="min-w-0">
				{label}
				{description && (
					<span className="block text-xs text-th-text-muted">
						{description}
					</span>
				)}
			</span>
		</button>
	);
}

export default MenuRow;
