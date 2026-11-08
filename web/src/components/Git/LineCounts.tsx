import type { LineStat } from "../../types/git";

/** `+12 −3`; a zero side is dropped rather than shown as `+0`. */
export function formatLineCounts({ additions, deletions }: LineStat): string {
	return [additions > 0 && `+${additions}`, deletions > 0 && `−${deletions}`]
		.filter(Boolean)
		.join(" ");
}

/**
 * Muted rather than green and red: colour in the Changes list is reserved for
 * its one primary action, and the diff is where green and red mean something.
 */
function LineCounts({
	lines,
	binary = false,
	className = "",
	id,
}: {
	lines: LineStat | null;
	binary?: boolean;
	className?: string;
	id?: string;
}) {
	const text = lines ? formatLineCounts(lines) : binary ? "Binary" : "";
	if (!text) return null;
	return (
		<span
			id={id}
			className={`whitespace-nowrap text-xs tabular-nums text-th-text-muted ${className}`}
		>
			{text}
		</span>
	);
}

export default LineCounts;
