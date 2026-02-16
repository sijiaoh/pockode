import { Loader2 } from "lucide-react";
import type { FileStatus } from "../../types/git";
import DiffFileItem from "./DiffFileItem";

interface Props {
	title: string;
	files: FileStatus[];
	staged: boolean;
	onSelectFile: (path: string, staged: boolean) => void;
	onToggleStage: (path: string) => void;
	onToggleAll: () => void;
	activeFile: { path: string; staged: boolean } | null;
	togglingPaths: Set<string>;
}

function DiffFileList({
	title,
	files,
	staged,
	onSelectFile,
	onToggleStage,
	onToggleAll,
	activeFile,
	togglingPaths,
}: Props) {
	if (files.length === 0) {
		return null;
	}

	const isTogglingAll = files.every((f) => togglingPaths.has(f.path));
	const isTogglingAny = files.some((f) => togglingPaths.has(f.path));
	const toggleAllLabel = staged ? "Unstage All" : "Stage All";

	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-3 py-2">
				<span className="text-xs uppercase text-th-text-muted">
					{title} ({files.length})
				</span>
				<button
					type="button"
					onClick={onToggleAll}
					disabled={isTogglingAny}
					className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
						isTogglingAny
							? "opacity-50 cursor-not-allowed text-th-text-muted"
							: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
					}`}
				>
					{isTogglingAll && (
						<Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
					)}
					{toggleAllLabel}
				</button>
			</div>
			<div className="flex flex-col gap-1 px-2 pb-1">
				{files.map((file) => (
					<DiffFileItem
						key={`${staged}-${file.path}`}
						file={file}
						staged={staged}
						onSelect={() => onSelectFile(file.path, staged)}
						onToggleStage={() => onToggleStage(file.path)}
						isActive={
							activeFile?.staged === staged && activeFile?.path === file.path
						}
						isToggling={togglingPaths.has(file.path)}
					/>
				))}
			</div>
		</div>
	);
}

export default DiffFileList;
