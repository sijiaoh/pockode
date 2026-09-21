import { createContext, useContext } from "react";
import type { WorktreeInfo } from "../types/message";
import { getDisplayName } from "./worktreeStore";

/**
 * The `from` search parameter: which worktree a session screen is reading its
 * data out of.
 *
 * It is the whole of the URL convention for cross-worktree viewing, and the one
 * place it is spelled:
 *
 * - It appears **only on the two session routes** (`/s/$sessionId` and
 *   `/w/$worktree/s/$sessionId`). Files, Git and Project are about the worktree
 *   the user is standing in, and that is the worktree in the *path* — `from`
 *   never moves it.
 * - Its value is a worktree *name*, and the empty string is the main worktree,
 *   exactly as `session_view.*` takes it on the wire. So `?from=` is a real
 *   value ("read main's copy") and is not the same as leaving the parameter off.
 * - Leaving it off means the session belongs to the worktree in the path, which
 *   is every ordinary session URL.
 * - `from` naming the worktree already in the path is a no-op rather than an
 *   error: it is the same session read the ordinary way, so the screen stays
 *   writable. Without that rule "Open there" would flash a read-only screen on
 *   the way out of one.
 */
export const SESSION_VIEW_PARAM = "from";

/**
 * A session screen that is reading another worktree's data, and therefore
 * read-only: the data arrives through `session_view.*`, which has no
 * subscription and no way to say anything to the session.
 */
export interface SessionView {
	/** The worktree the data is read from; "" is the main worktree. */
	worktree: string;
	/**
	 * Whether that worktree still exists. Read from the live worktree list on
	 * every render rather than captured once: a worktree can be deleted, or
	 * recreated under the same name, while its sessions are being read, and both
	 * strips change wording when it does.
	 */
	exists: boolean;
	/** What to call it on screen. */
	label: string;
}

/**
 * The view the current session screen is in, or null when it is an ordinary
 * one.
 *
 * `null` is the default because every screen that is not a session screen is in
 * no view at all, and because a consumer reached without a provider must read as
 * "ordinary session" rather than fail.
 */
const SessionViewContext = createContext<SessionView | null>(null);

export const SessionViewProvider = SessionViewContext.Provider;

/**
 * Where the transcript on screen is being read from.
 *
 * A context rather than a prop because the one thing deep in the tree that
 * needs it — reading an attachment's bytes — sits under memoized message rows
 * that would all have to carry it. Nothing else may read it to *decide* what to
 * render: whether the screen is read-only is `ChatPanel`'s, stated once.
 */
export function useSessionView(): SessionView | null {
	return useContext(SessionViewContext);
}

/**
 * What to say about a worktree a session is read out of: whether it is still
 * there, and what to call it.
 *
 * Read against the live worktree list on every call rather than captured once —
 * a worktree can be deleted, or recreated under the same name, while its
 * sessions are on screen.
 *
 * @param worktree The worktree's name; "" is the main worktree.
 */
export function describeWorktree(
	worktree: string,
	worktrees: WorktreeInfo[],
): SessionView {
	const info = worktrees.find((w) =>
		worktree ? w.name === worktree : w.is_main,
	);
	return {
		worktree,
		exists: info !== undefined,
		// The name is all a deleted worktree left behind; one that still exists
		// is named the way it is named everywhere else, which for the main
		// worktree is its branch rather than its empty name.
		label: info ? getDisplayName(info) : worktree || "main",
	};
}

/**
 * Resolves the `from` parameter against where the user is standing.
 *
 * @param from The parameter as the URL carries it; undefined when absent.
 * @param currentWorktree The worktree in the path.
 * @param worktrees The worktrees that exist right now.
 */
export function resolveSessionView(
	from: string | undefined,
	currentWorktree: string,
	worktrees: WorktreeInfo[],
): SessionView | null {
	if (from === undefined) return null;
	if (from === currentWorktree) return null;

	return describeWorktree(from, worktrees);
}
