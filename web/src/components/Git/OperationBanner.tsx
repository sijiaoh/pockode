import { ConfirmDialog, useIsExpanded } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Sparkles,
	TriangleAlert,
	X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	invalidateGitQueries,
	operationPromptAtPress,
} from "../../hooks/gitQueries";
import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useIsWorktreeSwitching } from "../../hooks/useIsWorktreeSwitching";
import {
	type PrefillComposer,
	usePrefillComposer,
} from "../../hooks/usePrefillComposer";
import {
	describeAbort,
	describeHeadKept,
	describeOperation,
	headBranchOf,
	type OperationDescription,
	operationKey,
	orderConflicted,
} from "../../lib/gitOperation";
import {
	gitOperationActions,
	isAbout,
	useAbortRun,
	useIsOperationCollapsed,
} from "../../lib/gitOperationStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { useWSStore } from "../../lib/wsStore";
import type { GitOperation } from "../../types/git";
import { splitExtension, splitPath } from "../../utils/path";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import ErrorBanner from "./ErrorBanner";

/** Rows shown before `Show all`. */
const COLLAPSED_FILE_ROWS = 3;

interface Props {
	/**
	 * A detail layer below `expanded`: one line, no actions — they are one Back
	 * away, and the diff needs the room.
	 */
	compact: boolean;
	/** Opens a conflicted file's review layer. */
	onSelectFile: (path: string) => void;
}

/**
 * What the workspace says while the repository is in the middle of a merge,
 * rebase, cherry-pick or revert, and its two ways out: hand it to the agent,
 * or abort (docs/git-conflict-ui.md). Live state: drawn from the status, gone
 * the moment the status no longer has an operation, whoever ended it.
 */
function OperationBanner({ compact, onSelectFile }: Props) {
	const { data: status, isFetching, dataUpdatedAt } = useGitStatus();
	const { data: branches } = useGitBranches();
	const worktree = useWorktreeStore((s) => s.current);
	const run = useAbortRun(worktree);
	// Here rather than in FullBanner, which is remounted for every operation
	// and gives way to the one-line form on a layer: a session being created
	// for the text, or its failure, has to outlive both.
	const handoff = usePrefillComposer();
	const operation = status?.operation;

	const switching = useIsWorktreeSwitching();

	useEffect(() => {
		// Only on an answer that is this worktree's: during a switch, and until
		// the refetch it triggers lands, the cache still holds the previous
		// worktree's, which says nothing about what ended here. An abort
		// answered after the status that shows the operation gone is settled by
		// the refetch the abort itself asks for.
		if (switching || isFetching || !status) return;
		gitOperationActions.settle(worktree, operation ?? null, dataUpdatedAt);
	}, [worktree, status, operation, dataUpdatedAt, switching, isFetching]);

	if (!operation || !status) {
		return run.headKept ? (
			<HeadKeptNotice
				message={describeHeadKept(run.headKept.kind, run.headKept.branch)}
				onDismiss={() => gitOperationActions.dismissHeadKept(worktree)}
			/>
		) : null;
	}

	const headBranch = headBranchOf(branches?.head);
	const conflicted = status.conflicted ?? [];
	const description = describeOperation(
		operation,
		conflicted.length,
		headBranch,
	);

	if (compact) {
		return (
			<div className="flex min-h-[36px] shrink-0 items-center gap-2 border-b border-l-[3px] border-b-th-border border-l-th-warning bg-th-bg-secondary px-3 text-sm text-th-text-primary">
				<TriangleAlert
					className="h-4 w-4 shrink-0 text-th-warning"
					aria-hidden="true"
				/>
				<span className="min-w-0 truncate">{description.title}</span>
				{description.progress && (
					<span className="shrink-0 tabular-nums text-th-text-secondary">
						· {description.progress}
					</span>
				)}
			</div>
		);
	}

	return (
		<FullBanner
			// A new operation starts from its own state: open, nothing confirming
			// — and so does another worktree's, even one of the same key.
			key={`${worktree}:${operationKey(operation)}`}
			worktree={worktree}
			operation={operation}
			conflicted={conflicted}
			headBranch={headBranch}
			description={description}
			handoff={handoff}
			switching={switching}
			onSelectFile={onSelectFile}
		/>
	);
}

interface FullBannerProps {
	worktree: string;
	operation: GitOperation;
	conflicted: string[];
	headBranch: string | null;
	description: OperationDescription;
	handoff: PrefillComposer;
	/**
	 * The status on screen is still the worktree being left, while requests
	 * already go to the one being entered: neither way out may be taken then,
	 * or the abort lands on the wrong worktree's operation of the same kind.
	 */
	switching: boolean;
	onSelectFile: (path: string) => void;
}

function FullBanner({
	worktree,
	operation,
	conflicted,
	headBranch,
	description,
	handoff,
	switching,
	onSelectFile,
}: FullBannerProps) {
	const isExpanded = useIsExpanded();
	const queryClient = useQueryClient();
	const abortRequest = useWSStore((s) => s.actions.abort);
	const run = useAbortRun(worktree);
	const key = operationKey(operation);
	const collapsed = useIsOperationCollapsed(worktree, key);
	const [confirming, setConfirming] = useState(false);
	const [showAllFiles, setShowAllFiles] = useState(false);
	const titleId = useId();

	const files = useMemo(() => orderConflicted(conflicted), [conflicted]);
	const isAborting = !!run.aborting && isAbout(run.aborting, operation);
	const abortError =
		run.error && isAbout(run.error, operation) ? run.error.failure : null;

	const resolve = () => {
		const text = operationPromptAtPress(queryClient);
		if (text) void handoff.prefill(text);
	};

	const abort = () => {
		setConfirming(false);
		const { kind } = operation;
		const branch =
			operation.kind === "rebase" ? (operation.branch ?? null) : headBranch;
		void gitOperationActions.abort(worktree, operation, branch, async () => {
			try {
				return await abortRequest(kind);
			} finally {
				// A refusal too: -32005 says the status on screen is out of date.
				invalidateGitQueries(queryClient);
			}
		});
	};

	const actions = (
		<div className="flex shrink-0 items-center gap-2">
			<button
				type="button"
				onClick={resolve}
				disabled={handoff.isPending || isAborting || switching}
				className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
					isExpanded ? "" : "flex-1"
				}`}
			>
				{handoff.isPending ? (
					<Spinner variant="current" size="h-4 w-4" srText={null} />
				) : (
					<Sparkles className="h-4 w-4" aria-hidden="true" />
				)}
				{description.primaryLabel}
			</button>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				disabled={isAborting || switching}
				className="flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-error transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50"
			>
				{isAborting && (
					<Spinner variant="current" size="h-4 w-4" srText={null} />
				)}
				{isAborting ? "Aborting…" : "Abort"}
			</button>
		</div>
	);

	const failures = (
		<>
			{handoff.error && (
				<ErrorBanner
					summary={handoff.error.summary}
					details={handoff.error.detail}
					onDismiss={handoff.dismissError}
				/>
			)}
			{abortError && (
				<ErrorBanner
					summary={abortError.summary}
					details={abortError.detail}
					onDismiss={() => gitOperationActions.dismissError(worktree)}
				/>
			)}
		</>
	);

	const hiddenFiles = files.length - COLLAPSED_FILE_ROWS;
	const visibleFiles = showAllFiles
		? files
		: files.slice(0, COLLAPSED_FILE_ROWS);

	return (
		<section
			aria-labelledby={titleId}
			className="shrink-0 border-b border-l-[3px] border-b-th-border border-l-th-warning bg-th-bg-secondary"
		>
			<div className="flex items-center gap-2 pr-1 pl-1">
				<button
					type="button"
					onClick={() =>
						gitOperationActions.setCollapsed(worktree, key, !collapsed)
					}
					aria-expanded={!collapsed}
					aria-label={collapsed ? "Show details" : "Hide details"}
					className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded px-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					<TriangleAlert
						className="h-4 w-4 shrink-0 text-th-warning"
						aria-hidden="true"
					/>
					<span
						id={titleId}
						className="min-w-0 flex-1 truncate text-sm font-medium text-th-text-primary"
					>
						{description.title}
					</span>
					{collapsed ? (
						<ChevronDown
							className="h-4 w-4 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					) : (
						<ChevronUp
							className="h-4 w-4 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					)}
				</button>
				{isExpanded && actions}
			</div>

			{!collapsed && (
				<div className="space-y-2 px-3 pb-2 pl-9">
					<ContextLines description={description} joined={isExpanded} />
					{files.length > 0 ? (
						<div>
							<ul
								className={`${
									isExpanded
										? "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-2"
										: "rounded-lg border border-th-border"
								} ${showAllFiles ? "max-h-[242px] overflow-y-auto" : ""}`}
							>
								{visibleFiles.map((path) => (
									<li key={path}>
										<ConflictRow path={path} onSelect={onSelectFile} />
									</li>
								))}
							</ul>
							{hiddenFiles > 0 && !showAllFiles && (
								<button
									type="button"
									onClick={() => setShowAllFiles(true)}
									className="inline-flex min-h-[44px] items-center px-2 text-sm text-th-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
								>
									Show all {files.length} files
								</button>
							)}
						</div>
					) : (
						<p className="text-xs text-th-text-muted">
							{description.noConflictsLine}
						</p>
					)}
					<p className="text-xs text-th-text-muted">
						{description.pauseSentence}
					</p>
				</div>
			)}

			{failures}

			{!isExpanded && <div className="px-3 pt-1 pb-2">{actions}</div>}

			{confirming && !switching && (
				<ConfirmDialog
					{...describeAbort(operation, conflicted.length, headBranch)}
					variant="danger"
					onConfirm={abort}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</section>
	);
}

function ContextLines({
	description,
	joined,
}: {
	description: OperationDescription;
	joined: boolean;
}) {
	const { context, progress, commitLine } = description;
	if (!context && !progress && !commitLine) return null;

	const contextLine = (context || progress) && (
		<span className="flex min-w-0">
			{context && (
				<span className="min-w-0 truncate">
					{context.map((part, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: built afresh each render, never reordered
						<span key={i} className={part.name ? "font-mono" : undefined}>
							{i > 0 && " "}
							{part.text}
						</span>
					))}
				</span>
			)}
			{progress && (
				<span className="shrink-0 tabular-nums">
					{context && "\u00a0· "}
					{progress}
				</span>
			)}
		</span>
	);
	const commit = commitLine && (
		<span className="min-w-0 truncate">
			{commitLine.prefix && `${commitLine.prefix} `}
			<span className="font-mono">{commitLine.hash}</span> {commitLine.subject}
		</span>
	);

	return joined ? (
		<div className="flex min-w-0 gap-2 text-xs text-th-text-muted">
			{contextLine}
			{contextLine && commit && <span aria-hidden="true">·</span>}
			{commit}
		</div>
	) : (
		<div className="space-y-0.5 text-xs text-th-text-muted">
			{contextLine && <div className="flex min-w-0">{contextLine}</div>}
			{commit && <div className="flex min-w-0">{commit}</div>}
		</div>
	);
}

function ConflictRow({
	path,
	onSelect,
}: {
	path: string;
	onSelect: (path: string) => void;
}) {
	const { fileName, directory } = splitPath(path);
	const { stem, extension: ext } = splitExtension(fileName);
	const dir = directory.replace(/\/$/, "");

	return (
		<button
			type="button"
			onClick={() => onSelect(path)}
			aria-label={`Review ${path}, conflicted`}
			className="flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
		>
			<TriangleAlert
				className="h-4 w-4 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<span className="flex min-w-0 shrink text-th-text-primary">
				<span className="truncate">{stem}</span>
				<span className="shrink-0">{ext}</span>
			</span>
			{dir && (
				<span className="min-w-0 flex-1 truncate text-xs text-th-text-muted [direction:rtl]">
					<bdi>{dir}</bdi>
				</span>
			)}
			<ChevronRight
				className="ml-auto h-4 w-4 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
		</button>
	);
}

function HeadKeptNotice({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<output className="flex shrink-0 items-start gap-2 border-b border-l-[3px] border-b-th-border border-l-th-warning bg-th-bg-secondary px-3 py-2">
			<TriangleAlert
				className="mt-0.5 h-4 w-4 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<span className="min-w-0 flex-1 text-sm text-th-text-primary">
				{message}
			</span>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss"
				className={iconButtonClass()}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</output>
	);
}

export default OperationBanner;
