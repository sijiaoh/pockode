import { GitBranch } from "lucide-react";
import type { UserMessage } from "../../types/message";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";
import { RestoreMenuRow } from "./DiscardedMessage";
import type { ForkBlocked } from "./MessageMenuTrigger";

/**
 * How each reason is worded. A tone table, not a table of facts: what puts a
 * message into one of these states is `forkUnavailableReason` and
 * `forkBlockedReason`, and repeating a condition here would only give it a
 * second place to drift.
 *
 * One sentence each, and the boundaries are not interchangeable:
 * - `nothing-before` is permanent, so it must never say "yet".
 * - `no-anchor-seq` leaves the user nothing to do, and in one case — a record
 *   that was never persisted — not even a reload brings it back. So: no
 *   imperative, and no promise that it recovers.
 * - `pending-request` is the only one the user can clear, so it is the only
 *   imperative. The verb is "Respond" and not "Answer": a permission card
 *   offers Allow and Deny, which nobody answers.
 *
 * These sentences are read into the row's accessible name (`MenuRow` renders
 * the description inside the button), so each has to be short, stand as its own
 * sentence, and never lean on a pronoun pointing back at the label — a screen
 * reader says the label and the reason in one breath.
 */
const FORK_BLOCKED_DESCRIPTION = {
	"nothing-before": "Nothing before this message to keep.",
	"no-anchor-seq": "This message has no saved position to fork from.",
	"pending-request": "Respond to the request in this message first.",
} as const satisfies Record<ForkBlocked, string>;

interface Props {
	/** Who spoke, which is all the title needs to name the subject. */
	side: "user" | "assistant";
	/** Absent when the session cannot fork, which removes the row. */
	onFork?: () => void;
	forkBlocked?: ForkBlocked;
	/**
	 * Set only on a message a Stop threw away unread, the one kind of message
	 * that can be restored into the composer.
	 */
	restore?: {
		message: UserMessage;
		sessionId: string;
		onRestore: (messages: UserMessage[]) => void;
	};
	onClose: () => void;
}

/**
 * Everything this message can do.
 *
 * A sheet rather than a popover, for the same reasons `Files/FileEntryMenu` is
 * one — the app has nothing to anchor a dropdown on — and for one of its own:
 * the transcript scrolls itself while the agent writes, so an anchored menu
 * would be tracking a moving row. `Sheet` is anchored to the viewport and is
 * already a drawer on a phone and a centered modal on a wide screen, so no
 * second breakpoint is written here.
 *
 * The full list even where all of it also stands as a button (the agent's
 * turn-end row): this is where a blocked action says why in a whole sentence,
 * which an icon could only whisper into `aria-label` where no finger ever reads
 * it — so on the agent's side only a blocked Fork opens it. On the user's side
 * it is usually a one-row sheet behind the `…` — an accepted middle, not an
 * oversight (docs/session-fork-ui.md) — with a second row only on a message a
 * Stop threw away (docs/discarded-messages-ui.md).
 *
 * Focus is `Sheet`'s job, not this menu's: it takes focus on open, cycles Tab
 * inside itself and hands focus back to the button that opened it on close.
 *
 * Rules for whoever adds an action, so the menu is not redesigned per row:
 * - Two groups: reversible above, destructive below, one divider between (the
 *   shape `FileEntryMenu` already has). Each group is append-only — a new row
 *   goes last in its group and existing rows never move, because what this
 *   protects is muscle memory.
 * - No mirroring. The sheet belongs to the viewport, not to a side, so both
 *   speakers open the same list in the same order.
 * - No ceiling on rows, but one level deep: no submenus. A long list scrolls,
 *   which the sheet body already does. The one move outwards is a row that
 *   replaces this whole sheet with another (`Fork from here` does exactly
 *   that) — replacing, never nesting.
 * - A row that cannot run right now is disabled with a reason, not removed.
 *   Removal is only for actions this kind of message could never have.
 */
function MessageMenu({ side, onFork, forkBlocked, restore, onClose }: Props) {
	return (
		<Sheet
			title={side === "user" ? "Your message" : "Agent message"}
			onClose={onClose}
		>
			<div className="py-1">
				{onFork && (
					<MenuRow
						icon={GitBranch}
						label="Fork from here"
						description={
							forkBlocked ? FORK_BLOCKED_DESCRIPTION[forkBlocked] : undefined
						}
						disabled={forkBlocked !== undefined}
						// Closed first so the two sheets replace one another rather than
						// stacking: the fork confirmation is what the user is looking at
						// next, and this menu has nothing left to say.
						onClick={() => {
							onClose();
							onFork();
						}}
					/>
				)}
				{restore && <RestoreMenuRow {...restore} onClose={onClose} />}
			</div>
		</Sheet>
	);
}

export default MessageMenu;
