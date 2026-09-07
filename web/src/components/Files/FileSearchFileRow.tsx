import { File } from "lucide-react";
import { memo, type ReactNode } from "react";
import { splitPath } from "../../utils/path";
import Highlight from "../common/Highlight";
import SidebarListItem from "../common/SidebarListItem";

interface Props {
	path: string;
	query: string;
	isActive: boolean;
	onSelect: (path: string) => void;
	actions?: ReactNode;
}

/**
 * One matched file, shared by both search modes.
 *
 * Memoized because typing re-renders the whole result list on every keystroke
 * while the props stay identical until the debounced query lands.
 */
const FileSearchFileRow = memo(function FileSearchFileRow({
	path,
	query,
	isActive,
	onSelect,
	actions,
}: Props) {
	const { fileName, directory } = splitPath(path);

	return (
		<SidebarListItem
			title={<Highlight text={fileName} query={query} />}
			// A query containing "/" can match the directory instead of the name.
			subtitle={
				directory ? <Highlight text={directory} query={query} /> : undefined
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
