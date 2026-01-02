import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
	createSession,
	deleteSession,
	listSessions,
	updateSessionTitle,
} from "../lib/sessionApi";
import type { SessionMeta } from "../types/message";

interface UseSessionOptions {
	enabled?: boolean;
	/** Session ID from URL */
	routeSessionId?: string | null;
}

export function useSession({
	enabled = true,
	routeSessionId,
}: UseSessionOptions = {}) {
	const queryClient = useQueryClient();

	const {
		data: sessions = [],
		isLoading,
		isSuccess,
	} = useQuery({
		queryKey: ["sessions"],
		queryFn: listSessions,
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["sessions"] });
	}, [queryClient]);

	const createMutation = useMutation({
		mutationFn: createSession,
		onSuccess: (newSession) => {
			queryClient.setQueryData<SessionMeta[]>(["sessions"], (old = []) => [
				newSession,
				...old,
			]);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteSession,
		onSuccess: (_, deletedId) => {
			queryClient.setQueryData<SessionMeta[]>(["sessions"], (old = []) =>
				old.filter((s) => s.id !== deletedId),
			);
		},
	});

	const updateTitleMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			updateSessionTitle(id, title),
		onSuccess: (_, { id, title }) => {
			queryClient.setQueryData<SessionMeta[]>(["sessions"], (old = []) =>
				old.map((s) => (s.id === id ? { ...s, title } : s)),
			);
		},
		onError: () => {
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
		},
	});

	const currentSessionId = routeSessionId ?? null;
	const currentSession = sessions.find((s) => s.id === currentSessionId);

	const getRedirectSessionId = (): string | null => {
		if (!isSuccess) return null;
		if (currentSessionId && currentSession) return null;
		if (sessions.length > 0) return sessions[0].id;
		return null;
	};

	const redirectSessionId = getRedirectSessionId();
	const needsNewSession = isSuccess && sessions.length === 0;

	return {
		sessions,
		currentSessionId,
		currentSession,
		isLoading,
		isSuccess,
		redirectSessionId,
		needsNewSession,
		refresh,
		createSession: () => createMutation.mutateAsync(),
		deleteSession: (id: string) => deleteMutation.mutateAsync(id),
		updateTitle: (id: string, title: string) =>
			updateTitleMutation.mutate({ id, title }),
	};
}
