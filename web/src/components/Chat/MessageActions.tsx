import { Check, Copy, GitBranch, X } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { iconButtonClass } from "../ui/iconButtonClass";
import MessageMenu from "./MessageMenu";
import type { ForkBlocked } from "./MessageMenuTrigger";

export interface MessageActionsProps {
	/** The message's own Markdown, absent when it has none to copy. */
	copyText?: string;
	/** Absent when the session cannot fork at all. */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
	/**
	 * Drawn on the row's right, outside the actions' group: the agents chip
	 * while a subagent outlives the turn (docs/turn-progress-ui.md#21-where-it-is).
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
 */
function MessageActions({
	copyText,
	onFork,
	forkBlocked,
	aside,
}: MessageActionsProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const { state: copyState, copy } = useCopyToClipboard({
		resetAfterMs: 2000,
	});

	if (!copyText && !onFork && !aside) return null;

	return (
		<div className="mt-2 flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
			{(copyText || onFork) && (
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
			{aside && <div className="ml-auto min-w-0">{aside}</div>}
		</div>
	);
}

// Memoized because its caller reads the tail's context, which changes on every
// thinking delta, in every settled reply: only the one reply with the agents
// chip gets new props.
export default memo(MessageActions);
