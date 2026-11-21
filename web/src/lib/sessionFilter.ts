import type { SessionListItem } from "../types/message";
import type { SessionView } from "./sessionView";

/**
 * Which worktree's sessions the sidebar lists.
 *
 * One selection rather than a set: the user's intent is "go and look at another
 * worktree's conversations", and a combination of two worktrees answers no
 * question anyone asks — while forcing every row to say which one it came from.
 * `all` covers the one cross-worktree need there is, "I don't remember where it
 * was".
 *
 * `worktree` never names the worktree the user is standing in; that one is
 * `current`, which reads the live, subscribed list rather than a snapshot.
 */
export type SessionFilter =
	| { kind: "current" }
	| { kind: "all" }
	| { kind: "worktree"; worktree: string };

export const CURRENT_WORKTREE_FILTER: SessionFilter = { kind: "current" };

/**
 * The kinds of session the list leaves out: those a work item drives, and
 * permission reviewers. Both are the server's to apply — they are parameters of
 * `session.list.subscribe` and `session_view.list`, not predicates over what
 * came back (docs/code/subscription-system.md#which-sessions-belong-to-work).
 */
export interface SessionListExclusions {
	workSessions: boolean;
	permissionReviewerSessions: boolean;
}

export const NO_EXCLUSIONS: SessionListExclusions = {
	workSessions: false,
	permissionReviewerSessions: false,
};

/**
 * The request parameters for `exclusions`. A flag that is off is omitted, so
 * the request is the one an older client sends; the server's default is "send
 * everything" either way.
 */
export function sessionListExclusionParams(exclusions: SessionListExclusions): {
	exclude_work_sessions?: true;
	exclude_permission_reviewer_sessions?: true;
} {
	return {
		...(exclusions.workSessions ? { exclude_work_sessions: true } : {}),
		...(exclusions.permissionReviewerSessions
			? { exclude_permission_reviewer_sessions: true }
			: {}),
	};
}

/** Whether `session` is one of the kinds `exclusions` leaves out. */
export function isExcludedSession(
	exclusions: SessionListExclusions,
	session: SessionListItem,
): boolean {
	return (
		(exclusions.workSessions && !!session.work_id) ||
		(exclusions.permissionReviewerSessions && !!session.permission_reviewer_of)
	);
}

/**
 * Where a row's session lives, and `null` when that is the worktree the user is
 * standing in — the ordinary case, and the one where nothing is drawn.
 *
 * It is `SessionView` because it answers the same three questions the read-only
 * screen asks of the session it shows: which worktree, is it still there, what
 * to call it. A row that is opened becomes that screen, so a second type here
 * would be the same fact written twice.
 */
export type SessionOrigin = SessionView;

/**
 * Whether a session read out of `origin` would have a row in the list as it is
 * filtered now.
 *
 * `origin` is null for a session of the current worktree.
 */
export function isVisibleUnder(
	filter: SessionFilter,
	origin: string | null,
): boolean {
	switch (filter.kind) {
		case "current":
			return origin === null;
		case "all":
			return true;
		case "worktree":
			return origin === filter.worktree;
	}
}

/** The filter under which a session read out of `origin` has a row. */
export function filterShowing(origin: string | null): SessionFilter {
	return origin === null
		? CURRENT_WORKTREE_FILTER
		: { kind: "worktree", worktree: origin };
}

/**
 * The worktrees a filter reads from, and null when it reads the live list of
 * the worktree the user is in.
 *
 * `all` is a list of sources rather than a single "every worktree" request
 * because the server has no such request: `session_view.list` names one
 * worktree, so the merge across them happens here
 * (see `mergeSessionRounds`).
 */
export function filterSources(
	filter: SessionFilter,
	available: string[],
): string[] | null {
	switch (filter.kind) {
		case "current":
			return null;
		case "all":
			return available;
		case "worktree":
			// Even one the source list no longer has: it is only dropped from that
			// list once its last session is deleted, and asking for an empty
			// worktree answers "no sessions" rather than failing.
			return [filter.worktree];
	}
}

/**
 * A row of the session sidebar: the session, and where it came from.
 *
 * `origin` is null for the rows the sidebar has always shown — this worktree's
 * own — and nothing is drawn for them. A filter that spans worktrees is the
 * only thing that puts a worktree on a row.
 */
export interface SessionRow {
	session: SessionListItem;
	origin: SessionOrigin | null;
}
