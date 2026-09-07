import type { LucideIcon } from "lucide-react";

interface Props {
	icon: LucideIcon;
	label: string;
	title: string;
	pressed: boolean;
	onToggle: () => void;
}

function ToggleChip({ icon: Icon, label, title, pressed, onToggle }: Props) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			title={title}
			// Keep focus (and the mobile keyboard) on whatever input is active.
			onMouseDown={(e) => e.preventDefault()}
			onClick={onToggle}
			// 36px is the floor for compact controls everywhere else in the sidebar.
			className={`flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
				pressed
					? "border-th-accent bg-th-accent/10 text-th-accent"
					: "border-th-border bg-transparent text-th-text-secondary hover:text-th-text-primary"
			}`}
		>
			<Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			{label}
		</button>
	);
}

export default ToggleChip;
