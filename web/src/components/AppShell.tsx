import { useIsDesktop } from "@pockode/shared";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentRoleSubscription } from "../hooks/useAgentRoleSubscription";
import { useFileDropGuard } from "../hooks/useFileDropGuard";
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
import { ReconnectBanner } from "./ui";

function AppShell() {
	const hasAuthToken = useAuthStore(selectHasAuthToken);
	const wsStatus = useWSStore((state) => state.status);
	const navigate = useNavigate();
	const isDesktop = useIsDesktop();
	const [sidebarOpen, setSidebarOpen] = useState(false);

	// Here rather than in `MainContainer`, which only exists once a session has
	// resolved: the token screen, the loading screen and the "can't reach the
	// server" screen are all screens someone can drop a file on, and every one of
	// them would be replaced by it.
	useFileDropGuard();

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
		createError,
		clearCreateError,
		deleteSession,
		updateTitle,
	} = useSession({ enabled: hasAuthToken, routeSessionId });

	// The destination is known from the URL the moment a switch starts; only its
	// title and history are not. It counts as resolved once it is found in the
	// session list of the worktree the connection is actually bound to —
	// worktreeSwitchInFlight alone is not enough, because the store syncs before
	// the list does. Looked up in the unfiltered list on purpose: a work's chat
	// link points at a task session, which is missing from filteredSessions
	// whenever the task-session filter is on.
	const isSessionResolved =
		!worktreeSwitchInFlight &&
		!isReloading &&
		currentSessionId !== null &&
		currentSession !== undefined;

	// Once the shell has been on screen, keep it there through a switch: falling
	// back to the full-screen "Loading..." would blank the whole app between two
	// sessions. Only the shell is kept — the previous session's content is not,
	// which is what the panel below renders the destination's placeholder for.
	const hasRenderedShell = useRef(false);
	if (isSessionResolved) {
		hasRenderedShell.current = true;
	}

	// filteredSessions/currentSessionId get a fresh identity on every session-store
	// update (new message, state change over WebSocket). Read them from a ref inside
	// handleDeleteSession so its identity stays stable and doesn't defeat the memo on
	// every SessionItem row.
	const deleteSessionCtxRef = useRef({ filteredSessions, currentSessionId });
	deleteSessionCtxRef.current = { filteredSessions, currentSessionId };

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

	// A create that failed in the worktree we left must not be reported against
	// the one we entered, nor keep the effect below from creating a session there.
	// biome-ignore lint/correctness/useExhaustiveDependencies: urlWorktree is what this effect reacts to, not something it reads
	useEffect(() => {
		clearCreateError();
	}, [urlWorktree, clearCreateError]);

	// createError gates this effect because needsNewSession stays true for as long
	// as the worktree has no session: without the gate a failing create re-runs
	// here on every render it causes, hammering the server thousands of times a
	// minute. One attempt, then the error screen hands the retry back to the user.
	useEffect(() => {
		if (worktreeSwitchInFlight) return;
		if (createError) return;
		if (needsNewSession) {
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
				.catch((error) => {
					// Reported through createError below; logged for the console trail.
					console.error("Failed to create session:", error);
				});
		}
	}, [
		worktreeSwitchInFlight,
		needsNewSession,
		createError,
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
		try {
			const newSession = await createSession();
			setSidebarOpen(false);
			navigate(
				buildNavigation({
					type: "session",
					worktree: urlWorktree,
					sessionId: newSession.id,
				}),
			);
		} catch (error) {
			// Reported through createError below; logged for the console trail.
			console.error("Failed to create session:", error);
		}
	}, [createSession, navigate, urlWorktree]);

	// Serves both create paths: clearing the error lets the auto-create effect run
	// again, and createSession deduplicates, so the effect joins the request
	// started here rather than adding a second one.
	const handleRetryCreateSession = useCallback(() => {
		clearCreateError();
		void handleCreateSession();
	}, [clearCreateError, handleCreateSession]);

	const handleDeleteSession = useCallback(
		async (id: string) => {
			const { filteredSessions, currentSessionId } =
				deleteSessionCtxRef.current;
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
		[deleteSession, navigate, urlWorktree],
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

	// The server's own wording is the whole point here: "claude: executable file
	// not found in $PATH" and a dropped connection must not read the same.
	const createErrorMessage = createError?.message || "Unknown error";

	if (!hasAuthToken) {
		return <TokenInput onSubmit={handleTokenSubmit} />;
	}

	const showShell =
		isSessionResolved ||
		(hasRenderedShell.current && inTransition && wsStatus === "connected");

	if (!showShell) {
		// "reconnecting" belongs here only because there is nothing to show yet
		// (the app was opened while the server was unreachable): retries now run for
		// as long as the tab is open, so without this the user would sit on
		// "Loading..." forever with no idea why. Once a session has rendered, the
		// shell stays mounted and a reconnect shows the banner below instead.
		if (wsStatus === "error" || wsStatus === "reconnecting") {
			return (
				<div
					className="flex h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary"
					role="alert"
				>
					<div className="text-th-text-muted">
						Can&apos;t reach the server &mdash; retrying&hellip;
					</div>
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

		// Checked after the transport screen on purpose: a create that failed
		// because the socket dropped is a symptom, and "retrying..." is both the
		// truer explanation and the one that resolves itself.
		if (createError) {
			return (
				<div
					className="flex h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary px-6 text-center"
					role="alert"
				>
					<div className="text-th-text-muted">
						Couldn&apos;t start a new session
					</div>
					<div className="max-w-md break-words text-sm text-th-error">
						{createErrorMessage}
					</div>
					<button
						type="button"
						onClick={handleRetryCreateSession}
						className="rounded bg-th-accent px-4 py-2 text-sm text-th-accent-text hover:opacity-90"
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
			{createError && (
				// Wraps rather than truncates: the reason is server text of any
				// length, and the narrow screens this app targets are exactly where
				// truncation would cut it off.
				<div
					className="flex flex-wrap items-center justify-center gap-3 bg-th-error/20 px-4 py-1 text-sm text-th-error"
					role="alert"
				>
					<span className="break-words">
						Couldn&apos;t start a new session: {createErrorMessage}
					</span>
					<button
						type="button"
						onClick={handleRetryCreateSession}
						className="shrink-0 underline hover:opacity-80"
					>
						Retry
					</button>
					<button
						type="button"
						onClick={clearCreateError}
						className="shrink-0 underline hover:opacity-80"
					>
						Dismiss
					</button>
				</div>
			)}
			<ReconnectBanner />
			<div className="flex min-h-0 flex-1">
				<SessionSidebar
					isOpen={sidebarOpen}
					onClose={() => setSidebarOpen(false)}
					currentSessionId={currentSessionId}
					onSelectSession={handleSelectSession}
					onCreateSession={handleCreateSession}
					onDeleteSession={handleDeleteSession}
					onSelectDiffFile={handleSelectDiffFile}
					onCloseDiffFile={handleCloseOverlay}
					activeDiffFile={activeDiffFile}
					onSelectCommit={handleSelectCommit}
					activeCommitHash={activeCommitHash}
					onSelectFile={handleSelectFile}
					activeFilePath={activeFilePath}
					onOpenWorkList={handleOpenWorkList}
					onOpenAgentRoleList={handleOpenAgentRoleList}
					isDesktop={isDesktop}
					isSwitchingWorktree={worktreeSwitchInFlight}
				/>
				<ChatPanel
					sessionId={currentSessionId ?? ""}
					sessionTitle={currentSession?.title ?? ""}
					isSessionResolved={isSessionResolved}
					onUpdateTitle={(title) => {
						if (currentSessionId) updateTitle(currentSessionId, title);
					}}
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
