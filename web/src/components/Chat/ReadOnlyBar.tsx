import { Archive, GitBranch } from "lucide-react";
import type { SessionView } from "../../lib/sessionView";

interface Props {
	view: SessionView;
	/** Opens the same session in its own worktree; absent when there is none. */
	onOpenThere?: () => void;
}

/**
 * What stands where the composer stands, on a session that cannot be written
 * to.
 *
 * It replaces `InputBar` rather than disabling it: a disabled box invites the
 * user to wait for it to come back, and nothing is coming back — the execution
 * environment is somewhere else, or gone. It is deliberately as tall as the
 * composer's single-line state, so moving between a live session and a viewed
 * one does not make the page jump.
 *
 * `Open there` is a secondary control, not an accent one. Accent means "the one
 * thing to do here", and the one thing to do here is read; switching worktree
 * is a change of context, and it must not shout louder than Send once did from
 * the same row.
 */
function ReadOnlyBar({ view, onOpenThere }: Props) {
	const Icon = view.exists ? GitBranch : Archive;

	return (
		<div className="flex min-h-[52px] shrink-0 items-center gap-2 border-t border-th-border bg-th-bg-secondary px-3 py-2">
			<Icon className="size-4 shrink-0 text-th-text-muted" aria-hidden="true" />
			<p className="min-w-0 flex-1 text-xs text-th-text-muted">
				{view.exists
					? `Read-only — this session belongs to "${view.label}".`
					: `Read-only — the worktree "${view.label}" no longer exists.`}
			</p>
			{view.exists && onOpenThere && (
				<button
					type="button"
					onClick={onOpenThere}
					aria-label={`Open this session in worktree ${view.label}`}
					className="min-h-9 shrink-0 rounded-lg border border-th-border bg-th-bg-tertiary px-3 text-xs text-th-text-primary transition-colors pointer-coarse:min-h-11 hover:border-th-border-focus focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					Open there
				</button>
			)}
		</div>
	);
}

export default ReadOnlyBar;
