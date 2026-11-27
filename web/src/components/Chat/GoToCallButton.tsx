/**
 * The transcript's jump to a tool row, as a word (`useGoToCall`).
 *
 * A word, not an arrow: beside a diff an arrow reads as scroll or fold, and
 * there is no hover to explain it. `touch-target` because the lines it sits
 * on — a section's header, the tail line — cannot grow. `label` has to start
 * with the visible words, so speech input can say what it sees.
 */
export function GoToCallButton({
	label,
	onClick,
	height = "h-6",
}: {
	label: string;
	onClick: () => void;
	/** The line's own height, so the box does not grow it; the hit area is `touch-target`'s. */
	height?: "h-6" | "h-4";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className={`touch-target flex ${height} shrink-0 items-center whitespace-nowrap rounded px-1 text-th-accent hover:bg-th-overlay-hover`}
		>
			Go to call
		</button>
	);
}
