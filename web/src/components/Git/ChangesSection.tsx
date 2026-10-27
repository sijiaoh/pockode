import { ConfirmDialog } from "@pockode/shared";
import { useCallback, useMemo, useState } from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import {
	gitWriteActions,
	useWriteFailure,
	WorktreeChangedError,
} from "../../lib/gitWriteStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeDiscard,
	type FileStatus,
	flattenGitStatus,
	stageFailureSummary,
} from "../../types/git";
import { describeGitFailure } from "../../utils/gitErrors";
import { Spinner } from "../ui";
import CommitBar from "./CommitBar";
import DiffFileList from "./DiffFileList";
import ErrorBanner from "./ErrorBanner";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	/**
	 * Closes the diff of `path` in `worktree`, which has just stopped having
	 * one — if that diff is still the page. Both are named because the discard
	 * is answered later than it was asked: by then the screen may be somewhere
	 * else, even in another worktree.
	 */
	onCloseFile: (path: string, worktree: string) => void;
	activeFile: { path: string; staged: boolean } | null;
}

/**
 * The working tree's changes: the inline-action banner, the Staged and Changes
 * groups, and the commit bar under them — the Git workspace's Changes segment.
 */
function ChangesSection({ onSelectFile, onCloseFile, activeFile }: Props) {
	const { data: status, isLoading, error } = useGitStatus();
	const { toggle, discard, writes } = useGitWriteRunner();
	// The files a confirmation is currently open for; null when none is.
	const [pendingDiscard, setPendingDiscard] = useState<FileStatus[] | null>(
		null,
	);
	// The worktree the runner sends to, read in the same render, so a failure
	// is filed under the worktree whose paths it names.
	const worktree = useWorktreeStore((s) => s.current);
	const actionError = useWriteFailure(worktree);

	const flatStatus = useMemo(
		() => (status ? flattenGitStatus(status) : null),
		[status],
	);

	const changeCount = flatStatus
		? flatStatus.staged.length + flatStatus.unstaged.length
		: 0;

	const togglePaths = useCallback(
		async (paths: string[], staged: boolean) => {
			try {
				await toggle(paths, staged);
				gitWriteActions.succeed(worktree, paths);
			} catch (e) {
				if (e instanceof WorktreeChangedError) return;
				gitWriteActions.fail(worktree, {
					...describeGitFailure(e, () => stageFailureSummary(staged)),
					paths,
				});
			}
		},
		[toggle, worktree],
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
				gitWriteActions.succeed(worktree, paths);
				// Each discarded file's unstaged diff no longer exists — the file is
				// either back to its staged content or gone altogether. Every path,
				// not the one open when the discard was confirmed: the reader may
				// have opened another of them since, and only the shell knows what
				// the page is now.
				for (const path of paths) onCloseFile(path, worktree);
			} catch (e) {
				// Nothing was written, so there is nothing to report.
				if (e instanceof WorktreeChangedError) return;
				gitWriteActions.fail(worktree, {
					...describeGitFailure(e, () => describeDiscard(files).failureSummary),
					paths,
				});
			}
		},
		[discard, worktree, onCloseFile],
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
		<>
			{actionError && (
				<ErrorBanner
					summary={actionError.summary}
					details={actionError.detail}
					onDismiss={() => gitWriteActions.dismissFailure(worktree)}
				/>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto">
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
					</div>
				)}
			</div>

			<CommitBar />

			{pendingDiscard && (
				<DiscardConfirm
					files={pendingDiscard}
					onConfirm={() => {
						runDiscard(pendingDiscard);
					}}
					onCancel={() => setPendingDiscard(null)}
				/>
			)}
		</>
	);
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

export default ChangesSection;
