import type { LucideIcon } from "lucide-react";

export interface ReadOnlyBarAction {
	label: string;
	/** The control's accessible name, which says where it leads. */
	accessibleName: string;
	onClick: () => void;
}

interface Props {
	icon: LucideIcon;
	/** Why nothing can be typed here, in the caller's words. */
	sentence: string;
	/** The way to where something can be done instead; absent when there is none. */
	action?: ReadOnlyBarAction;
}

/**
 * What stands where the composer stands, on a session that cannot be written
 * to: one read out of another worktree, or a permission reviewer. Each caller
 * says why and offers its own way out.
 *
 * It replaces `InputBar` rather than disabling it: a disabled box invites the
 * user to wait for it to come back, and nothing is coming back. It is
 * deliberately as tall as the composer's single-line state, so moving between
 * a live session and a read-only one does not make the page jump.
 *
 * The action is a secondary control, not an accent one. Accent means "the one
 * thing to do here", and the one thing to do here is read; going somewhere
 * else is a change of context, and it must not shout louder than Send once did
 * from the same row.
 */
function ReadOnlyBar({ icon: Icon, sentence, action }: Props) {
	return (
		<div className="flex min-h-[52px] shrink-0 items-center gap-2 border-t border-th-border bg-th-bg-secondary px-3 py-2">
			<Icon className="size-4 shrink-0 text-th-text-muted" aria-hidden="true" />
			<p className="min-w-0 flex-1 text-xs text-th-text-muted">{sentence}</p>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					aria-label={action.accessibleName}
					className="min-h-9 shrink-0 rounded-lg border border-th-border bg-th-bg-tertiary px-3 text-xs text-th-text-primary transition-colors pointer-coarse:min-h-11 hover:border-th-border-focus focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}

export default ReadOnlyBar;
