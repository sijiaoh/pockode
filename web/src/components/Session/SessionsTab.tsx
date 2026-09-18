import { Plus } from "lucide-react";
import { useCallback } from "react";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useSession } from "../../hooks/useSession";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import SessionFilterButton from "./SessionFilterButton";
import SessionList from "./SessionList";
import SessionListSkeleton from "./SessionListSkeleton";

interface Props {
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	isSwitchingWorktree: boolean;
}

function SessionsTab({
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	isSwitchingWorktree,
}: Props) {
	const {
		sessions,
		isLoading,
		isReloading,
		refresh,
		hasMore,
		isLoadingMore,
		pageError,
		autoLoad,
		hasPaged,
		loadMore,
		retryLoadMore,
	} = useSession();

	// The list on screen belongs to the worktree the user is leaving. Selecting a
	// row from it would navigate to a session that doesn't exist in the new
	// worktree, only to be redirected away again; creating one would land it in
	// whichever worktree the connection happens to be bound to.
	const isStale = isSwitchingWorktree || isReloading;

	// Refreshing is barred for the same stretch, and not merely to hold the list
	// still: it resubscribes over a connection still bound to the worktree being
	// left, and the list that comes back looks authoritative — it clears
	// isReloading and raises isSuccess, which releases AppShell's redirect effect
	// and bounces the user off the session they were navigating to. Merely
	// opening the sidebar refreshes, so this is reachable by ordinary use.
	const refreshUnlessStale = useCallback(() => {
		if (isStale) return;
		return refresh();
	}, [isStale, refresh]);
	const { isActive } = useSidebarRefresh("sessions", refreshUnlessStale);

	// The sentinel is one control in every state, so pressing it after a failure
	// has to be the retry: clearing the error is what re-arms auto-loading, and
	// the request is the same one either way.
	//
	// Barred while the list is stale for the same reason a refresh is: it would
	// page a subscription bound to the worktree being left, and the answer —
	// rows of the old worktree, or the refusal of a subscription that switch has
	// already ended — lands on a list about to be replaced either way. The
	// observer is disarmed alongside it, because `inert` stops the tap but not
	// the scroll that arms it.
	const handleLoadMore = useCallback(() => {
		if (isStale) return;
		if (pageError) retryLoadMore();
		loadMore();
	}, [isStale, pageError, retryLoadMore, loadMore]);

	// Delayed while a list is on screen, so a switch that lands quickly stays
	// visually still. The first load has nothing to hold, so it goes straight to
	// the skeleton.
	const isStaleForAWhile = useDelayedFlag(isStale, SKELETON_DELAY_MS);
	const showSkeleton = isLoading || isStaleForAWhile;

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<div className="flex items-center gap-2 p-2">
				<button
					type="button"
					onClick={onCreateSession}
					disabled={isStale}
					className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent p-3 text-th-accent-text hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Plus className="h-5 w-5" aria-hidden="true" />
					New Chat
				</button>
				<SessionFilterButton disabled={isStale} />
			</div>
			<PullToRefresh onRefresh={refreshUnlessStale}>
				{showSkeleton ? (
					<SessionListSkeleton />
				) : (
					// `inert` rather than `pointer-events-none`: the rows stay in the
					// tab order under the latter, so a keyboard user could still open
					// a session that doesn't exist in the worktree being entered.
					<div inert={isStale}>
						<SessionList
							sessions={sessions}
							currentSessionId={currentSessionId}
							onSelectSession={onSelectSession}
							onDeleteSession={onDeleteSession}
							hasMore={hasMore}
							isLoadingMore={isLoadingMore}
							pageError={pageError}
							autoLoad={autoLoad && !isStale}
							hasPaged={hasPaged}
							onLoadMore={handleLoadMore}
						/>
					</div>
				)}
			</PullToRefresh>
		</div>
	);
}

export default SessionsTab;
