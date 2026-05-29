import type { Workspace } from "../../lib/workspaceStore";
import WorkspaceEmptyState from "./WorkspaceEmptyState";
import WorkspaceItem from "./WorkspaceItem";

interface Props {
	workspaces: Workspace[];
	onSelect: (workspace: Workspace) => void;
	onDelete: (workspace: Workspace) => void;
	onAdd: () => void;
	isLoading: boolean;
}

function WorkspaceListSkeleton() {
	return (
		<div className="space-y-1">
			{[1, 2, 3].map((i) => (
				<div key={i} className="animate-pulse px-4 py-3">
					<div className="flex items-center gap-3">
						<div className="h-5 w-5 rounded bg-th-text-muted/20" />
						<div className="flex-1 space-y-2">
							<div className="h-4 w-32 rounded bg-th-text-muted/20" />
							<div className="h-3 w-48 rounded bg-th-text-muted/20" />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

function WorkspaceList({
	workspaces,
	onSelect,
	onDelete,
	onAdd,
	isLoading,
}: Props) {
	if (isLoading) {
		return <WorkspaceListSkeleton />;
	}

	if (workspaces.length === 0) {
		return <WorkspaceEmptyState onAdd={onAdd} />;
	}

	return (
		<div className="flex-1 overflow-y-auto" role="listbox">
			{workspaces.map((workspace) => (
				<WorkspaceItem
					key={workspace.id}
					workspace={workspace}
					onSelect={() => onSelect(workspace)}
					onDelete={() => onDelete(workspace)}
				/>
			))}
		</div>
	);
}

export default WorkspaceList;
