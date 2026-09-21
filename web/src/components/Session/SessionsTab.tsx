import { useQueryClient } from "@tanstack/react-query";
import { Archive, GitBranch, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import {
	invalidateSessionViewQueries,
	useSessionViewSources,
} from "../../hooks/sessionViewQueries";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useSession } from "../../hooks/useSession";
import { useSessionViewList } from "../../hooks/useSessionViewList";
import { useWorktreeList } from "../../hooks/useWorktreeList";
import {
	CURRENT_WORKTREE_FILTER,
	filterSources,
	type SessionFilter,
	type SessionOrigin,
	type SessionRow,
} from "../../lib/sessionFilter";
import { useSessionStore } from "../../lib/sessionStore";
import { describeWorktree } from "../../lib/sessionView";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import SessionFilterButton from "./SessionFilterButton";
import SessionList from "./SessionList";
import SessionListSkeleton from "./SessionListSkeleton";

interface Props {
	currentSessionId: string | null;
	/** Both take the row's worktree, null for this one; see `SessionItem`. */
	onSelectSession: (id: string, worktree: string | null) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string, worktree: string | null) => void;
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

	const filter = useSessionStore((s) => s.worktreeFilter);
	const showTaskSessions = useSessionStore((s) => s.showTaskSessions);
	const currentWorktree = useWorktreeStore((s) => s.current);
	const worktrees = useWorktreeList();

	// Two lists, never both: this worktree's is the live subscribed one, anybody
	// else's is read through `session_view.*`, which pushes nothing.
	const isViewing = filter.kind !== "current";
	const {
		sources: available,
		isLoading: isLoadingSources,
		isAnswered: hasSources,
		error: sourcesError,
	} = useSessionViewSources(isViewing);
	const sources = useMemo(() => {
		// "All worktrees" cannot be asked for until it is known which those are;
		// asking with none yet would answer "no sessions" for a frame.
		if (filter.kind === "all" && isLoadingSources) return null;
		return filterSources(
			filter,
			available.map((source) => source.worktree),
		);
	}, [filter, available, isLoadingSources]);
	const view = useSessionViewList(sources, !showTaskSessions);

	// A worktree drops off the source list when its last session is deleted, and
	// a filter pointing at one that is no longer there is a list that can only
	// ever be empty. The selection falls back rather than sitting on nothing.
	const setFilter = useSessionStore((s) => s.setWorktreeFilter);
	useEffect(() => {
		// Only on the server's own answer: an empty list left behind by a failed
		// read would take the user's selection away for a moment of bad network.
		if (!hasSources) return;
		const elsewhere = available.filter(
			(source) => source.worktree !== currentWorktree,
		);
		// "All worktrees" falls back on the same event, and it has to: the panel
		// stops offering worktree rows once there are none, so a selection left
		// pointing at them would be one the user could no longer undo — on a list
		// that by then holds nothing but this worktree's own sessions, read as a
		// snapshot rather than the live one.
		const isOrphaned =
			filter.kind === "all"
				? elsewhere.length === 0
				: filter.kind === "worktree" &&
					!elsewhere.some((source) => source.worktree === filter.worktree);
		if (!isOrphaned) return;
		setFilter(CURRENT_WORKTREE_FILTER);
	}, [filter, hasSources, available, currentWorktree, setFilter]);

	const rows = useMemo(
		() =>
			view
				? toViewRows(view.rows, currentWorktree, worktrees)
				: sessions.map((session) => ({ session, origin: null })),
		[view, sessions, currentWorktree, worktrees],
	);

	// The list on screen belongs to the worktree the user is leaving. Selecting a
	// row from it would navigate to a session that doesn't exist in the new
	// worktree, only to be redirected away again; creating one would land it in
	// whichever worktree the connection happens to be bound to.
	const isStale = isSwitchingWorktree || isReloading;

	const queryClient = useQueryClient();
	// Refreshing is barred for the same stretch, and not merely to hold the list
	// still: it resubscribes over a connection still bound to the worktree being
	// left, and the list that comes back looks authoritative — it clears
	// isReloading and raises isSuccess, which releases AppShell's redirect effect
	// and bounces the user off the session they were navigating to. Merely
	// opening the sidebar refreshes, so this is reachable by ordinary use.
	//
	// A viewed list has none of that to fear — it names its worktree in the
	// request — but a switch is about to reset the filter out from under it
	// anyway, so it waits too.
	const refreshUnlessStale = useCallback(() => {
		if (isStale) return;
		if (isViewing) return invalidateSessionViewQueries(queryClient);
		return refresh();
	}, [isStale, isViewing, queryClient, refresh]);
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
		// The viewed list needs no separate retry: asking for the page again is
		// what clears the failure that stopped it.
		if (view) return view.loadMore();
		if (pageError) retryLoadMore();
		loadMore();
	}, [isStale, view, pageError, retryLoadMore, loadMore]);

	// Delayed while a list is on screen, so a switch that lands quickly stays
	// visually still. The first load has nothing to hold, so it goes straight to
	// the skeleton.
	const isStaleForAWhile = useDelayedFlag(isStale, SKELETON_DELAY_MS);
	// The source list is only this list's business under "All worktrees", which
	// cannot be asked for until it is known which worktrees those are. A filter
	// naming one worktree reads that worktree whatever the panel knows.
	const fatalSourcesError = filter.kind === "all" ? sourcesError : null;
	const showSkeleton = isViewing
		? fatalSourcesError === null && (view === null || view.isLoading)
		: isLoading || isStaleForAWhile;
	// A viewed list is a one-shot read, so a failure is the whole answer and has
	// to be said — an empty list would say "nothing was ever said here", which
	// is the one thing a failure must not be allowed to claim. The live list
	// never gets here: its failures are the subscription's, and the shell
	// reports those.
	const loadError =
		fatalSourcesError ??
		(view && view.rows.length === 0 ? view.loadError : null);

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
			{isViewing && <FilterContextLine filter={filter} worktrees={worktrees} />}
			<PullToRefresh onRefresh={refreshUnlessStale}>
				{showSkeleton ? (
					<SessionListSkeleton />
				) : loadError ? (
					<div
						className="flex flex-col items-center gap-2 p-4 text-center text-sm text-th-text-muted"
						role="alert"
					>
						<span className="break-words text-th-error">{loadError}</span>
						<button
							type="button"
							onClick={refreshUnlessStale}
							className="min-h-9 rounded-lg border border-th-border bg-th-bg-tertiary px-3 text-xs text-th-text-primary pointer-coarse:min-h-11 hover:border-th-border-focus"
						>
							Retry
						</button>
					</div>
				) : (
					// `inert` rather than `pointer-events-none`: the rows stay in the
					// tab order under the latter, so a keyboard user could still open
					// a session that doesn't exist in the worktree being entered.
					//
					// Only the live list: a viewed row names the worktree it opens
					// from, so a switch cannot send it anywhere that does not exist.
					<div inert={!isViewing && isStale}>
						<SessionList
							rows={rows}
							currentSessionId={currentSessionId}
							onSelectSession={onSelectSession}
							onDeleteSession={onDeleteSession}
							emptyMessage={emptyMessage(filter, worktrees)}
							hasMore={view ? view.hasMore : hasMore}
							isLoadingMore={view ? view.isLoadingMore : isLoadingMore}
							pageError={view ? view.pageError : pageError}
							autoLoad={view ? view.pageError === null : autoLoad && !isStale}
							hasPaged={view ? view.hasPaged : hasPaged}
							onLoadMore={handleLoadMore}
						/>
					</div>
				)}
			</PullToRefresh>
		</div>
	);
}

/**
 * What a row's worktree means, resolved once per worktree rather than once per
 * row: the object is what keeps `SessionItem`'s memo from re-rendering every
 * row of a list whose worktrees have not changed.
 *
 * A row of the worktree the user is standing in gets no origin even under a
 * filter that spans worktrees — it opens, and deletes, exactly as it always
 * has.
 */
function toViewRows(
	merged: { session: SessionRow["session"]; worktree: string }[],
	currentWorktree: string,
	worktrees: WorktreeInfo[],
): SessionRow[] {
	const origins = new Map<string, SessionOrigin | null>();
	return merged.map(({ session, worktree }) => {
		if (!origins.has(worktree)) {
			origins.set(
				worktree,
				worktree === currentWorktree
					? null
					: describeWorktree(worktree, worktrees),
			);
		}
		return { session, origin: origins.get(worktree) ?? null };
	});
}

/**
 * What the list as a whole is, said once above it rather than on every row.
 *
 * The difference it announces — that opening a row may switch worktree, or may
 * only ever be read — belongs to the list, not to any single session in it. On
 * a row it would be repeated dozens of times and would be competing with the
 * session's own title for a 240px line.
 *
 * Sentence case and a bottom border, deliberately unlike the panel's uppercase
 * group headers: at the same size, a label and a statement have to be told
 * apart by their shape.
 */
function FilterContextLine({
	filter,
	worktrees,
}: {
	filter: SessionFilter;
	worktrees: WorktreeInfo[];
}) {
	const origin =
		filter.kind === "worktree"
			? describeWorktree(filter.worktree, worktrees)
			: null;
	const Icon = origin && !origin.exists ? Archive : GitBranch;
	return (
		<div className="flex min-h-[32px] items-center gap-1.5 border-b border-th-border px-3 py-1.5 text-xs text-th-text-muted">
			<Icon className="size-3 shrink-0" aria-hidden="true" />
			<span className="min-w-0 flex-1">
				{!origin
					? "Sessions from every worktree. Opening one may switch worktree."
					: origin.exists
						? `Sessions in "${origin.label}". Opening one switches to that worktree.`
						: `"${origin.label}" was deleted. Its sessions can only be read.`}
			</span>
		</div>
	);
}

function emptyMessage(
	filter: SessionFilter,
	worktrees: WorktreeInfo[],
): string {
	switch (filter.kind) {
		case "current":
			return "No conversations yet";
		case "all":
			return "No sessions.";
		case "worktree":
			return `No sessions in "${describeWorktree(filter.worktree, worktrees).label}".`;
	}
}

export default SessionsTab;
