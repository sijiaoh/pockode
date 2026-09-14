interface Props {
	/**
	 * Geometry and rounding. The call site is the only place that knows what
	 * shape the real value takes, and the placeholder has to match it exactly:
	 * the value replaces it in place, with nothing moving.
	 */
	className: string;
	/**
	 * False stops the pulse without giving up the space. A pulse says something
	 * is on its way; once the answer is known to be "never", it is a lie.
	 */
	animated?: boolean;
	/**
	 * Names the missing value for assistive tech. Only for the places where the
	 * interactive element itself is replaced while waiting — where a control is
	 * still on screen it keeps the name, and this block is decoration.
	 */
	label?: string;
}

/** A stand-in for a value the server has not sent. */
export default function Skeleton({ className, animated = true, label }: Props) {
	// A `<span>` made block-level rather than a `<div>`: these stand in for values
	// inside buttons and paragraphs, neither of which may contain a `<div>`.
	const classes = `block ${animated ? "animate-pulse " : ""}bg-th-text-muted/20 ${className}`;
	return label ? (
		// biome-ignore lint/a11y/useSemanticElements: not a form output; role="status" is here to name the value being waited on
		<span role="status" aria-label={label} className={classes} />
	) : (
		<span aria-hidden="true" className={classes} />
	);
}
