import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { iconButtonClass } from "../ui/iconButtonClass";
import MessageMenu from "./MessageMenu";

/**
 * Why fork applies to this message but cannot run on it.
 *
 * - `not-yet`: the message holds a request nobody has answered, or it has no
 *   seq. The second is rare now that the server tells a sender where its own
 *   message landed, leaving only a server too old to answer with one and a
 *   record that could not be persisted. Neither is on a clock — an answer
 *   settles the request, a reload names what an old server would not — so the
 *   sentence on the row promises only that this is not the message's permanent
 *   state. The unpersisted record is the one case it outlives rather than
 *   describes: it does not survive a reload, so nobody is left waiting.
 * - `nothing-before`: the message opens the session, and a fork returns to
 *   before it was sent. Permanent, so the sentence must not promise later.
 */
export type ForkBlocked = "not-yet" | "nothing-before";

interface Props {
	/** Which side the bubble sits on, so the menu can name whose message it is. */
	side: "user" | "assistant";
	/**
	 * Absent when this message is not a conversation turn — a bubble still being
	 * written, a Pockode event line. The slot stays, the glyph does not.
	 */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
}

/**
 * The 36px slot beside a chat bubble, and the `…` in it.
 *
 * The slot is always drawn, empty or not, and every row in a session that can
 * fork at all gets one. That buys two things: a message going from streaming to
 * settled does not move a pixel, and the full-bleed event lines end where the
 * widest bubble ends instead of overhanging it by the slot's width.
 *
 * The slot sits on the inside of the bubble, the side facing the middle of the
 * conversation: the outside is the avatar's, and the inside is space this
 * message was leaving empty anyway. It is a flex sibling of the bubble rather
 * than pinned to the edge of the row, so it travels with the bubble it belongs
 * to — a two-word message would otherwise have its `…` stranded half a screen
 * away. Belonging beats a tidy vertical rule.
 *
 * The glyph fades in rather than appearing (`animate-message-menu-in`, not a
 * transition: it is mounted, and there is no before-value to transition from).
 * The mount the fade is written for is a turn settling — the one moment the
 * user is certainly watching this bubble — and it lands at the bubble's *top*,
 * which is not where the writing was. The same fade plays wherever else a glyph
 * mounts, on a transcript's first paint or on a page of older messages, and
 * costs nothing there: the slot is already the size it will stay.
 *
 * Visible under both pointers, never revealed on hover: the slot's width is
 * paid whether or not anything is drawn in it, so hiding the glyph would save
 * ink and not one pixel of layout, while costing a touch user the only way to
 * find the action. It is quiet instead — half opacity at rest, full on hover,
 * focus, or while its menu is open.
 *
 * `MoreHorizontal` rather than a glyph for the action behind it: the file tree,
 * the Git log and the files panel already say "this thing has a menu" with
 * these three dots, and forty copies of a *feature's* icon down a transcript
 * read as forty announcements of that feature.
 */
function MessageMenuTrigger({ side, onFork, forkBlocked }: Props) {
	const [open, setOpen] = useState(false);

	return (
		<div className="size-9 shrink-0 self-start">
			{onFork && (
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={open}
					// Named per speaker: forty buttons called "Message actions" is a
					// list no screen reader user can navigate.
					aria-label={
						side === "user"
							? "Actions for your message"
							: "Actions for the agent's message"
					}
					className={`${iconButtonClass({ grow: false })} animate-message-menu-in ${
						open ? "opacity-100" : "opacity-50 hover:opacity-100"
					} focus-visible:opacity-100`}
				>
					<MoreHorizontal className="size-4" aria-hidden="true" />
				</button>
			)}
			{open && onFork && (
				<MessageMenu
					side={side}
					onFork={onFork}
					forkBlocked={forkBlocked}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

export default MessageMenuTrigger;
