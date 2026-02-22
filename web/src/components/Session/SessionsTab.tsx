import { Eye, EyeOff, Plus } from "lucide-react";
import { useSession } from "../../hooks/useSession";
import { useSessionStore } from "../../lib/sessionStore";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import SessionList from "./SessionList";

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
	const { filteredSessions, isLoading, refresh } = useSession();
	const hideTaskSessions = useSessionStore((s) => s.hideTaskSessions);
	const toggleHide = useSessionStore((s) => s.toggleHideTaskSessions);
	const { isActive } = useSidebarRefresh("sessions", refresh);

	const ToggleIcon = hideTaskSessions ? EyeOff : Eye;

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<div className="flex items-center gap-2 p-2">
				<button
					type="button"
					onClick={onCreateSession}
					className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent p-3 text-th-accent-text hover:bg-th-accent-hover"
				>
					<Plus className="h-5 w-5" aria-hidden="true" />
					New Chat
				</button>
				<button
					type="button"
					onClick={toggleHide}
					className="flex items-center justify-center rounded-lg border border-th-border p-3 text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary"
					aria-label={
						hideTaskSessions ? "Show task sessions" : "Hide task sessions"
					}
					title={hideTaskSessions ? "Show task sessions" : "Hide task sessions"}
				>
					<ToggleIcon className="h-5 w-5" aria-hidden="true" />
				</button>
			</div>
			<PullToRefresh onRefresh={refresh}>
				{isLoading ? (
					<div className="p-4 text-center text-th-text-muted">Loading...</div>
				) : (
					<SessionList
						sessions={filteredSessions}
						currentSessionId={currentSessionId}
						onSelectSession={onSelectSession}
						onDeleteSession={onDeleteSession}
					/>
				)}
			</PullToRefresh>
		</div>
	);
}

export default SessionsTab;
