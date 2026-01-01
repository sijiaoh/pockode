import { useMatch, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useSession } from "../hooks/useSession";
import {
	authActions,
	selectIsAuthenticated,
	useAuthStore,
} from "../lib/authStore";
import type { DiffSearchParams } from "../router";
import type { OverlayState } from "../types/overlay";
import TokenInput from "./Auth/TokenInput";
import { ChatPanel } from "./Chat";
import { SessionSidebar } from "./Session";

interface RouteInfo {
	overlay: OverlayState;
	sessionId: string | null;
}

/**
 * Derives overlay and session state from the current route.
 */
function useRouteState(): RouteInfo {
	const sessionMatch = useMatch({
		from: "/s/$sessionId",
		shouldThrow: false,
	});
	const stagedMatch = useMatch({
		from: "/staged/$",
		shouldThrow: false,
	});
	const unstagedMatch = useMatch({
		from: "/unstaged/$",
		shouldThrow: false,
	});

	if (sessionMatch) {
		return {
			overlay: null,
			sessionId: sessionMatch.params.sessionId,
		};
	}

	if (stagedMatch) {
		const search = stagedMatch.search as DiffSearchParams;
		return {
			overlay: {
				type: "diff",
				path: stagedMatch.params._splat ?? "",
				staged: true,
			},
			sessionId: search.session ?? null,
		};
	}

	if (unstagedMatch) {
		const search = unstagedMatch.search as DiffSearchParams;
		return {
			overlay: {
				type: "diff",
				path: unstagedMatch.params._splat ?? "",
				staged: false,
			},
			sessionId: search.session ?? null,
		};
	}

	return {
		overlay: null,
		sessionId: null,
	};
}

function AppShell() {
	const isAuthenticated = useAuthStore(selectIsAuthenticated);
	const navigate = useNavigate();
	const isDesktop = useIsDesktop();
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const isCreatingSession = useRef(false);

	const { overlay, sessionId: routeSessionId } = useRouteState();

	const activeFile =
		overlay?.type === "diff"
			? { path: overlay.path, staged: overlay.staged }
			: null;

	const {
		sessions,
		currentSessionId,
		currentSession,
		isLoading,
		redirectSessionId,
		needsNewSession,
		loadSessions,
		createSession,
		deleteSession,
		updateTitle,
	} = useSession({ enabled: isAuthenticated, routeSessionId });

	useEffect(() => {
		if (redirectSessionId) {
			navigate({
				to: "/s/$sessionId",
				params: { sessionId: redirectSessionId },
				replace: true,
			});
		}
	}, [redirectSessionId, navigate]);

	// TODO: Fails silently and retries; persistent errors (e.g. network down) show only Loading with no feedback
	useEffect(() => {
		if (needsNewSession && !isCreatingSession.current) {
			isCreatingSession.current = true;
			createSession()
				.then((newSession) => {
					navigate({
						to: "/s/$sessionId",
						params: { sessionId: newSession.id },
						replace: true,
					});
				})
				.finally(() => {
					isCreatingSession.current = false;
				});
		}
	}, [needsNewSession, createSession, navigate]);

	// Load sessions on mount for desktop (sidebar always visible)
	useEffect(() => {
		if (isDesktop && isAuthenticated) {
			loadSessions();
		}
	}, [isDesktop, isAuthenticated, loadSessions]);

	const handleTokenSubmit = (token: string) => {
		authActions.login(token);
	};

	const handleOpenSidebar = useCallback(() => {
		setSidebarOpen(true);
		loadSessions();
	}, [loadSessions]);

	const handleSelectSession = useCallback(
		(id: string) => {
			navigate({ to: "/s/$sessionId", params: { sessionId: id } });
			setSidebarOpen(false);
		},
		[navigate],
	);

	const handleCreateSession = useCallback(async () => {
		const newSession = await createSession();
		setSidebarOpen(false);
		navigate({ to: "/s/$sessionId", params: { sessionId: newSession.id } });
	}, [createSession, navigate]);

	const handleDeleteSession = useCallback(
		async (id: string) => {
			const isCurrentSession = id === currentSessionId;
			const remaining = sessions.filter((s) => s.id !== id);

			await deleteSession(id);

			if (isCurrentSession && remaining.length > 0) {
				navigate({
					to: "/s/$sessionId",
					params: { sessionId: remaining[0].id },
					replace: true,
				});
			}
		},
		[currentSessionId, sessions, deleteSession, navigate],
	);

	const handleSelectDiffFile = useCallback(
		(path: string, staged: boolean) => {
			const route = staged ? "/staged/$" : "/unstaged/$";
			navigate({
				to: route,
				params: { _splat: path },
				search: currentSessionId ? { session: currentSessionId } : {},
			});
		},
		[navigate, currentSessionId],
	);

	const handleCloseOverlay = useCallback(() => {
		if (currentSessionId) {
			navigate({
				to: "/s/$sessionId",
				params: { sessionId: currentSessionId },
			});
		} else {
			navigate({ to: "/" });
		}
	}, [navigate, currentSessionId]);

	if (!isAuthenticated) {
		return <TokenInput onSubmit={handleTokenSubmit} />;
	}

	if (!currentSessionId || !currentSession) {
		return (
			<div className="flex h-dvh items-center justify-center bg-th-bg-primary">
				<div className="text-th-text-muted">Loading...</div>
			</div>
		);
	}

	return (
		<div className="flex h-dvh">
			<SessionSidebar
				isOpen={sidebarOpen}
				onClose={() => setSidebarOpen(false)}
				sessions={sessions}
				currentSessionId={currentSessionId}
				onSelectSession={handleSelectSession}
				onCreateSession={handleCreateSession}
				onDeleteSession={handleDeleteSession}
				onSelectDiffFile={handleSelectDiffFile}
				isLoading={isLoading}
				activeFile={activeFile}
				isDesktop={isDesktop}
			/>
			<ChatPanel
				sessionId={currentSessionId}
				sessionTitle={currentSession.title}
				onUpdateTitle={(title) => updateTitle(currentSessionId, title)}
				onLogout={authActions.logout}
				onOpenSidebar={handleOpenSidebar}
				overlay={overlay}
				onCloseOverlay={handleCloseOverlay}
			/>
		</div>
	);
}

export default AppShell;
