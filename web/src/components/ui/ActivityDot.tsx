/**
 * One dot, one hue, one meaning: `needsUser` is true somewhere below this thing
 * (docs/lifecycle-ui.md §4).
 *
 * `aria-hidden`, and it takes no handler: it is a rollup of states named in
 * words further in, not a control and not a second announcement of them.
 */
export default function ActivityDot({
	className = "",
}: {
	className?: string;
}) {
	return (
		<span
			className={`h-2 w-2 shrink-0 rounded-full bg-th-warning ${className}`}
			aria-hidden="true"
		/>
	);
}
