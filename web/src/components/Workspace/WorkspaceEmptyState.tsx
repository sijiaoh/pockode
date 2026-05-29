import { FolderPlus } from "lucide-react";

interface Props {
	onAdd: () => void;
}

function WorkspaceEmptyState({ onAdd }: Props) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
			<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-th-bg-tertiary">
				<FolderPlus className="h-6 w-6 text-th-text-muted" />
			</div>
			<p className="text-base font-medium text-th-text-primary">
				No workspaces yet
			</p>
			<p className="mt-1 text-sm text-th-text-muted">
				Add a workspace to start coding
			</p>
			<button
				type="button"
				onClick={onAdd}
				className="mt-6 rounded-lg bg-th-accent px-6 py-2.5 text-sm text-th-accent-text hover:bg-th-accent-hover"
			>
				+ Add Workspace
			</button>
		</div>
	);
}

export default WorkspaceEmptyState;
