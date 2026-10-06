import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import type { ForkUnavailable } from "../../utils/forkAnchor";
import { iconButtonClass } from "../ui/iconButtonClass";
import MessageMenu from "./MessageMenu";

/**
 * Why fork applies to this message but cannot run on it.
 *
 * - `nothing-before`: the message opens the session, and a fork returns to
 *   before it was sent. Permanent — nothing the user or the server can do makes
 *   this message forkable.
 * - `no-anchor-seq`: the message has no seq to be named by.
 * - `pending-request`: the message holds a request nobody has answered.
 *
 * The last two are `forkUnavailableReason`'s answers and are explained there,
 * next to the checks that produce them; only the first needs the transcript, so
 * only it is decided by `MessageItem`.
 */
export type ForkBlocked = "nothing-before" | ForkUnavailable;

interface Props {
	/**
	 * Absent while the message is still being sent: it is not a turn yet. The
	 * slot stays, the glyph does not.
	 */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
}

/**
 * The 36px slot beside a row the user sent, and the `…` in it. The agent's
 * messages have no bubble and no slot; their actions are a row at the end of
 * the message instead (`MessageActions`).
 *
 * The slot is always drawn, empty or not, on every user row of a session that
 * can fork at all: a message going from sending to settled does not move a
 * pixel. Work event lines get none — they are never turns.
 *
 * The slot sits on the inside of the bubble, the side facing the middle of the
 * conversation: the outside is the avatar's, and the inside is space this
 * message was leaving empty anyway. It is a flex sibling of the bubble rather
 * than pinned to the edge of the row, so it travels with the bubble it belongs
 * to — a two-word message would otherwise have its `…` stranded half a screen
 * away. Belonging beats a tidy vertical rule.
 *
 * `self-end` is written here rather than left to the row's own `items-*`: where
 * the `…` sits is the slot's rule, and the rows that host one set their
 * alignment for reasons of their own — an avatar to level, a full-bleed line to
 * start at the top. Inherited, the fork glyph would move the next time one of
 * those reasons changed, and the author would not know they had moved it.
 *
 * The glyph fades in rather than appearing (`animate-message-menu-in`, not a
 * transition: it is mounted, and there is no before-value to transition from),
 * and costs nothing: the slot is already the size it will stay.
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
function MessageMenuTrigger({ onFork, forkBlocked }: Props) {
	const [open, setOpen] = useState(false);

	return (
		<div className="size-9 shrink-0 self-end">
			{onFork && (
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={open}
					// Named for the speaker: forty buttons called "Message actions" is a
					// list no screen reader user can navigate.
					aria-label="Actions for your message"
					className={`${iconButtonClass({ grow: false })} animate-message-menu-in ${
						open ? "opacity-100" : "opacity-50 hover:opacity-100"
					} focus-visible:opacity-100`}
				>
					<MoreHorizontal className="size-4" aria-hidden="true" />
				</button>
			)}
			{open && onFork && (
				<MessageMenu
					side="user"
					onFork={onFork}
					forkBlocked={forkBlocked}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

export default MessageMenuTrigger;
