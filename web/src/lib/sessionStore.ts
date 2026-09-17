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

interface SessionActions {
	setSessions: (sessions: SessionListItem[]) => void;
	updateSessions: (
		updater: (old: SessionListItem[]) => SessionListItem[],
	) => void;
	/** Soft reset for worktree switch: keep sessions, mark list as reloading. */
	beginReload: () => void;
	toggleShowTaskSessions: () => void;
	reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	isLoading: true,
	isSuccess: false,
	isReloading: false,
	showTaskSessions: loadShowTaskSessions(),
	setSessions: (sessions) =>
		set({ sessions, isLoading: false, isSuccess: true, isReloading: false }),
	updateSessions: (updater) =>
		set((state) => ({ sessions: updater(state.sessions) })),
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
		set({
			sessions: [],
			isLoading: false,
			isSuccess: false,
			isReloading: false,
		}),
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
 * "Deleted" is only warranted while nothing is being hidden. The list is
 * narrowed by the server, so with the task-session filter on a work session is
 * absent from it for a reason that has nothing to do with whether the session
 * exists (docs/code/subscription-system.md#which-sessions-belong-to-work) — and
 * a fork of a work session is an ordinary session whose parent is exactly that,
 * which is how both callers reach this.
 *
 * One home for the rule because both callers state it to the user in words, and
 * a claim about what an absence means is the kind that goes quietly stale.
 */
export function selectUnlistedSessionName(s: SessionStore): string {
	return s.showTaskSessions
		? "a deleted session"
		: "a session that is not in the list";
}

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
