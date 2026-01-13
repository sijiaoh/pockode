import { GitBranch, Plus } from "lucide-react";
import { useMemo } from "react";
import type { WorktreeInfo } from "../../types/message";
import ResponsivePanel from "../ui/ResponsivePanel";
import WorktreeItem from "./WorktreeItem";

interface Props {
	isOpen: boolean;
	worktrees: WorktreeInfo[];
	current: string;
	onSelect: (worktree: WorktreeInfo) => void;
	onDelete: (worktree: WorktreeInfo) => void;
	onCreateNew: () => void;
	onClose: () => void;
	getDisplayName: (worktree: WorktreeInfo) => string;
	triggerRef?: React.RefObject<HTMLButtonElement>;
	isDesktop: boolean;
}

function WorktreeDropdown({
	isOpen,
	worktrees,
	current,
	onSelect,
	onDelete,
	onCreateNew,
	onClose,
	getDisplayName,
	triggerRef,
	isDesktop,
}: Props) {
	// Filter out current worktree - dropdown shows "switch to" options only
	const switchableWorktrees = useMemo(() => {
		return worktrees.filter((wt) =>
			current ? wt.name !== current : !wt.is_main,
		);
	}, [worktrees, current]);

	const hasNoSwitchTargets = switchableWorktrees.length === 0;

	return (
		<ResponsivePanel
			isOpen={isOpen}
			onClose={onClose}
			title="Switch worktree"
			triggerRef={triggerRef}
			isDesktop={isDesktop}
			mobileMaxHeight="70dvh"
			desktopMaxHeight="50vh"
		>
			{hasNoSwitchTargets ? (
				<div className="flex flex-col items-center px-4 py-6 text-center">
					<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-th-bg-tertiary">
						<GitBranch className="h-5 w-5 text-th-text-muted" />
					</div>
					<p className="text-sm text-th-text-muted">No other worktrees yet</p>
				</div>
			) : (
				<div className="flex-1 overflow-y-auto py-2">
					{switchableWorktrees.map((worktree) => (
						<WorktreeItem
							key={worktree.name || "__main__"}
							worktree={worktree}
							isCurrent={false}
							displayName={getDisplayName(worktree)}
							onSelect={() => onSelect(worktree)}
							onDelete={() => onDelete(worktree)}
						/>
					))}
				</div>
			)}

			<div className="border-t border-th-border p-2">
				<button
					type="button"
					onClick={onCreateNew}
					className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-th-accent transition-colors hover:bg-th-accent/10"
				>
					<Plus className="h-4 w-4" />
					<span className="text-sm font-medium">New worktree</span>
				</button>
			</div>
		</ResponsivePanel>
	);
}

export default WorktreeDropdown;
