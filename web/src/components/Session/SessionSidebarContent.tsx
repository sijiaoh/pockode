import { Plus } from "lucide-react";
import type { SessionMeta } from "../../types/message";
import SessionList from "./SessionList";

interface Props {
	sessions: SessionMeta[];
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	isLoading: boolean;
}

function SessionSidebarContent({
	sessions,
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	isLoading,
}: Props) {
	return (
		<>
			<div className="p-2">
				<button
					type="button"
					onClick={onCreateSession}
					className="flex w-full items-center justify-center gap-2 rounded-lg bg-th-accent p-3 font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					<Plus className="h-5 w-5" aria-hidden="true" />
					New Chat
				</button>
			</div>

			<div className="min-h-0 flex-1">
				{isLoading ? (
					<div className="p-4 text-center text-th-text-muted">Loading...</div>
				) : (
					<SessionList
						sessions={sessions}
						currentSessionId={currentSessionId}
						onSelectSession={onSelectSession}
						onDeleteSession={onDeleteSession}
					/>
				)}
			</div>
		</>
	);
}

export default SessionSidebarContent;
