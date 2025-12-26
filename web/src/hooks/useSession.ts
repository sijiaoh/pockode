import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	createSession,
	deleteSession,
	listSessions,
	updateSessionTitle,
} from "../lib/sessionApi";
import type { SessionMeta } from "../types/message";

// Extract session ID from URL path (e.g., /s/abc123 -> abc123)
function getSessionIdFromUrl(): string | null {
	const match = window.location.pathname.match(/^\/s\/([^/]+)/);
	return match ? match[1] : null;
}

// Update URL to reflect current session
function updateUrl(sessionId: string | null) {
	const newPath = sessionId ? `/s/${sessionId}` : "/";
	if (window.location.pathname !== newPath) {
		window.history.pushState(null, "", newPath);
	}
}

interface UseSessionOptions {
	enabled?: boolean;
}

export function useSession({ enabled = true }: UseSessionOptions = {}) {
	const queryClient = useQueryClient();
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(
		getSessionIdFromUrl,
	);

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

	const updateTitleMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			updateSessionTitle(id, title),
		onSuccess: (_, { id, title }) => {
			queryClient.setQueryData<SessionMeta[]>(["sessions"], (old = []) =>
				old.map((s) => (s.id === id ? { ...s, title } : s)),
			);
		},
	});

	// Set initial session when data loads
	useEffect(() => {
		if (!isSuccess || createMutation.isPending) return;

		// If we have a session ID from URL, validate it exists
		if (currentSessionId) {
			const exists = sessions.some((s) => s.id === currentSessionId);
			if (exists) return; // Valid session, keep it
			// Invalid session ID in URL, fall through to select/create
		}

		if (sessions.length > 0) {
			setCurrentSessionId(sessions[0].id);
		} else {
			createMutation.mutate();
		}
	}, [isSuccess, sessions, currentSessionId, createMutation]);

	// Sync URL when session changes
	useEffect(() => {
		if (currentSessionId) {
			updateUrl(currentSessionId);
		}
	}, [currentSessionId]);

	// Handle browser back/forward
	useEffect(() => {
		const handlePopState = () => {
			const urlSessionId = getSessionIdFromUrl();
			if (urlSessionId !== currentSessionId) {
				setCurrentSessionId(urlSessionId);
			}
		};

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, [currentSessionId]);

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

	const currentSession = sessions.find((s) => s.id === currentSessionId);

	return {
		sessions,
		currentSessionId,
		currentSession,
		isLoading,
		loadSessions: () =>
			queryClient.invalidateQueries({ queryKey: ["sessions"] }),
		createSession: () => createMutation.mutateAsync(),
		selectSession: setCurrentSessionId,
		deleteSession: handleDelete,
		updateTitle: (id: string, title: string) =>
			updateTitleMutation.mutate({ id, title }),
	};
}
