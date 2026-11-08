import { FolderTree, List } from "lucide-react";
import {
	type ChangedFile,
	type ChangesView,
	sumLines,
} from "../../lib/gitChanges";
import { iconButtonClass } from "../ui/iconButtonClass";
import LineCounts from "./LineCounts";

interface Props {
	/** One per path, both sides: a partly staged file counts once. */
	files: ChangedFile[];
	view: ChangesView;
	onChangeView: (view: ChangesView) => void;
}

const VIEWS = [
	{ value: "flat", icon: List, label: "Flat list" },
	{ value: "tree", icon: FolderTree, label: "Folder tree" },
] as const;

/**
 * The list's sticky header: the file count, the totals and flat/tree. It
 * stages nothing — each group header does that for its own rows — and
 * discards nothing: that is the bottom bar's.
 *
 * At a narrow column the label and totals are the one element that gives
 * way, totals first; the controls keep their size.
 */
function ChangesHeader({ files, view, onChangeView }: Props) {
	const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;

	return (
		<div className="sticky top-0 z-10 flex min-h-[44px] items-center gap-1 border-b border-th-border bg-th-bg-secondary px-2 pointer-coarse:gap-2">
			<span className="flex min-w-0 flex-1 pl-2 items-baseline gap-2 overflow-hidden whitespace-nowrap">
				<span className="shrink-0 text-sm text-th-text-primary">{count}</span>
				<LineCounts lines={sumLines(files)} className="min-w-0 truncate" />
			</span>
			<div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2">
				{VIEWS.map(({ value, icon: Icon, label }) => (
					<button
						key={value}
						type="button"
						aria-label={label}
						aria-pressed={view === value}
						onClick={() => onChangeView(value)}
						className={`${iconButtonClass()} ${
							view === value ? "bg-th-bg-tertiary text-th-text-primary" : ""
						}`}
					>
						<Icon className="h-4 w-4" aria-hidden="true" />
					</button>
				))}
			</div>
		</div>
	);
}

export default ChangesHeader;
