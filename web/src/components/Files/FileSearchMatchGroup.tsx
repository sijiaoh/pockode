import { memo } from "react";
import type { FileMatch } from "../../types/search";
import { buildSnippet } from "../../utils/snippet";
import Highlight from "../common/Highlight";
import FileSearchFileRow from "./FileSearchFileRow";

// Enough to judge relevance without turning one file into a wall of text on a
// phone screen; the rest is summarised by the "+N more" hint.
const MAX_PREVIEW_LINES = 3;

interface Props {
	match: FileMatch;
	query: string;
	isActive: boolean;
	onSelect: (path: string) => void;
}

const FileSearchMatchGroup = memo(function FileSearchMatchGroup({
	match,
	query,
	isActive,
	onSelect,
}: Props) {
	const lines = match.lines ?? [];
	const preview = lines.slice(0, MAX_PREVIEW_LINES);
	// The server caps lines per file, so this is "more than shown", not
	// necessarily every remaining match in the file.
	const hidden = lines.length - preview.length;

	return (
		<div className="flex flex-col">
			<FileSearchFileRow
				path={match.path}
				query={query}
				isActive={isActive}
				onSelect={onSelect}
				actions={
					<span className="rounded-full bg-th-bg-tertiary px-2 py-0.5 text-xs text-th-text-muted">
						{lines.length}
						{/* A bare number reads as noise without the file name next to it.
						    Not aria-label: a span carries no role to attach a name to. */}
						<span className="sr-only">
							{` matching ${lines.length === 1 ? "line" : "lines"}`}
						</span>
					</span>
				}
			/>
			{preview.map((line) => (
				<button
					key={line.number}
					type="button"
					onClick={() => onSelect(match.path)}
					className="flex min-h-[36px] w-full items-start gap-2 rounded-md py-1 pr-2 pl-8 text-left transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
					aria-label={`Open ${match.path}, match on line ${line.number}`}
				>
					<span className="w-8 shrink-0 text-right font-mono text-[11px] leading-5 text-th-text-muted">
						{line.number}
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-xs leading-5 text-th-text-secondary">
						<Highlight text={buildSnippet(line.text, query)} query={query} />
					</span>
				</button>
			))}
			{hidden > 0 && (
				<div className="py-1 pl-8 text-xs text-th-text-muted">
					+{hidden} more {hidden === 1 ? "match" : "matches"}
				</div>
			)}
		</div>
	);
});

export default FileSearchMatchGroup;
