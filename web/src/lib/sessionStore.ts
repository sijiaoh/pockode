import { create } from "zustand";
import type { SessionListItem } from "../types/message";

const SHOW_TASK_SESSIONS_KEY = "show-task-sessions";

function loadShowTaskSessions(): boolean {
	return localStorage.getItem(SHOW_TASK_SESSIONS_KEY) === "true";
}

interface SessionState {
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
 * Prepend a session to the list, removing any existing session with the same ID.
 * Used for both create notifications and optimistic updates.
 */
export function prependSession(
	sessions: SessionListItem[],
	session: SessionListItem,
): SessionListItem[] {
	return [session, ...sessions.filter((s) => s.id !== session.id)];
}
