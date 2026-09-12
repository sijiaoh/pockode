import type { LucideIcon } from "lucide-react";

/**
 * One full-bleed row of a menu sheet: 48px tall, flush to the sheet's edges
 * because `Sheet` gives its body no padding of its own.
 */
const menuRowClass =
	"flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-sm transition-colors";

const interactiveClass =
	"hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset";

interface Props {
	icon: LucideIcon;
	label: string;
	/** Reserved for destructive rows, which render in the error colour. */
	danger?: boolean;
	onClick: () => void;
}

function MenuRow({ icon: Icon, label, danger, onClick }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`${menuRowClass} ${interactiveClass} ${danger ? "text-th-error" : "text-th-text-primary"}`}
		>
			<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
			{label}
		</button>
	);
}

export default MenuRow;
