import { MessageSquare } from "lucide-react";
import { useRouteState } from "../../hooks/useRouteState";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../../lib/sessionDetailStore";
import BadgeDot from "./BadgeDot";

interface Props {
	onClick: () => void;
}

const buttonClass =
	"relative flex items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary active:scale-95";

export default function BackToChatButton({ onClick }: Props) {
	const { sessionId } = useRouteState();
	// From the open session's own metadata, not from the list: the list is
	// narrowed server-side and leaves out exactly the session a work item drives
	// (docs/code/subscription-system.md#which-sessions-belong-to-work), so
	// reading it there would silently never light the dot for those. The detail
	// is the session this button goes back to, which is the one it is about.
	const detail = useSessionDetailStore(selectSessionDetail(sessionId));
	const hasUnread = detail?.unread ?? false;

	return (
		<button
			type="button"
			onClick={onClick}
			className={buttonClass}
			aria-label="Back to chat"
		>
			<MessageSquare className="h-5 w-5" aria-hidden="true" />
			<BadgeDot show={hasUnread} className="top-1 right-1" />
		</button>
	);
}
