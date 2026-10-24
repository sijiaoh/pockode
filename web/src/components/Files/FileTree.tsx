import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import type { Entry } from "../../types/contents";
import { Spinner } from "../ui";
import FileTreeNode, { type EntryDragStart } from "./FileTreeNode";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	expandSignal: number;
	watchEnabled: boolean;
	onOpenMenu: (entry: Entry) => void;
	/** Row whose menu is open, so it can keep its button showing. */
	menuPath: string | null;
	/** Where a drop would land right now; null while nothing is being dragged. */
	dropTargetPath: string | null;
	/** Folder a drag has hovered long enough to open. */
	springOpenPath: string | null;
	/**
	 * Folders something outside the tree — a new or moved entry — needs open.
	 * A new array is a new request, even for paths asked for before.
	 */
	forceOpenPaths: readonly string[];
	/**
	 * Starts a row's drag, and with it the move of that entry. Left out where
	 * rows must not be dragged: on a touch screen, where a long press is not a
	 * drag but the start of a scroll or a menu.
	 */
	onEntryDragStart?: (entry: Entry, drag: EntryDragStart) => void;
	/** Entry being dragged right now. */
	dragSourcePath: string | null;
	/** Entries whose move has been sent and not yet answered. */
	movingPaths: ReadonlySet<string>;
}

function FileTree({
	onSelectFile,
	activeFilePath,
	expandSignal,
	watchEnabled,
	onOpenMenu,
	menuPath,
	dropTargetPath,
	springOpenPath,
	forceOpenPaths,
	onEntryDragStart,
	dragSourcePath,
	movingPaths,
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
					onOpenMenu={onOpenMenu}
					menuPath={menuPath}
					dropTargetPath={dropTargetPath}
					springOpenPath={springOpenPath}
					forceOpenPaths={forceOpenPaths}
					onEntryDragStart={onEntryDragStart}
					dragSourcePath={dragSourcePath}
					movingPaths={movingPaths}
				/>
			))}
		</div>
	);
}

export default FileTree;
