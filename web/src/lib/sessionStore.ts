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
	showTaskSessions: boolean;
}

interface SessionActions {
	setSessions: (sessions: SessionListItem[]) => void;
	updateSessions: (
		updater: (old: SessionListItem[]) => SessionListItem[],
	) => void;
	toggleShowTaskSessions: () => void;
	reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	isLoading: true,
	isSuccess: false,
	showTaskSessions: loadShowTaskSessions(),
	setSessions: (sessions) =>
		set({ sessions, isLoading: false, isSuccess: true }),
	updateSessions: (updater) =>
		set((state) => ({ sessions: updater(state.sessions) })),
	toggleShowTaskSessions: () =>
		set((state) => {
			const next = !state.showTaskSessions;
			localStorage.setItem(SHOW_TASK_SESSIONS_KEY, String(next));
			return { showTaskSessions: next };
		}),
	reset: () => set({ sessions: [], isLoading: false, isSuccess: false }),
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
