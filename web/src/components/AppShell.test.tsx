import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../lib/authStore";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { useSessionStore } from "../lib/sessionStore";
import { useWorkStore } from "../lib/workStore";
import {
	resetWorktreeStore,
	useWorktreeStore,
	worktreeActions,
} from "../lib/worktreeStore";
import { wsActions } from "../lib/wsStore";
import { routeTree } from "../router";
import {
	makeSessionDetail,
	makeSessionListItem,
} from "../test/sessionFixtures";
import type { SessionListChangedNotification } from "../types/message";

// ChatPanel is the attach point; render the session it was handed and whether
// that session has resolved, which together are what the panel needs to show
// the destination rather than the session left behind. `onOpenSidebar` is
// reported as well: whether the header gets a hamburger is decided here, not in
// the header (see MainContainer's Props).
// The work-list wiring is reported too: which segment the shell hands down, and
// the three navigations that read it back (switch segment, open a work, come
// back out of one). They are the shell's, not the list's.
vi.mock("./Chat", () => ({
	ChatPanel: ({
		sessionId,
		isSessionResolved,
		onOpenSidebar,
		workSegment,
		onSelectWorkSegment,
		onOpenWorkDetail,
		onOpenWorkList,
		onNavigateToSession,
		view,
	}: {
		sessionId: string;
		isSessionResolved: boolean;
		onOpenSidebar?: () => void;
		workSegment?: string;
		onSelectWorkSegment?: (segment: "current" | "closed") => void;
		onOpenWorkDetail?: (workId: string) => void;
		onOpenWorkList?: () => void;
		onNavigateToSession?: (sessionId: string, worktree: string) => void;
		view?: { worktree: string; exists: boolean } | null;
	}) => (
		<div
			data-testid="chat-panel"
			data-resolved={String(isSessionResolved)}
			data-can-open-sidebar={String(Boolean(onOpenSidebar))}
			data-work-segment={workSegment}
			// Absent rather than empty when there is no view: "" is a worktree here.
			data-view-worktree={view?.worktree}
			data-view-exists={view ? String(view.exists) : undefined}
		>
			{sessionId}
			<button
				type="button"
				onClick={() => onNavigateToSession?.("gone-session", "old-fix")}
			>
				Open a deleted worktree's session
			</button>
			<button type="button" onClick={() => onNavigateToSession?.("b1", "B")}>
				Open a live worktree's session
			</button>
			<button type="button" onClick={() => onSelectWorkSegment?.("closed")}>
				Show Closed
			</button>
			<button type="button" onClick={() => onOpenWorkDetail?.("w1")}>
				Open w1
			</button>
			<button type="button" onClick={() => onOpenWorkList?.()}>
				Back to list
			</button>
		</div>
	),
}));

// The sidebar reports the row it would highlight, and fires onCreateSession for
// the manual "+" path. Its rows can also belong to another worktree now, so it
// offers one of each: what opening and deleting them mean is the shell's.
vi.mock("./Session", () => ({
	SessionSidebar: ({
		currentSessionId,
		onCreateSession,
		onSelectSession,
		onDeleteSession,
		onOpenWorkList,
		isExpanded,
	}: {
		currentSessionId: string | null;
		onCreateSession: () => void;
		onSelectSession: (id: string, worktree: string | null) => void;
		onDeleteSession: (id: string, worktree: string | null) => void;
		onOpenWorkList: () => void;
		isExpanded: boolean;
	}) => (
		<div
			data-testid="session-sidebar"
			data-current-session={currentSessionId}
			data-expanded={String(isExpanded)}
		>
			<button type="button" onClick={onCreateSession}>
				New Chat
			</button>
			<button type="button" onClick={onOpenWorkList}>
				Project
			</button>
			<button
				type="button"
				onClick={() => onSelectSession("gone-session", "old-fix")}
			>
				Open a deleted worktree's row
			</button>
			<button type="button" onClick={() => onSelectSession("b1", "B")}>
				Open a live worktree's row
			</button>
			<button
				type="button"
				onClick={() => onDeleteSession("gone-session", "old-fix")}
			>
				Delete a deleted worktree's row
			</button>
		</div>
	),
}));

// The worktree existence guard would otherwise redirect unknown worktrees to
// main; report both worktrees as present so navigation is not interfered with.
vi.mock("../hooks/useWorktree", () => ({
	useWorktree: () => ({
		worktrees: [
			{ name: "A", branch: "A", is_main: false },
			{ name: "B", branch: "B", is_main: false },
		],
		isSuccess: true,
		isGitRepo: true,
	}),
}));

vi.mock("../hooks/useSettingsSubscription", () => ({
	useSettingsSubscription: () => {},
}));
vi.mock("../hooks/useWorkSubscription", () => ({
	useWorkSubscription: () => {},
}));
vi.mock("../hooks/useAgentRoleSubscription", () => ({
	useAgentRoleSubscription: () => {},
}));

const session = (id: string, workId?: string) =>
	makeSessionListItem({ id, title: id, work_id: workId });

// Session lists are worktree-scoped. B's target session "x" is intentionally NOT
// first so a redirect leaking across the worktree switch would land on "b1"; it
// belongs to a work item, which is what the sidebar filter hides.
const worktreeSessions: Record<string, ReturnType<typeof session>[]> = {
	A: [session("a1")],
	B: [session("b1"), session("x", "w1")],
};

// The filter is the server's, so the stub applies it rather than handing back
// the whole list for the client to narrow (see useSessionSubscription).
const mockSubscribe = vi.fn(
	async (
		_cb: (p: SessionListChangedNotification) => void,
		excludeWorkSessions?: boolean,
	) => {
		const wt = worktreeActions.getCurrent();
		const all = worktreeSessions[wt] ?? [];
		return {
			id: `watch-${wt}`,
			initial: {
				sessions: excludeWorkSessions ? all.filter((s) => !s.work_id) : all,
				has_unread: false,
			},
		};
	},
);
const mockUnsubscribe = vi.fn(async () => {});

// `session.detail.subscribe` is what tells the shell whether the open session
// exists — the filtered list above cannot. It answers from the worktree's whole
// list, and refuses a session that is not in it, which is what the server does.
const mockDetailSubscribe = vi.fn(async (sessionId: string, _cb: unknown) => {
	const wt = worktreeActions.getCurrent();
	if (!(worktreeSessions[wt] ?? []).some((s) => s.id === sessionId)) {
		// Refused with the server's own code: only a reply the server wrote is
		// evidence the session is gone, so anything else here would stop the shell
		// redirecting and make this case untestable.
		throw new JSONRPCErrorException(
			"session not found",
			JSONRPCErrorCode.InvalidParams,
		);
	}
	return {
		id: `detail-${sessionId}`,
		initial: { session: makeSessionDetail({ id: sessionId }) },
	};
});
const mockDetailUnsubscribe = vi.fn(async () => {});
const mockListModels = vi.fn(async () => ({ claude: [], codex: [] }));
const mockListEfforts = vi.fn(async () => ({ claude: [], codex: [] }));

const ws = vi.hoisted(() => ({ status: "connected" }));

vi.mock("../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/wsStore")>()),
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			status: ws.status,
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
				sessionDetailSubscribe: mockDetailSubscribe,
				sessionDetailUnsubscribe: mockDetailUnsubscribe,
				listModels: mockListModels,
				listEfforts: mockListEfforts,
			},
		}),
	wsActions: {
		createSession: vi.fn(),
		disconnect: vi.fn(),
		sessionViewDelete: vi.fn(async () => {}),
	},
}));

function renderAppShell(initialPath: string) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
	render(
		<QueryClientProvider client={queryClient}>
			{/* biome-ignore lint/suspicious/noExplicitAny: test router uses a memory history */}
			<RouterProvider router={router as any} />
		</QueryClientProvider>,
	);
	return router;
}

// Opening the app while the server is unreachable leaves nothing to render, and
// the store now retries for as long as the tab is open rather than settling
// into a terminal error. Without a reconnecting branch here the user would be
// left staring at "Loading..." with no idea the server is the problem.
describe("AppShell when the server is unreachable", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
		useAuthStore.setState({ sessionToken: "test-session-token" });
		ws.status = "reconnecting";
		return () => {
			ws.status = "connected";
		};
	});

	it("explains the outage instead of loading forever", async () => {
		renderAppShell("/");

		expect(await screen.findByRole("alert")).toHaveTextContent(/retrying/i);
	});
});

// An empty worktree makes AppShell create a session on its own. That create used
// to run without a catch, so a failure re-armed the effect on the very render it
// caused: thousands of session.create calls a minute behind a permanent
// "Loading...", with nothing on screen saying why.
describe("AppShell when the automatic session create fails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
		useAuthStore.setState({ sessionToken: "test-session-token" });
	});

	it("attempts once, shows the reason, and creates on retry", async () => {
		vi.mocked(wsActions.createSession)
			.mockRejectedValueOnce(new Error("no agent configured"))
			.mockResolvedValueOnce(session("fresh"));
		const user = userEvent.setup();

		renderAppShell("/");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"no agent configured",
		);
		expect(wsActions.createSession).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole("button", { name: /retry/i }));

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("fresh");
		});
		expect(wsActions.createSession).toHaveBeenCalledTimes(2);
	});

	// The manual "+" fails the same way but must not take the screen: the session
	// the user already has stays open, with the reason reported next to it.
	it("reports a failed manual create without losing the open session", async () => {
		mockSubscribe.mockImplementationOnce(async () => ({
			id: "watch-main",
			initial: { sessions: [session("m1")], has_unread: false },
		}));
		vi.mocked(wsActions.createSession).mockRejectedValueOnce(
			new Error("worktree is dirty"),
		);
		const user = userEvent.setup();

		renderAppShell("/");

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("m1");
		});

		await user.click(screen.getByRole("button", { name: "New Chat" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"worktree is dirty",
		);
		expect(screen.getByTestId("chat-panel")).toHaveTextContent("m1");
	});
});

describe("AppShell cross-worktree navigation", () => {
	let unsubscribeSwitch: (() => void) | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			// The app default, restored between tests because the task-session
			// filter is what one of them turns on.
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ sessionToken: "test-session-token" });
		// Mimic wsStore's worktree switch handling: once the switch RPC completes,
		// the session list resubscribes against the new worktree.
		unsubscribeSwitch = worktreeActions.onWorktreeChange(() => {
			worktreeActions.notifyWorktreeSwitchEnd();
		});
	});

	afterEach(() => {
		unsubscribeSwitch?.();
		unsubscribeSwitch = null;
	});

	it("lands on the target session when navigating to another worktree", async () => {
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => {
			expect(useWorktreeStore.getState().current).toBe("A");
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("a1");
		});

		await router.navigate({
			to: "/w/$worktree/s/$sessionId",
			params: { worktree: "B", sessionId: "x" },
		});

		// The switch settles on the requested session X, not B's first session,
		// proving the redirect race no longer hijacks the URL mid-switch.
		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("x");
		});
		expect(router.state.location.pathname).toBe("/w/B/s/x");
	});

	// The chat link on a work points at that work's own task session, and the
	// task-session filter — on by default — hides exactly those from the list
	// the server sends. Resolving the destination against that list would leave
	// it permanently unresolved and then redirect away from it, for the very
	// links this navigation exists to serve.
	it("opens a task session that the sidebar filter hides", async () => {
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("a1");
		});

		await router.navigate({
			to: "/w/$worktree/s/$sessionId",
			params: { worktree: "B", sessionId: "x" },
		});

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveAttribute(
				"data-resolved",
				"true",
			);
		});
		expect(screen.getByTestId("chat-panel")).toHaveTextContent("x");
		expect(router.state.location.pathname).toBe("/w/B/s/x");
	});

	// The session being left is another conversation entirely. Showing it while
	// the destination resolves reads as having opened the wrong chat, and — until
	// the panel was handed the destination id — let a message be sent into it.
	it("shows the destination, not the session left behind, during a worktree switch", async () => {
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("a1");
		});

		// Delay the new worktree's session list so the switch stays mid-flight and
		// we can observe what the shell renders during the transition.
		let releaseSubscribe: () => void = () => {};
		mockSubscribe.mockImplementationOnce(async (_cb, excludeWorkSessions) => {
			await new Promise<void>((resolve) => {
				releaseSubscribe = resolve;
			});
			const wt = worktreeActions.getCurrent();
			const all = worktreeSessions[wt] ?? [];
			return {
				id: `watch-${wt}`,
				initial: {
					sessions: excludeWorkSessions ? all.filter((s) => !s.work_id) : all,
					has_unread: false,
				},
			};
		});

		await router.navigate({
			to: "/w/$worktree/s/$sessionId",
			params: { worktree: "B", sessionId: "x" },
		});

		await waitFor(() => {
			expect(useWorktreeStore.getState().current).toBe("B");
		});

		// Mid-switch: no full-screen "Loading..." blank, the panel already belongs
		// to X and says X hasn't resolved yet, and the sidebar highlight has left
		// a1 rather than lingering on it.
		expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
		const panel = screen.getByTestId("chat-panel");
		expect(panel).toHaveTextContent("x");
		expect(panel).toHaveAttribute("data-resolved", "false");
		expect(screen.getByTestId("session-sidebar")).toHaveAttribute(
			"data-current-session",
			"x",
		);

		releaseSubscribe();

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveAttribute(
				"data-resolved",
				"true",
			);
		});
		expect(screen.getByTestId("chat-panel")).toHaveTextContent("x");
	});
});

// #7 in docs/responsive-ui.md: the hamburger used to be hidden by `md:hidden`
// while the sidebar chose its form from a hook. Two copies of one decision, in
// two components — edit either and you get a sidebar with no switch, or a
// switch with no sidebar. The tier is now read once, here, and the header is
// simply not handed an opener when there is no drawer to open.
describe("AppShell sidebar form and its switch", () => {
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ sessionToken: "test-session-token" });
		ws.status = "connected";
	});

	afterEach(() => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: originalMatchMedia,
		});
	});

	// Every width query answers the same way, so the stub describes one viewport
	// rather than an impossible one that is both expanded and compact. Only the
	// three members useMediaQuery actually reads are modelled; anything else
	// would imply coverage that is not here.
	const setExpanded = (expanded: boolean) =>
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: (query: string) => ({
				matches: expanded && query.includes("min-width"),
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});

	it.each([
		["a drawer", false],
		["a persistent column", true],
	])("gives the header an opener only while the sidebar is %s", async (_form, expanded) => {
		setExpanded(expanded);
		renderAppShell("/w/A/s/a1");

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("a1");
		});

		expect(screen.getByTestId("session-sidebar")).toHaveAttribute(
			"data-expanded",
			String(expanded),
		);
		expect(screen.getByTestId("chat-panel")).toHaveAttribute(
			"data-can-open-sidebar",
			String(!expanded),
		);
	});
});

// docs/project-ui.md §5: the segment is a place in the URL, so Back walks the
// user's own choices and a link to the archive opens the archive. The shell
// owns every one of these navigations.
//
// Worktree A, because the shell adopts that worktree's existing session rather
// than creating one — and the adoption is itself worth having under the test:
// it rewrites the URL, and the segment has to survive that rewrite.
describe("AppShell work list segment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ sessionToken: "test-session-token" });
	});

	const segmentOnScreen = () =>
		screen.getByTestId("chat-panel").getAttribute("data-work-segment");

	const segmentInUrl = (router: ReturnType<typeof renderAppShell>) =>
		(router.state.location.search as { segment?: string }).segment;

	it("opens the archive when the URL says so, and keeps it through the session redirect", async () => {
		const router = renderAppShell("/w/A/works?segment=closed");

		await waitFor(() => expect(segmentOnScreen()).toBe("closed"));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/works"),
		);
		expect(segmentInUrl(router)).toBe("closed");
	});

	it("leaves a history entry per switch, so Back returns the previous choice", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/works");

		await waitFor(() => expect(segmentOnScreen()).toBe("current"));
		await user.click(screen.getByRole("button", { name: "Show Closed" }));

		await waitFor(() => expect(segmentOnScreen()).toBe("closed"));
		expect(segmentInUrl(router)).toBe("closed");

		router.history.back();

		await waitFor(() => expect(segmentOnScreen()).toBe("current"));
		// `Current` is the absence of the parameter, not `segment=current`.
		expect(segmentInUrl(router)).toBeUndefined();
	});

	// The entrance is an entrance: it goes to `Current` whatever the reader was
	// last looking at, which is the whole reason nothing remembers the choice.
	it("lands on Current from the Project button even while the archive is open", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/works?segment=closed");

		await waitFor(() => expect(segmentOnScreen()).toBe("closed"));
		await user.click(screen.getByRole("button", { name: "Project" }));

		await waitFor(() => expect(segmentOnScreen()).toBe("current"));
		expect(router.state.location.pathname).toBe("/w/A/works");
		expect(segmentInUrl(router)).toBeUndefined();
	});

	// The list unmounts on the way into a work, so without carrying the segment
	// the trip out would hand an archive reader back to `Current`.
	it("returns to the segment a work was opened from", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/works?segment=closed");

		await waitFor(() => expect(segmentOnScreen()).toBe("closed"));
		await user.click(screen.getByRole("button", { name: "Open w1" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/works/w1"),
		);
		expect(segmentInUrl(router)).toBe("closed");

		await user.click(screen.getByRole("button", { name: "Back to list" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/works"),
		);
		expect(segmentInUrl(router)).toBe("closed");
	});
});

// A worktree's sessions outlive the worktree. The URL keeps saying where the
// user is standing — Files and Git stay with it — and one query parameter says
// where the transcript is read from.
describe("AppShell reading a session of another worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ sessionToken: "test-session-token" });
	});

	const panel = () => screen.getByTestId("chat-panel");

	// Before this, a work in a deleted worktree could not be opened at all: the
	// URL named a worktree that was gone and the shell bounced it to main.
	it("opens a work's session in place when its worktree is gone", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await user.click(
			screen.getByRole("button", { name: "Open a deleted worktree's session" }),
		);

		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-view-worktree", "old-fix"),
		);
		// Still standing in A: only the transcript comes from elsewhere.
		expect(router.state.location.pathname).toBe("/w/A/s/gone-session");
		expect(router.state.location.search).toEqual({ from: "old-fix" });
		expect(panel()).toHaveAttribute("data-view-exists", "false");
		expect(panel()).toHaveTextContent("gone-session");
	});

	// The other half of the same handler, unchanged: a worktree that is still
	// there is switched to, because the session can be talked to there.
	it("switches worktree for a work whose worktree still exists", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await user.click(
			screen.getByRole("button", { name: "Open a live worktree's session" }),
		);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/B/s/b1"),
		);
		expect(panel()).not.toHaveAttribute("data-view-worktree");
	});

	// The list of this worktree has no row for the session named, and used to
	// read that absence as "deleted" and redirect to its own first session.
	it("keeps the URL instead of recovering to a session of its own", async () => {
		const router = renderAppShell("/w/A/s/gone-session?from=old-fix");

		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-view-worktree", "old-fix"),
		);
		expect(router.state.location.pathname).toBe("/w/A/s/gone-session");
		expect(router.state.location.search).toEqual({ from: "old-fix" });
		expect(panel()).toHaveTextContent("gone-session");
		// Files and Git follow the worktree the connection is bound to, which the
		// parameter must not move.
		expect(useWorktreeStore.getState().current).toBe("A");
	});

	// "" is the main worktree on the wire, so it has to survive the round trip
	// through the URL as a value rather than collapsing into an absent parameter.
	it("reads the main worktree's copy when the parameter is empty", async () => {
		renderAppShell("/w/A/s/m1?from=");

		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-view-worktree", ""),
		);
		expect(useWorktreeStore.getState().current).toBe("A");
	});

	// Otherwise "Open there" would flash a read-only screen on its way out of one.
	it("is an ordinary session when the source is the worktree in the path", async () => {
		renderAppShell("/w/A/s/a1?from=A");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		expect(panel()).not.toHaveAttribute("data-view-worktree");
		expect(panel()).toHaveAttribute("data-resolved", "true");
	});

	// A row of a worktree that is gone: there is nowhere to switch to, so it
	// opens where the user is standing and is read from there.
	it("opens a sidebar row of a deleted worktree without moving the user", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await user.click(
			screen.getByRole("button", { name: "Open a deleted worktree's row" }),
		);

		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-view-worktree", "old-fix"),
		);
		expect(router.state.location.pathname).toBe("/w/A/s/gone-session");
		expect(useWorktreeStore.getState().current).toBe("A");
	});

	// A row of a worktree that is still there opens as an ordinary session,
	// because it can still be talked to — reading a running session out of a
	// screen that cannot follow it is the case this avoids.
	it("switches worktree for a sidebar row that still has one", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await user.click(
			screen.getByRole("button", { name: "Open a live worktree's row" }),
		);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/B/s/b1"),
		);
		expect(panel()).not.toHaveAttribute("data-view-worktree");
	});

	// The delete button on such a row stays live: the data outlives the
	// worktree, so it needs a way out. It cannot go through the connection's own
	// worktree, which is not the one the row belongs to.
	it("deletes a row of another worktree by naming that worktree", async () => {
		const user = userEvent.setup();
		renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await user.click(
			screen.getByRole("button", { name: "Delete a deleted worktree's row" }),
		);

		await waitFor(() =>
			expect(wsActions.sessionViewDelete).toHaveBeenCalledWith(
				"old-fix",
				"gone-session",
			),
		);
	});

	// Deleting the conversation on screen leaves nothing to read, and this
	// worktree's list holds no neighbour to fall back to — so it goes home, and
	// the shell's own recovery takes it from there.
	it("leaves the screen when the session it is reading is deleted", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/gone-session?from=old-fix");

		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-view-worktree", "old-fix"),
		);
		await user.click(
			screen.getByRole("button", { name: "Delete a deleted worktree's row" }),
		);

		await waitFor(() =>
			expect(router.state.location.pathname).not.toContain("gone-session"),
		);
		expect(router.state.location.search).toEqual({});
		expect(panel()).not.toHaveAttribute("data-view-worktree");
	});

	// The other half of moving the filter: the list it moved to has a row for
	// the session on screen, and that row is the one highlighted.
	it("highlights the viewed session in the sidebar", async () => {
		renderAppShell("/w/A/s/gone-session?from=old-fix");

		await waitFor(() =>
			expect(screen.getByTestId("session-sidebar")).toHaveAttribute(
				"data-current-session",
				"gone-session",
			),
		);
	});

	// Otherwise the sidebar opens on a list where nothing is selected, and the
	// conversation on screen appears in none of it.
	it("moves the sidebar filter to the worktree the session is read from", async () => {
		renderAppShell("/w/A/s/gone-session?from=old-fix");

		await waitFor(() =>
			expect(useSessionStore.getState().worktreeFilter).toEqual({
				kind: "worktree",
				worktree: "old-fix",
			}),
		);
	});

	// The same rule the other way: an ordinary session has no row in a filter
	// pointing somewhere else, so opening one brings the filter back.
	it("brings the filter back when an ordinary session is opened", async () => {
		useSessionStore.setState({
			worktreeFilter: { kind: "worktree", worktree: "old-fix" },
		});

		renderAppShell("/w/A/s/a1");

		await waitFor(() =>
			expect(useSessionStore.getState().worktreeFilter).toEqual({
				kind: "current",
			}),
		);
	});
});
