import { FileText, History, Trash2, Undo2 } from "lucide-react";
import { type ChangedFile, changeKindOf } from "../../lib/gitChanges";
import CopyMenuRow from "../common/CopyMenuRow";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";

interface Props {
	file: ChangedFile;
	onClose: () => void;
	onOpenFile: (path: string) => void;
	onOpenHistory: (path: string) => void;
	/**
	 * Only offered while the file has unstaged changes: a staged side has
	 * nothing to discard, and a conflict has no side at all — git refuses to
	 * restore an unmerged path, and picking a side is not offered here.
	 */
	onDiscard: (file: ChangedFile) => void;
	/**
	 * A write for this file is queued or running. Discard waits it out: the
	 * write queue drops a path it already holds, so a discard pressed now would
	 * report success without having run.
	 */
	busy: boolean;
}

/**
 * What a changed file's row does beyond reviewing and staging it. A sheet on
 * both layouts, for `FileEntryMenu`'s reasons, and in its order: the one row
 * that takes something away comes last, behind a divider.
 */
function ChangedFileMenu({
	file,
	onClose,
	onOpenFile,
	onOpenHistory,
	onDiscard,
	busy,
}: Props) {
	const deleted = changeKindOf(file) === "deleted";
	const untracked = file.unstaged?.status === "?";

	return (
		<Sheet title={file.path} onClose={onClose}>
			<div className="py-1">
				<MenuRow
					icon={FileText}
					label="Open file"
					disabled={deleted}
					description={deleted ? "(deleted)" : undefined}
					onClick={() => onOpenFile(file.path)}
				/>
				{/* An untracked file has never been committed, so has no history. */}
				{!untracked && (
					<MenuRow
						icon={History}
						label="History of this file"
						onClick={() => onOpenHistory(file.path)}
					/>
				)}
				<CopyMenuRow text={file.path} label="Copy path" onCopied={onClose} />
				{file.unstaged && (
					<>
						<div className="my-1 border-t border-th-border" />
						<MenuRow
							icon={untracked ? Trash2 : Undo2}
							label={untracked ? "Delete file" : "Discard changes"}
							danger
							disabled={busy}
							description={
								busy ? "Wait for the change in progress to finish." : undefined
							}
							onClick={() => onDiscard(file)}
						/>
					</>
				)}
			</div>
		</Sheet>
	);
}

export default ChangedFileMenu;
