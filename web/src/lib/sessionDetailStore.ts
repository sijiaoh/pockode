import { create } from "zustand";
import type { SessionDetail } from "../types/message";

interface SessionDetailState {
	/**
	 * Which session `detail` describes, or null when nothing is held.
	 *
	 * Kept beside the detail rather than implied by it, because the two move at
	 * different moments: the open session changes as soon as the route does,
	 * while its metadata only arrives a round trip later. Reading through
	 * `selectSessionDetail` is what keeps the previous session's model and effort
	 * from being shown under the new session's name during that gap.
	 */
	sessionId: string | null;
	/** Null until the snapshot arrives, and again once the session is deleted. */
	detail: SessionDetail | null;
}

interface SessionDetailActions {
	setDetail: (sessionId: string, detail: SessionDetail | null) => void;
	clear: () => void;
}

export type SessionDetailStore = SessionDetailState & SessionDetailActions;

/**
 * The open session's metadata, as `session.detail.subscribe` reports it.
 *
 * One session at a time, because one session is open at a time: this is the
 * conversation on screen, not a cache of every session the app has visited.
 * Whether its agent is running is not here — that is the session list's to
 * report, through `SessionListItem.state`.
 */
export const useSessionDetailStore = create<SessionDetailStore>((set) => ({
	sessionId: null,
	detail: null,
	setDetail: (sessionId, detail) => set({ sessionId, detail }),
	clear: () => set({ sessionId: null, detail: null }),
}));

/** The held detail, but only when it is the one the caller asked about. */
export function selectSessionDetail(sessionId: string) {
	return (s: SessionDetailStore): SessionDetail | null =>
		s.sessionId === sessionId ? s.detail : null;
}
