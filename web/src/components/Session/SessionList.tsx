import type { SessionListItem } from "../../types/message";
import SessionItem from "./SessionItem";
import SessionListSentinel from "./SessionListSentinel";

interface Props {
	sessions: SessionListItem[];
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onDeleteSession: (id: string) => void;
	/** The end of the list; see `SessionListSentinel`. */
	hasMore: boolean;
	isLoadingMore: boolean;
	pageError: string | null;
	autoLoad: boolean;
	hasPaged: boolean;
	onLoadMore: () => void;
}

function SessionList({
	sessions,
	currentSessionId,
	onSelectSession,
	onDeleteSession,
	hasMore,
	isLoadingMore,
	pageError,
	autoLoad,
	hasPaged,
	onLoadMore,
}: Props) {
	if (sessions.length === 0 && !hasMore) {
		return (
			<div className="p-4 text-center text-th-text-muted">
				No conversations yet
			</div>
		);
	}

	return (
		// No `overflow-anchor: none` here, deliberately: a session created while
		// the reader is far down the list is the one event that moves everything
		// below it, and the browser's own scroll anchoring is what absorbs that.
		// The transcript switches anchoring off because it pins its own anchor by
		// hand; a list that does no measuring of its own must not disable the
		// thing that measures for it (docs/list-paging-ui.md §3.2).
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
			<SessionListSentinel
				hasMore={hasMore}
				isLoading={isLoadingMore}
				error={pageError}
				autoLoad={autoLoad}
				hasPaged={hasPaged}
				loadedCount={sessions.length}
				onLoadMore={onLoadMore}
			/>
		</div>
	);
}

export default SessionList;
