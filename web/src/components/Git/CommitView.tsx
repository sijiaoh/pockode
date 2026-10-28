import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useGitCommit, useGitCommitSubject } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { refChips } from "../../lib/commitHistory";
import { overlayToNavigation } from "../../lib/navigation";
import {
	type FileChange,
	GIT_STATUS_INFO,
	type GitFileStatus,
} from "../../types/git";
import { commitOriginOf } from "../../types/overlay";
import { formatDateTime } from "../../utils/dateTime";
import PageHeader, { type PageBack } from "../Layout/PageHeader";
import { ContentView, CopyButton } from "../ui";
import { headerTitleTextClass } from "../ui/HeaderTitle";
import { headerIconButtonClass } from "../ui/headerIconButtonClass";
import Skeleton from "../ui/Skeleton";
import CommitActions from "./CommitActions";
import RefChips from "./RefChips";

interface Props {
	hash: string;
	/**
	 * Back to the list this was opened from, or the branch's detail. Absent
	 * where that is on screen beside it.
	 */
	onBack?: () => void;
}

function FileChangeItem({
	file,
	onClick,
}: {
	file: FileChange;
	onClick: () => void;
}) {
	const statusInfo =
		GIT_STATUS_INFO[file.status as GitFileStatus] ?? GIT_STATUS_INFO["?"];

	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[44px] items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-th-bg-tertiary rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
		>
			<span className={`font-mono ${statusInfo.color}`}>{file.status}</span>
			<span className="truncate text-th-text-primary">{file.path}</span>
		</button>
	);
}

/** How a merge's parent is named; a commit with one parent has no number. */
function parentName(index: number): string {
	return index === 0 ? "First parent" : `Merged-in parent ${index + 1}`;
}

/**
 * One parent: its short hash at once, its subject once `git.show` answers for
 * it. Opens that commit, pushed so Back returns here.
 */
function ParentRow({
	hash,
	index,
	numbered,
	onOpen,
}: {
	hash: string;
	index: number;
	/** A merge's: `1`, `2`… before each. */
	numbered: boolean;
	onOpen: (hash: string) => void;
}) {
	const { data: subject, error } = useGitCommitSubject(hash);
	const short = hash.substring(0, 7);

	return (
		<button
			type="button"
			onClick={() => onOpen(hash)}
			aria-label={
				numbered
					? `${parentName(index)}: ${short}${subject ? ` ${subject}` : ""}`
					: undefined
			}
			className="flex min-h-[44px] items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
		>
			{numbered && (
				<span className="w-3 shrink-0 tabular-nums text-th-text-muted">
					{index + 1}
				</span>
			)}
			<span className="shrink-0 font-mono text-th-text-secondary">{short}</span>
			<span className="min-w-0 flex-1 truncate text-th-text-primary">
				{subject ??
					// Nothing more is coming for a parent that cannot be read: its
					// hash is still enough to open it.
					(error ? null : <Skeleton className="h-4 w-40 max-w-full rounded" />)}
			</span>
			<ChevronRight
				className="h-4 w-4 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
		</button>
	);
}

function CommitView({ hash, onBack }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId, overlay } = useRouteState();
	// Carried from layer to layer, so Back lands on the list the commit was
	// picked from (docs/git-history-ui.md#url), or the branch
	// (docs/git-branches-ui.md#opening-a-commit).
	const origin = commitOriginOf(overlay);
	const back: PageBack | undefined = onBack && {
		to: "parent",
		label: origin.branch ? "Back to branch" : "Back to history",
		onClick: onBack,
	};
	const { data: commit, isLoading, error } = useGitCommit(hash);
	const [menuOpen, setMenuOpen] = useState(false);

	const shortHash = hash.substring(0, 7);
	const isMerge = (commit?.parents.length ?? 0) > 1;

	const openCommit = (parent: string) => {
		navigate(
			overlayToNavigation(
				{ type: "commit", hash: parent, ...origin },
				worktree,
				sessionId,
			),
		);
	};

	const handleFileClick = (path: string) => {
		navigate(
			overlayToNavigation(
				{ type: "commit-diff", hash, path, ...origin },
				worktree,
				sessionId,
			),
		);
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			{/* Named by its hash, which is what identifies a commit and comes with
			    the route; the subject is the body's, as the start of its message. */}
			<PageHeader
				back={back}
				title={
					<span className={headerTitleTextClass}>
						Commit <span className="font-mono">{shortHash}</span>
					</span>
				}
				actions={
					commit && (
						<button
							type="button"
							onClick={() => setMenuOpen(true)}
							aria-label={`Actions for commit ${shortHash}`}
							className={headerIconButtonClass}
						>
							<MoreHorizontal className="size-5" aria-hidden="true" />
						</button>
					)
				}
			/>
			<CommitActions
				target={menuOpen && commit ? { commit } : null}
				onClose={() => setMenuOpen(false)}
			/>
			<ContentView isLoading={isLoading} error={error ?? undefined}>
				{commit && (
					<div className="flex flex-col">
						{/* Commit metadata */}
						<div className="border-b border-th-border p-4">
							<div className="font-medium text-th-text-primary">
								{commit.subject}
							</div>
							{commit.body && (
								<p className="mt-2 whitespace-pre-wrap text-sm text-th-text-secondary">
									{commit.body}
								</p>
							)}
							{/* Every ref, wrapping: there is room here to say them all. */}
							{commit.refs && commit.refs.length > 0 && (
								<div className="mt-3 flex flex-wrap gap-1.5 text-xs text-th-text-muted">
									<RefChips
										chips={refChips(commit.refs)}
										limit={Number.POSITIVE_INFINITY}
										color="currentColor"
										width="full"
									/>
								</div>
							)}
							<div className="mt-3 text-xs text-th-text-muted">
								<div>{commit.author}</div>
								<div>{formatDateTime(commit.date)}</div>
								<div className="mt-1 flex items-center gap-2">
									<span className="min-w-0 break-all font-mono">
										{commit.hash}
									</span>
									<CopyButton
										text={commit.hash}
										label="Copy hash"
										className="flex size-6 shrink-0 items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
									/>
								</div>
							</div>
						</div>

						<div className="border-b border-th-border p-4">
							<div className="mb-2 text-xs uppercase text-th-text-muted">
								Parents ({commit.parents.length})
							</div>
							{commit.parents.length === 0 ? (
								<p className="px-3 text-sm text-th-text-muted">
									No parents — this is the first commit.
								</p>
							) : (
								<div className="flex flex-col">
									{commit.parents.map((parent, i) => (
										<ParentRow
											key={parent}
											hash={parent}
											index={i}
											numbered={isMerge}
											onOpen={openCommit}
										/>
									))}
								</div>
							)}
						</div>

						{/* Changed files */}
						{commit.files && commit.files.length > 0 && (
							<div className="p-4">
								<div className="mb-2 text-xs uppercase text-th-text-muted">
									Changed files ({commit.files.length})
									{/* What the merge brought into the line it was made on. */}
									{isMerge && <span className="normal-case"> vs parent 1</span>}
								</div>
								<div className="flex flex-col">
									{commit.files.map((file) => (
										<FileChangeItem
											key={file.path}
											file={file}
											onClick={() => handleFileClick(file.path)}
										/>
									))}
								</div>
							</div>
						)}
					</div>
				)}
			</ContentView>
		</div>
	);
}

export default CommitView;
