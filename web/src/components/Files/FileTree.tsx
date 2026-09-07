import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { Spinner } from "../ui";
import FileTreeNode from "./FileTreeNode";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	expandSignal: number;
	watchEnabled: boolean;
	/** Folder uploads currently land in; empty is the workspace root. */
	uploadDestPath: string;
	onSelectDir: (path: string) => void;
	/** Where a drop would land right now; null while nothing is being dragged. */
	dropTargetPath: string | null;
	/** Folder a drag has hovered long enough to open. */
	springOpenPath: string | null;
}

function FileTree({
	onSelectFile,
	activeFilePath,
	expandSignal,
	watchEnabled,
	uploadDestPath,
	onSelectDir,
	dropTargetPath,
	springOpenPath,
}: Props) {
	const queryClient = useQueryClient();
	const { data, isLoading, error } = useContents();

	useFSWatch({
		path: "",
		onChanged: useCallback(() => {
			queryClient.invalidateQueries({ queryKey: contentsQueryKey("") });
		}, [queryClient]),
		enabled: watchEnabled,
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Spinner variant="current" className="text-th-text-muted" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-center text-th-error">
				<div className="">Failed to load files</div>
				<div className="mt-1 text-sm text-th-text-muted">
					{error instanceof Error ? error.message : String(error)}
				</div>
			</div>
		);
	}

	if (!Array.isArray(data) || data.length === 0) {
		return (
			<div className="p-4 text-center text-th-text-muted">
				No files to display
			</div>
		);
	}

	return (
		// The root has no row of its own, so the whole listing lights up to say a
		// drop would land at the top level.
		<div className={`py-1 ${dropTargetPath === "" ? "bg-th-accent/10" : ""}`}>
			{data.map((entry) => (
				<FileTreeNode
					key={entry.path}
					entry={entry}
					depth={0}
					onSelectFile={onSelectFile}
					activeFilePath={activeFilePath}
					expandSignal={expandSignal}
					watchEnabled={watchEnabled}
					uploadDestPath={uploadDestPath}
					onSelectDir={onSelectDir}
					dropTargetPath={dropTargetPath}
					springOpenPath={springOpenPath}
				/>
			))}
		</div>
	);
}

export default FileTree;
