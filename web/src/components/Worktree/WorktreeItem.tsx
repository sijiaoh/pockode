import type { WorktreeInfo } from "../../types/message";
import DeleteButton from "../common/DeleteButton";

interface Props {
	worktree: WorktreeInfo;
	displayName: string;
	onSelect: () => void;
	onDelete: () => void;
	isCurrent: boolean;
}

function WorktreeItem({
	worktree,
	displayName,
	onSelect,
	onDelete,
	isCurrent,
}: Props) {
	const showBranchSubtitle =
		worktree.branch !== worktree.name && worktree.branch !== displayName;

	const canDelete = !worktree.is_main;

	return (
		/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: Keyboard navigation handled by listbox parent */
		<div
			onClick={isCurrent ? undefined : onSelect}
			className={`group flex min-h-11 w-full items-center gap-3 px-3 py-2.5 transition-colors ${
				isCurrent ? "bg-th-accent/10" : "cursor-pointer hover:bg-th-bg-tertiary"
			}`}
			role="option"
			aria-selected={isCurrent}
		>
			<div className="min-w-0 flex-1 text-left">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm text-th-text-primary">
						{displayName}
					</span>
					{worktree.is_main && (
						<span className="shrink-0 rounded border border-th-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-th-text-muted">
							Default
						</span>
					)}
				</div>
				{showBranchSubtitle && (
					<span className="mt-0.5 block truncate text-xs text-th-text-muted">
						{worktree.branch}
					</span>
				)}
			</div>

			{canDelete && (
				<DeleteButton
					itemName={displayName}
					itemType="worktree"
					onDelete={onDelete}
					confirmMessage={`This will remove the worktree "${displayName}" and its working directory. This action cannot be undone.`}
				/>
			)}
		</div>
	);
}

export default WorktreeItem;
