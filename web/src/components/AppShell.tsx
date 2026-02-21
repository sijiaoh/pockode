import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { useRouteState } from "../hooks/useRouteState";
import { useSession } from "../hooks/useSession";
import { useSettingsSubscription } from "../hooks/useSettingsSubscription";
import { useWorktree } from "../hooks/useWorktree";
import {
	authActions,
	selectHasAuthToken,
	useAuthStore,
} from "../lib/authStore";
import { buildNavigation, overlayToNavigation } from "../lib/navigation";
import { useWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import { useWSStore, wsActions } from "../lib/wsStore";
import TokenInput from "./Auth/TokenInput";
import { ChatPanel } from "./Chat";
import { SessionSidebar } from "./Session";

function AppShell() {
	const hasAuthToken = useAuthStore(selectHasAuthToken);
	const wsStatus = useWSStore((state) => state.status);
	const navigate = useNavigate();
	const isDesktop = useIsDesktop();
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const isCreatingSession = useRef(false);

	const {
		overlay,
		sessionId: routeSessionId,
		worktree: urlWorktree,
	} = useRouteState();
	const storeWorktree = useWorktreeStore((state) => state.current);

	const token = useAuthStore((state) => state.token);

	// Sync URL worktree to store, redirect if sessionId becomes invalid
	const prevWorktreeRef = useRef(urlWorktree);
	useEffect(() => {
		const prevWorktree = prevWorktreeRef.current;
		prevWorktreeRef.current = urlWorktree;

		if (urlWorktree !== storeWorktree) {
			worktreeActions.setCurrent(urlWorktree);
		}

		// Redirect to home when worktree changes (sessionId is worktree-specific)
		if (prevWorktree !== urlWorktree && routeSessionId) {
			navigate(
				buildNavigation(
					{ type: "home", worktree: urlWorktree },
					{ replace: true },
				),
			);
		}
	}, [urlWorktree, storeWorktree, routeSessionId, navigate]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally exclude wsStatus to avoid bypassing retry delay
	useEffect(() => {
		if (token && wsStatus === "disconnected") {
			wsActions.connect(token);
		}
	}, [token]);

	useEffect(() => {
		if (wsStatus === "auth_failed") {
			authActions.logout();
		}
	}, [wsStatus]);

	const {
		worktrees,
		isSuccess: isWorktreesLoaded,
		isGitRepo,
	} = useWorktree({ enabled: hasAuthToken });

	useSettingsSubscription(hasAuthToken);

	// Redirect to main when URL worktree doesn't exist in worktree list
	useEffect(() => {
		if (!isWorktreesLoaded) return;
		if (!urlWorktree) return;
		if (!isGitRepo) return;
		if (worktrees.length === 0) return;

		const exists = worktrees.some((w) => w.name === urlWorktree);
		if (!exists) {
			console.warn(`Worktree "${urlWorktree}" not found, redirecting to main`);
			navigate(
				buildNavigation({ type: "home", worktree: "" }, { replace: true }),
			);
		}
	}, [isWorktreesLoaded, isGitRepo, worktrees, urlWorktree, navigate]);

	const activeDiffFile =
		overlay?.type === "diff"
			? { path: overlay.path, staged: overlay.staged }
			: null;

	const activeFilePath = overlay?.type === "file" ? overlay.path : null;
	const activeCommitHash = overlay?.type === "commit" ? overlay.hash : null;

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
			// When overlay is active, preserve it and only update session query param
			const navResult = overlay
				? overlayToNavigation(overlay, urlWorktree, redirectSessionId)
				: buildNavigation({
						type: "session",
						worktree: urlWorktree,
						sessionId: redirectSessionId,
					});
			navigate({ ...navResult, replace: true });
		}
	}, [redirectSessionId, navigate, urlWorktree, overlay]);

	useEffect(() => {
		if (needsNewSession && !isCreatingSession.current) {
			isCreatingSession.current = true;
			createSession()
				.then((newSession) => {
					navigate(
						buildNavigation(
							{
								type: "session",
								worktree: urlWorktree,
								sessionId: newSession.id,
							},
							{ replace: true },
						),
					);
				})
				.finally(() => {
					isCreatingSession.current = false;
				});
		}
	}, [needsNewSession, createSession, navigate, urlWorktree]);

	const handleTokenSubmit = (token: string) => {
		authActions.login(token);
	};

	const handleOpenSidebar = useCallback(() => {
		setSidebarOpen(true);
	}, []);

	const handleSelectSession = useCallback(
		(id: string) => {
			navigate(
				buildNavigation({
					type: "session",
					worktree: urlWorktree,
					sessionId: id,
				}),
			);
			setSidebarOpen(false);
		},
		[navigate, urlWorktree],
	);

	const handleCreateSession = useCallback(async () => {
		const newSession = await createSession();
		setSidebarOpen(false);
		navigate(
			buildNavigation({
				type: "session",
				worktree: urlWorktree,
				sessionId: newSession.id,
			}),
		);
	}, [createSession, navigate, urlWorktree]);

	const handleDeleteSession = useCallback(
		async (id: string) => {
			const isCurrentSession = id === currentSessionId;
			const remaining = sessions.filter((s) => s.id !== id);

			await deleteSession(id);

			if (isCurrentSession && remaining.length > 0) {
				navigate(
					buildNavigation(
						{
							type: "session",
							worktree: urlWorktree,
							sessionId: remaining[0].id,
						},
						{ replace: true },
					),
				);
			}
		},
		[currentSessionId, sessions, deleteSession, navigate, urlWorktree],
	);

	const handleSelectDiffFile = useCallback(
		(path: string, staged: boolean) => {
			navigate(
				overlayToNavigation(
					{ type: "diff", path, staged },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleSelectFile = useCallback(
		(path: string) => {
			navigate(
				overlayToNavigation(
					{ type: "file", path },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleSelectCommit = useCallback(
		(hash: string) => {
			navigate(
				overlayToNavigation(
					{ type: "commit", hash },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleCloseOverlay = useCallback(() => {
		if (currentSessionId) {
			navigate(
				buildNavigation({
					type: "session",
					worktree: urlWorktree,
					sessionId: currentSessionId,
				}),
			);
		} else {
			navigate(buildNavigation({ type: "home", worktree: urlWorktree }));
		}
	}, [navigate, urlWorktree, currentSessionId]);

	const handleOpenSettings = useCallback(() => {
		navigate(
			overlayToNavigation({ type: "settings" }, urlWorktree, currentSessionId),
		);
	}, [navigate, urlWorktree, currentSessionId]);

	const handleOpenWorkList = useCallback(() => {
		setSidebarOpen(false);
		navigate(
			overlayToNavigation({ type: "work-list" }, urlWorktree, currentSessionId),
		);
	}, [navigate, urlWorktree, currentSessionId]);

	const handleNavigateToSession = useCallback(
		(sessionId: string) => {
			navigate(
				buildNavigation({
					type: "session",
					worktree: urlWorktree,
					sessionId,
				}),
			);
		},
		[navigate, urlWorktree],
	);

	if (!hasAuthToken) {
		return <TokenInput onSubmit={handleTokenSubmit} />;
	}

	if (!currentSessionId || !currentSession) {
		if (wsStatus === "error") {
			return (
				<div
					className="flex h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary"
					role="alert"
				>
					<div className="text-th-text-muted">Unable to connect to server</div>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="rounded bg-th-accent px-4 py-2 text-sm text-white hover:opacity-90"
					>
						Retry
					</button>
				</div>
			);
		}

		return (
			// biome-ignore lint/a11y/useSemanticElements: loading indicator is not a form output
			<div
				className="flex h-dvh items-center justify-center bg-th-bg-primary"
				role="status"
				aria-label="Loading"
			>
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
				onSelectCommit={handleSelectCommit}
				activeCommitHash={activeCommitHash}
				onSelectFile={handleSelectFile}
				activeFilePath={activeFilePath}
				onOpenWorkList={handleOpenWorkList}
				isDesktop={isDesktop}
			/>
			<ChatPanel
				sessionId={currentSessionId}
				sessionTitle={currentSession.title}
				onUpdateTitle={(title) => updateTitle(currentSessionId, title)}
				onOpenSidebar={handleOpenSidebar}
				onOpenSettings={handleOpenSettings}
				overlay={overlay}
				onCloseOverlay={handleCloseOverlay}
				onNavigateToSession={handleNavigateToSession}
			/>
		</div>
	);
}

export default AppShell;
