import { useCallback, useState } from "react";
import { prependSession, useSessionStore } from "../lib/sessionStore";
import { wsActions } from "../lib/wsStore";
import type { HistorySeq, SessionListItem } from "../types/message";

/**
 * Where the fork is cut: after a message, quoted back by its seq, or at the
 * moment a canvas page had just been drawn, which the server finds the record
 * of (docs/canvas-ui.md §13.6, *From a revision*).
 */
export type ForkCut = { anchorSeq: HistorySeq } | { canvasRevision: number };

interface UseForkSessionReturn {
	forkSession: (
		sessionId: string,
		cut: ForkCut,
		title: string,
	) => Promise<SessionListItem>;
	isForking: boolean;
	/**
	 * The server's own wording, kept verbatim: "fork anchor is outside the
	 * session's history" and a dropped connection must not read the same.
	 */
	forkError: string | null;
	clearForkError: () => void;
}

/**
 * Forks a session, adding the result to the session list.
 *
 * The list is updated here rather than waiting for the subscription to report
 * the new session, so navigating to it straight away finds it — otherwise the
 * app lands on a session it cannot resolve yet and shows an empty shell. The
 * notification that follows deduplicates against it.
 *
 * Plain state rather than a query mutation: this is one request whose result
 * belongs to the session store, so there is nothing for a cache to hold.
 */
export function useForkSession(): UseForkSessionReturn {
	const updateSessions = useSessionStore((s) => s.updateSessions);
	const [isForking, setIsForking] = useState(false);
	const [forkError, setForkError] = useState<string | null>(null);

	const forkSession = useCallback(
		async (sessionId: string, cut: ForkCut, title: string) => {
			setIsForking(true);
			setForkError(null);
			try {
				const session =
					"canvasRevision" in cut
						? await wsActions.forkSessionAtCanvasRevision(
								sessionId,
								cut.canvasRevision,
								title,
							)
						: await wsActions.forkSession(sessionId, cut.anchorSeq, title);
				updateSessions((old) => prependSession(old, session));
				return session;
			} catch (error) {
				setForkError(
					error instanceof Error && error.message
						? error.message
						: "Unknown error",
				);
				throw error;
			} finally {
				setIsForking(false);
			}
		},
		[updateSessions],
	);

	const clearForkError = useCallback(() => setForkError(null), []);

	return { forkSession, isForking, forkError, clearForkError };
}
