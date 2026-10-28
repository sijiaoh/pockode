import { CoveredSurface, useIsExpanded } from "@pockode/shared";
import { useMemo } from "react";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useAutoFetch } from "../../hooks/useGitSync";
import { flattenGitStatus } from "../../types/git";
import type { GitSegment, OverlayState } from "../../types/overlay";
import { gitSegmentOf } from "../../types/overlay";
import PageHeader, { InlinePageHeaders } from "../Layout/PageHeader";
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
				return <CommitView hash={detail.hash} onBack={backToList} />;
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
			/>

			{/* Narrow, a layer has no room for the whole banner over its content;
			    the actions are one Back away. Wide, the banner spans both
			    columns, so it is never a second form. */}
			<OperationBanner
				compact={!listOnScreen}
				onSelectFile={(path) => onSelectFile(path, false)}
			/>

			<div className="relative flex min-h-0 flex-1">
				{/* Covered rather than unmounted under a narrow layer: the list's
				    scroll position is what Back returns the reader to. And covered
				    with `invisible`, not `hidden`: `display: none` destroys the
				    scroll box it is kept for (docs/answering-ui.md, the transcript
				    under an overlay). */}
				<div
					inert={!listOnScreen}
					className={
						!listOnScreen
							? "invisible absolute inset-0 flex flex-col"
							: twoColumns
								? "flex w-[clamp(280px,35%,400px)] shrink-0 flex-col border-r border-th-border"
								: "flex min-w-0 flex-1 flex-col"
					}
				>
					<CoveredSurface covered={!listOnScreen}>
						{/* The control keeps its place and its width when Branches
					    drops the second column: a control that moves once pressed
					    sends the next press somewhere else. */}
						<div
							className={
								isExpanded && !twoColumns
									? "w-[clamp(280px,35%,400px)]"
									: undefined
							}
						>
							<SegmentedControl
								label="Which part of the repository to show"
								items={SEGMENTS}
								selected={segment}
								onSelect={onSelectSegment}
							/>
						</div>
						<div
							className={`flex min-h-0 flex-1 flex-col ${
								isExpanded && !twoColumns ? "w-full max-w-xl" : ""
							}`}
						>
							{segment === "changes" ? (
								<ChangesSection
									onSelectFile={onSelectFile}
									onCloseFile={onCloseFile}
									onViewHistory={() => onSelectSegment("history")}
									activeFile={activeFile}
								/>
							) : segment === "history" ? (
								<HistorySection
									activeHash={activeCommitHash}
									onSelectCommit={onSelectCommit}
								/>
							) : (
								<BranchesSection />
							)}
						</div>
					</CoveredSurface>
				</div>

				{detail ? (
					<div className="flex min-w-0 flex-1 flex-col">
						<InlinePageHeaders inline={isExpanded}>
							{renderDetail(detail)}
						</InlinePageHeaders>
					</div>
				) : (
					isExpanded &&
					segment !== "branches" && <EmptyDetail segment={segment} />
				)}
			</div>
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
function EmptyDetail({ segment }: { segment: "changes" | "history" }) {
	return segment === "changes" ? (
		<EmptyChangesDetail />
	) : (
		<EmptyHistoryDetail />
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

function EmptyHistoryDetail() {
	const { data: log } = useGitLog();
	const message = !log
		? null
		: log.commits.length > 0
			? "Select a commit to see what it changed"
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
