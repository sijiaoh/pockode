import { GitBranch, Plus } from "lucide-react";
import { useMemo } from "react";
import type { WorktreeInfo } from "../../types/message";
import ResponsivePanel from "../ui/ResponsivePanel";
import WorktreeItem from "./WorktreeItem";

interface Props {
	isOpen: boolean;
	worktrees: WorktreeInfo[];
	onSelect: (worktree: WorktreeInfo) => void;
	onDelete: (worktree: WorktreeInfo) => void;
	onCreateNew: () => void;
	onClose: () => void;
	getDisplayName: (worktree: WorktreeInfo) => string;
	triggerRef?: React.RefObject<HTMLButtonElement | null>;
	isExpanded: boolean;
	isCurrent: (worktree: WorktreeInfo) => boolean;
}

function WorktreeDropdown({
	isOpen,
	worktrees,
	onSelect,
	onDelete,
	onCreateNew,
	onClose,
	getDisplayName,
	triggerRef,
	isExpanded,
	isCurrent,
}: Props) {
	// Only main worktree exists = no other worktrees to switch to
	const hasOnlyMain = worktrees.length === 1 && worktrees[0].is_main;

	// Sort: main first, then alphabetically by name
	const sortedWorktrees = useMemo(() => {
		return [...worktrees].sort((a, b) => {
			if (a.is_main !== b.is_main) return a.is_main ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}, [worktrees]);

	return (
		<ResponsivePanel
			isOpen={isOpen}
			onClose={onClose}
			title="Switch worktree"
			triggerRef={triggerRef}
			isExpanded={isExpanded}
			mobileMaxHeight="70dvh"
			desktopMaxHeight="50vh"
		>
			{hasOnlyMain ? (
				<div className="flex flex-col items-center px-4 py-6 text-center">
					<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-th-bg-tertiary">
						<GitBranch className="h-5 w-5 text-th-text-muted" />
					</div>
					<p className="text-sm text-th-text-muted">No other worktrees yet</p>
					<p className="mt-1 text-xs text-th-text-muted">
						git worktree lets you work on
						<br />
						multiple branches in parallel
					</p>
				</div>
			) : (
				<div className="flex-1 overflow-y-auto py-2">
					{sortedWorktrees.map((worktree) => {
						const isCurrentWorktree = isCurrent(worktree);
						return (
							<WorktreeItem
								key={worktree.name || "__main__"}
								worktree={worktree}
								displayName={getDisplayName(worktree)}
								onSelect={() => onSelect(worktree)}
								onDelete={() => onDelete(worktree)}
								isCurrent={isCurrentWorktree}
							/>
						);
					})}
				</div>
			)}

			<div className="border-t border-th-border py-2">
				<button
					type="button"
					onClick={onCreateNew}
					className="flex w-full items-center gap-3 px-3 py-2.5 text-th-accent transition-colors hover:bg-th-accent/10 focus-visible:bg-th-accent/10 focus-visible:outline-none"
				>
					<Plus className="h-4 w-4" />
					<span className="text-sm ">New worktree</span>
				</button>
			</div>
		</ResponsivePanel>
	);
}

export default WorktreeDropdown;
