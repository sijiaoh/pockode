import type { SessionRow } from "../../lib/sessionFilter";
import SessionItem from "./SessionItem";
import SessionListSentinel from "./SessionListSentinel";

interface Props {
	rows: SessionRow[];
	currentSessionId: string | null;
	/** Both take the row's worktree, null for this one; see `SessionItem`. */
	onSelectSession: (id: string, worktree: string | null) => void;
	onDeleteSession: (id: string, worktree: string | null) => void;
	/** What to say when there is nothing to list; the filter decides. */
	emptyMessage: string;
	/** The end of the list; see `SessionListSentinel`. */
	hasMore: boolean;
	isLoadingMore: boolean;
	pageError: string | null;
	autoLoad: boolean;
	hasPaged: boolean;
	onLoadMore: () => void;
}

function SessionList({
	rows,
	currentSessionId,
	onSelectSession,
	onDeleteSession,
	emptyMessage,
	hasMore,
	isLoadingMore,
	pageError,
	autoLoad,
	hasPaged,
	onLoadMore,
}: Props) {
	if (rows.length === 0 && !hasMore) {
		return (
			<div className="p-4 text-center text-th-text-muted">{emptyMessage}</div>
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
			{rows.map(({ session, origin }) => (
				<SessionItem
					key={session.id}
					session={session}
					origin={origin}
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
				loadedCount={rows.length}
				onLoadMore={onLoadMore}
			/>
		</div>
	);
}

export default SessionList;
