import { Ellipsis, FolderTree, List, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	aggregateCheckState,
	type ChangedFile,
	type ChangesView,
	describeStageable,
	sumLines,
	withoutConflicts,
} from "../../lib/gitChanges";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import LineCounts from "./LineCounts";
import StageCheckbox, { StageGutter } from "./StageCheckbox";

interface Props {
	files: ChangedFile[];
	busy: boolean;
	view: ChangesView;
	onToggleAll: () => void;
	onChangeView: (view: ChangesView) => void;
	onDiscardAll: () => void;
}

const VIEWS = [
	{ value: "flat", icon: List, label: "Flat list" },
	{ value: "tree", icon: FolderTree, label: "Folder tree" },
] as const;

/**
 * The list's sticky header: select all, the totals, flat/tree and the one
 * destructive action for every file — in a menu, since a one-tap discard-all
 * beside the most-tapped box on the screen is what this layout removes.
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
	onDiscardAll,
}: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
	const stageable = withoutConflicts(files);
	const anyConflict = stageable.length < files.length;
	// A conflict has no unstaged side, so discard-all already passes it over.
	const anyUnstaged = files.some((f) => f.unstaged);

	// Gone with its one item, rather than left offering a discard that has
	// nothing left to do — and not back by itself when something is again.
	useEffect(() => {
		if (!anyUnstaged) setMenuOpen(false);
	}, [anyUnstaged]);

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
				{anyUnstaged && (
					<button
						type="button"
						aria-label="More actions for all changes"
						onClick={() => setMenuOpen(true)}
						className={iconButtonClass()}
					>
						<Ellipsis className="h-4 w-4" aria-hidden="true" />
					</button>
				)}
			</div>
			{menuOpen && (
				<Sheet title="All changes" onClose={() => setMenuOpen(false)}>
					<div className="py-1">
						<MenuRow
							icon={Undo2}
							label="Discard all changes…"
							danger
							// The write queue drops a path it already holds, so a
							// discard-all now would skip those files and say nothing.
							disabled={busy}
							description={
								busy ? "Wait for the changes in progress to finish." : undefined
							}
							onClick={() => {
								setMenuOpen(false);
								onDiscardAll();
							}}
						/>
					</div>
				</Sheet>
			)}
		</div>
	);
}

export default ChangesHeader;
