import { FolderTree, List } from "lucide-react";
import {
	aggregateCheckState,
	type ChangedFile,
	type ChangesView,
	describeStageable,
	sumLines,
	withoutConflicts,
} from "../../lib/gitChanges";
import { iconButtonClass } from "../ui/iconButtonClass";
import LineCounts from "./LineCounts";
import StageCheckbox, { StageGutter } from "./StageCheckbox";

interface Props {
	files: ChangedFile[];
	busy: boolean;
	view: ChangesView;
	onToggleAll: () => void;
	onChangeView: (view: ChangesView) => void;
}

const VIEWS = [
	{ value: "flat", icon: List, label: "Flat list" },
	{ value: "tree", icon: FolderTree, label: "Folder tree" },
] as const;

/**
 * The list's sticky header: select all, the totals and flat/tree. Nothing
 * destructive: discarding is the bottom bar's, away from the most-tapped box
 * on the screen.
 *
 * At a narrow column the label and totals are the one element that gives
 * way, totals first; the controls keep their size.
 */
function ChangesHeader({
	files,
	busy,
	view,
	onToggleAll,
	onChangeView,
}: Props) {
	const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
	const stageable = withoutConflicts(files);
	const anyConflict = stageable.length < files.length;

	return (
		<div className="sticky top-0 z-10 flex min-h-[44px] items-center gap-1 border-b border-th-border bg-th-bg-secondary px-2 pointer-coarse:gap-2">
			{stageable.length > 0 ? (
				<StageCheckbox
					state={aggregateCheckState(files)}
					label={
						anyConflict
							? `Stage ${describeStageable(files)}`
							: `Stage all ${count}`
					}
					busy={busy}
					onToggle={onToggleAll}
				/>
			) : (
				<StageGutter />
			)}
			<span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap">
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
