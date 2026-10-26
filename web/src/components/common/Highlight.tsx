import type { ReactNode } from "react";
import type { SearchRange } from "../../types/search";

interface Props {
	text: string;
	/** Ascending, non-overlapping spans of `text` to mark, in UTF-16 code units. */
	ranges: readonly SearchRange[];
}

/**
 * Renders `text` with the given spans marked.
 *
 * The spans come from whoever did the matching rather than being recomputed
 * here: a fuzzy match is not a substring of the query, so only the matcher
 * knows which characters it picked.
 */
function Highlight({ text, ranges }: Props) {
	if (ranges.length === 0) {
		return <>{text}</>;
	}

	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const { start, end } of ranges) {
		if (start > cursor) {
			parts.push(text.slice(cursor, start));
		}
		parts.push(
			<mark
				key={start}
				className="rounded-sm bg-th-accent/20 px-0.5 text-th-text-primary"
			>
				{text.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	if (cursor < text.length) {
		parts.push(text.slice(cursor));
	}

	return <>{parts}</>;
}

export default Highlight;
