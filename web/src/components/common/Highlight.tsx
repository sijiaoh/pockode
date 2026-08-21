import type { ReactNode } from "react";
import { findMatchIndexes } from "../../utils/textMatch";

interface Props {
	text: string;
	query: string;
}

/**
 * Renders `text` with every case-insensitive occurrence of `query` marked.
 *
 * Matching is done here rather than from server-provided offsets: those are
 * UTF-8 byte offsets, and converting them to JS string indexes is an easy place
 * to cut a character in half. The server may also fold case slightly
 * differently for exotic characters — a missing highlight is the worst outcome.
 */
function Highlight({ text, query }: Props) {
	const indexes = findMatchIndexes(text, query);
	if (indexes.length === 0) {
		return <>{text}</>;
	}

	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const index of indexes) {
		if (index > cursor) {
			parts.push(text.slice(cursor, index));
		}
		cursor = index + query.length;
		parts.push(
			<mark
				key={index}
				className="rounded-sm bg-th-accent/20 px-0.5 text-th-text-primary"
			>
				{text.slice(index, cursor)}
			</mark>,
		);
	}
	if (cursor < text.length) {
		parts.push(text.slice(cursor));
	}

	return <>{parts}</>;
}

export default Highlight;
