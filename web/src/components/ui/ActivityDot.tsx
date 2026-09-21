/**
 * One dot, one hue, one meaning: `needsAttention` is true somewhere below this
 * thing (docs/lifecycle-ui.md §4).
 *
 * It is the one place the two dimensions — what the agent is waiting on, and
 * how many questions it has posted — are merged into a single bit. A dot cannot
 * be aimed at, so one bit is the whole of what it owes; everywhere the user can
 * act on one of the two, both are drawn side by side instead.
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
