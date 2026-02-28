import { MessageSquare } from "lucide-react";
import { useRouteState } from "../../hooks/useRouteState";
import { useSessionStore } from "../../lib/sessionStore";
import BadgeDot from "./BadgeDot";

interface Props {
	onClick: () => void;
}

const buttonClass =
	"relative flex items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary active:scale-95";

export default function BackToChatButton({ onClick }: Props) {
	const { sessionId } = useRouteState();
	const hasUnread = useSessionStore(
		(s) => s.sessions.find((sess) => sess.id === sessionId)?.unread ?? false,
	);

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
