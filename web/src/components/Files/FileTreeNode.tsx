import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useContents } from "../../hooks/useContents";
import type { Entry } from "../../types/contents";
import { Spinner } from "../ui";

interface Props {
	entry: Entry;
	depth: number;
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	expandSignal: number;
}

function FileTreeNode({
	entry,
	depth,
	onSelectFile,
	activeFilePath,
	expandSignal,
}: Props) {
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

	const { data, isLoading, error } = useContents(
		entry.path,
		isDirectory && isExpanded,
	);

	const handleClick = () => {
		if (isDirectory) {
			setIsExpanded(!isExpanded);
		} else {
			onSelectFile(entry.path);
		}
	};

	const paddingLeft = 12 + depth * 16;

	return (
		<div>
			<button
				type="button"
				onClick={handleClick}
				style={{ paddingLeft }}
				className={`flex w-full min-h-[36px] items-center gap-1.5 pr-3 py-1.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
					isActive
						? "bg-th-bg-tertiary text-th-text-primary"
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
						<Folder className="h-4 w-4 shrink-0 text-th-text-muted" />
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
							<Spinner className="h-4 w-4 text-th-text-muted" />
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
							/>
						))
					) : null}
				</div>
			)}
		</div>
	);
}

export default FileTreeNode;
