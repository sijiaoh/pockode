import { Check, Copy, GitBranch, X } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { TurnWork } from "../../lib/turnWork";
import { iconButtonClass } from "../ui/iconButtonClass";
import MessageMenu from "./MessageMenu";
import type { ForkBlocked } from "./MessageMenuTrigger";
import { spokenWorkFigures, WorkFiguresWords } from "./WorkFigures";

export interface MessageActionsProps {
	/** The message's own Markdown, absent when it has none to copy. */
	copyText?: string;
	/** Absent when the session cannot fork at all. */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
	/**
	 * The figures of a turn that made calls and changed no file, drawn at the
	 * row's right end; a turn that changed files has them on its changes card.
	 */
	work?: TurnWork;
	/**
	 * Something live that takes the right end in place of the figures: the
	 * agents chip while a subagent outlives the turn
	 * (docs/turn-progress-ui.md#21-where-it-is). Unlike the figures it makes
	 * the row on its own.
	 */
	aside?: ReactNode;
}

const quiet = "opacity-60 hover:opacity-100 focus-visible:opacity-100";

/**
 * The row under a settled agent message: Copy and Fork. Left-aligned under
 * the full-width text it acts on, with the first *icon* (not its box) on the
 * text's left edge — hence the negative margin, which is half of the box
 * minus half of the icon at each pointer size.
 *
 * Standing rather than behind a single `…` like the user's side: the agent's
 * text no longer sits in a bubble with a slot beside it, so the 44px column
 * that slot took is what the text got back, and the row takes the place of the
 * tail line and the bubble's padding instead (docs/session-fork-ui.md): both
 * hold the same height, so settling moves nothing above or below.
 *
 * No `…` beside them: the menu holds nothing these two do not, and a `…`
 * earns its place only by holding something the row lacks. A blocked fork
 * stays clickable and opens the menu, which says why: an icon cannot, and a
 * touch device shows no tooltip.
 *
 * The work figures at the right end are not an action, so they sit outside
 * the group; nor do they make a row of their own when there is none — a turn's
 * end gains no row for them (docs/tool-call-ui.md#the-work-figures). A count the
 * oldest page may have cut is not shown: alone it would claim a size it does
 * not know.
 *
 * The right end is one slot, not two: an agents chip and the figures never
 * share it. The chip is live and the figures are history, so the chip holds
 * the slot while it lasts and the figures take it when the chip goes — a swap
 * inside a row whose height is fixed, so nothing below moves. Side by side
 * they would not fit a phone's row without both truncating, and the figures
 * would slide right when the chip left.
 */
function MessageActions({
	copyText,
	onFork,
	forkBlocked,
	work,
	aside,
}: MessageActionsProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const { state: copyState, copy } = useCopyToClipboard({
		resetAfterMs: 2000,
	});

	const hasActions = !!copyText || !!onFork;
	if (!hasActions && !aside) return null;
	const figures =
		!aside && work?.calls !== undefined ? { work, files: 0 } : undefined;

	return (
		// The row, not the figures' content-sized box, is the `work-line`
		// container: a box sized by its content cannot be a size container.
		<div className="@container mt-2 flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
			{hasActions && (
				// biome-ignore lint/a11y/useSemanticElements: a row of actions on a message, not form controls a fieldset would group
				<div
					role="group"
					aria-label="Message actions"
					className="-ml-2.5 flex items-center gap-1 pointer-coarse:-ml-3.5 pointer-coarse:gap-2"
				>
					{copyText && (
						<button
							type="button"
							onClick={() => copy(copyText)}
							aria-label={
								copyState === "copied"
									? "Copied"
									: copyState === "failed"
										? "Copy failed"
										: "Copy message"
							}
							className={`${iconButtonClass()} animate-message-menu-in ${quiet}`}
						>
							{copyState === "copied" ? (
								<Check className="size-4" aria-hidden="true" />
							) : copyState === "failed" ? (
								// A failed copy needs nothing more: the text is on screen.
								<X className="size-4 text-th-error" aria-hidden="true" />
							) : (
								<Copy className="size-4" aria-hidden="true" />
							)}
						</button>
					)}
					{onFork && (
						<button
							type="button"
							onClick={forkBlocked ? () => setMenuOpen(true) : onFork}
							aria-disabled={forkBlocked ? true : undefined}
							// Blocked, it opens the menu that says why instead of forking.
							aria-haspopup={forkBlocked ? "dialog" : undefined}
							aria-expanded={forkBlocked ? menuOpen : undefined}
							aria-label="Fork from here"
							className={`${iconButtonClass()} animate-message-menu-in ${
								forkBlocked ? "opacity-40" : quiet
							}`}
						>
							<GitBranch className="size-4" aria-hidden="true" />
						</button>
					)}
					{menuOpen && onFork && (
						<MessageMenu
							side="assistant"
							onFork={onFork}
							forkBlocked={forkBlocked}
							onClose={() => setMenuOpen(false)}
						/>
					)}
				</div>
			)}
			{aside ? (
				<div className="ml-auto min-w-0">{aside}</div>
			) : (
				figures && (
					<span className="ml-auto min-w-0 animate-message-menu-in truncate text-xs text-th-text-muted">
						<span className="sr-only">{spokenWorkFigures(figures)}</span>
						<span aria-hidden>
							<WorkFiguresWords {...figures} />
						</span>
					</span>
				)
			)}
		</div>
	);
}

// Memoized because its caller reads the tail's context, which changes on every
// thinking delta, in every settled reply: only the one reply with the agents
// chip gets new props.
export default memo(MessageActions);
