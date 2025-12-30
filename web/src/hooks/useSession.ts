import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	createSession,
	deleteSession,
	listSessions,
	updateSessionTitle,
} from "../lib/sessionApi";
import type { SessionMeta } from "../types/message";

interface UseSessionOptions {
	enabled?: boolean;
	/** Session ID from router - takes precedence over internal state */
	routeSessionId?: string | null;
}

export function useSession({
	enabled = true,
	routeSessionId,
}: UseSessionOptions = {}) {
	const queryClient = useQueryClient();
	const [internalSessionId, setInternalSessionId] = useState<string | null>(
		null,
	);

	// Route session ID takes precedence over internal state
	const currentSessionId = routeSessionId ?? internalSessionId;

	const {
		data: sessions = [],
		isLoading,
		isSuccess,
	} = useQuery({
		queryKey: ["sessions"],
		queryFn: listSessions,
		enabled,
	});

	const createMutation = useMutation({
		mutationFn: createSession,
		onSuccess: (newSession) => {
			queryClient.setQueryData<typeof sessions>(["sessions"], (old = []) => [
				newSession,
				...old,
			]);
			setInternalSessionId(newSession.id);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteSession,
		onSuccess: (_, deletedId) => {
			queryClient.setQueryData<typeof sessions>(["sessions"], (old = []) =>
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

	const isCreating = createMutation.isPending;
	const createNewSession = createMutation.mutate;

	useEffect(() => {
		if (!isSuccess || isCreating) return;

		if (currentSessionId) {
			const exists = sessions.some((s) => s.id === currentSessionId);
			if (exists) return;
			// Invalid session ID - fall through to select first or create new
		}

		if (sessions.length > 0) {
			setInternalSessionId(sessions[0].id);
		} else {
			createNewSession();
		}
	}, [isSuccess, sessions, currentSessionId, isCreating, createNewSession]);

	const handleDelete = async (id: string) => {
		const remaining = sessions.filter((s) => s.id !== id);

		if (id === currentSessionId) {
			if (remaining.length > 0) {
				setInternalSessionId(remaining[0].id);
				deleteMutation.mutate(id);
			} else {
				// Must create before delete to ensure we always have a session
				await createMutation.mutateAsync();
				deleteMutation.mutate(id);
			}
		} else {
			deleteMutation.mutate(id);
		}
	};

	const currentSession = sessions.find((s) => s.id === currentSessionId);

	return {
		sessions,
		currentSessionId,
		currentSession,
		isLoading,
		loadSessions: () =>
			queryClient.invalidateQueries({ queryKey: ["sessions"] }),
		createSession: () => createMutation.mutateAsync(),
		selectSession: setInternalSessionId,
		deleteSession: handleDelete,
		updateTitle: (id: string, title: string) =>
			updateTitleMutation.mutate({ id, title }),
	};
}
