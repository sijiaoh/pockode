import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { prependSession, useSessionStore } from "../lib/sessionStore";
import { collectWorkSessionIds, useWorkStore } from "../lib/workStore";
import { wsActions } from "../lib/wsStore";
import type { SessionListItem } from "../types/message";
import { useSessionSubscription } from "./useSessionSubscription";

interface UseSessionOptions {
	enabled?: boolean;
	/** Session ID from URL */
	routeSessionId?: string | null;
}

export function useSession({
	enabled = true,
	routeSessionId,
}: UseSessionOptions = {}) {
	const sessions = useSessionStore((s) => s.sessions);
	const isLoading = useSessionStore((s) => s.isLoading);
	const isSuccess = useSessionStore((s) => s.isSuccess);
	const isReloading = useSessionStore((s) => s.isReloading);
	const showTaskSessions = useSessionStore((s) => s.showTaskSessions);
	const updateSessions = useSessionStore((s) => s.updateSessions);
	const works = useWorkStore((s) => s.works);
	const { refresh } = useSessionSubscription(enabled);

	const workSessionIds = useMemo(() => collectWorkSessionIds(works), [works]);

	const filteredSessions = useMemo(
		() =>
			showTaskSessions
				? sessions
				: sessions.filter((s) => !workSessionIds.has(s.id)),
		[sessions, showTaskSessions, workSessionIds],
	);

	const hasAnyUnread = useMemo(
		() => filteredSessions.some((s) => s.unread),
		[filteredSessions],
	);

	const createMutation = useMutation({
		mutationFn: wsActions.createSession,
		onSuccess: (newSession) => {
			// Optimistically add session to avoid redirect race condition.
			// The subscription notification will deduplicate.
			updateSessions((old) => prependSession(old, newSession));
		},
	});

	// Every entry point to session creation goes through here, so a second caller
	// arriving while a create is in flight joins that one instead of starting
	// another: a double tap on "+" would otherwise leave a stray session behind,
	// and an effect that re-runs mid-request would do the same.
	const createInFlight = useRef<Promise<SessionListItem> | null>(null);
	const { mutateAsync: runCreate } = createMutation;
	const createSession = useCallback(() => {
		if (!createInFlight.current) {
			createInFlight.current = runCreate().finally(() => {
				createInFlight.current = null;
			});
		}
		return createInFlight.current;
	}, [runCreate]);

	const deleteMutation = useMutation({
		mutationFn: wsActions.deleteSession,
	});

	const updateTitleMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			wsActions.updateSessionTitle(id, title),
	});

	const currentSessionId = routeSessionId ?? null;
	const currentSession = sessions.find((s) => s.id === currentSessionId);

	const redirectSessionId = (() => {
		if (!isSuccess) return null;
		if (currentSessionId && currentSession) return null;
		if (filteredSessions.length > 0) return filteredSessions[0].id;
		return null;
	})();

	const needsNewSession = isSuccess && sessions.length === 0;

	return {
		sessions,
		filteredSessions,
		hasAnyUnread,
		currentSessionId,
		currentSession,
		isLoading,
		isSuccess,
		isReloading,
		redirectSessionId,
		needsNewSession,
		refresh,
		createSession,
		createError: createMutation.error,
		clearCreateError: createMutation.reset,
		deleteSession: (id: string) => deleteMutation.mutateAsync(id),
		updateTitle: (id: string, title: string) =>
			updateTitleMutation.mutate({ id, title }),
	};
}
