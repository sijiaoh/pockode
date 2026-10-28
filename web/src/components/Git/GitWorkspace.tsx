import { CoveredSurface, useIsExpanded } from "@pockode/shared";
import { useId, useMemo, useRef } from "react";
import { useBranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useAutoFetch } from "../../hooks/useGitSync";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import type { BranchRow } from "../../lib/gitBranches";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { flattenGitStatus } from "../../types/git";
import type { GitSegment, OverlayState } from "../../types/overlay";
import {
	type BranchRef,
	branchRowKey,
	commitOriginOf,
	gitSegmentOf,
	type HistoryQuery,
	historyQueryOf,
} from "../../types/overlay";
import PageHeader, { InlinePageHeaders } from "../Layout/PageHeader";
import ResizeHandle from "../ui/ResizeHandle";
import SegmentedControl from "../ui/SegmentedControl";
import BranchBar from "./BranchBar";
import BranchDetail from "./BranchDetail";
import BranchesSection from "./BranchesSection";
import ChangesSection from "./ChangesSection";
import CommitDiffView from "./CommitDiffView";
import CommitFileView from "./CommitFileView";
import CommitView from "./CommitView";
import DiffView from "./DiffView";
import HistorySection from "./HistorySection";
import OperationBanner from "./OperationBanner";

/** A layer of the workspace: the overlays `gitSegmentOf` gives a segment. */
export type GitLayer = Extract<
	NonNullable<OverlayState>,
	{
		type: "git" | "diff" | "branch" | "commit" | "commit-diff" | "commit-file";
	}
>;

const SEGMENTS = [
	{ value: "changes", label: "Changes" },
	{ value: "history", label: "History" },
	{ value: "branches", label: "Branches" },
] as const satisfies readonly { value: GitSegment; label: string }[];

// The list column at `expanded`. The minimum is the narrowest its rows have
// been checked at, the narrow-width rule's 280px (docs/sidebar-ui.md);
// the detail column is left at least DETAIL_MIN_WIDTH, the width a diff stays
// readable at, unless the minimum itself does not fit.
const LIST_MIN_WIDTH = 280;
const DETAIL_MIN_WIDTH = 480;
const LIST_DEFAULT_MIN = 320;
const LIST_DEFAULT_SHARE = 0.4;
const LIST_DEFAULT_MAX = 560;

function listDefaultWidth(rowWidth: number): number {
	return Math.round(
		Math.min(
			LIST_DEFAULT_MAX,
			Math.max(LIST_DEFAULT_MIN, rowWidth * LIST_DEFAULT_SHARE),
		),
	);
}

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
}

/**
 * The Git workspace (`/git`): a top bar naming the branch, three segments —
 * Changes, History, Branches — and the diff, commit and branch pages as layers
 * under them.
 *
 * Below `expanded` a layer fills the screen on its own; at `expanded` the list
 * and the layer under it stand side by side. The same URL is either: what
 * changes with the width is only how many of its layers are on screen.
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
}: Props) {
	const isExpanded = useIsExpanded();
	const worktree = useWorktreeStore((s) => s.current);
	// Here rather than in BranchBar: it belongs to arriving in the workspace,
	// which this component lives exactly as long as; the bar is only where its
	// failure is shown.
	useAutoFetch();
	// Here rather than in BranchesSection, which unmounts with its segment.
	const mergeHandoff = useBranchMergeHandoff();
	// Always a segment: every layer has one.
	const segment = gitSegmentOf(layer) ?? "changes";
	const detail = layer.type === "git" ? null : layer;

	const activeFile =
		layer.type === "diff" ? { path: layer.path, staged: layer.staged } : null;
	const activeCommitHash = layer.type === "git" ? null : commitHashOf(layer);
	// Lit only beside the list: below `expanded` a detail covers it. A commit
	// opened from a branch keeps that branch lit, as a commit keeps its row lit
	// in History.
	// `commitOriginOf` gives the branch of a branch's detail too.
	const openBranch = commitOriginOf(layer).branch;
	const activeBranchKey =
		isExpanded && openBranch ? branchRowKey(openBranch) : null;

	// Whichever surface the delete was pressed in, a detail of the deleted
	// branch leaves for the list (docs/git-branches-ui.md#when-the-branch-goes-away).
	const onBranchDeleted = (row: BranchRow) =>
		onRepointBranch({ ref: row.label, remote: row.remote }, null, worktree);

	// Narrow, the back of a detail is the list it came from: the list is not on
	// screen to go back to by any other way. Wide, it is.
	const backToList = isExpanded ? undefined : () => onSelectSegment(segment);

	const renderDetail = (detail: Exclude<GitLayer, { type: "git" }>) => {
		switch (detail.type) {
			case "diff":
				return (
					// One instance per file: a stage answered for one file must not
					// report on, or navigate away from, the next one opened beside
					// the list. Per file and not per side: switching sides is a move
					// within the file's review, and staging the file flips it.
					<DiffView
						key={detail.path}
						path={detail.path}
						staged={detail.staged}
						// Not `backToList`: the review replaces its way out, since it
						// is one history entry (docs/git-changes-ui.md).
						showBack={!isExpanded}
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
						onLeave={() => onSelectSegment("branches")}
						holdsFailures={!isExpanded}
						mergeHandoff={mergeHandoff}
						onRepoint={(to) => onRepointBranch(detail, to, worktree)}
						onBranchDeleted={onBranchDeleted}
						onSelectCommit={onSelectCommit}
					/>
				);
			case "commit": {
				// A commit opened from a branch goes back to that branch at every
				// width: beside the list it is the branch's page that is not on
				// screen, not the list (docs/git-branches-ui.md#opening-a-commit).
				const { branch } = detail;
				return (
					// Keyed like the review: a sheet raised over one commit, and a
					// failed handoff from it, are not the next commit's.
					<CommitView
						key={detail.hash}
						hash={detail.hash}
						onBack={branch ? () => onSelectBranch(branch) : backToList}
					/>
				);
			}
			case "commit-diff":
				return <CommitDiffView hash={detail.hash} path={detail.path} />;
			case "commit-file":
				return <CommitFileView hash={detail.hash} path={detail.path} />;
		}
	};

	const listOnScreen = isExpanded || detail === null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Wide, the app header names the workspace, since it cannot name both
			    columns at once; each layer names itself at the top of its column
			    instead. Narrow, a layer is the page, and it names itself there. */}
			{listOnScreen && (
				<PageHeader back={{ to: "chat", onClick: onBack }} title="Git" />
			)}

			{/* On every layer, not only the lists: a sync left running when its
			    sheet was closed reports through the chip and nowhere else. */}
			<BranchBar
				onOpenBranches={() => onSelectSegment("branches")}
				branchFailureSurface={branchFailureSurface(layer, isExpanded)}
				mergeHandoff={mergeHandoff}
			/>

			{/* Narrow, a layer has no room for the whole banner over its content;
			    the actions are one Back away. Wide, the banner spans both
			    columns, so it is never a second form. */}
			<OperationBanner
				compact={!listOnScreen}
				onSelectFile={(path) => onSelectFile(path, false)}
			/>

			<WorkspaceColumns
				isExpanded={isExpanded}
				listOnScreen={listOnScreen}
				control={
					<SegmentedControl
						label="Which part of the repository to show"
						items={SEGMENTS}
						selected={segment}
						onSelect={onSelectSegment}
					/>
				}
				list={
					segment === "changes" ? (
						<ChangesSection
							onSelectFile={onSelectFile}
							onCloseFile={onCloseFile}
							activeFile={activeFile}
						/>
					) : segment === "history" ? (
						<HistorySection
							history={historyQueryOf(layer)}
							activeHash={activeCommitHash}
							onSelectCommit={onSelectCommit}
						/>
					) : (
						<BranchesSection
							mergeHandoff={mergeHandoff}
							activeKey={activeBranchKey}
							onSelectBranch={(row) =>
								onSelectBranch({ ref: row.label, remote: row.remote })
							}
							onBranchDeleted={onBranchDeleted}
						/>
					)
				}
				detail={
					detail ? (
						<div className="flex min-w-0 flex-1 flex-col">
							<InlinePageHeaders inline={isExpanded}>
								{renderDetail(detail)}
							</InlinePageHeaders>
						</div>
					) : (
						isExpanded && (
							<EmptyDetail segment={segment} history={historyQueryOf(layer)} />
						)
					)
				}
			/>
		</div>
	);
}

/**
 * The row under the bars: the list column and, beside it, the detail.
 *
 * The list's width lives here rather than in GitWorkspace so that a drag,
 * which sets it on every pointer move, re-renders only this frame: the
 * columns' contents arrive as elements already made and are not rendered
 * again for it.
 */
function WorkspaceColumns({
	isExpanded,
	listOnScreen,
	control,
	list,
	detail,
}: {
	isExpanded: boolean;
	listOnScreen: boolean;
	control: React.ReactNode;
	list: React.ReactNode;
	detail: React.ReactNode;
}) {
	// One width for every segment, so the segmented control above the list
	// stays where it was when the segment changes: a control that moves once
	// pressed sends the next press somewhere else.
	const rowRef = useRef<HTMLDivElement>(null);
	const rowWidth = useElementWidth(rowRef);
	const listWidth = useResizableWidth({
		storageKey: "pockode:gitListWidth",
		min: LIST_MIN_WIDTH,
		max: rowWidth - DETAIL_MIN_WIDTH,
		defaultWidth: listDefaultWidth(rowWidth),
		active: isExpanded,
	});
	const listId = useId();

	return (
		<div ref={rowRef} className="relative flex min-h-0 flex-1">
			{/* Covered rather than unmounted under a narrow layer: the list's
			    scroll position is what Back returns the reader to. And covered
			    with `invisible`, not `hidden`: `display: none` destroys the
			    scroll box it is kept for (docs/answering-ui.md, the transcript
			    under an overlay). */}
			<div
				id={listId}
				inert={!listOnScreen}
				className={
					!listOnScreen
						? "invisible absolute inset-0 flex flex-col"
						: isExpanded
							? "relative flex shrink-0 flex-col border-r border-th-border"
							: "flex min-w-0 flex-1 flex-col"
				}
				style={isExpanded ? { width: listWidth.width } : undefined}
			>
				<CoveredSurface covered={!listOnScreen}>
					{control}
					<div className="flex min-h-0 flex-1 flex-col">{list}</div>
				</CoveredSurface>
				{isExpanded && (
					<ResizeHandle
						resize={listWidth}
						label="Resize list"
						controls={listId}
						onDoubleClick={listWidth.reset}
					/>
				)}
			</div>
			{detail}
		</div>
	);
}

function commitHashOf(layer: Exclude<GitLayer, { type: "git" }>) {
	return layer.type === "diff" || layer.type === "branch" ? null : layer.hash;
}

/**
 * Whether a surface that pins the branch failures — a switch's, a delete's,
 * a merge handoff's — is on screen; where none is, the top bar shows them
 * (docs/git-branches-ui.md#the-pinned-area). Beside the list, the list's
 * pinned area holds them, whatever is open next to it. Below `expanded`, the
 * bare list does, and so does a branch's detail, which covers the list.
 */
function branchFailureSurface(layer: GitLayer, isExpanded: boolean): boolean {
	if (isExpanded) return gitSegmentOf(layer) === "branches";
	return (
		(layer.type === "git" && layer.segment === "branches") ||
		layer.type === "branch"
	);
}

/**
 * The second column with nothing chosen in the first. Said in words, so that
 * it cannot be taken for a column still loading; left blank while the list
 * itself is loading or has failed, which the list is already saying.
 *
 * One component per segment, so that each reads only its own list's query —
 * an observed log would be refetched on every git.changed while the reader
 * is in Changes.
 */
function EmptyDetail({
	segment,
	history,
}: {
	segment: GitSegment;
	history: HistoryQuery;
}) {
	switch (segment) {
		case "changes":
			return <EmptyChangesDetail />;
		case "history":
			return <EmptyHistoryDetail history={history} />;
		case "branches":
			return <EmptyBranchesDetail />;
	}
}

function EmptyChangesDetail() {
	const { data: status } = useGitStatus();
	const message = useMemo(() => {
		if (!status) return null;
		const flat = flattenGitStatus(status);
		return flat.staged.length + flat.unstaged.length > 0
			? "Select a file to see its diff"
			: "No changes to review";
	}, [status]);
	return <EmptyDetailMessage message={message} />;
}

/** Reads the list's own query, so it shares the list's cache entry. */
function EmptyHistoryDetail({ history }: { history: HistoryQuery }) {
	const { data: log } = useGitLog(history);
	const message = !log
		? null
		: (log.pages[0]?.commits.length ?? 0) > 0
			? "Select a commit to see what it changed"
			: history.q || history.file
				? "No matching commits"
				: "No commits yet";
	return <EmptyDetailMessage message={message} />;
}

function EmptyBranchesDetail() {
	const { data: branches } = useGitBranches();
	const message = !branches
		? null
		: branches.local.length + branches.remote_only.length > 0
			? "Select a branch to see its commits"
			: "No branches yet";
	return <EmptyDetailMessage message={message} />;
}

function EmptyDetailMessage({ message }: { message: string | null }) {
	return (
		<div className="flex min-w-0 flex-1 items-center justify-center p-4 text-center text-sm text-th-text-muted">
			{message}
		</div>
	);
}

export default GitWorkspace;
