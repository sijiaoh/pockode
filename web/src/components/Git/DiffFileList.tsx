import { Loader2, Minus, Plus, Undo2 } from "lucide-react";
import type { FileStatus } from "../../types/git";
import { iconButtonClass } from "../common/iconButtonClass";
import DiffFileItem from "./DiffFileItem";
import GroupHeader from "./GroupHeader";

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
	const ToggleAllIcon = staged ? Minus : Plus;
	const toggleAllLabel = staged ? "Unstage all files" : "Stage all files";

	return (
		<div className="flex flex-col">
			<GroupHeader
				label={`${title} ${files.length}`}
				actions={
					/* Gapped rather than flush, so the destructive button is not a
					   neighbour of the one used all day. */
					<div className="flex shrink-0 items-center gap-3">
						{onDiscardAll && (
							<button
								type="button"
								onClick={onDiscardAll}
								disabled={isBusy}
								aria-label="Discard all changes"
								className={iconButtonClass(isBusy)}
							>
								{isDiscardingAny ? (
									<Loader2
										className="h-4 w-4 animate-spin"
										aria-hidden="true"
									/>
								) : (
									<Undo2 className="h-4 w-4" aria-hidden="true" />
								)}
							</button>
						)}
						<button
							type="button"
							onClick={onToggleAll}
							disabled={isBusy}
							aria-label={toggleAllLabel}
							className={iconButtonClass(isBusy)}
						>
							{isTogglingAll ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<ToggleAllIcon className="h-4 w-4" aria-hidden="true" />
							)}
						</button>
					</div>
				}
			/>
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
