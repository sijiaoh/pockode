export interface SpinnerProps {
	/** Tailwind size classes, e.g. "h-4 w-4". */
	size?: string;
	/** Extra classes (margin, color, etc.); appended, does not override `size`. */
	className?: string;
	/** "accent" uses theme accent color, "current" inherits text color */
	variant?: "accent" | "current";
	/** Accessible label for screen readers. Set to null to hide from AT */
	srText?: string | null;
}

export function Spinner({
	size = "h-4 w-4",
	className,
	variant = "accent",
	srText = "Loading",
}: SpinnerProps) {
	const borderClass =
		variant === "current"
			? "border-current border-t-transparent"
			: "border-th-accent border-t-transparent";

	const classes = [
		"inline-block animate-spin rounded-full border-2",
		borderClass,
		size,
		className,
	]
		.filter(Boolean)
		.join(" ");

	return (
		// biome-ignore lint/a11y/useSemanticElements: spinner is not a form output, role="status" is for screen readers
		<span role="status" aria-label={srText ?? undefined} className={classes} />
	);
}
