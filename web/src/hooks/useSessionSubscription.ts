import { useCallback } from "react";
import { prependSession, useSessionStore } from "../lib/sessionStore";
import { useWSStore } from "../lib/wsStore";
import type {
	SessionListChangedNotification,
	SessionListItem,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Manages WebSocket subscription to the session list.
 * Handles subscribe/unsubscribe lifecycle and notification processing.
 *
 * @param excludeWorkSessions Whether to ask the server for the list without the
 * sessions that belong to work items. The filter lives on the subscription, so
 * flipping it resubscribes; the list already on screen stays there until the new
 * snapshot replaces it, which is what keeps the sidebar from blanking.
 */
export function useSessionSubscription(
	enabled: boolean,
	excludeWorkSessions: boolean,
) {
	const sessionListSubscribe = useWSStore(
		(s) => s.actions.sessionListSubscribe,
	);
	const sessionListUnsubscribe = useWSStore(
		(s) => s.actions.sessionListUnsubscribe,
	);

	const setSessions = useSessionStore((s) => s.setSessions);
	const updateSessions = useSessionStore((s) => s.updateSessions);
	const reset = useSessionStore((s) => s.reset);
	const beginReload = useSessionStore((s) => s.beginReload);

	const subscribe = useCallback(
		(onNotification: (params: SessionListChangedNotification) => void) =>
			sessionListSubscribe(onNotification, excludeWorkSessions),
		[sessionListSubscribe, excludeWorkSessions],
	);

	const handleNotification = useCallback(
		(params: SessionListChangedNotification) => {
			if (params.operation === "sync") {
				setSessions(params.sessions);
				return;
			}
			updateSessions((old) => {
				switch (params.operation) {
					case "create":
						return prependSession(old, params.session);
					case "update":
						return old.map((s) =>
							s.id === params.session.id ? params.session : s,
						);
					case "delete":
						return old.filter((s) => s.id !== params.sessionId);
				}
			});
		},
		[setSessions, updateSessions],
	);

	const { refresh } = useSubscription<
		SessionListChangedNotification,
		SessionListItem[]
	>(subscribe, sessionListUnsubscribe, handleNotification, {
		enabled,
		onSubscribed: setSessions,
		onReset: reset,
		// Keep the previous worktree's sessions visible during a switch; the new
		// list swaps in via onSubscribed. Avoids blanking the whole app shell.
		onWorktreeSwitch: beginReload,
	});

	return { refresh };
}
