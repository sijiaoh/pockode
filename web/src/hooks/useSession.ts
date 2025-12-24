import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createSession, deleteSession, listSessions } from "../lib/sessionApi";

interface UseSessionOptions {
	enabled?: boolean;
}

export function useSession({ enabled = true }: UseSessionOptions = {}) {
	const queryClient = useQueryClient();
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

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
			setCurrentSessionId(newSession.id);
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

	// Set initial session when data loads
	useEffect(() => {
		if (!isSuccess || currentSessionId || createMutation.isPending) return;

		if (sessions.length > 0) {
			setCurrentSessionId(sessions[0].id);
		} else {
			createMutation.mutate();
		}
	}, [isSuccess, sessions, currentSessionId, createMutation]);

	const handleDelete = async (id: string) => {
		const remaining = sessions.filter((s) => s.id !== id);

		if (id === currentSessionId) {
			if (remaining.length > 0) {
				setCurrentSessionId(remaining[0].id);
				deleteMutation.mutate(id);
			} else {
				// Create new session first, then delete
				await createMutation.mutateAsync();
				deleteMutation.mutate(id);
			}
		} else {
			deleteMutation.mutate(id);
		}
	};

	return {
		sessions,
		currentSessionId,
		isLoading,
		loadSessions: () =>
			queryClient.invalidateQueries({ queryKey: ["sessions"] }),
		createSession: () => createMutation.mutateAsync(),
		selectSession: setCurrentSessionId,
		deleteSession: handleDelete,
	};
}
