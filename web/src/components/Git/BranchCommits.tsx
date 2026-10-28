import { useMemo, useState } from "react";
import { useGitLog } from "../../hooks/useGitLog";
import { useHistoryGraph } from "../../hooks/useHistoryGraph";
import { useOffsetWithin } from "../../hooks/useOffsetWithin";
import type { BranchRow } from "../../lib/gitBranches";
import type { GitBranches } from "../../types/git";
import { errorMessage } from "../../utils/errorMessage";
import { Spinner } from "../ui";
import HistoryList from "./HistoryList";
import { useCommitMenu } from "./useCommitMenu";
import { useHistoryPaging } from "./useHistoryPaging";

interface Props {
	row: BranchRow;
	branches: GitBranches;
	/**
	 * Whether the row is in the list as it is now, rather than the one the
	 * page last had: `git.log` refuses a branch that is not there, and a page
	 * kept for a branch whose delete is answering must not say it failed.
	 */
	listed: boolean;
	/** The page's scroll area, which the commits share with what is above. */
	scroller: HTMLElement | null;
	/** That scroll area's content, the list's offset in which is followed. */
	content: HTMLElement | null;
	onSelectCommit: (hash: string) => void;
}

/**
 * Why a branch's commits are not listed, or null when they are
 * (docs/git-branches-ui.md#the-branch). None of them is asked: `git.log`
 * would refuse it, answer with nothing, or — for a remote name a local
 * branch shares — answer with the local branch's commits.
 */
function unlistedReason(row: BranchRow, branches: GitBranches): string | null {
	const base = branches.default_branch;
	if (row.isDefault) return "This is the default branch.";
	if (!base) return "No default branch to compare with.";
	if (row.remote && branches.local.some((b) => b.name === row.label)) {
		return `Can't list these commits: a local branch is also named ${row.label}.`;
	}
	if (row.vs_default?.ahead === 0) return nothingHere(base);
	return null;
}

function nothingHere(base: string): string {
	return `Nothing here that ${base} doesn't have.`;
}

/**
 * A branch's commits that the default branch lacks — the ones its row counts
 * as `ahead` — under the branch's facts, in the page's one scroll area.
 *
 * Dots without lines: the range is cut wherever it meets the default branch,
 * and lanes would run on to commits that are never listed.
 */
function BranchCommits({
	row,
	branches,
	listed,
	scroller,
	content,
	onSelectCommit,
}: Props) {
	const base = branches.default_branch;
	const reason = unlistedReason(row, branches);
	const log = useGitLog(
		{ scope: "branch", branch: row.label },
		{ enabled: listed && reason === null },
	);
	const { data, isLoading, error } = log;
	const graphRows = useHistoryGraph(data?.pages, "branch", false);
	// HEAD's history is told by walking down from the row carrying HEAD,
	// which is a tip of this range only on the current branch — and there
	// every commit listed is HEAD's. Elsewhere it is not known, which keeps
	// `Ask AI to revert` offered with its own check in the prompt.
	const rows = useMemo(
		() =>
			row.current
				? graphRows.map((r) => ({ ...r, inHeadHistory: true }))
				: graphRows,
		[graphRows, row.current],
	);
	const { footer, loadMore, retry } = useHistoryPaging(
		log,
		`Older commits are on ${base} too`,
	);
	const { openMenu, menu } = useCommitMenu(rows);
	const [listTop, setListTop] = useState<HTMLElement | null>(null);
	// Measured live: a pinned failure, the inspect's banner, a name rewrapped
	// after a resize all move the list down the scroll area.
	const margin = useOffsetWithin(listTop, content);

	const heading =
		base && !row.isDefault
			? `Not on ${base}${row.vs_default ? ` (${row.vs_default.ahead})` : ""}`
			: null;

	return (
		<section aria-label={heading ?? "Commits"}>
			{heading && (
				<h2 className="px-3 pt-3 pb-1 text-xs uppercase text-th-text-muted">
					{heading}
				</h2>
			)}
			{menu}
			{reason ? (
				<Muted text={reason} />
			) : isLoading ? (
				<div className="flex items-center justify-center p-8">
					<Spinner variant="current" className="text-th-text-muted" />
				</div>
			) : data ? (
				rows.length === 0 ? (
					<Muted text={nothingHere(base)} />
				) : (
					<>
						<div ref={setListTop} />
						{scroller && (
							<HistoryList
								rows={rows}
								footer={footer}
								onLoadMore={loadMore}
								onRetry={retry}
								activeHash={null}
								onSelectCommit={onSelectCommit}
								onOpenMenu={openMenu}
								scroller={{ element: scroller, margin }}
							/>
						)}
					</>
				)
			) : (
				error && (
					<div className="p-4 text-center text-th-error">
						<div>Failed to load commits</div>
						<div className="mt-1 text-sm text-th-text-muted">
							{errorMessage(error)}
						</div>
					</div>
				)
			)}
		</section>
	);
}

function Muted({ text }: { text: string }) {
	return (
		<p className="break-words px-3 py-2 text-sm text-th-text-muted">{text}</p>
	);
}

export default BranchCommits;
