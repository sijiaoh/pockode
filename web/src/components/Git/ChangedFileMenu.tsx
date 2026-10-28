import { Check, Copy, FileText, Trash2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { type ChangedFile, changeKindOf } from "../../lib/gitChanges";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";

/** Long enough to read `Copied`, short enough not to feel like a wait. */
const COPIED_CLOSE_MS = 1000;

interface Props {
	file: ChangedFile;
	onClose: () => void;
	onOpenFile: (path: string) => void;
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
	onDiscard,
	busy,
}: Props) {
	const deleted = changeKindOf(file) === "deleted";
	const untracked = file.unstaged?.status === "?";
	const { state: copyState, copy } = useCopyToClipboard();

	// The row says `Copied` before the sheet goes, so the press is seen to work.
	// A failure keeps the sheet: its title holds the path to copy by hand.
	useEffect(() => {
		if (copyState !== "copied") return;
		const timer = window.setTimeout(onClose, COPIED_CLOSE_MS);
		return () => clearTimeout(timer);
	}, [copyState, onClose]);

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
				<MenuRow
					icon={copyState === "copied" ? Check : Copy}
					label={
						copyState === "copied"
							? "Copied"
							: copyState === "failed"
								? "Copy failed"
								: "Copy path"
					}
					onClick={() => {
						copy(file.path);
					}}
				/>
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
