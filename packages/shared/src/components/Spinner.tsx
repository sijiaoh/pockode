export interface SpinnerProps {
	className?: string;
	/** "accent" uses theme accent color, "current" inherits text color */
	variant?: "accent" | "current";
	/** Accessible label for screen readers. Set to null to hide from AT */
	srText?: string | null;
}

export function Spinner({
	className = "h-4 w-4",
	variant = "accent",
	srText = "Loading",
}: SpinnerProps) {
	const borderClass =
		variant === "current"
			? "border-current border-r-transparent"
			: "border-th-accent border-t-transparent";

	return (
		// biome-ignore lint/a11y/useSemanticElements: spinner is not a form output, role="status" is for screen readers
		<span
			role="status"
			aria-label={srText ?? undefined}
			className={`inline-block animate-spin rounded-full border-2 ${borderClass} ${className}`}
		/>
	);
}
