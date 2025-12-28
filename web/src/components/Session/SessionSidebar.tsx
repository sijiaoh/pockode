import type { SessionMeta } from "../../types/message";
import Sidebar from "../Layout/Sidebar";
import SessionSidebarContent from "./SessionSidebarContent";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	sessions: SessionMeta[];
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	isLoading: boolean;
}

function SessionSidebar({
	isOpen,
	onClose,
	sessions,
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	isLoading,
}: Props) {
	return (
		<Sidebar isOpen={isOpen} onClose={onClose} title="Conversations">
			<SessionSidebarContent
				sessions={sessions}
				currentSessionId={currentSessionId}
				onSelectSession={(id) => {
					onSelectSession(id);
					onClose();
				}}
				onCreateSession={onCreateSession}
				onDeleteSession={onDeleteSession}
				isLoading={isLoading}
			/>
		</Sidebar>
	);
}

export default SessionSidebar;
