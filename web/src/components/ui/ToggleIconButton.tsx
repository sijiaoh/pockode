import type { LucideIcon } from "lucide-react";

interface Props {
	icon: LucideIcon;
	pressed: boolean;
	onClick: () => void;
	/**
	 * Accessible name. Callers swing it with `pressed` so it names the action
	 * about to happen rather than the state already announced by `aria-pressed`.
	 */
	label: string;
}

/**
 * An icon action in a bottom bar that stays on once pressed.
 *
 * Same box as `actionIconButtonClass` — 36px for a mouse, 44px for a thumb —
 * but the pressed state is filled with the accent instead of merely focused,
 * since these controls have no other way to say they are still in effect.
 */
function ToggleIconButton({ icon: Icon, pressed, onClick, label }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={pressed}
			aria-label={label}
			title={label}
			className={`flex size-9 items-center justify-center rounded border transition-all pointer-coarse:size-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
				pressed
					? "bg-th-accent text-th-accent-text border-th-accent"
					: "text-th-text-muted hover:text-th-text-secondary border-th-border bg-th-bg-tertiary hover:border-th-border-focus"
			}`}
		>
			<Icon className="h-4 w-4" aria-hidden="true" />
		</button>
	);
}

export default ToggleIconButton;
