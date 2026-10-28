import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useGitLog } from "../../hooks/useGitLog";
import { useHistoryGraph } from "../../hooks/useHistoryGraph";
import { useRouteState } from "../../hooks/useRouteState";
import { HISTORY_SEARCH_DEBOUNCE_MS } from "../../lib/commitHistory";
import { overlayToNavigation } from "../../lib/navigation";
import type { GitHistoryScope } from "../../types/git";
import type { HistoryQuery } from "../../types/overlay";
import { errorMessage } from "../../utils/errorMessage";
import { splitPath } from "../../utils/path";
import { Spinner } from "../ui";
import HistoryFilters from "./HistoryFilters";
import HistoryHeader from "./HistoryHeader";
import HistoryList from "./HistoryList";
import { useCommitMenu } from "./useCommitMenu";
import { useHistoryPaging } from "./useHistoryPaging";

interface Props {
	/** The range and filters the URL names. */
	history: HistoryQuery;
	activeHash: string | null;
	/** Set while the lit row is wanted on screen; called once it is. */
	reveal?: () => void;
	onSelectCommit: (hash: string) => void;
}

/** An empty field is no search, and neither is one of only spaces. */
function searchOf(text: string): string {
	return text.trim() ? text : "";
}

function noMatchText({ q, file }: HistoryQuery): string {
	const name = file ? splitPath(file).fileName : "";
	if (q && file) return `No commits changed ${name} matching "${q}"`;
	if (q) return `No commits match "${q}"`;
	return `No commits changed ${name}`;
}

/**
 * The Git workspace's History segment: the commit graph over the chosen
 * range, a page at a time (docs/git-history-ui.md).
 */
function HistorySection({
	history,
	activeHash,
	reveal,
	onSelectCommit,
}: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId, overlay } = useRouteState();
	const log = useGitLog(history);
	const { data, isLoading, error } = log;
	// A search or a file filter lists commits that are not each other's
	// parents; lines drawn between them would be lies.
	const filtered = Boolean(history.q || history.file);
	const listKey = `${history.scope}\0${history.q ?? ""}\0${history.file ?? ""}`;
	const rows = useHistoryGraph(data?.pages, history.scope, !filtered);
	const first = data?.pages[0];

	// The label keeps the name it last had while another range loads, rather
	// than flicker to the one that does not name it.
	const knownDefault = useRef<string | undefined>(undefined);
	if (first) knownDefault.current = first.default_branch;

	const { openMenu, menu } = useCommitMenu(rows);

	// Onto whichever history layer is up: a commit beside the list at
	// `expanded` stays open, and a search settling after a row was pressed
	// lands on that commit's page rather than replacing it with the list.
	const showHistory = (next: HistoryQuery, replace = false) => {
		const layer =
			overlay?.type === "commit" ||
			overlay?.type === "commit-diff" ||
			overlay?.type === "commit-file"
				? // A commit under History carries no branch; said for the type.
					{ ...overlay, branch: undefined, history: next }
				: { type: "git" as const, segment: "history" as const, history: next };
		navigate(overlayToNavigation(layer, worktree, sessionId, { replace }));
	};
	const changeScope = (scope: GitHistoryScope) =>
		showHistory({ ...history, scope });

	// The field runs ahead of the URL by the debounce; the URL is what is
	// listed. A URL that arrives with `q` opens the row with the text in it.
	const urlQ = history.q ?? "";
	const [searchOpen, setSearchOpen] = useState(urlQ !== "");
	const [text, setText] = useState(urlQ);
	const inputRef = useRef<HTMLInputElement>(null);
	const searchButtonRef = useRef<HTMLButtonElement>(null);
	// Compared with what the field last wrote rather than with the field: a
	// character typed while that write lands must not be taken back.
	const writtenQ = useRef(urlQ);
	// A `q` the field did not write — Back, a link, a worktree switch dropping
	// it — replaces what is in the field.
	useEffect(() => {
		if (urlQ === writtenQ.current) return;
		writtenQ.current = urlQ;
		setText(urlQ);
		// As a fresh mount would have it: a URL without `q` has no search row.
		setSearchOpen(urlQ !== "");
	}, [urlQ]);
	const debouncedText = useDebouncedValue(text, HISTORY_SEARCH_DEBOUNCE_MS);
	// Settling, not the debounced value changing, is what writes: text typed
	// back to what it was before a Cancel settles without the value moving.
	const settled = text === debouncedText;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the settled text writes the URL; a URL change on its own must not write it back
	useEffect(() => {
		if (!settled) return;
		const q = searchOf(debouncedText);
		if (q === urlQ) return;
		writtenQ.current = q;
		// Replaced, so Back does not walk back through what was typed.
		showHistory({ ...history, q: q || undefined }, true);
	}, [debouncedText, settled]);
	const [focusRequest, setFocusRequest] = useState(0);
	useEffect(() => {
		if (focusRequest > 0) inputRef.current?.focus();
	}, [focusRequest]);
	const openSearch = () => {
		setSearchOpen(true);
		setFocusRequest((n) => n + 1);
	};
	const cancelSearch = () => {
		setSearchOpen(false);
		setText("");
		// The row goes with the focus in it.
		searchButtonRef.current?.focus();
		// Also when the last write has not landed yet, or it would bring the
		// search back once it does.
		const pending = urlQ !== "" || writtenQ.current !== "";
		writtenQ.current = "";
		if (pending) showHistory({ ...history, q: undefined }, true);
	};
	// Pushed: dropping the file is a step the user took, as adding it was.
	const clearFile = () => showHistory({ ...history, file: undefined });

	const { footer, loadMore, retry } = useHistoryPaging(
		log,
		first?.shallow
			? "Older history isn't in this clone"
			: filtered
				? "No more matches"
				: "Beginning of history",
	);

	return (
		<>
			<HistoryHeader
				scope={history.scope}
				defaultBranch={knownDefault.current}
				unpushedCount={filtered ? 0 : (first?.unpushed_count ?? 0)}
				onChangeScope={changeScope}
				onSearch={openSearch}
				searchButtonRef={searchButtonRef}
			/>
			<HistoryFilters
				searchOpen={searchOpen}
				text={text}
				onTextChange={setText}
				onCancel={cancelSearch}
				inputRef={inputRef}
				q={history.q}
				file={history.file}
				onClearFile={clearFile}
			/>
			{menu}
			{isLoading ? (
				<div className="flex items-center justify-center p-8">
					<Spinner variant="current" className="text-th-text-muted" />
				</div>
			) : data ? (
				// A refetch that fails keeps the log already on screen: it is
				// still what HEAD was a moment ago.
				rows.length === 0 ? (
					filtered ? (
						<div className="px-3 py-2 text-sm text-th-text-muted">
							<p className="break-words">{noMatchText(history)}</p>
							{history.scope !== "all" && (
								<button
									type="button"
									onClick={() => changeScope("all")}
									className="-ml-3 mt-1 min-h-[36px] rounded-md px-3 text-sm text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
								>
									Look in all branches
								</button>
							)}
						</div>
					) : (
						<div className="px-3 py-2 text-sm text-th-text-muted">
							No commits yet
						</div>
					)
				) : (
					// Keyed by the query: another range or filter is another list,
					// read from the top, with a graph column that starts narrow.
					<HistoryList
						key={listKey}
						rows={rows}
						footer={footer}
						onLoadMore={loadMore}
						onRetry={retry}
						activeHash={activeHash}
						reveal={reveal}
						onSelectCommit={onSelectCommit}
						onOpenMenu={openMenu}
					/>
				)
			) : (
				error && (
					<div className="p-4 text-center text-th-error">
						<div>Failed to load history</div>
						<div className="mt-1 text-sm text-th-text-muted">
							{errorMessage(error)}
						</div>
					</div>
				)
			)}
		</>
	);
}

export default HistorySection;
