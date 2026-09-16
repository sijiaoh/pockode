import { FilePlus, FolderPlus, PencilLine, Trash2, Upload } from "lucide-react";
import type { Entry } from "../../types/contents";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";

/**
 * Stands in for the workspace root, which has no row of its own in the tree.
 *
 * A sentinel rather than a nullable target: the menu is opened from a row or
 * from the search bar, and every caller in between would otherwise have to
 * carry "no entry, but still open" as a second piece of state.
 */
export const ROOT_ENTRY: Entry = { name: "", type: "dir", path: "" };

interface Props {
	entry: Entry;
	onClose: () => void;
	onUpload: () => void;
	onNewFile: () => void;
	onNewFolder: () => void;
	onRename: () => void;
	/**
	 * Set when this entry is the file open in the editor, or a folder above it.
	 * Renaming it would pull the path out from under a buffer being written to;
	 * deleting is allowed there because the file really is gone, while here it
	 * is not (docs/file.md).
	 */
	renameBlockedByEditor?: boolean;
	onDelete: () => void;
}

/**
 * Everything a tree row can do beyond the one thing tapping it does.
 *
 * A sheet on both layouts: the project has no popover to build a dropdown on,
 * and one anchored to a row of a scrolling tree would mean positioning,
 * flipping and scroll tracking for a menu opened a few times a day. A sheet is
 * anchored to the viewport instead, so none of that arises, and it is the right
 * shape on a phone anyway.
 *
 * Focus is `Sheet`'s job, not this menu's: it takes focus on open, cycles Tab
 * inside itself and hands focus back to the `…` on close.
 */
function FileEntryMenu({
	entry,
	onClose,
	onUpload,
	onNewFile,
	onNewFolder,
	onRename,
	renameBlockedByEditor,
	onDelete,
}: Props) {
	const isRoot = entry.path === "";
	const isDirectory = entry.type === "dir";

	return (
		<Sheet title={isRoot ? "Project root" : entry.name} onClose={onClose}>
			<div className="py-1">
				{isDirectory && (
					<>
						<MenuRow icon={Upload} label="Upload files" onClick={onUpload} />
						<MenuRow icon={FilePlus} label="New file" onClick={onNewFile} />
						<MenuRow
							icon={FolderPlus}
							label="New folder"
							onClick={onNewFolder}
						/>
					</>
				)}
				{/* The root is the work directory itself rather than an entry of
				    the file namespace, so neither of these is ever about it. */}
				{!isRoot && (
					<>
						<MenuRow
							icon={PencilLine}
							label="Rename"
							disabled={renameBlockedByEditor}
							description={
								renameBlockedByEditor ? "Close the editor first." : undefined
							}
							onClick={onRename}
						/>
						{/* Kept apart and last: everything above it adds to the entry
						    or leaves it where it is, and this is the one row that
						    takes the entry away. */}
						<div className="my-1 border-t border-th-border" />
						<MenuRow icon={Trash2} label="Delete" danger onClick={onDelete} />
					</>
				)}
			</div>
		</Sheet>
	);
}

export default FileEntryMenu;
