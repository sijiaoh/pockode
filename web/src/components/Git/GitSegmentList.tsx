import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import type { BranchRow } from "../../lib/gitBranches";
import {
	type BranchRef,
	branchRowKey,
	commitOriginOf,
	type GitLayer,
	type GitSegment,
	type HistoryQuery,
} from "../../types/overlay";
import SegmentedControl from "../ui/SegmentedControl";
import BranchesSection from "./BranchesSection";
import ChangesSection from "./ChangesSection";
import HistorySection from "./HistorySection";

const SEGMENTS = [
	{ value: "changes", label: "Changes" },
	{ value: "history", label: "History" },
	{ value: "branches", label: "Branches" },
] as const satisfies readonly { value: GitSegment; label: string }[];

/**
 * The rows a list lights for `layer`, the detail open in the main area. A
 * commit opened from a branch keeps that branch lit, as a commit keeps its row
 * lit in History; and a file of a commit keeps the commit lit.
 */
export function activeRowsOf(layer: GitLayer | null) {
	const branch = layer ? commitOriginOf(layer).branch : undefined;
	return {
		activeFile:
			layer?.type === "diff"
				? { path: layer.path, staged: layer.staged }
				: null,
		activeHash:
			layer?.type === "commit" ||
			layer?.type === "commit-diff" ||
			layer?.type === "commit-file"
				? layer.hash
				: null,
		activeBranchKey: branch ? branchRowKey(branch) : null,
	};
}

interface Props {
	segment: GitSegment;
	history: HistoryQuery;
	/** The rows to light for what the main area has open. */
	activeFile: { path: string; staged: boolean } | null;
	activeHash: string | null;
	activeBranchKey: string | null;
	/**
	 * Set while the lit row is wanted on screen; called once the list has
	 * scrolled to it. Left out where the list keeps its own place (the page
	 * below `expanded`).
	 */
	reveal?: () => void;
	mergeHandoff: BranchMergeHandoff;
	onSelectSegment: (segment: GitSegment) => void;
	onSelectFile: (path: string, staged: boolean) => void;
	onCloseFile: (
		path: string,
		worktree: string,
		next: { path: string; staged: boolean } | null,
	) => void;
	onSelectCommit: (hash: string) => void;
	/**
	 * Changes' `onShowFileHistory` and History's `onShowHistory`: left out
	 * where the URL holds the list.
	 */
	onShowFileHistory?: (path: string) => void;
	onShowHistory?: (next: HistoryQuery) => void;
	onSelectBranch: (branch: BranchRef) => void;
	onBranchDeleted: (row: BranchRow) => void;
}

/**
 * The segment control and the list under it: the Git workspace's page below
 * `expanded`, and the sidebar's Git tab at `expanded` — one list, wherever the
 * width puts it, so each of its writes is on screen in one place.
 */
function GitSegmentList({
	segment,
	history,
	activeFile,
	activeHash,
	activeBranchKey,
	reveal,
	mergeHandoff,
	onSelectSegment,
	onSelectFile,
	onCloseFile,
	onSelectCommit,
	onShowFileHistory,
	onShowHistory,
	onSelectBranch,
	onBranchDeleted,
}: Props) {
	return (
		<>
			<SegmentedControl
				label="Which part of the repository to show"
				items={SEGMENTS}
				selected={segment}
				onSelect={onSelectSegment}
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				{segment === "changes" ? (
					<ChangesSection
						onSelectFile={onSelectFile}
						onCloseFile={onCloseFile}
						activeFile={activeFile}
						reveal={reveal}
						onShowFileHistory={onShowFileHistory}
					/>
				) : segment === "history" ? (
					<HistorySection
						history={history}
						activeHash={activeHash}
						reveal={reveal}
						onSelectCommit={onSelectCommit}
						onShowHistory={onShowHistory}
					/>
				) : (
					<BranchesSection
						mergeHandoff={mergeHandoff}
						activeKey={activeBranchKey}
						reveal={reveal}
						onSelectBranch={(row) =>
							onSelectBranch({ ref: row.label, remote: row.remote })
						}
						onBranchDeleted={onBranchDeleted}
					/>
				)}
			</div>
		</>
	);
}

export default GitSegmentList;
