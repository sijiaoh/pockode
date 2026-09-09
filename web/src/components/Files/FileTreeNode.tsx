import { useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
	MoreHorizontal,
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
	onOpenMenu: (entry: Entry) => void;
	/** Row whose menu is open, so it can keep its button showing. */
	menuPath: string | null;
	/** Where a drop would land right now; null while nothing is being dragged. */
	dropTargetPath: string | null;
	/** Folder a drag has hovered long enough to open. */
	springOpenPath: string | null;
	/** Folder something outside the tree — a new entry — needs open. */
	forceOpenPath: string | null;
}

/**
 * Not `iconButtonClass()`: that rung is fixed at 36px and this button takes the
 * 44px touch floor. Appending a height to it would not settle that — both are
 * single utility classes at the same specificity, so stylesheet order would
 * decide which won, not call order.
 *
 * The rung having two heights at all is a known divergence, not a rule this
 * button is the exception to; it is flagged in docs/sidebar-ui.md#visual-weight.
 */
const menuButtonClass =
	"flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-th-text-muted transition-all hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset active:scale-95";

const FileTreeNode = memo(function FileTreeNode({
	entry,
	depth,
	onSelectFile,
	activeFilePath,
	expandSignal,
	watchEnabled,
	onOpenMenu,
	menuPath,
	dropTargetPath,
	springOpenPath,
	forceOpenPath,
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

	// Something was just created in this folder, and a folder that stays closed
	// over it is the same as the creation having done nothing.
	useEffect(() => {
		if (isDirectory && forceOpenPath === entry.path) setIsExpanded(true);
	}, [isDirectory, forceOpenPath, entry.path]);

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
		} else {
			onSelectFile(entry.path);
		}
	};

	const isDropTarget = isDirectory && entry.path === dropTargetPath;
	const isMenuOpen = entry.path === menuPath;

	const paddingLeft = 12 + depth * 16;

	return (
		// On the wrapper rather than the row: the subtree of an expanded folder
		// then answers for that folder, so the gaps around its children — the
		// loading spinner, the failure line — are aimed somewhere too.
		<div data-entry-path={entry.path} data-entry-type={entry.type}>
			{/* Highlight, hover and indentation sit here rather than on the row
			    button, which no longer spans the row: on the button they would stop
			    short of the menu, leaving a notch out of the drop target. */}
			<div
				style={{ paddingLeft }}
				className={`group flex min-h-[44px] items-center gap-1.5 pr-1 text-sm transition-colors ${
					isDropTarget
						? // A fill rather than a tint of the row, because this one is
							// answering a cursor that is moving right now.
							"bg-th-accent/10 text-th-text-primary"
						: isActive
							? "bg-th-bg-tertiary text-th-text-primary"
							: "text-th-text-secondary hover:bg-th-bg-tertiary hover:text-th-text-primary"
				}`}
			>
				<button
					type="button"
					onClick={handleClick}
					className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
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
								<Folder className="h-4 w-4 shrink-0 text-th-text-muted" />
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

				{/* A sibling of the row, never inside it: nested, every tap on it
				    would also open the file or toggle the folder. Always drawn on a
				    touch screen, which has no hover to reveal it with; on a pointer
				    only its opacity changes, so the name beside it never reflows. */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onOpenMenu(entry);
					}}
					className={`${menuButtonClass} ${
						isMenuOpen
							? ""
							: "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
					}`}
					aria-label={`More actions for ${entry.path}`}
					aria-haspopup="dialog"
					aria-expanded={isMenuOpen}
				>
					<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>

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
								onOpenMenu={onOpenMenu}
								menuPath={menuPath}
								dropTargetPath={dropTargetPath}
								springOpenPath={springOpenPath}
								forceOpenPath={forceOpenPath}
							/>
						))
					) : null}
				</div>
			)}
		</div>
	);
});

export default FileTreeNode;
