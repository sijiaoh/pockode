import { useSession } from "../../hooks/useSession";
import { useSidebarRefresh } from "../Layout";
import SessionSidebarContent from "./SessionSidebarContent";

interface Props {
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
}

function SessionsTab({
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
}: Props) {
	const { sessions, isLoading, refresh } = useSession();
	const { isActive } = useSidebarRefresh("sessions", refresh);

	if (!isActive) return null;

	return (
		<SessionSidebarContent
			sessions={sessions}
			currentSessionId={currentSessionId}
			onSelectSession={onSelectSession}
			onCreateSession={onCreateSession}
			onDeleteSession={onDeleteSession}
			isLoading={isLoading}
		/>
	);
}

export default SessionsTab;
