import { Zap } from "lucide-react";

interface Props {
	onClick: () => void;
	isActive?: boolean;
}

function CommandTrigger({ onClick, isActive }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
				isActive
					? "bg-th-accent text-th-accent-text"
					: "bg-th-bg-secondary text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			}`}
			aria-label="Toggle commands"
			aria-pressed={isActive}
		>
			<Zap className="h-5 w-5" />
		</button>
	);
}

export default CommandTrigger;
