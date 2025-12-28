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
					<svg
						className="h-5 w-5"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					New Chat
				</button>
			</div>

			<div className="flex-1 overflow-y-auto">
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
