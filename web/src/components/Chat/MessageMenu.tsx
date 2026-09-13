import { GitBranch } from "lucide-react";
import MenuRow from "../common/MenuRow";
import { Sheet } from "../ui";
import type { ForkBlocked } from "./MessageMenuTrigger";

/**
 * One sentence per reason, shown on the row itself.
 *
 * `not-yet` covers two unrelated causes — a request nobody has answered, and a
 * message the server never gave a seq for — so the sentence has to be true of
 * both. "Still being written" is false of the second, which was finished long
 * ago and merely has no address; what they share is that this message cannot
 * be named as the cut point. It promises only that this is not permanent, not
 * when it changes.
 *
 * `nothing-before` is permanent, so it must never say "yet".
 */
const FORK_BLOCKED_DESCRIPTION = {
	"not-yet": "This message can't be a fork point yet.",
	"nothing-before": "Nothing before this message to keep.",
} as const satisfies Record<ForkBlocked, string>;

interface Props {
	/** Who spoke, which is all the title needs to name the subject. */
	side: "user" | "assistant";
	onFork: () => void;
	forkBlocked?: ForkBlocked;
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
 * One row today — the very shape the standing action row was once chosen over,
 * for charging two taps and handing back one thing. What changed is the other
 * side of the trade: this row can carry a whole sentence saying why fork cannot
 * run, which an icon could only whisper into `aria-label` where no finger ever
 * reads it, and the transcript gets back the 36-44px per message that a
 * standing row spends on its first icon. A one-row sheet is an accepted middle,
 * not an oversight.
 *
 * Focus is `Sheet`'s job, not this menu's: it takes focus on open, cycles Tab
 * inside itself and hands focus back to the `…` on close.
 *
 * Rules for whoever adds the second action, so the menu is not redesigned per
 * row:
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
function MessageMenu({ side, onFork, forkBlocked, onClose }: Props) {
	return (
		<Sheet
			title={side === "user" ? "Your message" : "Agent message"}
			onClose={onClose}
		>
			<div className="py-1">
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
			</div>
		</Sheet>
	);
}

export default MessageMenu;
