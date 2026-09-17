import { create } from "zustand";
import type { SessionDetail } from "../types/message";

/**
 * What is known about whether the open session exists.
 *
 * `missing` is positive evidence and nothing less: the server said the session
 * is gone, or refused to subscribe to it while the connection was up. A
 * disconnect is not evidence — it goes back to `loading`, because the session
 * list subscription drops with it and the whole app is waiting either way.
 * Nothing navigates away on a `loading`.
 */
export type SessionDetailStatus = "loading" | "ready" | "missing";

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
	status: SessionDetailStatus;
}

interface SessionDetailActions {
	setDetail: (sessionId: string, detail: SessionDetail | null) => void;
	/** The session is not there: nothing to show, and the route has to move on. */
	setMissing: (sessionId: string) => void;
	clear: () => void;
}

export type SessionDetailStore = SessionDetailState & SessionDetailActions;

/**
 * The open session's metadata, as `session.detail.subscribe` reports it.
 *
 * One session at a time, because one session is open at a time: this is the
 * conversation on screen, not a cache of every session the app has visited.
 * What the session is doing is here, on `turn`: it is the live source the chat
 * panel reads, and the same value the session's row carries.
 *
 * It is also the only thing that can say whether the open session exists at
 * all. The session list cannot: the server hides work sessions from it when the
 * filter is on, and a hidden row is the same absence as a deleted one
 * (docs/code/subscription-system.md#which-sessions-belong-to-work).
 */
export const useSessionDetailStore = create<SessionDetailStore>((set) => ({
	sessionId: null,
	detail: null,
	status: "loading",
	setDetail: (sessionId, detail) =>
		set({ sessionId, detail, status: detail ? "ready" : "missing" }),
	setMissing: (sessionId) =>
		set({ sessionId, detail: null, status: "missing" }),
	clear: () => set({ sessionId: null, detail: null, status: "loading" }),
}));

/**
 * The held detail, but only when it is the one the caller asked about. Takes a
 * null id — a caller that reads the open session off the route has one — and
 * answers for it the way it answers for any other session the store is not
 * holding.
 */
export function selectSessionDetail(sessionId: string | null) {
	return (s: SessionDetailStore): SessionDetail | null =>
		sessionId !== null && s.sessionId === sessionId ? s.detail : null;
}

/**
 * What is known about `sessionId`, and `loading` for any other session — a
 * verdict about the session the store was last pointed at says nothing about
 * the one the route has just moved to.
 */
export function selectSessionDetailStatus(sessionId: string | null) {
	return (s: SessionDetailStore): SessionDetailStatus =>
		sessionId !== null && s.sessionId === sessionId ? s.status : "loading";
}
