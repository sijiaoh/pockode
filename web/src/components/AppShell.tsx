import { useIsExpanded } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { invalidateSessionViewQueries } from "../hooks/sessionViewQueries";
import { useAgentOptions } from "../hooks/useAgentOptions";
import { useAgentRoleSubscription } from "../hooks/useAgentRoleSubscription";
import { useFileDropGuard } from "../hooks/useFileDropGuard";
import { useRouteState } from "../hooks/useRouteState";
import { useSession } from "../hooks/useSession";
import { useSessionDetailSubscription } from "../hooks/useSessionDetailSubscription";
import { useSettingsSubscription } from "../hooks/useSettingsSubscription";
import { useWorkSubscription } from "../hooks/useWorkSubscription";
import { useWorktree } from "../hooks/useWorktree";
import { authActions, selectCredential, useAuthStore } from "../lib/authStore";
import { buildNavigation, overlayToNavigation } from "../lib/navigation";
import { filterShowing, isVisibleUnder } from "../lib/sessionFilter";
import { useSessionStore } from "../lib/sessionStore";
import { resolveSessionView } from "../lib/sessionView";
import { useWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import { useWSStore, wsActions } from "../lib/wsStore";
import type { WorkSegment } from "../types/overlay";
import PasswordInput from "./Auth/PasswordInput";
import { ChatPanel } from "./Chat";
import { SessionSidebar } from "./Session";
import { ReconnectBanner } from "./ui";

function AppShell() {
	const wsStatus = useWSStore((state) => state.status);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const isExpanded = useIsExpanded();
	const [sidebarOpen, setSidebarOpen] = useState(false);

	// Here rather than in `MainContainer`, which only exists once a session has
	// resolved: the password screen, the loading screen and the "can't reach the
	// server" screen are all screens someone can drop a file on, and every one of
	// them would be replaced by it.
	useFileDropGuard();

	const {
		overlay,
		sessionId: routeSessionId,
		worktree: urlWorktree,
		viewWorktree,
	} = useRouteState();
	const storeWorktree = useWorktreeStore((state) => state.current);

	// A fresh object per call, hence useShallow; see selectCredential.
	const credential = useAuthStore(useShallow(selectCredential));
	const isAuthenticated = credential !== null;
	// Why the last attempt was refused. Local because it is about one visit to
	// the password screen, not about the credential the store keeps.
	const [authError, setAuthError] = useState<string | null>(null);

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
		if (credential && wsStatus === "disconnected") {
			wsActions.connect(credential);
		}
	}, [credential]);

	// The other half of the pair above, and the reason authStore can stay a leaf
	// module: logging out — from here, from a 401 anywhere in the app, from the
	// Settings button — is the credential going away, and the socket has to go
	// with it.
	useEffect(() => {
		if (!credential) {
			wsActions.disconnect();
		}
	}, [credential]);

	useEffect(() => {
		if (wsStatus === "auth_failed") {
			setAuthError("Authentication failed — check your password.");
			authActions.logout();
		}
	}, [wsStatus]);

	const {
		worktrees,
		isSuccess: isWorktreesLoaded,
		isGitRepo,
	} = useWorktree({ enabled: isAuthenticated });

	// Which worktree the open session's data is read from, when that is not the
	// worktree the user is standing in. Recomputed every render rather than
	// captured: the source worktree can be deleted — or recreated under the same
	// name — while its session is on screen, and both strips say so.
	const sessionView = useMemo(
		() => resolveSessionView(viewWorktree ?? undefined, urlWorktree, worktrees),
		[viewWorktree, urlWorktree, worktrees],
	);
	// Until the worktree list has landed, "deleted" cannot be told from "not
	// asked yet", and the strips would claim the wrong one for a frame.
	const isSessionViewReady = !isGitRepo || isWorktreesLoaded;

	useSettingsSubscription(isAuthenticated);
	useWorkSubscription(isAuthenticated);
	useAgentRoleSubscription(isAuthenticated);
	useAgentOptions(isAuthenticated);

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
	// Coarse on purpose: whether the editor is on screen, not whether it has
	// unsaved text. The dirty flag belongs to the editor, and lifting it here to
	// gate one menu row would run a state line across the whole shell.
	const activeFileEdit = overlay?.type === "file" && overlay.edit === true;
	const activeCommitHash = overlay?.type === "commit" ? overlay.hash : null;

	const {
		sessions,
		currentSessionId,
		currentSession,
		isRouteSessionResolved,
		isSuccess: isSessionListLoaded,
		isReloading,
		redirectSessionId,
		needsNewSession,
		createSession,
		createError,
		clearCreateError,
		deleteSession,
		updateTitle,
	} = useSession({
		enabled: isAuthenticated,
		// A viewed session belongs to another worktree, so this worktree's list
		// has no row for it and no subscription can resolve it. Withholding the id
		// is what keeps the recovery below from reading its absence as "deleted"
		// and redirecting off the screen the user just opened; the transcript is
		// fed from `sessionView` instead.
		routeSessionId: sessionView ? null : routeSessionId,
	});

	// Whether the server is in a position to answer about this session at all:
	// the connection is bound to the worktree the URL names, and its session
	// list has landed. worktreeSwitchInFlight alone is not enough, because the
	// store syncs before the list does — and until then the server would be
	// answering for the worktree being left, where a refusal would say nothing
	// about the session.
	const canLoadSession =
		!worktreeSwitchInFlight &&
		!isReloading &&
		isSessionListLoaded &&
		currentSessionId !== null;

	// The destination is known from the URL the moment a switch starts; only its
	// title and history are not. It counts as resolved once the session is known
	// to exist — from its row in the list, or, for a session the task-session
	// filter hides, from its own detail subscription. The list alone can no
	// longer say: a work's Chat link points at a session that filter removes, so
	// "not in the list" and "not there" are the same absence to it.
	const isSessionResolved = canLoadSession && isRouteSessionResolved;

	// Held here rather than in ChatPanel, which is where it used to live: it is
	// what tells the shell whether the open session exists, and the shell does
	// not mount the panel until it knows. Leaving it down there deadlocked every
	// session the list has no row for — the panel that would resolve it was
	// behind the resolution.
	useSessionDetailSubscription(currentSessionId ?? "", canLoadSession);

	// Once the shell has been on screen, keep it there through a switch: falling
	// back to the full-screen "Loading..." would blank the whole app between two
	// sessions. Only the shell is kept — the previous session's content is not,
	// which is what the panel below renders the destination's placeholder for.
	//
	// A viewed session resolves through its own read instead: this worktree's
	// session list will never have a row for it, so `isSessionResolved` cannot
	// speak for it. What it waits for is the worktree list, which is what says
	// whether the source worktree is still there — and therefore what the two
	// read-only strips say.
	const isScreenResolved = sessionView ? isSessionViewReady : isSessionResolved;
	const hasRenderedShell = useRef(false);
	if (isScreenResolved) {
		hasRenderedShell.current = true;
	}

	// sessions/currentSessionId get a fresh identity on every session-store
	// update (new message, state change over WebSocket). Read them from a ref inside
	// handleDeleteSession so its identity stays stable and doesn't defeat the memo on
	// every SessionItem row.
	const deleteSessionCtxRef = useRef({
		sessions,
		currentSessionId,
		viewedSessionId: null as string | null,
	});
	deleteSessionCtxRef.current = {
		sessions,
		currentSessionId,
		// The session the read-only screen is showing, which has no row in this
		// worktree's list and so is not `currentSessionId`.
		viewedSessionId: sessionView ? routeSessionId : null,
	};

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
		if (sessionView) return;
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
		sessionView,
		redirectSessionId,
		navigate,
		urlWorktree,
		overlay,
	]);

	// Opening a session the sidebar filter has no row for moves the filter to
	// where that session is — once, at the moment of navigation.
	//
	// Without it, arriving at a deleted worktree's session from a work leaves a
	// sidebar whose every row belongs to somewhere else and none of which is
	// selected. It is deliberately not kept in step afterwards: the filter is the
	// user's from then on, even if they point it somewhere the open session has
	// no row in.
	const navigatedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!routeSessionId) return;
		// The view, not the raw parameter: `?from=` naming the worktree in the
		// path is an ordinary session (SESSION_VIEW_PARAM), and its rows are this
		// worktree's.
		const origin = sessionView ? sessionView.worktree : null;
		const arrival = `${urlWorktree}\u0000${routeSessionId}\u0000${origin ?? ""}\u0000${origin === null ? "" : "v"}`;
		if (navigatedRef.current === arrival) return;
		navigatedRef.current = arrival;

		const { worktreeFilter, setWorktreeFilter } = useSessionStore.getState();
		if (!isVisibleUnder(worktreeFilter, origin)) {
			setWorktreeFilter(filterShowing(origin));
		}
	}, [routeSessionId, urlWorktree, sessionView]);

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
		// Nothing is missing: the screen is showing another worktree's session, and
		// creating one here would navigate away from it.
		if (sessionView) return;
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
		sessionView,
		needsNewSession,
		createError,
		createSession,
		navigate,
		urlWorktree,
	]);

	const handlePasswordSubmit = (password: string) => {
		setAuthError(null);
		authActions.login(password);
	};

	const handleOpenSidebar = useCallback(() => {
		setSidebarOpen(true);
	}, []);

	// Growing into the expanded tier turns the drawer into a persistent column,
	// which has no open/closed state of its own. Without this the flag survives
	// the transition, so rotating a mini pad to landscape and back would reopen
	// a drawer the user never asked for.
	useEffect(() => {
		if (isExpanded) setSidebarOpen(false);
	}, [isExpanded]);

	/**
	 * Where a session that lives in `worktree` opens.
	 *
	 * In its own worktree while that worktree is still there — an ordinary,
	 * writable session, and the app switches to it. Once it is not, the session
	 * data is all that is left, so it opens where the user already stands and is
	 * read from there (`viewWorktree`). Both entrances to another worktree's
	 * session — a row of the sidebar, a work's chat link — decide it here, so
	 * they cannot decide it differently.
	 */
	const sessionTarget = useCallback(
		(sessionId: string, worktree: string) => {
			const isGone =
				isWorktreesLoaded &&
				worktree !== "" &&
				!worktrees.some((w) => w.name === worktree);
			return isGone
				? ({
						type: "session" as const,
						worktree: urlWorktree,
						sessionId,
						viewWorktree: worktree,
					} as const)
				: ({ type: "session" as const, worktree, sessionId } as const);
		},
		[isWorktreesLoaded, worktrees, urlWorktree],
	);

	const handleSelectSession = useCallback(
		(id: string, worktree: string | null) => {
			navigate(
				buildNavigation(
					worktree === null
						? { type: "session", worktree: urlWorktree, sessionId: id }
						: sessionTarget(id, worktree),
				),
			);
			setSidebarOpen(false);
		},
		[navigate, urlWorktree, sessionTarget],
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
		async (id: string, worktree: string | null) => {
			const { sessions, currentSessionId, viewedSessionId } =
				deleteSessionCtxRef.current;

			// A row of another worktree — or of one that is gone — is deleted by
			// name rather than through the connection's own worktree, and nothing
			// is pushed afterwards, so the lists it was in are re-read here.
			if (worktree !== null) {
				await wsActions.sessionViewDelete(worktree, id);
				invalidateSessionViewQueries(queryClient);
				if (viewedSessionId === id) {
					// The screen is reading the conversation that just went. There is
					// no neighbour to fall back to — this worktree's list is not the
					// list the row came from.
					navigate(
						buildNavigation(
							{ type: "home", worktree: urlWorktree },
							{ replace: true },
						),
					);
				}
				return;
			}

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
		[deleteSession, navigate, urlWorktree, queryClient],
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

	/**
	 * Follows the open file to a new path after it is renamed under the overlay.
	 *
	 * Apart from `replace`, this is `handleSelectFile` — but it must not be that
	 * function, because the sidebar wraps its own copy in "and close the drawer",
	 * which is the right answer to a tap on a row and the wrong one to a rename.
	 * `replace` because the overlay is being corrected rather than opened: a
	 * pushed entry would send Back to a path that no longer resolves.
	 */
	const handleRepointFile = useCallback(
		(path: string) => {
			navigate(
				overlayToNavigation(
					{ type: "file", path },
					urlWorktree,
					currentSessionId,
					{ replace: true },
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

	// The segment the screen is currently standing in, for the navigations that
	// continue a visit rather than start one. Read off the URL because that is
	// now the only place it lives (docs/project-ui.md §5).
	const workSegment =
		overlay?.type === "work-list" || overlay?.type === "work-detail"
			? overlay.segment
			: "current";

	// The Project entry button. Always `Current`: the button is an entrance, and
	// an entrance that lands somewhere different depending on what the user last
	// tapped is an entrance nobody can predict.
	const handleOpenWorkList = useCallback(() => {
		setSidebarOpen(false);
		navigate(
			overlayToNavigation(
				{ type: "work-list", segment: "current" },
				urlWorktree,
				currentSessionId,
			),
		);
	}, [navigate, urlWorktree, currentSessionId]);

	// Back out of a work detail, which is a return rather than an entrance: it
	// goes to the segment the reader opened the work from.
	const handleBackToWorkList = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "work-list", segment: workSegment },
				urlWorktree,
				currentSessionId,
			),
		);
	}, [navigate, urlWorktree, currentSessionId, workSegment]);

	const handleSelectWorkSegment = useCallback(
		(segment: WorkSegment) => {
			navigate(
				overlayToNavigation(
					{ type: "work-list", segment },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId],
	);

	const handleOpenWorkDetail = useCallback(
		(workId: string) => {
			navigate(
				overlayToNavigation(
					{ type: "work-detail", workId, segment: workSegment },
					urlWorktree,
					currentSessionId,
				),
			);
		},
		[navigate, urlWorktree, currentSessionId, workSegment],
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
		//
		// Unless that worktree is gone. Its sessions are not — deleting a worktree
		// deliberately leaves them — so the conversation is opened where the user
		// already is and read from there, rather than the URL bouncing back to
		// main as a worktree that does not exist used to make it do.
		(sessionId: string, worktree: string) => {
			navigate(buildNavigation(sessionTarget(sessionId, worktree)));
		},
		[navigate, sessionTarget],
	);

	/**
	 * Opens another session of the transcript on screen — the parent a fork came
	 * from, or a fork just made. It stays in whatever view the screen is in: the
	 * other session lives in the same worktree as this one, viewed or not.
	 *
	 * Not `handleSelectSession`, which is the sidebar's: those rows are this
	 * worktree's own sessions and must open as ordinary, writable ones.
	 */
	const handleSelectChatSession = useCallback(
		(id: string) => {
			setSidebarOpen(false);
			navigate(
				buildNavigation({
					type: "session",
					worktree: urlWorktree,
					sessionId: id,
					...(sessionView ? { viewWorktree: sessionView.worktree } : {}),
				}),
			);
		},
		[navigate, urlWorktree, sessionView],
	);

	/** Leaves the viewed session for the real one, in the worktree that owns it. */
	const handleOpenSessionThere = useCallback(() => {
		if (!sessionView || !routeSessionId) return;
		navigate(
			buildNavigation({
				type: "session",
				worktree: sessionView.worktree,
				sessionId: routeSessionId,
			}),
		);
	}, [navigate, sessionView, routeSessionId]);

	// The server's own wording is the whole point here: "claude: executable file
	// not found in $PATH" and a dropped connection must not read the same.
	const createErrorMessage = createError?.message || "Unknown error";

	if (!isAuthenticated) {
		return <PasswordInput onSubmit={handlePasswordSubmit} error={authError} />;
	}

	const showShell =
		isScreenResolved ||
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
					className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary"
					role="alert"
				>
					<div className="text-th-text-muted">
						Can&apos;t reach the server &mdash; retrying&hellip;
					</div>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="rounded bg-th-accent px-4 py-2 text-sm text-th-accent-text hover:opacity-90"
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
					className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary px-6 text-center"
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
				className="flex min-h-dvh items-center justify-center bg-th-bg-primary"
				role="status"
				aria-label="Loading"
			>
				<div className="text-th-text-muted">Loading...</div>
			</div>
		);
	}

	return (
		// Clips because it is exactly the viewport: a descendant that grew the
		// document would make the page itself the scroll container an inner
		// list's overscroll chains into
		// (docs/responsive-ui.md § Who owns the scroll boundary).
		<div className="flex h-dvh flex-col overflow-hidden">
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
						className="inline-flex min-h-9 shrink-0 items-center rounded px-2 underline pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:opacity-80"
					>
						Retry
					</button>
					<button
						type="button"
						onClick={clearCreateError}
						className="inline-flex min-h-9 shrink-0 items-center rounded px-2 underline pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:opacity-80"
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
					// The session on screen, whichever list it came from. A viewed
					// one has no row in this worktree's list and so is not
					// `currentSessionId` — but the filter has moved to the list it
					// does have a row in, and that row is the one to highlight.
					currentSessionId={sessionView ? routeSessionId : currentSessionId}
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
					activeFileEdit={activeFileEdit}
					onRepointFile={handleRepointFile}
					onCloseFile={handleCloseOverlay}
					onOpenWorkList={handleOpenWorkList}
					onOpenAgentRoleList={handleOpenAgentRoleList}
					isExpanded={isExpanded}
					isSwitchingWorktree={worktreeSwitchInFlight}
				/>
				<ChatPanel
					view={sessionView}
					onOpenSessionThere={handleOpenSessionThere}
					sessionId={
						sessionView ? (routeSessionId ?? "") : (currentSessionId ?? "")
					}
					sessionTitle={currentSession?.title ?? ""}
					isSessionResolved={isSessionResolved}
					onUpdateTitle={(title) => {
						if (currentSessionId) updateTitle(currentSessionId, title);
					}}
					onOpenSidebar={isExpanded ? undefined : handleOpenSidebar}
					onOpenSettings={handleOpenSettings}
					overlay={overlay}
					onCloseOverlay={handleCloseOverlay}
					onNavigateToSession={handleNavigateToSession}
					onSelectSession={handleSelectChatSession}
					onOpenWorkDetail={handleOpenWorkDetail}
					onOpenFile={handleSelectFile}
					onOpenWorkList={handleBackToWorkList}
					workSegment={workSegment}
					onSelectWorkSegment={handleSelectWorkSegment}
					onOpenAgentRoleList={handleOpenAgentRoleList}
					onOpenAgentRoleDetail={handleOpenAgentRoleDetail}
				/>
			</div>
		</div>
	);
}

export default AppShell;
