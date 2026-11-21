import { Bot } from "lucide-react";

interface Props {
	/** The main session's title, and null until it is known. */
	mainTitle: string | null;
}

/**
 * Whose permission requests this transcript answers, above a reviewer's
 * transcript. Drawn like `SessionOriginBar` and for its reason: it has to be
 * true at every scroll position, and it carries no control — the way to the
 * main session is the bar where an answer would have been typed
 * (docs/unattended-mode-ui.md §5).
 */
function ReviewerOriginBar({ mainTitle }: Props) {
	return (
		<div className="flex min-h-[32px] shrink-0 items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-3 text-xs text-th-text-muted">
			<Bot className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">
				{mainTitle === null
					? "Permission reviewer of another session"
					: `Permission reviewer of “${mainTitle}”`}
			</span>
		</div>
	);
}

export default ReviewerOriginBar;
