import { Loader2, Undo2 } from "lucide-react";
import type { FileStatus } from "../../types/git";
import DiffFileItem from "./DiffFileItem";

interface Props {
	title: string;
	files: FileStatus[];
	staged: boolean;
	onSelectFile: (path: string, staged: boolean) => void;
	onToggleStage: (path: string, staged: boolean) => void;
	onToggleAll: () => void;
	/** Absent on the staged group, which has nothing to discard. */
	onDiscard?: (file: FileStatus) => void;
	onDiscardAll?: () => void;
	activeFile: { path: string; staged: boolean } | null;
	togglingPaths: Set<string>;
	discardingPaths?: Set<string>;
}

function DiffFileList({
	title,
	files,
	staged,
	onSelectFile,
	onToggleStage,
	onToggleAll,
	onDiscard,
	onDiscardAll,
	activeFile,
	togglingPaths,
	discardingPaths,
}: Props) {
	if (files.length === 0) {
		return null;
	}

	const isDiscarding = (path: string) => Boolean(discardingPaths?.has(path));
	const isTogglingAll = files.every((f) => togglingPaths.has(f.path));
	const isTogglingAny = files.some((f) => togglingPaths.has(f.path));
	const isDiscardingAny = files.some((f) => isDiscarding(f.path));
	const isBusy = isTogglingAny || isDiscardingAny;
	const toggleAllLabel = staged ? "Unstage All" : "Stage All";

	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-3 py-2">
				<span className="text-xs uppercase text-th-text-muted">
					{title} ({files.length})
				</span>
				{/* Gapped rather than flush, so the destructive button is not a
				    neighbour of the one used all day. */}
				<div className="flex items-center gap-3">
					{onDiscardAll && (
						<button
							type="button"
							onClick={onDiscardAll}
							disabled={isBusy}
							aria-label={`Discard all ${title.toLowerCase()} changes`}
							className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
								isBusy
									? "opacity-50 cursor-not-allowed text-th-text-muted"
									: "text-th-text-secondary hover:text-th-text-primary active:scale-95"
							}`}
						>
							{isDiscardingAny ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<Undo2 className="h-4 w-4" aria-hidden="true" />
							)}
						</button>
					)}
					<button
						type="button"
						onClick={onToggleAll}
						disabled={isBusy}
						className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
							isBusy
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
			</div>
			<div className="flex flex-col gap-1 px-2 pb-1">
				{files.map((file) => (
					<DiffFileItem
						key={`${staged}-${file.path}`}
						file={file}
						staged={staged}
						onSelect={onSelectFile}
						onToggleStage={onToggleStage}
						onDiscard={onDiscard}
						isActive={
							activeFile?.staged === staged && activeFile?.path === file.path
						}
						isToggling={togglingPaths.has(file.path)}
						isDiscarding={isDiscarding(file.path)}
					/>
				))}
			</div>
		</div>
	);
}

export default DiffFileList;
