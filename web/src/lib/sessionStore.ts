import { create } from "zustand";
import type { SessionListItem } from "../types/message";

const HIDE_TASK_SESSIONS_KEY = "hide-task-sessions";

function loadHideTaskSessions(): boolean {
	return localStorage.getItem(HIDE_TASK_SESSIONS_KEY) === "true";
}

interface SessionState {
	sessions: SessionListItem[];
	isLoading: boolean;
	isSuccess: boolean;
	hideTaskSessions: boolean;
}

interface SessionActions {
	setSessions: (sessions: SessionListItem[]) => void;
	updateSessions: (
		updater: (old: SessionListItem[]) => SessionListItem[],
	) => void;
	toggleHideTaskSessions: () => void;
	reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	isLoading: true,
	isSuccess: false,
	hideTaskSessions: loadHideTaskSessions(),
	setSessions: (sessions) =>
		set({ sessions, isLoading: false, isSuccess: true }),
	updateSessions: (updater) =>
		set((state) => ({ sessions: updater(state.sessions) })),
	toggleHideTaskSessions: () =>
		set((state) => {
			const next = !state.hideTaskSessions;
			localStorage.setItem(HIDE_TASK_SESSIONS_KEY, String(next));
			return { hideTaskSessions: next };
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
