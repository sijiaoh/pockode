import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useGitLog } from "../../hooks/useGitLog";
import { useGitStage } from "../../hooks/useGitStage";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWatch } from "../../hooks/useGitWatch";
import { flattenGitStatus } from "../../types/git";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh, Spinner } from "../ui";
import DiffFileList from "./DiffFileList";
import LogList from "./LogList";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	onSelectCommit: (hash: string) => void;
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
	activeFile,
	activeCommitHash,
}: Props) {
	const { data: status, isLoading, error, refresh } = useGitStatus();
	const { data: logData, refresh: refreshLog } = useGitLog();

	const refreshAll = useCallback(() => {
		refresh();
		refreshLog();
	}, [refresh, refreshLog]);

	const { isActive } = useSidebarRefresh("git", refreshAll);
	const { stageMutation, unstageMutation } = useGitStage();
	const [togglingPaths, setTogglingPaths] = useState<Set<string>>(new Set());

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
			<PullToRefresh onRefresh={refreshAll}>
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner className="text-th-text-muted" />
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
											onToggleStage={(path) => handleToggleStage(path, true)}
											onToggleAll={handleToggleAllStaged}
											activeFile={activeFile}
											togglingPaths={togglingPaths}
										/>
										<DiffFileList
											title="Unstaged"
											files={flatStatus?.unstaged ?? []}
											staged={false}
											onSelectFile={onSelectFile}
											onToggleStage={(path) => handleToggleStage(path, false)}
											onToggleAll={handleToggleAllUnstaged}
											activeFile={activeFile}
											togglingPaths={togglingPaths}
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
		</div>
	);
}

export default DiffTab;
