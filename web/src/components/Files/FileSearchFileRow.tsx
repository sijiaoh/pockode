import { File } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { SearchRange } from "../../types/search";
import { splitPath } from "../../utils/path";
import { sliceRanges } from "../../utils/searchRange";
import Highlight from "../common/Highlight";
import SidebarListItem from "../common/SidebarListItem";

interface Props {
	path: string;
	/** Matched characters of `path`; omitted where the row has nothing to mark. */
	pathRanges?: readonly SearchRange[];
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
	isActive,
	onSelect,
	actions,
}: Props) {
	const { fileName, directory } = splitPath(path);

	return (
		<SidebarListItem
			title={
				<Highlight
					text={fileName}
					ranges={sliceRanges(pathRanges, directory.length, path.length)}
				/>
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
			onSelect={() => onSelect(path)}
			ariaLabel={`Open file: ${path}`}
			leftSlot={
				<File className="mt-0.5 h-4 w-4 shrink-0 self-start text-th-text-muted" />
			}
			actions={actions}
		/>
	);
});

export default FileSearchFileRow;
