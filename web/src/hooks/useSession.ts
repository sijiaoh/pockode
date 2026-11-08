import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { attachmentActions } from "../lib/inputStore";
import { createSession } from "../lib/sessionCreate";
import {
	selectSessionDetailStatus,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { useSessionStore } from "../lib/sessionStore";
import { wsActions } from "../lib/wsStore";
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
	const hasMore = useSessionStore((s) => s.nextCursor !== null);
	const isLoadingMore = useSessionStore((s) => s.isLoadingMore);
	const pageError = useSessionStore((s) => s.pageError);
	const autoLoad = useSessionStore((s) => s.autoLoad);
	const hasPaged = useSessionStore((s) => s.hasPaged);
	const retryLoadMore = useSessionStore((s) => s.retryLoadMore);
	const showTaskSessions = useSessionStore((s) => s.showTaskSessions);
	// The filter is the server's, so the toggle is a subscription parameter
	// rather than a predicate applied to what came back. Deciding it here would
	// mean holding the whole work list to invert it, which makes this list wrong
	// for as long as that list is incomplete — and a work list that pages is
	// never complete (docs/code/subscription-system.md#which-sessions-belong-to-work).
	const { refresh, loadMore } = useSessionSubscription(
		enabled,
		!showTaskSessions,
	);

	// The server's answer over the whole list, not `sessions.some(...)`: the list
	// is a page, and an unread session is one an agent finished with while nobody
	// was looking — exactly the session nobody has scrolled to
	// (docs/list-paging-ui.md §2.1).
	const hasAnyUnread = useSessionStore((s) => s.hasUnread);

	// The create itself, and the joining of concurrent callers, is shared with
	// the entries that create without this hook (`createSession`); the mutation
	// only holds the failure for the shell's error screen.
	const createMutation = useMutation({ mutationFn: createSession });
	const { mutateAsync: runCreate } = createMutation;
	const create = useCallback(() => runCreate(), [runCreate]);

	const deleteMutation = useMutation({
		mutationFn: wsActions.deleteSession,
		// Its files went with its store; what the draft still holds of them is
		// memory and uploads with nowhere left to go.
		onSuccess: (_, sessionId) => attachmentActions.discard(sessionId),
	});

	const updateTitleMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			wsActions.updateSessionTitle(id, title),
	});

	const currentSessionId = routeSessionId ?? null;
	const currentSession = sessions.find((s) => s.id === currentSessionId);

	// The list no longer answers "does the route's session exist". With the
	// filter on it is missing every session that belongs to work — and a work's
	// Chat link points at exactly one of those, so an absence here would read as
	// "deleted" and bounce the user off the conversation they just opened.
	// The session's own `session.detail` subscription says so instead, and this
	// only reads what it left behind: the three fields below, and therefore
	// `redirectSessionId` and `needsNewSession` with them, are answers for the
	// caller that holds that subscription. `AppShell` is that caller, and the
	// only one that reads them; a sidebar does not route.
	const routeSessionStatus = useSessionDetailStore(
		selectSessionDetailStatus(currentSessionId),
	);
	// A row in the list is proof in itself, and the fast path: a session the
	// sidebar shows resolves the moment the list lands, without waiting on a
	// second round trip. Only a session the filter hides pays for one.
	const isRouteSessionResolved =
		currentSession !== undefined || routeSessionStatus === "ready";
	const isRouteSessionMissing =
		currentSession === undefined && routeSessionStatus === "missing";

	const redirectSessionId = (() => {
		if (!isSuccess) return null;
		// `loading` is not a verdict: leaving the route alone while the session is
		// still being resolved is what keeps a work session openable.
		if (currentSessionId && !isRouteSessionMissing) return null;
		if (sessions.length > 0) return sessions[0].id;
		return null;
	})();

	// Only when there is nothing to show and nothing to wait for: a worktree
	// whose every session is hidden by the filter still has the route's session
	// to open, and creating one behind the user's back would be the filter
	// inventing sessions.
	const needsNewSession =
		isSuccess &&
		sessions.length === 0 &&
		(currentSessionId === null || isRouteSessionMissing);

	return {
		sessions,
		hasAnyUnread,
		hasMore,
		isLoadingMore,
		pageError,
		autoLoad,
		hasPaged,
		loadMore,
		retryLoadMore,
		currentSessionId,
		currentSession,
		isRouteSessionResolved,
		isLoading,
		isSuccess,
		isReloading,
		redirectSessionId,
		needsNewSession,
		refresh,
		createSession: create,
		createError: createMutation.error,
		clearCreateError: createMutation.reset,
		deleteSession: (id: string) => deleteMutation.mutateAsync(id),
		updateTitle: (id: string, title: string) =>
			updateTitleMutation.mutate({ id, title }),
	};
}
