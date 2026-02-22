import { Plus } from "lucide-react";
import { useSession } from "../../hooks/useSession";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import SessionFilterButton from "./SessionFilterButton";
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
	const { isActive } = useSidebarRefresh("sessions", refresh);

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
				<SessionFilterButton />
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
