import { GitBranch } from "lucide-react";
import {
	selectSessionTitle,
	selectUnlistedSessionName,
	useSessionStore,
} from "../../lib/sessionStore";

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
 * the fork, so a rename shows through. A parent the list has no row for is not
 * necessarily deleted any more — `selectUnlistedSessionName` is what decides
 * what may be claimed — so the banner states that much instead of linking to a
 * name it does not have.
 */
function ForkOriginBanner({ parentSessionId, onOpenParent }: Props) {
	const parentTitle = useSessionStore(selectSessionTitle(parentSessionId));
	const unlistedName = useSessionStore(selectUnlistedSessionName);

	const line = "flex items-center justify-center gap-1.5 text-xs";

	if (parentTitle === null) {
		return (
			<div className={`${line} py-2 text-th-text-muted`}>
				<GitBranch className="size-3 shrink-0" aria-hidden="true" />
				Forked from {unlistedName}
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
