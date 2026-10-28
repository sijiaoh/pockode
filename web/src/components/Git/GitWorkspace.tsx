import { CoveredSurface, useIsExpanded } from "@pockode/shared";
import { useSharedMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useAutoFetch } from "../../hooks/useGitSync";
import type { BranchRow } from "../../lib/gitBranches";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { BranchRef, GitLayer, GitSegment } from "../../types/overlay";
import {
	branchRowKey,
	gitSegmentOf,
	historyQueryOf,
} from "../../types/overlay";
import PageHeader from "../Layout/PageHeader";
import BranchBar from "./BranchBar";
import BranchDetail from "./BranchDetail";
import CommitDiffView from "./CommitDiffView";
import CommitFileView from "./CommitFileView";
import CommitView from "./CommitView";
import DiffView from "./DiffView";
import { detailActionsPlacement } from "./detailActions";
import GitSegmentList, { activeRowsOf } from "./GitSegmentList";
import OperationBanner from "./OperationBanner";

interface Props {
	layer: GitLayer;
	/** Leaves the workspace, for the chat it was opened over. */
	onBack: () => void;
	/**
	 * Opens a segment's list. Also how a diff or a commit goes back to the list
	 * it was opened from.
	 */
	onSelectSegment: (segment: GitSegment) => void;
	onSelectFile: (path: string, staged: boolean) => void;
	onSelectCommit: (hash: string) => void;
	onSelectBranch: (branch: BranchRef) => void;
	/**
	 * Replaces the detail of `from` with `to`'s, or with the Branches list —
	 * only while that detail is still the one open in `worktree`.
	 */
	onRepointBranch: (
		from: BranchRef,
		to: BranchRef | null,
		worktree: string,
	) => void;
	/** Moves the review off a file just discarded from the list. */
	onCloseFile: (
		path: string,
		worktree: string,
		next: { path: string; staged: boolean } | null,
	) => void;
	/**
	 * Whether the sidebar's Git list is on screen beside this, at `expanded`:
	 * its Git tab selected and the column not collapsed. What a detail's
	 * presses report is then the list's to show, as it is beside a list
	 * (docs/git-branches-ui.md#the-pinned-area); without it the detail shows
	 * it, since nothing else on screen would.
	 */
	listBeside?: boolean;
	/**
	 * Whether the chat's composer under a detail holds a soft keyboard, which
	 * takes a detail's action bar off the screen (`DetailActionsPlacement`).
	 */
	keyboardUp?: boolean;
}

/**
 * The Git workspace (`/git`) in the main area.
 *
 * Below `expanded` it is a page of its own: three segments — Changes,
 * History, Branches — under a top bar naming the branch, and the diff, commit
 * and branch pages as layers that cover the list. At `expanded` the list is
 * the sidebar's Git tab (`GitTab`), and this is only the detail open from it,
 * across the whole main area; a list URL there is the chat
 * (`mainAreaOverlay`), so this is never handed one. The same URL is either:
 * what changes with the width is where its layers are on screen.
 */
function GitWorkspace({
	layer,
	onBack,
	onSelectSegment,
	onSelectFile,
	onSelectCommit,
	onSelectBranch,
	onRepointBranch,
	onCloseFile,
	listBeside = false,
	keyboardUp = false,
}: Props) {
	const isExpanded = useIsExpanded();
	const actionsAt = detailActionsPlacement(isExpanded, keyboardUp);
	const worktree = useWorktreeStore((s) => s.current);
	// Here rather than in BranchBar: it belongs to arriving in the workspace,
	// which this component lives exactly as long as; the bar is only where its
	// failure is shown. At `expanded` the Git tab arrives too, and the two
	// cannot both start one: a fetch running is never started again.
	useAutoFetch();
	const mergeHandoff = useSharedMergeHandoff();
	// Always a segment: every layer has one.
	const segment = gitSegmentOf(layer) ?? "changes";
	const detail = layer.type === "git" ? null : layer;
	const { activeFile, activeHash } = activeRowsOf(detail);

	// Whichever surface the delete was pressed in, a detail of the deleted
	// branch leaves for the list (docs/git-branches-ui.md#when-the-branch-goes-away).
	const onBranchDeleted = (row: BranchRow) =>
		onRepointBranch({ ref: row.label, remote: row.remote }, null, worktree);

	// The back of a detail is the list it came from. At `expanded` that list
	// is in the sidebar and its URL shows the chat, so the same press is drawn
	// as the way back to the chat.
	const backToList = () => onSelectSegment(segment);

	const renderDetail = (detail: Exclude<GitLayer, { type: "git" }>) => {
		switch (detail.type) {
			case "diff":
				return (
					// One instance per file: a stage answered for one file must not
					// report on, or navigate away from, the next one opened from the
					// list. Per file and not per side: switching sides is a move
					// within the file's review, and staging the file flips it.
					// The review leaves by itself, replacing, since it is one history
					// entry (docs/git-changes-ui.md).
					<DiffView
						key={detail.path}
						path={detail.path}
						staged={detail.staged}
						backToChat={isExpanded}
						actionsAt={actionsAt}
					/>
				);
			case "branch":
				// Keyed like the review: an inspect or a confirm raised over one
				// branch is not the next one's.
				return (
					<BranchDetail
						key={branchRowKey(detail)}
						branch={detail}
						onBack={backToList}
						backToChat={isExpanded}
						onLeave={() => onSelectSegment("branches")}
						holdsFailures={!(isExpanded && listBeside)}
						mergeHandoff={mergeHandoff}
						onRepoint={(to) => onRepointBranch(detail, to, worktree)}
						onBranchDeleted={onBranchDeleted}
						onSelectCommit={onSelectCommit}
					/>
				);
			case "commit": {
				// A commit opened from a branch goes back to that branch at every
				// width (docs/git-branches-ui.md#opening-a-commit).
				const { branch } = detail;
				return (
					// Keyed like the review: a sheet raised over one commit, and a
					// failed handoff from it, are not the next commit's.
					<CommitView
						key={detail.hash}
						hash={detail.hash}
						onBack={branch ? () => onSelectBranch(branch) : backToList}
						backToChat={isExpanded}
					/>
				);
			}
			case "commit-diff":
				return (
					// Per file, like the review: a line selection, and a failed
					// handoff of it, are not the next file's.
					<CommitDiffView
						key={`${detail.hash}\0${detail.path}`}
						hash={detail.hash}
						path={detail.path}
						actionsAt={actionsAt}
					/>
				);
			case "commit-file":
				return (
					<CommitFileView
						hash={detail.hash}
						path={detail.path}
						actionsAt={actionsAt}
					/>
				);
		}
	};

	// Wide, the list is never here: it is the sidebar's.
	const hasList = !isExpanded;
	const listOnScreen = hasList && detail === null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Over the list, the page is the workspace and names itself so; a
			    layer is a page of its own, and names itself. */}
			{listOnScreen && (
				<PageHeader back={{ to: "chat", onClick: onBack }} title="Git" />
			)}

			{/* Only over a list: a layer is for reading, and a sync's progress
			    and failure wait for the list, which is one Back away — the store
			    keeps the outcome until it is shown. The Branches list pins the
			    branch failures itself; any other list leaves them here. Wide,
			    the bar is the Git tab's. */}
			{listOnScreen && (
				<BranchBar
					onOpenBranches={() => onSelectSegment("branches")}
					branchFailureSurface={segment === "branches"}
					mergeHandoff={mergeHandoff}
				/>
			)}

			{/* A layer has no room for the whole banner over its content; its
			    actions are over the list — one Back away, or beside it in the
			    sidebar at `expanded`, so they are never a second form. */}
			<OperationBanner
				compact={!listOnScreen}
				onSelectFile={(path) => onSelectFile(path, false)}
			/>

			<div className="relative flex min-h-0 flex-1">
				{/* Covered rather than unmounted under a layer: the list's scroll
				    position is what Back returns the reader to. And covered with
				    `invisible`, not `hidden`: `display: none` destroys the scroll
				    box it is kept for (docs/answering-ui.md, the transcript under
				    an overlay). */}
				{hasList && (
					<div
						inert={!listOnScreen}
						className={
							listOnScreen
								? "flex min-w-0 flex-1 flex-col"
								: "invisible absolute inset-0 flex flex-col"
						}
					>
						<CoveredSurface covered={!listOnScreen}>
							<GitSegmentList
								segment={segment}
								history={historyQueryOf(layer)}
								activeFile={activeFile}
								activeHash={activeHash}
								// Never lit: a branch's detail covers the list here.
								activeBranchKey={null}
								mergeHandoff={mergeHandoff}
								onSelectSegment={onSelectSegment}
								onSelectFile={onSelectFile}
								onCloseFile={onCloseFile}
								onSelectCommit={onSelectCommit}
								onSelectBranch={onSelectBranch}
								onBranchDeleted={onBranchDeleted}
							/>
						</CoveredSurface>
					</div>
				)}
				{detail && (
					<div className="flex min-w-0 flex-1 flex-col">
						{renderDetail(detail)}
					</div>
				)}
			</div>
		</div>
	);
}

export default GitWorkspace;
