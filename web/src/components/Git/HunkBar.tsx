import { TextSelect } from "lucide-react";
import type { DiffHunk } from "../../lib/diffHunks";
import { capitalize, formatRange } from "../../lib/diffRows";
import { iconButtonClass } from "../ui/iconButtonClass";
import StageCheckbox from "./StageCheckbox";

interface Props {
	hunk: DiffHunk;
	index: number;
	/** Whether the side on screen is the staged one, which fixes the box's state. */
	staged: boolean;
	/** Absent when the server sent no ID for the hunk: it cannot be staged as shown. */
	stage?: {
		busy: boolean;
		onToggle: () => void;
	};
	/** Selects the hunk's lines for handing to the agent. */
	onSelect?: () => void;
}

/** Where the review finds a bar again after the diff under it changed. */
export const HUNK_BAR_ATTRIBUTE = "data-hunk-bar";

/**
 * `lines 40–48`, numbered on the side's new version — the working tree's on
 * the unstaged side, the index's on the staged one. A hunk that only removes
 * lines has none there, so it is `removed lines 41–43` in the old numbering.
 */
export function hunkRange(hunk: DiffHunk): string {
	return hunk.newCount === 0
		? formatRange("removed", hunk.oldStart, hunk.oldStart + hunk.oldCount - 1)
		: formatRange("lines", hunk.newStart, hunk.newStart + hunk.newCount - 1);
}

/**
 * A hunk's title row in the review: its stage box, its range and git's
 * function context, and the button that selects its lines
 * (docs/git-changes-ui.md#staging-a-hunk).
 *
 * The box sits between the gap row's expand target and the lines' gutter, so
 * the row is taller than the box's hit area by the floor's spacing on either
 * side: 60px around a 44px area under a thumb, 44px around 36px for a mouse.
 */
function HunkBar({ hunk, index, staged, stage, onSelect }: Props) {
	const range = hunkRange(hunk);
	return (
		<div
			{...{ [HUNK_BAR_ATTRIBUTE]: index }}
			className="flex h-11 items-center gap-2 bg-th-bg-secondary px-1 text-xs pointer-coarse:h-15"
		>
			{stage ? (
				<StageCheckbox
					state={staged ? "checked" : "unchecked"}
					label={`Stage ${range}`}
					busy={stage.busy}
					onToggle={stage.onToggle}
				/>
			) : (
				// Keeps the range where the boxed hunks have theirs.
				<span aria-hidden="true" className="w-9 shrink-0 pointer-coarse:w-11" />
			)}
			<span className="shrink-0 tabular-nums text-th-text-primary">
				{capitalize(range)}
			</span>
			<span className="min-w-0 flex-1 truncate font-mono text-th-text-muted">
				{hunk.context}
			</span>
			{onSelect && (
				<button
					type="button"
					onClick={onSelect}
					aria-label={`Select ${range}`}
					className={iconButtonClass()}
				>
					<TextSelect className="h-4 w-4" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

export default HunkBar;
