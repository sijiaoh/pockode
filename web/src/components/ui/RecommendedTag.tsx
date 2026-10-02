/**
 * Marks the option the asking agent would pick itself. Neutral on purpose:
 * accent or success would read as "already selected", and a recommendation is
 * never a selection (docs/answering-ui.md, "What it draws"). Opaque, so it
 * stays legible on a selected row's tint; `leading-none` keeps it from
 * growing the line.
 */
export default function RecommendedTag() {
	return (
		<>
			{/* Without a separator the two text runs are read as one word. */}
			<span className="sr-only">, </span>
			<span className="ml-1.5 inline-block whitespace-nowrap rounded bg-th-bg-tertiary px-1.5 py-0.5 align-middle text-xs leading-none text-th-text-muted">
				Recommended
			</span>
		</>
	);
}
