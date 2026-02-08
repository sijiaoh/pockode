import { useCallback } from "react";
import { prependSession, useSessionStore } from "../lib/sessionStore";
import { unreadActions } from "../lib/unreadStore";
import { useWSStore } from "../lib/wsStore";
import type {
	SessionListChangedNotification,
	SessionListItem,
} from "../types/message";
import { useSubscription } from "./useSubscription";

/**
 * Manages WebSocket subscription to the session list.
 * Handles subscribe/unsubscribe lifecycle and notification processing.
 */
export function useSessionSubscription(enabled: boolean) {
	const sessionListSubscribe = useWSStore(
		(s) => s.actions.sessionListSubscribe,
	);
	const sessionListUnsubscribe = useWSStore(
		(s) => s.actions.sessionListUnsubscribe,
	);

	const setSessions = useSessionStore((s) => s.setSessions);
	const updateSessions = useSessionStore((s) => s.updateSessions);
	const reset = useSessionStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: SessionListChangedNotification) => {
			// Mark as unread when session content is updated (not just state change)
			if (params.operation === "update") {
				const sessions = useSessionStore.getState().sessions;
				const existing = sessions.find((s) => s.id === params.session.id);
				const isContentUpdate =
					existing && existing.updated_at !== params.session.updated_at;
				if (isContentUpdate && !unreadActions.isViewing(params.session.id)) {
					unreadActions.markUnread(params.session.id);
				}
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
		[updateSessions],
	);

	const { refresh } = useSubscription<
		SessionListChangedNotification,
		SessionListItem[]
	>(sessionListSubscribe, sessionListUnsubscribe, handleNotification, {
		enabled,
		onSubscribed: setSessions,
		onReset: reset,
	});

	return { refresh };
}
