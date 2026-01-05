import { useMatch, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useSession } from "../hooks/useSession";
import {
	authActions,
	selectHasAuthToken,
	useAuthStore,
} from "../lib/authStore";
import { useWSStore, wsActions } from "../lib/wsStore";
import type { OverlaySearchParams } from "../router";
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
	const fileMatch = useMatch({
		from: "/files/$",
		shouldThrow: false,
	});

	if (sessionMatch) {
		return {
			overlay: null,
			sessionId: sessionMatch.params.sessionId,
		};
	}

	if (stagedMatch) {
		const search = stagedMatch.search as OverlaySearchParams;
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
		const search = unstagedMatch.search as OverlaySearchParams;
		return {
			overlay: {
				type: "diff",
				path: unstagedMatch.params._splat ?? "",
				staged: false,
			},
			sessionId: search.session ?? null,
		};
	}

	if (fileMatch) {
		const search = fileMatch.search as OverlaySearchParams;
		return {
			overlay: {
				type: "file",
				path: fileMatch.params._splat ?? "",
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
	const hasAuthToken = useAuthStore(selectHasAuthToken);
	const wsStatus = useWSStore((state) => state.status);
	const navigate = useNavigate();
	const isDesktop = useIsDesktop();
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const isCreatingSession = useRef(false);

	const { overlay, sessionId: routeSessionId } = useRouteState();

	const token = useAuthStore((state) => state.token);

	// Connect to WebSocket when token becomes available (initial connection only)
	// Reconnection is handled internally by wsStore with proper delay
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally exclude wsStatus to avoid bypassing retry delay
	useEffect(() => {
		if (token && wsStatus === "disconnected") {
			wsActions.connect(token);
		}
	}, [token]);

	// Handle auth failure by logging out
	useEffect(() => {
		if (wsStatus === "auth_failed") {
			authActions.logout();
		}
	}, [wsStatus]);

	const activeDiffFile =
		overlay?.type === "diff"
			? { path: overlay.path, staged: overlay.staged }
			: null;

	const activeFilePath = overlay?.type === "file" ? overlay.path : null;

	const {
		sessions,
		currentSessionId,
		currentSession,
		redirectSessionId,
		needsNewSession,
		createSession,
		deleteSession,
		updateTitle,
	} = useSession({ enabled: hasAuthToken, routeSessionId });

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

	const handleTokenSubmit = (token: string) => {
		authActions.login(token);
	};

	const handleOpenSidebar = useCallback(() => {
		setSidebarOpen(true);
	}, []);

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

	const handleSelectFile = useCallback(
		(path: string) => {
			navigate({
				to: "/files/$",
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

	if (!hasAuthToken) {
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
				currentSessionId={currentSessionId}
				onSelectSession={handleSelectSession}
				onCreateSession={handleCreateSession}
				onDeleteSession={handleDeleteSession}
				onSelectDiffFile={handleSelectDiffFile}
				activeDiffFile={activeDiffFile}
				onSelectFile={handleSelectFile}
				activeFilePath={activeFilePath}
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
