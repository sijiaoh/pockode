import { Archive, GitBranch } from "lucide-react";
import type { SessionView } from "../../lib/sessionView";

interface Props {
	view: SessionView;
}

/**
 * Whose conversation this is, above a transcript read out of another worktree.
 *
 * Above the transcript rather than inside it, and it does not scroll: "this is
 * not the worktree you are in" has to be true at every scroll position, unlike
 * `ForkOriginBanner`, which states a fact about where the transcript *begins*
 * and is right to scroll away with it.
 *
 * It carries no control at all. The bar answers "whose session is this"; what
 * can be done about it is the bar at the other end of the screen, next to where
 * the answer would have been typed.
 */
function SessionOriginBar({ view }: Props) {
	// Two glyphs rather than a word: at 360px there is no room for "(deleted)"
	// beside a worktree name, and the two states have to be distinguishable at a
	// glance. `Archive` means "kept, but no longer running", which is exactly
	// what a deleted worktree's sessions are.
	const Icon = view.exists ? GitBranch : Archive;

	return (
		<div className="flex min-h-[32px] shrink-0 items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-3 text-xs text-th-text-muted">
			<Icon className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">
				Session from &quot;{view.label}&quot;
				{view.exists ? "" : " (deleted)"}
			</span>
		</div>
	);
}

export default SessionOriginBar;
