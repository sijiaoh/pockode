import { memo, type ReactNode } from "react";
import { linkDescription, opensAt } from "../../lib/symlink";
import type { EntryType, Link } from "../../types/contents";
import type { SearchRange } from "../../types/search";
import { splitPath } from "../../utils/path";
import { sliceRanges } from "../../utils/searchRange";
import Highlight from "../common/Highlight";
import SidebarListItem from "../common/SidebarListItem";
import { EntryIcon, LinkStatusGlyph } from "./EntryIcon";

interface Props {
	path: string;
	/** Matched characters of `path`; omitted where the row has nothing to mark. */
	pathRanges?: readonly SearchRange[];
	/** Set on a symlink, which name search lists by its own name. */
	link?: Link;
	/** The link's type as the tree gives it; a plain match is a file. */
	type?: EntryType;
	isActive: boolean;
	onSelect: (path: string) => void;
	actions?: ReactNode;
}

const NO_RANGES: readonly SearchRange[] = [];

/**
 * One matched file, shared by both search modes.
 *
 * Memoized because typing re-renders the whole result list on every keystroke
 * while the props stay identical until the debounced query lands.
 */
const FileSearchFileRow = memo(function FileSearchFileRow({
	path,
	pathRanges = NO_RANGES,
	link,
	type = "file",
	isActive,
	onSelect,
	actions,
}: Props) {
	const { fileName, directory } = splitPath(path);
	const name = (
		<Highlight
			text={fileName}
			ranges={sliceRanges(pathRanges, directory.length, path.length)}
		/>
	);
	const opens = opensAt(path, link);

	return (
		<SidebarListItem
			title={
				link ? (
					<span className="flex min-w-0 items-center gap-1.5">
						<span
							className={`truncate ${type === "link" ? "text-th-text-muted" : ""}`}
						>
							{name}
						</span>
						<LinkStatusGlyph link={link} />
					</span>
				) : (
					name
				)
			}
			// A fuzzy match can pick characters from the directory as well as the name.
			subtitle={
				directory ? (
					<Highlight
						text={directory}
						ranges={sliceRanges(pathRanges, 0, directory.length)}
					/>
				) : undefined
			}
			isActive={isActive}
			onSelect={() => onSelect(opens)}
			ariaLabel={
				link ? `Open: ${linkDescription(path, link)}` : `Open file: ${path}`
			}
			leftSlot={
				<EntryIcon
					type={type}
					link={link}
					className="mt-0.5 h-4 w-4 shrink-0 self-start text-th-text-muted"
				/>
			}
			actions={actions}
		/>
	);
});

export default FileSearchFileRow;
