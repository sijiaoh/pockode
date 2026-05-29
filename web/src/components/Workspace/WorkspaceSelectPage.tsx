import { Plus, Settings } from "lucide-react";
import { useCallback, useState } from "react";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import type { Workspace } from "../../lib/workspaceStore";
import WorkspaceCreateSheet from "./WorkspaceCreateSheet";
import WorkspaceList from "./WorkspaceList";

interface Props {
	workspaces: Workspace[];
	onSelect: (workspace: Workspace) => void;
	onCreate: (name: string, path: string) => Promise<void>;
	onDelete: (workspace: Workspace) => Promise<void>;
	onOpenSettings: () => void;
	isLoading: boolean;
}

function WorkspaceSelectPage({
	workspaces,
	onSelect,
	onCreate,
	onDelete,
	onOpenSettings,
	isLoading,
}: Props) {
	const isDesktop = useIsDesktop();
	const [showCreate, setShowCreate] = useState(false);
	const [isCreating, setIsCreating] = useState(false);

	const handleCreate = useCallback(
		async (name: string, path: string) => {
			setIsCreating(true);
			try {
				await onCreate(name, path);
				setShowCreate(false);
			} finally {
				setIsCreating(false);
			}
		},
		[onCreate],
	);

	const handleDelete = useCallback(
		async (workspace: Workspace) => {
			await onDelete(workspace);
		},
		[onDelete],
	);

	return (
		<div className="flex h-dvh flex-col bg-th-bg-primary">
			{/* Header */}
			<header className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
				<h1 className="text-lg font-bold text-th-text-primary">Pockode</h1>
				<button
					type="button"
					onClick={onOpenSettings}
					className="rounded p-2 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
					aria-label="Settings"
				>
					<Settings className="h-5 w-5" />
				</button>
			</header>

			{/* Main Content */}
			<main className="flex min-h-0 flex-1 flex-col">
				<WorkspaceList
					workspaces={workspaces}
					onSelect={onSelect}
					onDelete={handleDelete}
					onAdd={() => setShowCreate(true)}
					isLoading={isLoading}
				/>
			</main>

			{/* Footer */}
			{workspaces.length > 0 && (
				<footer className="shrink-0 border-t border-th-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					<button
						type="button"
						onClick={() => setShowCreate(true)}
						className="flex w-full items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text hover:bg-th-accent-hover"
					>
						<Plus className="h-4 w-4" />
						Add Workspace
					</button>
				</footer>
			)}

			{/* Create Sheet */}
			{showCreate && (
				<WorkspaceCreateSheet
					onClose={() => setShowCreate(false)}
					onCreate={handleCreate}
					isCreating={isCreating}
					isDesktop={isDesktop}
				/>
			)}
		</div>
	);
}

export default WorkspaceSelectPage;
