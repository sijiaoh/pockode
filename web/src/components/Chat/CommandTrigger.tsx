interface Props {
	onClick: () => void;
	isActive?: boolean;
	disabled?: boolean;
}

function CommandTrigger({ onClick, isActive, disabled }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg pointer-coarse:h-11 pointer-coarse:w-11 ${
				isActive
					? "bg-th-accent text-th-accent-text"
					: "bg-th-bg-tertiary text-th-text-muted hover:text-th-text-primary"
			} disabled:cursor-not-allowed disabled:opacity-50`}
			aria-label="Toggle commands"
			aria-pressed={isActive}
		>
			/
		</button>
	);
}

export default CommandTrigger;
