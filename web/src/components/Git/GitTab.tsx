import { useQueryClient } from "@tanstack/react-query";
import {
	FileDiff,
	GitBranch,
	History,
	type LucideIcon,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import { useGitBranches } from "../../hooks/useGitBranches";
import {
	describeChangeCount,
	describeChangeLines,
	useGitChangeCount,
	useGitChangeLines,
} from "../../hooks/useGitChangeCount";
import { useGitStatus } from "../../hooks/useGitStatus";
import {
	describeOperation,
	headBranchOf,
	rebasingBranch,
} from "../../lib/gitOperation";
import { useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { GitSegment } from "../../types/overlay";
import {
	describeSyncStatus,
	describeSyncStep,
	hasSyncStatus,
	RUNNING_DESCRIPTION,
} from "../../utils/gitSyncStatus";
import { useSidebarRefresh } from "../Layout";
import { formatBadgeCount, Spinner } from "../ui";
import { HeadName } from "./BranchBar";
import HeadPlaceholder from "./HeadPlaceholder";
import LineCounts, { formatLineCounts } from "./LineCounts";

interface Props {
	onOpenSegment: (segment: GitSegment) => void;
	/** The segment the Git workspace is standing in, and null when it is not on screen. */
	activeSegment: GitSegment | null;
}

/**
 * The sidebar's Git tab: where the worktree stands, and the doors into the Git
 * workspace — the same shape as the Project tab. Nothing here writes: every
 * write lives once, in the workspace.
 */
function GitTab({ onOpenSegment, activeSegment }: Props) {
	const queryClient = useQueryClient();
	const refreshAll = useCallback(
		() => invalidateGitQueries(queryClient),
		[queryClient],
	);
	const { isActive } = useSidebarRefresh("git", refreshAll);
	const changeCount = useGitChangeCount();
	const changeLines = useGitChangeLines();
	const hasLines = changeLines !== null && formatLineCounts(changeLines) !== "";

	return (
		<div className={isActive ? "flex flex-col" : "hidden"}>
			<Overview />
			<div className="space-y-1 p-2">
				<Entry
					icon={FileDiff}
					label="Changes"
					isActive={activeSegment === "changes"}
					onClick={() => onOpenSegment("changes")}
					ariaLabel={
						changeCount
							? [
									"Changes",
									describeChangeCount(changeCount),
									hasLines && describeChangeLines(changeLines),
								]
									.filter(Boolean)
									.join(", ")
							: undefined
					}
				>
					{/* Nothing while the status has no answer: like the tab's badge,
					    this is not where a failed read is reported — the workspace
					    says it. */}
					{changeCount === 0 ? (
						<span className="ml-auto text-xs text-th-text-muted">
							No changes
						</span>
					) : changeCount !== undefined ? (
						<span className="ml-auto flex min-w-0 items-baseline gap-2">
							<span className="text-xs tabular-nums text-th-text-secondary">
								{formatBadgeCount(changeCount)}
							</span>
							{hasLines && <LineCounts lines={changeLines} />}
						</span>
					) : null}
				</Entry>
				<Entry
					icon={History}
					label="History"
					isActive={activeSegment === "history"}
					onClick={() => onOpenSegment("history")}
				/>
				<Entry
					icon={GitBranch}
					label="Branches"
					isActive={activeSegment === "branches"}
					onClick={() => onOpenSegment("branches")}
				/>
			</div>
		</div>
	);
}

/**
 * Read-only on purpose: something drawn like the chip that does nothing when
 * pressed is worse than no chip, and the entries below already go everywhere
 * it could.
 */
function Overview() {
	const { data: branches, isLoading, error } = useGitBranches();
	const worktree = useWorktreeStore((s) => s.current);
	const run = useSyncRun(worktree);
	const { data: gitStatus } = useGitStatus();
	const operation = gitStatus?.operation;

	const head = branches?.head;
	const sync = branches?.sync;

	// Data first, as in the workspace's top bar: a failed refetch keeps the
	// branch already known.
	if (!head) {
		return (
			<div className="flex min-h-[44px] items-center border-b border-th-border px-2">
				<HeadPlaceholder isLoading={isLoading} error={error} />
			</div>
		);
	}

	// The same description the workspace's sync chip is drawn from, so the two
	// cannot disagree about what the branch needs.
	const status = hasSyncStatus(head, sync)
		? describeSyncStatus(sync, run)
		: null;
	// A repository stuck mid-operation is what the doorplate has to say, in
	// place of the sync line (docs/git-conflict-ui.md).
	const operationTitle = operation
		? describeOperation(
				operation,
				gitStatus?.conflicted?.length ?? 0,
				headBranchOf(head),
			).title
		: null;

	return (
		<div className="space-y-1 border-b border-th-border px-4 py-2.5">
			<div className="flex min-w-0 items-center gap-2 text-th-text-primary">
				<GitBranch
					className="h-4 w-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<HeadName head={head} rebasing={rebasingBranch(operation)} />
			</div>
			{operationTitle ? (
				<div className="flex items-center gap-1.5 pl-6 text-xs text-th-text-secondary">
					<TriangleAlert
						className="h-3 w-3 shrink-0 text-th-warning"
						aria-hidden="true"
					/>
					<span className="min-w-0 truncate">{operationTitle}</span>
				</div>
			) : (
				status && (
					<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 text-xs text-th-text-secondary">
						<span>{sentence(describeSyncStep(status.step))}</span>
						{status.running && (
							<span className="flex items-center gap-1">
								<span aria-hidden="true">·</span>
								<Spinner variant="current" size="h-3 w-3" srText={null} />
								{sentence(RUNNING_DESCRIPTION[status.running])}
							</span>
						)}
						{status.autoFetchFailed && (
							<span className="flex items-center gap-1 text-th-warning">
								<span aria-hidden="true">·</span>
								<TriangleAlert className="h-3 w-3" aria-hidden="true" />
								Automatic fetch failed
							</span>
						)}
					</div>
				)
			)}
		</div>
	);
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

interface EntryProps {
	icon: LucideIcon;
	label: string;
	isActive: boolean;
	onClick: () => void;
	ariaLabel?: string;
	children?: ReactNode;
}

function Entry({
	icon: Icon,
	label,
	isActive,
	onClick,
	ariaLabel,
	children,
}: EntryProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			// Still pressable while lit: it is the way back to that segment's list.
			aria-current={isActive ? "page" : undefined}
			className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-[0.98] ${
				isActive ? "bg-th-bg-tertiary" : ""
			}`}
		>
			<Icon className="size-4 text-th-text-muted" aria-hidden="true" />
			{label}
			{children}
		</button>
	);
}

export default GitTab;
