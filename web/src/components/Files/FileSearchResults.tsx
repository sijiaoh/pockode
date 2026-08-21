import { AlertTriangle, Search, SearchX } from "lucide-react";
import type { FileSearchState } from "../../hooks/useFileSearch";
import { useFilesSearchStore } from "../../lib/filesSearchStore";
import type { FileMatch, FileSearchResult } from "../../types/search";
import { Spinner } from "../ui";
import FileSearchFileRow from "./FileSearchFileRow";
import FileSearchMatchGroup from "./FileSearchMatchGroup";

interface Props {
	search: FileSearchState;
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
}

const stateContainerClass =
	"flex flex-col items-center gap-2 px-6 py-10 text-center";
const remedyButtonClass =
	"min-h-[44px] px-3 text-sm text-th-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

function FileSearchResults({ search, onSelectFile, activeFilePath }: Props) {
	const { status, result, error, mode, minQueryLength, matchedQuery } = search;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Always mounted so screen readers announce updates reliably. */}
			<div
				className="shrink-0 border-b border-th-border px-3 py-1.5"
				aria-live="polite"
			>
				<StatusBar status={status} result={result} mode={mode} />
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{status === "too-short" && (
					<div className={stateContainerClass}>
						<Search className="h-8 w-8 text-th-text-muted" aria-hidden="true" />
						<div className="text-sm text-th-text-muted">
							Type at least {minQueryLength} characters to search file contents
						</div>
					</div>
				)}

				{status === "loading" && (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				)}

				{status === "error" && (
					<div className={stateContainerClass}>
						<div className="text-th-error">Search failed</div>
						<div className="text-sm text-th-text-muted">
							{error instanceof Error ? error.message : String(error)}
						</div>
						<button
							type="button"
							onClick={search.retry}
							className="min-h-[44px] rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-colors hover:bg-th-bg-secondary"
						>
							Retry
						</button>
					</div>
				)}

				{status === "ready" && result && (
					<Matches
						result={result}
						mode={mode}
						query={matchedQuery}
						onSelectFile={onSelectFile}
						activeFilePath={activeFilePath}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * Contents of the live region above the list.
 *
 * Stays empty while loading or failing rather than repeating what the list area
 * already spells out, which would make a screen reader read it twice.
 */
function StatusBar({
	status,
	result,
	mode,
}: {
	status: FileSearchState["status"];
	result?: FileSearchResult;
	mode: FileSearchState["mode"];
}) {
	if (status !== "ready" || !result || result.matches.length === 0) {
		return null;
	}

	const fileCount = result.matches.length;
	let summary = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;

	if (mode === "content") {
		// The server caps lines per file, so this counts what is shown rather than
		// every match in the repository.
		const matchCount = result.matches.reduce(
			(total, match) => total + (match.lines?.length ?? 0),
			0,
		);
		summary += ` · ${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
	}

	// A single file with more matching lines than the server returns is enough to
	// flag the whole result, which is most searches in content mode — so the
	// counts stay alongside the warning instead of being replaced by it. They are
	// a floor either way, since truncation also covers timeouts.
	if (result.truncated) {
		return (
			<div className="flex items-center gap-1.5 text-xs text-th-warning">
				<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				{summary} · more results exist
			</div>
		);
	}

	return <div className="text-xs text-th-text-muted">{summary}</div>;
}

function Matches({
	result,
	mode,
	query,
	onSelectFile,
	activeFilePath,
}: {
	result: FileSearchResult;
	mode: FileSearchState["mode"];
	query: string;
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
}) {
	if (result.matches.length === 0) {
		// A cut-short search found nothing *so far*, which is not the same claim as
		// "nothing matches" — and the status bar above stays empty when there are no
		// files to count, so without this the truncation would go unmentioned.
		return result.truncated ? (
			<CutOffWithoutMatches query={query} />
		) : (
			<NoMatches query={query} />
		);
	}

	return (
		<>
			<div
				className={`flex flex-col p-2 ${mode === "name" ? "gap-0.5" : "gap-2"}`}
			>
				{result.matches.map((match: FileMatch) =>
					mode === "name" ? (
						<FileSearchFileRow
							key={match.path}
							path={match.path}
							query={query}
							isActive={match.path === activeFilePath}
							onSelect={onSelectFile}
						/>
					) : (
						<FileSearchMatchGroup
							key={match.path}
							match={match}
							query={query}
							isActive={match.path === activeFilePath}
							onSelect={onSelectFile}
						/>
					),
				)}
			</div>
			{result.truncated && (
				<div className="px-3 py-3 text-center text-xs text-th-text-muted">
					More matches were cut off — refine your search
				</div>
			)}
		</>
	);
}

/**
 * No results *and* the server ran out of budget getting there.
 *
 * The remedies offered below widen the scan, which is the wrong advice for a
 * search that already hit its limits, so they are deliberately absent here.
 */
function CutOffWithoutMatches({ query }: { query: string }) {
	return (
		<div className={stateContainerClass}>
			<AlertTriangle className="h-8 w-8 text-th-warning" aria-hidden="true" />
			<div className="text-sm text-th-text-muted">
				{`Search stopped before it finished and found no match for "${query}" yet`}
			</div>
			<div className="text-sm text-th-text-muted">
				Try a longer query, or narrow the search down.
			</div>
		</div>
	);
}

function NoMatches({ query }: { query: string }) {
	const respectGitignore = useFilesSearchStore(
		(state) => state.respectGitignore,
	);
	const searchContent = useFilesSearchStore((state) => state.searchContent);
	const toggleRespectGitignore = useFilesSearchStore(
		(state) => state.toggleRespectGitignore,
	);
	const toggleSearchContent = useFilesSearchStore(
		(state) => state.toggleSearchContent,
	);

	return (
		<div className={stateContainerClass}>
			<SearchX className="h-8 w-8 text-th-text-muted" aria-hidden="true" />
			<div className="text-sm text-th-text-muted">{`No matches for "${query}"`}</div>
			{respectGitignore && (
				<button
					type="button"
					onClick={toggleRespectGitignore}
					className={remedyButtonClass}
				>
					Search ignored files too
				</button>
			)}
			{!searchContent && (
				<button
					type="button"
					onClick={toggleSearchContent}
					className={remedyButtonClass}
				>
					Search file contents
				</button>
			)}
		</div>
	);
}

export default FileSearchResults;
