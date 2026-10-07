import { ChevronDown, GitBranch, PanelLeftClose, X } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useWorktree } from "../../hooks/useWorktree";
import { useWSStore } from "../../lib/wsStore";
import type { WorktreeInfo } from "../../types/message";
import WorktreeCreateSheet from "./WorktreeCreateSheet";
import WorktreeDropdown from "./WorktreeDropdown";

interface Props {
	/** Takes the sidebar off the screen; no button at the row's end without it. */
	onClose?: () => void;
	/** Two columns fit, so the sidebar is a column that collapses rather than a drawer that closes. */
	isExpanded?: boolean;
}

function WorktreeSwitcher({ onClose, isExpanded = true }: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const {
		current,
		currentWorktree,
		worktrees,
		isLoading,
		error,
		isGitRepo,
		setupHookSkip,
		select,
		create,
		delete: deleteWorktree,
		isCreating,
		isDeleting,
		getDisplayName,
	} = useWorktree();
	const projectTitle = useWSStore((s) => s.projectTitle);

	const handleSelect = useCallback(
		(worktree: WorktreeInfo) => {
			const name = worktree.is_main ? "" : worktree.name;
			select(name);
			setIsOpen(false);
		},
		[select],
	);

	// TODO: Add error handling with toast notification when available
	const handleDelete = useCallback(
		async (worktree: WorktreeInfo) => {
			if (isDeleting) return;
			await deleteWorktree(worktree.name);
		},
		[deleteWorktree, isDeleting],
	);

	// Worktree to switch to once the create sheet closes. Switching navigates,
	// which would tear the sheet down before the user has read a skipped-setup
	// warning, so it is deferred until they dismiss it.
	const pendingSelectRef = useRef<string | null>(null);

	const handleCreate = useCallback(
		async (name: string, branch: string, baseBranch?: string) => {
			const skipped = await create(name, branch, baseBranch);
			if (skipped) {
				pendingSelectRef.current = name;
			} else {
				select(name);
				setIsCreateOpen(false);
			}
			return skipped;
		},
		[create, select],
	);

	const handleCloseCreate = useCallback(() => {
		setIsCreateOpen(false);
		const pending = pendingSelectRef.current;
		pendingSelectRef.current = null;
		if (pending !== null) {
			select(pending);
		}
	}, [select]);

	const handleOpenCreate = useCallback(() => {
		setIsOpen(false);
		setIsCreateOpen(true);
	}, []);

	// No main in the list is a project inside another repository's directory,
	// whose main worktree git reports elsewhere; the fallback matches main's own.
	const displayName = currentWorktree
		? getDisplayName(currentWorktree)
		: "Default";

	const isCurrent = useCallback(
		(worktree: WorktreeInfo) => {
			return current ? worktree.name === current : worktree.is_main;
		},
		[current],
	);

	// The column's button only exists while the column is expanded, so its
	// `aria-expanded` has one value.
	const closeButton = onClose && (
		<button
			type="button"
			onClick={onClose}
			className="flex size-9 shrink-0 pointer-coarse:size-11 items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			{...(isExpanded
				? { "aria-label": "Collapse sidebar", "aria-expanded": true }
				: { "aria-label": "Close sidebar" })}
		>
			{isExpanded ? (
				<PanelLeftClose className="h-5 w-5" aria-hidden="true" />
			) : (
				<X className="h-5 w-5" aria-hidden="true" />
			)}
		</button>
	);

	// Not a repository: nothing to switch between, so the project's name in
	// place of a switcher — no hint about `git init` (docs/git-ui.md).
	if (isGitRepo === false) {
		return (
			<SwitcherRow closeButton={closeButton}>
				<span className="truncate px-3 text-sm font-medium text-th-text-primary">
					{projectTitle || "Pockode"}
				</span>
			</SwitcherRow>
		);
	}

	// The list failed and there is nothing of it to show; a skeleton would say
	// it is still coming, and "Default" would pass off an empty list as real.
	if (error && worktrees.length === 0) {
		return (
			<SwitcherRow closeButton={closeButton}>
				<p
					className="min-w-0 px-3 py-2 text-sm break-words text-th-error"
					role="alert"
				>
					Couldn&apos;t load worktrees: {error.message}
				</p>
			</SwitcherRow>
		);
	}

	// Not known yet whether there is anything to switch: show skeleton
	if (isGitRepo === null || isLoading) {
		return (
			<SwitcherRow closeButton={closeButton}>
				<div className="flex items-center gap-1.5 px-3" aria-hidden="true">
					<div className="size-4 shrink-0 rounded bg-th-text-muted/20 animate-pulse" />
					<div className="h-4 w-24 rounded bg-th-text-muted/20 animate-pulse" />
				</div>
			</SwitcherRow>
		);
	}

	return (
		<SwitcherRow
			closeButton={closeButton}
			overlays={
				<>
					<WorktreeDropdown
						isOpen={isOpen}
						worktrees={worktrees}
						onSelect={handleSelect}
						onDelete={handleDelete}
						onCreateNew={handleOpenCreate}
						onClose={() => setIsOpen(false)}
						getDisplayName={getDisplayName}
						triggerRef={buttonRef}
						isExpanded={isExpanded}
						isCurrent={isCurrent}
					/>
					{isCreateOpen && (
						<WorktreeCreateSheet
							onClose={handleCloseCreate}
							onCreate={handleCreate}
							isCreating={isCreating}
							setupHookSkip={setupHookSkip}
						/>
					)}
				</>
			}
		>
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="group flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg px-3 text-th-text-primary transition-colors hover:bg-th-bg-tertiary aria-expanded:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
				aria-expanded={isOpen}
				aria-haspopup="listbox"
				aria-label="Select worktree"
			>
				<GitBranch
					className="size-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<span className="truncate text-sm font-medium">{displayName}</span>
				<ChevronDown
					className={`size-3.5 shrink-0 text-th-text-muted transition-transform group-hover:text-th-text-primary ${
						isOpen ? "rotate-180" : ""
					}`}
					aria-hidden="true"
				/>
			</button>
		</SwitcherRow>
	);
}

/**
 * The one shell every state renders in, so the row keeps its height — and the
 * tab bar below stays put — as loading gives way to the switcher or an error.
 * Its floor matches the close button beside it, with or without one.
 *
 * `relative` sits inside the `px-2` inset: the dropdown stretches to its
 * positioned ancestor, and this way it spans exactly the New Chat row below
 * (New Chat and the session filter together).
 */
function SwitcherRow({
	closeButton,
	overlays,
	children,
}: {
	closeButton: ReactNode;
	overlays?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="px-2 py-1">
			<div className="relative flex items-center gap-2">
				<div className="flex min-h-9 min-w-0 flex-1 items-center pointer-coarse:min-h-11">
					{children}
				</div>
				{closeButton}
				{overlays}
			</div>
		</div>
	);
}

export default WorktreeSwitcher;
