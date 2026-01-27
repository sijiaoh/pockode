import { ChevronDown, GitBranch, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useWorktree } from "../../hooks/useWorktree";
import type { WorktreeInfo } from "../../types/message";
import WorktreeCreateSheet from "./WorktreeCreateSheet";
import WorktreeDropdown from "./WorktreeDropdown";

interface Props {
	/** Called when close button is clicked (mobile only) */
	onClose?: () => void;
	/** Whether in desktop mode */
	isDesktop?: boolean;
}

function WorktreeSwitcher({ onClose, isDesktop = true }: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const {
		current,
		currentWorktree,
		worktrees,
		isLoading,
		isGitRepo,
		select,
		create,
		delete: deleteWorktree,
		isCreating,
		isDeleting,
		getDisplayName,
	} = useWorktree();

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

	const handleCreate = useCallback(
		async (name: string, branch: string, baseBranch?: string) => {
			await create(name, branch, baseBranch);
			select(name);
			setIsCreateOpen(false);
		},
		[create, select],
	);

	const handleOpenCreate = useCallback(() => {
		setIsOpen(false);
		setIsCreateOpen(true);
	}, []);

	const displayName = currentWorktree ? getDisplayName(currentWorktree) : null;

	const isCurrent = useCallback(
		(worktree: WorktreeInfo) => {
			return current ? worktree.name === current : worktree.is_main;
		},
		[current],
	);

	// Close button component (reused in multiple places)
	const closeButton = !isDesktop && onClose && (
		<button
			type="button"
			onClick={onClose}
			className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			aria-label="Close sidebar"
		>
			<X className="h-5 w-5" aria-hidden="true" />
		</button>
	);

	// Non-git repository: show simple header
	if (!isGitRepo) {
		return (
			<div className="mx-3 mt-3 mb-2 flex items-center gap-2">
				<div className="flex min-w-0 flex-1 items-center px-1 py-2">
					<span className="truncate text-base font-bold text-th-text-primary">
						Pockode
					</span>
				</div>
				{closeButton}
			</div>
		);
	}

	// Loading state or no worktree data yet: show skeleton
	if (isLoading || !displayName) {
		return (
			<div className="mx-3 mt-3 mb-2 flex items-center gap-2">
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-th-border bg-th-bg-tertiary px-3 py-2">
					<div className="h-4 w-4 shrink-0 rounded bg-th-text-muted/20 animate-pulse" />
					<div className="h-4 flex-1 rounded bg-th-text-muted/20 animate-pulse" />
				</div>
				{closeButton}
			</div>
		);
	}

	return (
		<div className="relative mx-3 mt-3 mb-2 flex items-center gap-2">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-th-border bg-th-bg-tertiary px-3 py-2 text-th-text-primary transition-colors hover:border-th-border-focus hover:bg-th-bg-secondary"
				aria-expanded={isOpen}
				aria-haspopup="listbox"
				aria-label="Select worktree"
			>
				<GitBranch
					className="h-4 w-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<span className="flex-1 truncate text-left text-sm">{displayName}</span>
				<ChevronDown
					className={`h-4 w-4 shrink-0 text-th-text-muted transition-transform group-hover:text-th-text-primary ${
						isOpen ? "rotate-180" : ""
					}`}
					aria-hidden="true"
				/>
			</button>

			{closeButton}

			<WorktreeDropdown
				isOpen={isOpen}
				worktrees={worktrees}
				onSelect={handleSelect}
				onDelete={handleDelete}
				onCreateNew={handleOpenCreate}
				onClose={() => setIsOpen(false)}
				getDisplayName={getDisplayName}
				triggerRef={buttonRef}
				isDesktop={isDesktop}
				isCurrent={isCurrent}
			/>

			{isCreateOpen && (
				<WorktreeCreateSheet
					onClose={() => setIsCreateOpen(false)}
					onCreate={handleCreate}
					isCreating={isCreating}
					isDesktop={isDesktop}
				/>
			)}
		</div>
	);
}

export default WorktreeSwitcher;
