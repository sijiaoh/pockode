import { Check, Copy, GitBranch, MoreHorizontal, X } from "lucide-react";
import { useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import MessageMenu from "./MessageMenu";
import type { ForkBlocked } from "./MessageMenuTrigger";

interface Props {
	/**
	 * The agent is still writing this message. The row holds its place with the
	 * spinner (when `spinning`) instead of buttons, so settling swaps one for the
	 * other without moving anything above or below.
	 */
	pending: boolean;
	spinning: boolean;
	/** The message's own Markdown, absent when it has none to copy. */
	copyText?: string;
	/** Absent when the session cannot fork at all. */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
}

const quiet = "opacity-60 hover:opacity-100 focus-visible:opacity-100";

/**
 * The row under a settled agent message: Copy, Fork and the `…` that holds
 * both. Left-aligned under the full-width text it acts on, with the first
 * *icon* (not its box) on the text's left edge — hence the negative margin,
 * which is half of the box minus half of the icon at each pointer size.
 *
 * Standing rather than behind a single `…` like the user's side: the agent's
 * text no longer sits in a bubble with a slot beside it, so the 44px column
 * that slot took is what the text got back, and the row takes the place of the
 * spinner and the bubble's padding instead (docs/session-fork-ui.md).
 *
 * A blocked fork stays clickable and opens the menu, which says why: an icon
 * cannot, and a touch device shows no tooltip.
 */
function MessageActions({
	pending,
	spinning,
	copyText,
	onFork,
	forkBlocked,
}: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const { state: copyState, copy } = useCopyToClipboard({
		resetAfterMs: 2000,
	});

	const onCopy = copyText ? () => copy(copyText) : undefined;
	// Without fork the menu would only repeat Copy.
	const hasMenu = onFork !== undefined;
	if (!pending && !onCopy && !hasMenu) return null;

	return (
		// biome-ignore lint/a11y/useSemanticElements: a row of actions on a message, not form controls a fieldset would group
		<div
			role="group"
			aria-label="Message actions"
			className="mt-2 -ml-2.5 flex min-h-9 items-center gap-1 pointer-coarse:-ml-3.5 pointer-coarse:min-h-11 pointer-coarse:gap-2"
		>
			{pending ? (
				// Back by the margin the row borrowed, so the spinner sits on the
				// text edge where it always has.
				spinning && (
					<Spinner variant="current" className="ml-2.5 pointer-coarse:ml-3.5" />
				)
			) : (
				<>
					{onCopy && (
						<button
							type="button"
							onClick={onCopy}
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
							aria-label="Fork from here"
							className={`${iconButtonClass()} animate-message-menu-in ${
								forkBlocked ? "opacity-40" : quiet
							}`}
						>
							<GitBranch className="size-4" aria-hidden="true" />
						</button>
					)}
					{hasMenu && (
						<button
							type="button"
							onClick={() => setMenuOpen(true)}
							aria-haspopup="dialog"
							aria-expanded={menuOpen}
							aria-label="More actions for the agent's message"
							className={`${iconButtonClass()} animate-message-menu-in ${
								menuOpen ? "opacity-100" : quiet
							}`}
						>
							<MoreHorizontal className="size-4" aria-hidden="true" />
						</button>
					)}
				</>
			)}
			{menuOpen && onFork && (
				<MessageMenu
					side="assistant"
					onFork={onFork}
					forkBlocked={forkBlocked}
					onCopy={onCopy}
					onClose={() => setMenuOpen(false)}
				/>
			)}
		</div>
	);
}

export default MessageActions;
