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
}

function FileTree({
	onSelectFile,
	activeFilePath,
	expandSignal,
	watchEnabled,
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
				<Spinner className="text-th-text-muted" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-center text-th-error">
				<div className="font-medium">Failed to load files</div>
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
		<div className="py-1">
			{data.map((entry) => (
				<FileTreeNode
					key={entry.path}
					entry={entry}
					depth={0}
					onSelectFile={onSelectFile}
					activeFilePath={activeFilePath}
					expandSignal={expandSignal}
					watchEnabled={watchEnabled}
				/>
			))}
		</div>
	);
}

export default FileTree;
