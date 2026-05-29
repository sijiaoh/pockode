import { FolderOpen } from "lucide-react";
import type { Workspace } from "../../lib/workspaceStore";
import DeleteButton from "../common/DeleteButton";

interface Props {
	workspace: Workspace;
	onSelect: () => void;
	onDelete: () => void;
	isActive?: boolean;
}

function WorkspaceItem({ workspace, onSelect, onDelete, isActive }: Props) {
	return (
		/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: Keyboard navigation handled by listbox parent */
		<div
			onClick={isActive ? undefined : onSelect}
			className={`group flex w-full items-center gap-3 px-4 py-3 transition-colors ${
				isActive ? "bg-th-accent/10" : "cursor-pointer hover:bg-th-bg-tertiary"
			}`}
			role="option"
			aria-selected={isActive}
		>
			<FolderOpen className="h-5 w-5 shrink-0 text-th-text-muted" />
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium text-th-text-primary">
					{workspace.name}
				</div>
				<div className="truncate text-xs text-th-text-muted">
					{workspace.path}
				</div>
			</div>

			<DeleteButton
				itemName={workspace.name}
				itemType="workspace"
				onDelete={onDelete}
				confirmMessage={`This will remove the workspace "${workspace.name}" from Pockode. The files on disk will not be deleted.`}
				className="shrink-0 rounded p-1 text-th-text-muted transition-all hover:bg-th-error/10 hover:text-th-error sm:opacity-0 sm:group-hover:opacity-100"
			/>
		</div>
	);
}

export default WorkspaceItem;
