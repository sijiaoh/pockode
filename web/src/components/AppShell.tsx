import { useIsDesktop } from "@pockode/shared";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentRoleSubscription } from "../hooks/useAgentRoleSubscription";
import { useRouteState } from "../hooks/useRouteState";
import { useSession } from "../hooks/useSession";
import { useSettingsSubscription } from "../hooks/useSettingsSubscription";
import { useWorkSubscription } from "../hooks/useWorkSubscription";
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

	// Sync URL worktree to store (URL is source of truth). This drives the
	// WebSocket rebind and session-list resubscribe via worktree switch listeners.
	//
	// We intentionally do NOT redirect to home on worktree change: a work's chat
	// links to that work's own worktree, so cross-worktree session URLs are valid
	// and must open. A genuinely stale session id (not in the new worktree) is
	// still recovered by useSession (redirectSessionId / needsNewSession), guarded
	// by worktreeSwitchInFlight so recovery only runs against the new worktree's
	// session list (see below).
	useEffect(() => {
		if (urlWorktree !== storeWorktree) {
			worktreeActions.setCurrent(urlWorktree);
		}
	}, [urlWorktree, storeWorktree]);

	// A worktree switch is in flight when the URL already points at the new
	// worktree but the store hasn't caught up (the effect above runs after this
	// render, and the session list only resubscribes when the switch completes).
	// During this transition the session store still holds the previous worktree's
	// list, so redirectSessionId / needsNewSession are computed against stale data.
	// Running the recovery effects here would hijack the URL away from the target
	// session (e.g. a cross-worktree chat link). Skip recovery until the switch
	// lands; once the new worktree's list is ready and the target session resolves,
	// no redirect is needed.
	const worktreeSwitchInFlight = urlWorktree !== storeWorktree;

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
	useWorkSubscription(hasAuthToken);
	useAgentRoleSubscription(hasAuthToken);

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
		filteredSessions,
		currentSessionId,
		currentSession,
		isReloading,
		redirectSessionId,
		needsNewSession,
		createSession,
		deleteSession,
		updateTitle,
	} = useSession({ enabled: hasAuthToken, routeSessionId });

	// Keep the last resolved session shell so a worktree switch (or the redirect
	// to another session that follows it) can reuse it as a placeholder instead
	// of dropping to a full-screen "Loading..." blank.
	const lastRenderedSession = useRef<{
		id: string;
		session: (typeof filteredSessions)[number];
	} | null>(null);
	if (currentSessionId && currentSession) {
		lastRenderedSession.current = {
			id: currentSessionId,
			session: currentSession,
		};
	}

	// A switch resolves through several transient renders (worktree store sync →
	// session list reload → redirect/create). Treat all of them as "in transition"
	// so the shell stays mounted until the new session lands.
	const inTransition =
		isReloading ||
		worktreeSwitchInFlight ||
		redirectSessionId !== null ||
		needsNewSession;

	useEffect(() => {
		if (worktreeSwitchInFlight) return;
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
	}, [
		worktreeSwitchInFlight,
		redirectSessionId,
		navigate,
		urlWorktree,
		overlay,
	]);

	useEffect(() => {
		if (worktreeSwitchInFlight) return;
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
	}, [
		worktreeSwitchInFlight,
		needsNewSession,
		createSession,
		navigate,
		urlWorktree,
	]);

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
			const remaining = filteredSessions.filter((s) => s.id !== id);

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
		[currentSessionId, filteredSessions, deleteSession, navigate, urlWorktree],
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

	const handleOpenWorkDetail = useCallback(
		(workId: string) => {
			navigate(
				overlayToNavigation(
					{ type: "work-detail", workId },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleOpenAgentRoleList = useCallback(() => {
		setSidebarOpen(false);
		navigate(
			overlayToNavigation(
				{ type: "agent-role-list" },
				urlWorktree,
				currentSessionId,
			),
		);
	}, [navigate, urlWorktree, currentSessionId]);

	const handleOpenAgentRoleDetail = useCallback(
		(roleId: string) => {
			navigate(
				overlayToNavigation(
					{ type: "agent-role-detail", roleId },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleNavigateToSession = useCallback(
		// Use the work's own worktree, not the current URL worktree: sessions are
		// worktree-scoped, so opening a work in another worktree must switch to it.
		(sessionId: string, worktree: string) => {
			navigate(
				buildNavigation({
					type: "session",
					worktree,
					sessionId,
				}),
			);
		},
		[navigate],
	);

	if (!hasAuthToken) {
		return <TokenInput onSubmit={handleTokenSubmit} />;
	}

	// While a session is resolving (initial load or a worktree switch), reuse the
	// previously rendered session as a placeholder so the shell doesn't blank.
	const displaySession =
		currentSessionId && currentSession
			? { id: currentSessionId, session: currentSession }
			: inTransition && wsStatus === "connected"
				? lastRenderedSession.current
				: null;

	if (!displaySession) {
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
		<div className="flex h-dvh flex-col">
			{wsStatus === "reconnecting" && (
				// biome-ignore lint/a11y/useSemanticElements: status banner is not a form output
				<div
					className="flex items-center justify-center gap-2 bg-th-accent/20 px-4 py-1 text-sm text-th-text-muted"
					role="status"
				>
					<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-th-accent" />
					Reconnecting...
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				<SessionSidebar
					isOpen={sidebarOpen}
					onClose={() => setSidebarOpen(false)}
					currentSessionId={displaySession.id}
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
					onOpenAgentRoleList={handleOpenAgentRoleList}
					isDesktop={isDesktop}
				/>
				<ChatPanel
					sessionId={displaySession.id}
					sessionTitle={displaySession.session.title}
					onUpdateTitle={(title) => updateTitle(displaySession.id, title)}
					onOpenSidebar={handleOpenSidebar}
					onOpenSettings={handleOpenSettings}
					overlay={overlay}
					onCloseOverlay={handleCloseOverlay}
					onNavigateToSession={handleNavigateToSession}
					onOpenWorkDetail={handleOpenWorkDetail}
					onOpenWorkList={handleOpenWorkList}
					onOpenAgentRoleList={handleOpenAgentRoleList}
					onOpenAgentRoleDetail={handleOpenAgentRoleDetail}
				/>
			</div>
		</div>
	);
}

export default AppShell;
