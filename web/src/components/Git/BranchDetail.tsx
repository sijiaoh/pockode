import { useEffect, useRef, useState } from "react";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useGitBranches } from "../../hooks/useGitBranches";
import {
	type BranchRow,
	branchStateWords,
	branchUpstreamLine,
	branchVsDefaultLine,
	findBranchRow,
} from "../../lib/gitBranches";
import type { GitBranches } from "../../types/git";
import { type BranchRef, branchRowKey } from "../../types/overlay";
import { formatDateTime } from "../../utils/dateTime";
import { errorMessage } from "../../utils/errorMessage";
import { formatRelativeDate } from "../../utils/relativeTime";
import PageHeader, { type PageBack } from "../Layout/PageHeader";
import Skeleton from "../ui/Skeleton";
import {
	BranchActionRows,
	type BranchActions,
	PinnedBranchFailures,
	useBranchActions,
} from "./BranchActions";
import BranchCommits from "./BranchCommits";
import BranchName from "./BranchName";

interface Props {
	branch: BranchRef;
	/**
	 * Back to the Branches list. Absent where that list is on screen beside
	 * it.
	 */
	onBack?: () => void;
	/** To the Branches list, from the notice of a branch that is gone. */
	onLeave: () => void;
	/**
	 * Whether the branch failures are pinned here: below `expanded`, where
	 * the list's pinned area is covered by this page
	 * (docs/git-branches-ui.md#the-pinned-area).
	 */
	holdsFailures: boolean;
	/** The workspace's, so that it outlives this page. */
	mergeHandoff: BranchMergeHandoff;
	/** This branch is now listed under another identity; open that one. */
	onRepoint: (to: BranchRef) => void;
	onBranchDeleted: (row: BranchRow) => void;
	/** Opens one of its commits, stacked on this branch. */
	onSelectCommit: (hash: string) => void;
}

/**
 * A branch's detail (docs/git-branches-ui.md#the-branch): what it is, where
 * it lives, how far it is from the default branch, and what can be done with
 * it — the `⋯`'s actions, laid out with their reasons — and the commits only
 * it has.
 *
 * It reads the list's own query and finds its row by key, so it cannot
 * describe a different moment from the list beside it.
 */
function BranchDetail({
	branch,
	onBack,
	onLeave,
	holdsFailures,
	mergeHandoff,
	onRepoint,
	onBranchDeleted,
	onSelectCommit,
}: Props) {
	const { data: branches, isLoading, error } = useGitBranches();
	const actions = useBranchActions(mergeHandoff, onBranchDeleted);
	const { checkout } = actions;

	const found = branches ? findBranchRow(branches, branchRowKey(branch)) : null;
	// What this page last showed, for the two moments the row is gone and the
	// page is not done with it: a delete of it still answering, and a remote
	// branch whose local name is needed once it has become local.
	const lastRow = useRef<BranchRow | null>(null);
	if (found) lastRow.current = found;
	const last = lastRow.current;
	const deletingThis =
		last !== null && !last.remote && checkout.deleting === last.name;
	// Held past the delete's end until the branch is listed again: a delete
	// that succeeded clears `deleting` a render before its confirm hands the
	// page back, and the gone notice would flash in between.
	const deletedHere = useRef(false);
	if (deletingThis) deletedHere.current = true;
	else if (found) deletedHere.current = false;
	const row = found ?? (deletedHere.current ? last : null);

	// A remote-only branch stops being listed once a local one tracks it —
	// whoever created that. The same work is now under the name the list
	// shows it by. The local name is the remote row's `name`, not something to
	// cut out of its ref: a remote's name may have slashes. A page that never
	// saw the remote row — opened after the change, by a commit's `Back to
	// branch` or a link — finds the local branch by what it tracks instead.
	const localName =
		!found && branch.remote && branches
			? branches.local.find((b) =>
					last ? b.name === last.name : b.upstream === branch.ref,
				)?.name
			: undefined;
	const becameLocal = localName !== undefined;
	// Once: the page is keyed by branch, and the new one is another page.
	const repointed = useRef(false);
	useEffect(() => {
		if (localName === undefined || repointed.current) return;
		repointed.current = true;
		onRepoint({ ref: localName, remote: false });
	}, [localName, onRepoint]);

	const back: PageBack | undefined = onBack && {
		to: "parent",
		label: "Back to branches",
		onClick: onBack,
	};
	// State rather than refs: the commits' list needs both mounted before it
	// can lay itself out in them.
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const [content, setContent] = useState<HTMLElement | null>(null);

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<PageHeader
				back={back}
				title={
					<span className="flex min-w-0">
						<BranchName name={branch.ref} />
					</span>
				}
				fullText={branch.ref}
			/>
			{/* One scroll area: the facts, the actions and the commits
			    scroll together, so a long name cannot push the rest off a
			    phone. No vertical padding of its own, for the pinned box. */}
			<div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
				{branches ? (
					<div ref={setContent}>
						{/* Over the gone notice too: a delete that failed because
						    the branch went is still a failure to show. */}
						{holdsFailures && (
							<div className="sticky top-0 z-10 bg-th-bg-primary">
								<PinnedBranchFailures
									checkout={checkout}
									handoff={mergeHandoff}
								/>
							</div>
						)}
						{row ? (
							<>
								<BranchPage row={row} branches={branches} actions={actions} />
								<BranchCommits
									row={row}
									branches={branches}
									listed={found !== null}
									scroller={scroller}
									content={content}
									onSelectCommit={onSelectCommit}
								/>
							</>
						) : (
							!becameLocal && <BranchGone name={branch.ref} onLeave={onLeave} />
						)}
					</div>
				) : isLoading ? (
					<FactsSkeleton />
				) : (
					error && (
						<div className="p-4 text-center text-th-error">
							<div>Failed to load branches</div>
							<div className="mt-1 text-sm text-th-text-muted">
								{errorMessage(error)}
							</div>
						</div>
					)
				)}
			</div>
			{actions.dialog}
		</div>
	);
}

function BranchPage({
	row,
	branches,
	actions,
}: {
	row: BranchRow;
	branches: GitBranches;
	actions: BranchActions;
}) {
	const states = branchStateWords(row);
	const vsDefault = branchVsDefaultLine(row, branches.default_branch);

	return (
		<>
			<div className="border-b border-th-border p-4">
				{/* The one place the whole name is guaranteed readable: wrapped,
				    never truncated, and selectable for copying. */}
				<div className="break-all text-base font-medium text-th-text-primary">
					{row.label}
				</div>
				{states.length > 0 && (
					<div className="mt-1 text-xs text-th-text-muted">
						{states.join(" · ")}
					</div>
				)}
				<div className="mt-3 space-y-1 text-sm text-th-text-secondary">
					<p>{branchUpstreamLine(row)}</p>
					{vsDefault && <p>{vsDefault}</p>}
					<p title={formatDateTime(row.committed_at)}>
						Last commit {formatRelativeDate(row.committed_at)} by{" "}
						{row.committer}
					</p>
				</div>
			</div>

			{/* None on the current branch, as its row has no `⋯`: every one
			    would be unavailable for the same reason, which the facts
			    already say. */}
			{!row.current && (
				<div className="border-b border-th-border">
					<BranchActionRows row={row} head={branches.head} actions={actions} />
				</div>
			)}
		</>
	);
}

/**
 * The branch is not there — gone since it was opened, or never there for a
 * typed URL. Said, and left to the user: a page that vanishes under a reader
 * looks like a bug.
 */
function BranchGone({ name, onLeave }: { name: string; onLeave: () => void }) {
	return (
		<div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-th-text-muted">
			<p className="break-all">No branch named {name}.</p>
			<button
				type="button"
				onClick={onLeave}
				className="inline-flex min-h-[36px] items-center px-2 text-th-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
			>
				Back to branches
			</button>
		</div>
	);
}

function FactsSkeleton() {
	return (
		<div className="space-y-2 p-4" aria-hidden="true">
			<Skeleton className="h-5 w-48 max-w-full rounded" />
			<Skeleton className="h-4 w-64 max-w-full rounded" />
			<Skeleton className="h-4 w-40 max-w-full rounded" />
		</div>
	);
}

export default BranchDetail;
