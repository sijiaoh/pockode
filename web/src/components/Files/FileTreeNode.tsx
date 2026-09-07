import { useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import type { Entry } from "../../types/contents";
import { Spinner } from "../ui";

interface Props {
	entry: Entry;
	depth: number;
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

const FileTreeNode = memo(function FileTreeNode({
	entry,
	depth,
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
	const isDirectory = entry.type === "dir";
	const isActive = entry.path === activeFilePath;
	const isInActivePath =
		isDirectory && !!activeFilePath?.startsWith(`${entry.path}/`);
	const [isExpanded, setIsExpanded] = useState(isInActivePath);

	// biome-ignore lint/correctness/useExhaustiveDependencies: expandSignal is used as a trigger to re-run the effect
	useEffect(() => {
		if (isInActivePath) {
			setIsExpanded(true);
		}
	}, [expandSignal, isInActivePath]);

	// Hovering a drag over a closed folder opens it: a drag cannot click, so this
	// is the only way to reach a folder that was not already showing.
	useEffect(() => {
		if (isDirectory && springOpenPath === entry.path) setIsExpanded(true);
	}, [isDirectory, springOpenPath, entry.path]);

	const { data, isLoading, error } = useContents(
		entry.path,
		isDirectory && isExpanded,
	);

	useFSWatch({
		path: entry.path,
		onChanged: useCallback(() => {
			queryClient.invalidateQueries({ queryKey: contentsQueryKey(entry.path) });
		}, [queryClient, entry.path]),
		enabled: watchEnabled && isDirectory && isExpanded,
	});

	const handleClick = () => {
		if (isDirectory) {
			setIsExpanded(!isExpanded);
			// Collapsing counts too: tapping a folder is the nearest thing to a
			// statement about where the user is working right now.
			onSelectDir(entry.path);
		} else {
			onSelectFile(entry.path);
		}
	};

	const isUploadDest = isDirectory && entry.path === uploadDestPath;
	const isDropTarget = isDirectory && entry.path === dropTargetPath;

	const paddingLeft = 12 + depth * 16;

	return (
		// On the wrapper rather than the row: the subtree of an expanded folder
		// then answers for that folder, so the gaps around its children — the
		// loading spinner, the failure line — are aimed somewhere too.
		<div data-entry-path={entry.path} data-entry-type={entry.type}>
			<button
				type="button"
				onClick={handleClick}
				style={{ paddingLeft }}
				className={`flex w-full min-h-[36px] items-center gap-1.5 pr-3 py-1.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
					isDropTarget
						? // Louder than the standing destination tint below: this one is
							// answering a cursor that is moving right now.
							"bg-th-accent/10 text-th-text-primary"
						: isActive
							? "bg-th-bg-tertiary text-th-text-primary"
							: isUploadDest
								? // Tinted rather than grey, so "uploads land here" never reads
									// as "this is the file you are looking at".
									"bg-th-accent/5 text-th-text-primary"
								: "text-th-text-secondary hover:bg-th-bg-tertiary hover:text-th-text-primary"
				}`}
				aria-label={
					isDirectory
						? `${isExpanded ? "Collapse" : "Expand"} folder: ${entry.name}`
						: `Open file: ${entry.name}`
				}
				aria-expanded={isDirectory ? isExpanded : undefined}
			>
				{isDirectory ? (
					<>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4 shrink-0 text-th-text-muted" />
						) : (
							<ChevronRight className="h-4 w-4 shrink-0 text-th-text-muted" />
						)}
						{isDropTarget ? (
							<FolderOpen className="h-4 w-4 shrink-0 text-th-accent" />
						) : (
							<Folder
								className={`h-4 w-4 shrink-0 ${isUploadDest ? "text-th-accent" : "text-th-text-muted"}`}
							/>
						)}
					</>
				) : (
					<>
						<span className="w-4" />
						<File className="h-4 w-4 shrink-0 text-th-text-muted" />
					</>
				)}
				<span className="truncate">{entry.name}</span>
			</button>

			{isDirectory && isExpanded && (
				<div>
					{isLoading ? (
						<div
							className="flex items-center py-2"
							style={{ paddingLeft: paddingLeft + 20 }}
						>
							<Spinner variant="current" className="text-th-text-muted" />
						</div>
					) : error ? (
						<div
							className="py-1.5 text-xs text-th-error"
							style={{ paddingLeft: paddingLeft + 20 }}
						>
							Failed to load
						</div>
					) : Array.isArray(data) ? (
						data.map((child) => (
							<FileTreeNode
								key={child.path}
								entry={child}
								depth={depth + 1}
								onSelectFile={onSelectFile}
								activeFilePath={activeFilePath}
								expandSignal={expandSignal}
								watchEnabled={watchEnabled}
								uploadDestPath={uploadDestPath}
								onSelectDir={onSelectDir}
								dropTargetPath={dropTargetPath}
								springOpenPath={springOpenPath}
							/>
						))
					) : null}
				</div>
			)}
		</div>
	);
});

export default FileTreeNode;
