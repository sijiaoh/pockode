import { createContext, useContext } from "react";
import type { SessionTurn } from "../../types/message";

/**
 * What a permission card needs from the session around it to say who is
 * answering (docs/unattended-mode-ui.md §3). Given by `ChatPanel` around the
 * transcript.
 *
 * A context rather than props because the cards sit under memoized message
 * rows — a subagent's request several renderers down — and the reviewing set
 * changes with the turn, which must not re-render every row.
 */
export interface PermissionReviewView {
	/**
	 * The requests the session's permission reviewer is answering right now,
	 * read from the turn's blockers (`TurnBlocker.reviewing`) — live state,
	 * never the card's own record.
	 */
	reviewing: ReadonlySet<string>;
	/** The session on screen, which a "View review" link must not point at. */
	sessionId: string;
	/** Opens another session in the screen's own view; absent, no link. */
	onOpenSession?: (sessionId: string) => void;
}

const NONE: PermissionReviewView = {
	reviewing: new Set(),
	sessionId: "",
};

export const PermissionReviewContext =
	createContext<PermissionReviewView>(NONE);

export function usePermissionReview(): PermissionReviewView {
	return useContext(PermissionReviewContext);
}

/** The permission requests in `turn` that are under review. */
export function reviewingRequestIds(turn: SessionTurn): Set<string> {
	const ids = new Set<string>();
	if (turn.phase !== "blocked") return ids;
	for (const b of turn.blockers ?? []) {
		if (b.kind === "permission" && b.reviewing && b.request_id) {
			ids.add(b.request_id);
		}
	}
	return ids;
}
