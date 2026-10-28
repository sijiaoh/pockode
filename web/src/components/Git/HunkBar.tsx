import { TextSelect } from "lucide-react";
import type { DiffHunk } from "../../lib/diffHunks";
import { capitalize, formatRange } from "../../lib/diffRows";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	hunk: DiffHunk;
	index: number;
	/**
	 * Absent where nothing can be staged — a commit's diff — and in the review
	 * when the server sent no ID for the hunk, which cannot be staged as shown,
	 * and when it is the side's only hunk, which the bottom bar's button
	 * already stages.
	 */
	stage?: {
		/** Whether the side on screen is the staged one: the button unstages there. */
		staged: boolean;
		busy: boolean;
		onToggle: () => void;
	};
	/** Selects the hunk's lines for handing to the agent. */
	onSelect?: () => void;
}

/** Where a page finds a bar again after the diff under it changed. */
export const HUNK_BAR_ATTRIBUTE = "data-hunk-bar";
/** The bar's stage button, for the review to hand focus on to. */
export const HUNK_STAGE_ATTRIBUTE = "data-hunk-stage";

/**
 * Frames to wait for the library to draw a diff's bars, about a second: it
 * rebuilds the lines of a changed diff in an effect, and draws an unwrapped
 * extend row only once it has measured the table.
 */
export const HUNK_BAR_FRAMES = 60;

/**
 * `lines 40–48`, numbered on the diff's new version — the working tree's on
 * the review's unstaged side, the index's on its staged one, the commit's in a
 * commit. A hunk that only removes lines has none there, so it is
 * `removed lines 41–43` in the old numbering.
 */
export function hunkRange(hunk: DiffHunk): string {
	return hunk.newCount === 0
		? formatRange("removed", hunk.oldStart, hunk.oldStart + hunk.oldCount - 1)
		: formatRange("lines", hunk.newStart, hunk.newStart + hunk.newCount - 1);
}

/**
 * A hunk's title row: its range and git's function context, the button that
 * selects its lines, and in the review the one that stages or unstages it
 * (docs/git-changes-ui.md#staging-a-hunk).
 *
 * An action named like the bottom bar's, not a checkbox: a box over each hunk
 * reads as "tick, then press Stage below", and on either side it could only
 * ever show one state.
 *
 * The row is taller than its buttons' hit areas by the floor's spacing on
 * either side, keeping them clear of the gap row's expand target above and
 * the lines' gutter below: 60px around a 44px area under a thumb, 44px around
 * 36px for a mouse.
 */
function HunkBar({ hunk, index, stage, onSelect }: Props) {
	const range = hunkRange(hunk);
	const verb = stage?.staged ? "Unstage" : "Stage";
	return (
		<div
			{...{ [HUNK_BAR_ATTRIBUTE]: index }}
			className="flex h-11 items-center gap-2 bg-th-bg-secondary pr-1 pl-3 text-xs pointer-coarse:h-15"
		>
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
			{stage && (
				// While busy it stays focusable and only ignores presses, as the
				// list's boxes do: `disabled` would drop a keyboard user's focus.
				<button
					type="button"
					{...{ [HUNK_STAGE_ATTRIBUTE]: "" }}
					aria-label={`${verb} ${range}`}
					aria-disabled={stage.busy || undefined}
					aria-busy={stage.busy || undefined}
					onClick={stage.busy ? undefined : stage.onToggle}
					className={`relative flex min-h-9 shrink-0 items-center justify-center rounded-md bg-th-bg-tertiary px-3 text-xs text-th-text-primary transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11 ${
						stage.busy
							? "cursor-not-allowed opacity-50"
							: "hover:opacity-90 active:scale-95"
					}`}
				>
					{/* The label keeps its width under the spinner, so the range and context do not shift. */}
					<span className={stage.busy ? "invisible" : undefined}>{verb}</span>
					{stage.busy && (
						<span className="absolute inset-0 flex items-center justify-center">
							<Spinner variant="current" size="h-3 w-3" srText={null} />
						</span>
					)}
				</button>
			)}
		</div>
	);
}

export default HunkBar;
