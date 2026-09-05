import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import { useGitDiscard } from "../../hooks/useGitDiscard";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStage } from "../../hooks/useGitStage";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWatch } from "../../hooks/useGitWatch";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeDiscard,
	type FileStatus,
	flattenGitStatus,
} from "../../types/git";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh, Spinner } from "../ui";
import BranchBar from "./BranchBar";
import CommitBar from "./CommitBar";
import DiffFileList from "./DiffFileList";
import ErrorBanner from "./ErrorBanner";
import LogList from "./LogList";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	onSelectCommit: (hash: string) => void;
	/** Closes the content area when the file it shows stops having a diff. */
	onCloseFile: () => void;
	activeFile: { path: string; staged: boolean } | null;
	activeCommitHash: string | null;
}

function SectionHeader({
	title,
	count,
	isExpanded,
	onToggle,
}: {
	title: string;
	count?: number;
	isExpanded: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			aria-expanded={isExpanded}
		>
			{isExpanded ? (
				<ChevronDown className="h-4 w-4 shrink-0 text-th-text-muted" />
			) : (
				<ChevronRight className="h-4 w-4 shrink-0 text-th-text-muted" />
			)}
			<span className="text-sm font-medium text-th-text-primary">{title}</span>
			{count !== undefined && !isExpanded && (
				<span className="text-xs text-th-text-muted">({count})</span>
			)}
		</button>
	);
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
	const { stageMutation, unstageMutation } = useGitStage();
	const discardMutation = useGitDiscard();
	const [togglingPaths, setTogglingPaths] = useState<Set<string>>(new Set());
	const [discardingPaths, setDiscardingPaths] = useState<Set<string>>(
		new Set(),
	);
	// The files a confirmation is currently open for; null when none is.
	const [pendingDiscard, setPendingDiscard] = useState<FileStatus[] | null>(
		null,
	);
	const [discardError, setDiscardError] = useState<{
		summary: string;
		details: string;
		/** What failed, so only a retry of it can clear the banner. */
		paths: string[];
	} | null>(null);

	// A failure names a path in the workspace it happened in, so carrying the
	// banner across a switch would point at a file that is not in this one.
	// Adjusted during render rather than in an effect: an effect would let the
	// previous workspace's error paint once before clearing it.
	const currentWorktree = useWorktreeStore((s) => s.current);
	const [bannerWorktree, setBannerWorktree] = useState(currentWorktree);
	if (bannerWorktree !== currentWorktree) {
		setBannerWorktree(currentWorktree);
		setDiscardError(null);
	}

	const [changesExpanded, setChangesExpanded] = useState(true);
	const [historyExpanded, setHistoryExpanded] = useState(true);

	useGitWatch({ onChanged: refreshAll, enabled: isActive });

	const flatStatus = useMemo(
		() => (status ? flattenGitStatus(status) : null),
		[status],
	);

	const changeCount = flatStatus
		? flatStatus.staged.length + flatStatus.unstaged.length
		: 0;

	const togglePaths = useCallback(
		async (paths: string[], staged: boolean) => {
			setTogglingPaths((prev) => new Set([...prev, ...paths]));
			try {
				if (staged) {
					await unstageMutation.mutateAsync(paths);
				} else {
					await stageMutation.mutateAsync(paths);
				}
			} finally {
				setTogglingPaths((prev) => {
					const next = new Set(prev);
					for (const p of paths) next.delete(p);
					return next;
				});
			}
		},
		[stageMutation, unstageMutation],
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
			setDiscardingPaths((prev) => new Set([...prev, ...paths]));
			try {
				await discardMutation.mutateAsync(paths);
				// Only a retry of what failed clears the banner. Another file
				// succeeding says nothing about the one that did not, and dropping
				// its message would leave that failure with no explanation on screen.
				setDiscardError((prev) =>
					prev?.paths.some((p) => paths.includes(p)) ? null : prev,
				);
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
				setDiscardError({
					summary: describeDiscard(files).failureSummary,
					details: e instanceof Error ? e.message : String(e),
					paths,
				});
			} finally {
				setDiscardingPaths((prev) => {
					const next = new Set(prev);
					for (const p of paths) next.delete(p);
					return next;
				});
			}
		},
		[discardMutation, activeFile, onCloseFile],
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

			{discardError && (
				<ErrorBanner
					summary={discardError.summary}
					details={discardError.details}
					onDismiss={() => setDiscardError(null)}
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
					<div className="flex flex-1 flex-col">
						{/* Changes Section */}
						<SectionHeader
							title="Changes"
							count={changeCount}
							isExpanded={changesExpanded}
							onToggle={() => setChangesExpanded(!changesExpanded)}
						/>
						{changesExpanded && (
							<div className="flex flex-col gap-2 pb-2">
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
											togglingPaths={togglingPaths}
										/>
										<DiffFileList
											title="Unstaged"
											files={flatStatus?.unstaged ?? []}
											staged={false}
											onSelectFile={onSelectFile}
											onToggleStage={handleToggleStage}
											onToggleAll={handleToggleAllUnstaged}
											onDiscard={handleDiscard}
											onDiscardAll={handleDiscardAll}
											activeFile={activeFile}
											togglingPaths={togglingPaths}
											discardingPaths={discardingPaths}
										/>
									</>
								)}
							</div>
						)}

						{/* History Section */}
						<SectionHeader
							title="History"
							count={logData?.commits.length}
							isExpanded={historyExpanded}
							onToggle={() => setHistoryExpanded(!historyExpanded)}
						/>
						{historyExpanded && (
							<LogList
								commits={logData?.commits ?? []}
								activeHash={activeCommitHash}
								onSelectCommit={onSelectCommit}
							/>
						)}
					</div>
				)}
			</PullToRefresh>

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
		</div>
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

export default DiffTab;
