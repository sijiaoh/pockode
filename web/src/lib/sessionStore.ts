import { create } from "zustand";
import type { SessionListItem } from "../types/message";

const SHOW_TASK_SESSIONS_KEY = "show-task-sessions";

function loadShowTaskSessions(): boolean {
	return localStorage.getItem(SHOW_TASK_SESSIONS_KEY) === "true";
}

interface SessionState {
	/**
	 * The list as the server sent it, already narrowed by `showTaskSessions`.
	 * Nothing filters it again on the way to the screen, and nothing may treat a
	 * session's absence from it as proof the session is gone — with the filter on
	 * it is also how a hidden work session looks
	 * (docs/code/subscription-system.md#which-sessions-belong-to-work).
	 */
	sessions: SessionListItem[];
	/**
	 * Where the next page starts, and null once the list has been read to its
	 * end. Opaque — it is handed back to the server unread
	 * (`SessionListPage.next_cursor`).
	 */
	nextCursor: string | null;
	/**
	 * Whether anything in the *whole* list is unread, as the server reports it.
	 * Not derived from `sessions`: that is a page, and "is there any" asked of a
	 * page answers no for a list nobody has scrolled far enough down
	 * (docs/list-paging-ui.md §2.1).
	 */
	hasUnread: boolean;
	isLoadingMore: boolean;
	/** Why the last page failed, and null when none has. */
	pageError: string | null;
	/**
	 * Whether the user has actually paged. "No earlier conversations" is only
	 * worth saying to someone who went looking for them: on a list that fitted in
	 * one page, saying where it ends states the obvious.
	 */
	hasPaged: boolean;
	/**
	 * Whether the sentinel may fetch on its own. Cleared by a failure — an
	 * observer left armed over a sentinel that never moves retries in a tight
	 * loop behind the user's back — and by a resync that shrank the list, which
	 * would otherwise leave the reader clamped to a new end that immediately
	 * asks for more. Both are transient, so the next page that lands re-arms it:
	 * the button is the way back, and pressing it must not leave the list
	 * click-only for the rest of the session.
	 */
	autoLoad: boolean;
	/**
	 * Bumped every time the list is replaced wholesale. A page that was in
	 * flight across a resync, a worktree switch or a filter change belongs to a
	 * list that no longer exists, and appending it would splice rows from one
	 * list into another.
	 */
	generation: number;
	isLoading: boolean;
	isSuccess: boolean;
	/**
	 * True while re-fetching the session list for a newly switched worktree.
	 * Unlike `reset`, the previous worktree's `sessions` are kept on screen so
	 * the UI can show them as a placeholder instead of blanking; `isSuccess` is
	 * cleared so redirect/new-session logic waits for the new worktree's list.
	 */
	isReloading: boolean;
	/**
	 * Whether the list should include the sessions that work items drive.
	 *
	 * A subscription parameter, not a predicate: the server applies it, so
	 * `sessions` is already narrowed to what the sidebar shows and flipping this
	 * resubscribes (`useSessionSubscription`). It lives here rather than in the
	 * filter button because the toggle outlives that button — it is persisted,
	 * and the subscription is opened somewhere else entirely.
	 */
	showTaskSessions: boolean;
}

/** One page of the list, as both the snapshot and a resync deliver it. */
export interface SessionPage {
	sessions: SessionListItem[];
	nextCursor: string | null;
	hasUnread: boolean;
}

interface SessionActions {
	/**
	 * Replaces the whole list, and starts paging over.
	 *
	 * `isResync` separates the two things that do this. A snapshot is a *new*
	 * list — a first subscribe, a refresh, a worktree switch, a flipped filter —
	 * and a new list that happens to be shorter says nothing about the reader's
	 * position in it. A resync is the *same* list handed back at the reader's own
	 * depth, so a short one means the cap in §3.4 cut it.
	 */
	setSessions: (page: SessionPage, isResync?: boolean) => void;
	updateSessions: (
		updater: (old: SessionListItem[]) => SessionListItem[],
	) => void;
	setHasUnread: (hasUnread: boolean) => void;
	beginLoadMore: () => void;
	/**
	 * Appends a page, dropping any row already held. The dedupe is not
	 * belt-and-braces: a session touched between two requests moves in the sort
	 * order, and the cursor removes the systematic error rather than every race
	 * (docs/list-paging-ui.md §3.3).
	 */
	appendSessions: (
		generation: number,
		sessions: SessionListItem[],
		nextCursor: string | null,
	) => void;
	failLoadMore: (generation: number, message: string) => void;
	/** Re-arms auto-loading after a failure; the sentinel's Retry. */
	retryLoadMore: () => void;
	/** Soft reset for worktree switch: keep sessions, mark list as reloading. */
	beginReload: () => void;
	toggleShowTaskSessions: () => void;
	reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	nextCursor: null,
	hasUnread: false,
	isLoadingMore: false,
	pageError: null,
	hasPaged: false,
	autoLoad: true,
	generation: 0,
	isLoading: true,
	isSuccess: false,
	isReloading: false,
	showTaskSessions: loadShowTaskSessions(),
	setSessions: (page, isResync = false) =>
		set((state) => ({
			sessions: page.sessions,
			nextCursor: page.nextCursor,
			hasUnread: page.hasUnread,
			isLoadingMore: false,
			pageError: null,
			hasPaged: false,
			// A resync hands back what the reader had loaded, up to a cap; past it
			// the list comes back shorter than what they were reading, and the
			// browser clamps them to its new end — where an armed sentinel would ask
			// for the next page at once, undoing the cap. The button is still there.
			autoLoad: !isResync || page.sessions.length >= state.sessions.length,
			generation: state.generation + 1,
			isLoading: false,
			isSuccess: true,
			isReloading: false,
		})),
	updateSessions: (updater) =>
		set((state) => ({ sessions: updater(state.sessions) })),
	setHasUnread: (hasUnread) => set({ hasUnread }),
	beginLoadMore: () => set({ isLoadingMore: true, pageError: null }),
	appendSessions: (generation, sessions, nextCursor) =>
		set((state) => {
			if (generation !== state.generation) return {};
			const held = new Set(state.sessions.map((s) => s.id));
			return {
				sessions: [
					...state.sessions,
					...sessions.filter((s) => !held.has(s.id)),
				],
				nextCursor,
				isLoadingMore: false,
				pageError: null,
				hasPaged: true,
				// Re-armed by the page that lands. Auto-loading is only ever off
				// because something transient turned it off — a failure, or a resync
				// that clamped the reader to a new end — and both of those are over
				// once the user has pressed the button and been given rows. Left off,
				// one resync would silently turn the rest of the session into a list
				// that has to be clicked down a page at a time.
				autoLoad: true,
			};
		}),
	failLoadMore: (generation, message) =>
		set((state) =>
			generation === state.generation
				? { isLoadingMore: false, pageError: message, autoLoad: false }
				: {},
		),
	retryLoadMore: () => set({ pageError: null, autoLoad: true }),
	// Keep isLoading false so views that show data (e.g. the session sidebar) keep
	// rendering the retained list instead of flashing a spinner during the switch.
	beginReload: () => set({ isSuccess: false, isReloading: true }),
	toggleShowTaskSessions: () =>
		set((state) => {
			const next = !state.showTaskSessions;
			localStorage.setItem(SHOW_TASK_SESSIONS_KEY, String(next));
			return { showTaskSessions: next };
		}),
	reset: () =>
		set((state) => ({
			sessions: [],
			nextCursor: null,
			hasUnread: false,
			isLoadingMore: false,
			pageError: null,
			hasPaged: false,
			autoLoad: true,
			generation: state.generation + 1,
			isLoading: false,
			isSuccess: false,
			isReloading: false,
		})),
}));

/**
 * The title of the session with this id, and null for one the list has no row
 * for. Null rather than undefined so a caller has to answer for the absence.
 */
export function selectSessionTitle(sessionId: string) {
	return (s: SessionStore): string | null =>
		s.sessions.find((x) => x.id === sessionId)?.title ?? null;
}

/**
 * What a surface may call a session the list has no row for.
 *
 * It never says "deleted", and there is no longer any state it could ask to
 * earn that word. The list is a page, so a row is missing when the user has not
 * scrolled that far — and it is narrowed by the server, so with the
 * task-session filter on a work session is absent for a reason that has nothing
 * to do with whether the session exists
 * (docs/code/subscription-system.md#which-sessions-belong-to-work). An absence
 * is not evidence (docs/list-paging-ui.md §2.3).
 *
 * One home for the rule because both callers — `SessionItem`'s fork line and
 * `ForkOriginBanner` — state it to the user in words, and a claim about what an
 * absence means is the kind that goes quietly stale.
 */
export const UNLISTED_SESSION_NAME = "a session that is not in the list";

/**
 * Prepend a session to the list, removing any existing session with the same ID.
 * Used for both create notifications and optimistic updates.
 */
export function prependSession(
	sessions: SessionListItem[],
	session: SessionListItem,
): SessionListItem[] {
	return [session, ...sessions.filter((s) => s.id !== session.id)];
}
