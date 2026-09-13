import { GitBranch } from "lucide-react";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	/** Which side the bubble sits on, so the row lines up under it. */
	side: "user" | "assistant";
	/** Absent when this session's agent cannot be forked at all. */
	onFork?: () => void;
	/**
	 * Why fork applies to this message but cannot run on it. The icon stays put
	 * and goes quiet either way — it is the same action in the same place, and
	 * one that vanishes under the user's thumb is worse than one that says no.
	 *
	 * - `not-yet`: the message holds a request nobody has answered, or it has no
	 *   seq. The second is rare now that the server tells a sender where its own
	 *   message landed, leaving only a server too old to answer with one and a
	 *   record that could not be persisted. Neither is on a clock — an answer
	 *   settles the request, a reload names what an old server would not — so the
	 *   label promises only that this is not the message's permanent state. The
	 *   unpersisted record is the one case it outlives rather than describes: it
	 *   does not survive a reload, so nobody is left waiting on the promise.
	 * - `nothing-before`: the message opens the session, and a fork returns to
	 *   before it was sent. Permanent, so the label must not promise later.
	 */
	forkBlocked?: "not-yet" | "nothing-before";
}

const FORK_BLOCKED_LABEL = {
	"not-yet": "Fork from here, not available yet",
	"nothing-before": "Fork from here, nothing before this message to keep",
} as const;

/**
 * The thin action row under a chat bubble.
 *
 * Icons directly on the row rather than behind a `…`: fork is a primary action
 * and this app's main pointer is a thumb, so the first rung of
 * docs/responsive-ui.md — always visible — is the answer until the row is full.
 * Not a long press on the bubble either: bubbles are the one place users select
 * and copy text, and long press is how a phone starts a selection.
 *
 * Rules for whoever adds the second action, decided once so the row is not
 * redesigned per icon:
 * - Order is append-only. A new action goes last and existing ones never move,
 *   because what this protects is muscle memory. No "most used first", no
 *   "destructive last" — those need reordering and so contradict it.
 * - Both sides read left to right. Mirroring for the user side would put the
 *   same action in a different relative place depending on who spoke.
 * - Three standing icons is the ceiling. Past that the first two stay and the
 *   rest fold behind a `…` into an overflow sheet. The limit is visual noise,
 *   not width: this row has no title whose truncation room icons could eat,
 *   which is the criterion rung 2 is written against.
 */
function MessageActions({ side, onFork, forkBlocked }: Props) {
	if (!onFork) return null;

	return (
		<div
			className={`flex items-center gap-1 pointer-coarse:gap-2 ${
				side === "user" ? "justify-end" : "justify-start"
			}`}
		>
			<button
				type="button"
				onClick={onFork}
				disabled={forkBlocked !== undefined}
				// The reason rides the label rather than a `title`: a tooltip never
				// fires on a touch device, so anything living only there is out of a
				// finger's reach (docs/responsive-ui.md).
				aria-label={
					forkBlocked ? FORK_BLOCKED_LABEL[forkBlocked] : "Fork from here"
				}
				className={iconButtonClass(forkBlocked !== undefined)}
			>
				<GitBranch className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}

export default MessageActions;
