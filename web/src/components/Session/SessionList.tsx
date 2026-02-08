import type { SessionListItem } from "../../types/message";
import SessionItem from "./SessionItem";

interface Props {
	sessions: SessionListItem[];
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onDeleteSession: (id: string) => void;
}

function SessionList({
	sessions,
	currentSessionId,
	onSelectSession,
	onDeleteSession,
}: Props) {
	if (sessions.length === 0) {
		return (
			<div className="p-4 text-center text-th-text-muted">
				No conversations yet
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 p-2">
			{sessions.map((session) => (
				<SessionItem
					key={session.id}
					session={session}
					isActive={session.id === currentSessionId}
					onSelect={onSelectSession}
					onDelete={onDeleteSession}
				/>
			))}
		</div>
	);
}

export default SessionList;
