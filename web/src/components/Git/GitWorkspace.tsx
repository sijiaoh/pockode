import { CoveredSurface, useIsExpanded } from "@pockode/shared";
import { useId, useMemo, useRef } from "react";
import { useBranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useAutoFetch } from "../../hooks/useGitSync";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { flattenGitStatus } from "../../types/git";
import type { GitSegment, OverlayState } from "../../types/overlay";
import {
	gitSegmentOf,
	type HistoryQuery,
	historyQueryOf,
} from "../../types/overlay";
import PageHeader, { InlinePageHeaders } from "../Layout/PageHeader";
import ResizeHandle from "../ui/ResizeHandle";
import SegmentedControl from "../ui/SegmentedControl";
import BranchBar from "./BranchBar";
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
	{ type: "git" | "diff" | "commit" | "commit-diff" | "commit-file" }
>;

const SEGMENTS = [
	{ value: "changes", label: "Changes" },
	{ value: "history", label: "History" },
	{ value: "branches", label: "Branches" },
] as const satisfies readonly { value: GitSegment; label: string }[];

// The list column at `expanded`. The minimum is the narrowest its rows have
// been checked at, above the narrow-width rule's 240px (docs/sidebar-ui.md);
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
	/** Moves the review off a file just discarded from the list. */
	onCloseFile: (
		path: string,
		worktree: string,
		next: { path: string; staged: boolean } | null,
	) => void;
}

/**
 * The Git workspace (`/git`): a top bar naming the branch, three segments —
 * Changes, History, Branches — and the diff and commit pages as layers under
 * the first two.
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
	onCloseFile,
}: Props) {
	const isExpanded = useIsExpanded();
	// Here rather than in BranchBar: it belongs to arriving in the workspace,
	// which this component lives exactly as long as; the bar is only where its
	// failure is shown.
	useAutoFetch();
	// Here rather than in BranchesSection, which unmounts with its segment.
	const mergeHandoff = useBranchMergeHandoff();
	// Always a segment: every layer has one.
	const segment = gitSegmentOf(layer) ?? "changes";
	const detail = layer.type === "git" ? null : layer;
	// Branches have no layer, and a column that could only ever stay empty
	// would promise one.
	const twoColumns = isExpanded && segment !== "branches";

	const activeFile =
		layer.type === "diff" ? { path: layer.path, staged: layer.staged } : null;
	const activeCommitHash = layer.type === "git" ? null : commitHashOf(layer);

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
			case "commit":
				// Keyed like the review: a sheet raised over one commit, and a
				// failed handoff from it, are not the next commit's.
				return (
					<CommitView
						key={detail.hash}
						hash={detail.hash}
						onBack={backToList}
					/>
				);
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
				branchesOnScreen={segment === "branches"}
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
				twoColumns={twoColumns}
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
							onViewHistory={() => onSelectSegment("history")}
							activeFile={activeFile}
						/>
					) : segment === "history" ? (
						<HistorySection
							history={historyQueryOf(layer)}
							activeHash={activeCommitHash}
							onSelectCommit={onSelectCommit}
						/>
					) : (
						<BranchesSection mergeHandoff={mergeHandoff} />
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
						isExpanded &&
						segment !== "branches" && (
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
	twoColumns,
	control,
	list,
	detail,
}: {
	isExpanded: boolean;
	listOnScreen: boolean;
	twoColumns: boolean;
	control: React.ReactNode;
	list: React.ReactNode;
	detail: React.ReactNode;
}) {
	// One width for every segment, so the segmented control above the list
	// stays where it was when the segment changes — Branches' included, which
	// has no column to resize but keeps the control at the same width.
	const rowRef = useRef<HTMLDivElement>(null);
	const rowWidth = useElementWidth(rowRef);
	const listWidth = useResizableWidth({
		storageKey: "pockode:gitListWidth",
		min: LIST_MIN_WIDTH,
		max: rowWidth - DETAIL_MIN_WIDTH,
		defaultWidth: listDefaultWidth(rowWidth),
		active: twoColumns,
	});
	const listId = useId();
	const singleWide = isExpanded && !twoColumns;

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
						: twoColumns
							? "relative flex shrink-0 flex-col border-r border-th-border"
							: "flex min-w-0 flex-1 flex-col"
				}
				style={twoColumns ? { width: listWidth.width } : undefined}
			>
				<CoveredSurface covered={!listOnScreen}>
					{/* The control keeps its place and its width when Branches
					    drops the second column: a control that moves once pressed
					    sends the next press somewhere else. The transparent border
					    stands for the list column's own, which its width includes. */}
					<div
						className={singleWide ? "border-r border-transparent" : undefined}
						style={singleWide ? { width: listWidth.width } : undefined}
					>
						{control}
					</div>
					<div
						className={`flex min-h-0 flex-1 flex-col ${
							singleWide ? "w-full max-w-xl" : ""
						}`}
					>
						{list}
					</div>
				</CoveredSurface>
				{twoColumns && (
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
	return layer.type === "diff" ? null : layer.hash;
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
	segment: "changes" | "history";
	history: HistoryQuery;
}) {
	return segment === "changes" ? (
		<EmptyChangesDetail />
	) : (
		<EmptyHistoryDetail history={history} />
	);
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

function EmptyDetailMessage({ message }: { message: string | null }) {
	return (
		<div className="flex min-w-0 flex-1 items-center justify-center p-4 text-center text-sm text-th-text-muted">
			{message}
		</div>
	);
}

export default GitWorkspace;
