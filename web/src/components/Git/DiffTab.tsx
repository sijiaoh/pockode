import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import { gitPanelActions, useHistoryExpanded } from "../../lib/gitPanelStore";
import { WorktreeChangedError } from "../../lib/gitWriteStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeDiscard,
	type FileStatus,
	flattenGitStatus,
	stageFailureSummary,
} from "../../types/git";
import { describeGitFailure, type GitFailure } from "../../utils/gitErrors";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh, Spinner } from "../ui";
import BranchBar from "./BranchBar";
import CommitBar from "./CommitBar";
import DiffFileList from "./DiffFileList";
import ErrorBanner from "./ErrorBanner";
import GitCommitSheet from "./GitCommitSheet";
import GroupHeader from "./GroupHeader";
import LogList from "./LogList";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	onSelectCommit: (hash: string) => void;
	/** Closes the content area when the file it shows stops having a diff. */
	onCloseFile: () => void;
	activeFile: { path: string; staged: boolean } | null;
	activeCommitHash: string | null;
}

function DiffTab({
	onSelectFile,
	onSelectCommit,
	onCloseFile,
	activeFile,
	activeCommitHash,
}: Props) {
	const queryClient = useQueryClient();
	const { data: status, isLoading, error } = useGitStatus();
	const { data: logData } = useGitLog();

	const refreshAll = useCallback(
		() => invalidateGitQueries(queryClient),
		[queryClient],
	);

	const { isActive } = useSidebarRefresh("git", refreshAll);
	const { toggle, discard, writes } = useGitWriteRunner();
	// The files a confirmation is currently open for; null when none is.
	const [pendingDiscard, setPendingDiscard] = useState<FileStatus[] | null>(
		null,
	);
	const [actionError, setActionError] = useState<ActionError | null>(null);

	// A failure names a path in the workspace it happened in, so carrying the
	// banner across a switch would point at a file that is not in this one.
	// Adjusted during render rather than in an effect: an effect would let the
	// previous workspace's error paint once before clearing it.
	const currentWorktree = useWorktreeStore((s) => s.current);
	const [bannerWorktree, setBannerWorktree] = useState(currentWorktree);
	if (bannerWorktree !== currentWorktree) {
		setBannerWorktree(currentWorktree);
		setActionError(null);
	}

	// Opened from the HEAD row's amend action; the commit bar owns its own.
	const [isAmending, setIsAmending] = useState(false);
	const handleAmend = useCallback(() => setIsAmending(true), []);

	const flatStatus = useMemo(
		() => (status ? flattenGitStatus(status) : null),
		[status],
	);

	const changeCount = flatStatus
		? flatStatus.staged.length + flatStatus.unstaged.length
		: 0;
	const historyExpanded = useHistoryExpanded(changeCount);

	const togglePaths = useCallback(
		async (paths: string[], staged: boolean) => {
			try {
				await toggle(paths, staged);
				setActionError((prev) => clearedBy(prev, paths));
			} catch (e) {
				if (e instanceof WorktreeChangedError) return;
				setActionError({
					...describeGitFailure(e, () => stageFailureSummary(staged)),
					paths,
				});
			}
		},
		[toggle],
	);

	const handleToggleStage = useCallback(
		(path: string, staged: boolean) => togglePaths([path], staged),
		[togglePaths],
	);

	const handleToggleAllStaged = useCallback(() => {
		if (!flatStatus || flatStatus.staged.length === 0) return;
		togglePaths(
			flatStatus.staged.map((f) => f.path),
			true,
		);
	}, [flatStatus, togglePaths]);

	const runDiscard = useCallback(
		async (files: FileStatus[]) => {
			const paths = files.map((f) => f.path);
			setPendingDiscard(null);
			try {
				await discard(paths);
				setActionError((prev) => clearedBy(prev, paths));
				// The open diff no longer exists — the file is either back to its
				// staged content or gone altogether.
				if (
					activeFile &&
					!activeFile.staged &&
					paths.includes(activeFile.path)
				) {
					onCloseFile();
				}
			} catch (e) {
				// Nothing was written and the banner belongs to a worktree that is
				// no longer on screen — the same reason a switch clears it above.
				if (e instanceof WorktreeChangedError) return;
				setActionError({
					...describeGitFailure(e, () => describeDiscard(files).failureSummary),
					paths,
				});
			}
		},
		[discard, activeFile, onCloseFile],
	);

	const handleDiscard = useCallback(
		(file: FileStatus) => setPendingDiscard([file]),
		[],
	);

	const handleDiscardAll = useCallback(() => {
		if (!flatStatus || flatStatus.unstaged.length === 0) return;
		setPendingDiscard(flatStatus.unstaged);
	}, [flatStatus]);

	const handleToggleAllUnstaged = useCallback(() => {
		if (!flatStatus || flatStatus.unstaged.length === 0) return;
		togglePaths(
			flatStatus.unstaged.map((f) => f.path),
			false,
		);
	}, [flatStatus, togglePaths]);

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<BranchBar />

			{actionError && (
				<ErrorBanner
					summary={actionError.summary}
					details={actionError.detail}
					onDismiss={() => setActionError(null)}
				/>
			)}

			<PullToRefresh onRefresh={refreshAll}>
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : error ? (
					<div className="p-4 text-center text-th-error">
						<div>Failed to load git status</div>
						<div className="mt-1 text-sm text-th-text-muted">
							{error instanceof Error ? error.message : String(error)}
						</div>
					</div>
				) : (
					<div className="flex flex-1 flex-col pt-2 pb-2">
						{changeCount === 0 ? (
							<div className="px-3 py-2 text-sm text-th-text-muted">
								No changes
							</div>
						) : (
							<>
								<DiffFileList
									title="Staged"
									files={flatStatus?.staged ?? []}
									staged={true}
									onSelectFile={onSelectFile}
									onToggleStage={handleToggleStage}
									onToggleAll={handleToggleAllStaged}
									activeFile={activeFile}
									togglingPaths={writes.toggling}
								/>
								<DiffFileList
									title="Changes"
									files={flatStatus?.unstaged ?? []}
									staged={false}
									onSelectFile={onSelectFile}
									onToggleStage={handleToggleStage}
									onToggleAll={handleToggleAllUnstaged}
									onDiscard={handleDiscard}
									onDiscardAll={handleDiscardAll}
									activeFile={activeFile}
									togglingPaths={writes.toggling}
									discardingPaths={writes.discarding}
								/>
							</>
						)}

						{/* Its own box, so its header stops being sticky once the
						    section it labels has scrolled past — the same way each
						    file group's header behaves. */}
						<div className="mt-2 flex flex-col">
							<GroupHeader
								label="History"
								isExpanded={historyExpanded}
								onToggle={() =>
									gitPanelActions.setHistoryExpanded(!historyExpanded)
								}
							/>
							{historyExpanded && (
								<LogList
									commits={logData?.commits ?? []}
									activeHash={activeCommitHash}
									onSelectCommit={onSelectCommit}
									onAmend={handleAmend}
								/>
							)}
						</div>
					</div>
				)}
			</PullToRefresh>

			<CommitBar />

			{isAmending && (
				<GitCommitSheet
					amendInitially={true}
					onClose={() => setIsAmending(false)}
				/>
			)}

			{pendingDiscard && (
				<DiscardConfirm
					files={pendingDiscard}
					onConfirm={() => {
						runDiscard(pendingDiscard);
					}}
					onCancel={() => setPendingDiscard(null)}
				/>
			)}
		</div>
	);
}

interface ActionError extends GitFailure {
	/** What failed, so only a retry of it can clear the banner. */
	paths: string[];
}

/**
 * Only a retry of what failed clears the banner. Another file succeeding says
 * nothing about the one that did not, and dropping its message would leave that
 * failure with no explanation on screen.
 */
function clearedBy(
	prev: ActionError | null,
	paths: string[],
): ActionError | null {
	return prev?.paths.some((p) => paths.includes(p)) ? null : prev;
}

/**
 * The wording of a discard confirmation, which differs by what is actually lost:
 * a tracked file gives up edits, an untracked one stops existing.
 */
function DiscardConfirm({
	files,
	onConfirm,
	onCancel,
}: {
	files: FileStatus[];
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { title, message, confirmLabel } = describeDiscard(files);

	return (
		<ConfirmDialog
			title={title}
			message={message}
			confirmLabel={confirmLabel}
			variant="danger"
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

export default DiffTab;
