import { GitBranch } from "lucide-react";
import { useSessionStore } from "../../lib/sessionStore";

interface Props {
	parentSessionId: string;
	onOpenParent: (sessionId: string) => void;
}

/**
 * Where a forked session's transcript came from, at the top of that transcript.
 *
 * The top of the transcript rather than the chat header: the header belongs to
 * the project title, and "this conversation begins as a copy of another one" is
 * a fact about where the transcript starts.
 *
 * The parent's title is resolved from the session list rather than copied onto
 * the fork, so a rename shows through; a parent missing from the list has been
 * deleted, and the row then states that instead of linking to nothing.
 */
function ForkOriginBanner({ parentSessionId, onOpenParent }: Props) {
	const parentTitle = useSessionStore(
		(s) => s.sessions.find((session) => session.id === parentSessionId)?.title,
	);

	const line = "flex items-center justify-center gap-1.5 text-xs";

	if (parentTitle === undefined) {
		return (
			<div className={`${line} py-2 text-th-text-muted`}>
				<GitBranch className="size-3 shrink-0" aria-hidden="true" />
				Forked from a deleted session
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={() => onOpenParent(parentSessionId)}
			className={`${line} w-full rounded py-2 text-th-text-muted transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent`}
		>
			<GitBranch className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">Forked from "{parentTitle}"</span>
		</button>
	);
}

export default ForkOriginBanner;
