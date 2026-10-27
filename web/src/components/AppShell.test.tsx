import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
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
// reported as well: whether the header gets a sidebar button is decided here,
// not in the header (see MainContainer's Props) — and so is which sidebar it
// opens, which names the button.
// The work-list wiring is reported too: which segment the shell hands down, and
// the three navigations that read it back (switch segment, open a work, come
// back out of one). They are the shell's, not the list's. So are the Git
// workspace's: the segment it is handed, and the two navigations it asks for.
vi.mock("./Chat", () => ({
	ChatPanel: ({
		sessionId,
		isSessionResolved,
		onOpenSidebar,
		sidebarKind,
		sidebarToggleRef,
		workSegment,
		onSelectWorkSegment,
		onOpenWorkDetail,
		onOpenWorkList,
		onNavigateToSession,
		onOpenScheduleList,
		onOpenScheduleDetail,
		onSelectGitSegment,
		onCloseGitFile,
		onCloseOverlay,
		overlay,
		view,
	}: {
		sessionId: string;
		isSessionResolved: boolean;
		onOpenSidebar?: () => void;
		sidebarKind?: "drawer" | "column";
		sidebarToggleRef?: React.Ref<HTMLButtonElement>;
		workSegment?: string;
		onSelectWorkSegment?: (segment: "current" | "closed") => void;
		onOpenWorkDetail?: (workId: string) => void;
		onOpenWorkList?: () => void;
		onNavigateToSession?: (sessionId: string, worktree: string) => void;
		onOpenScheduleList?: () => void;
		onOpenScheduleDetail?: (scheduleId: string) => void;
		onSelectGitSegment?: (segment: "changes" | "history" | "branches") => void;
		onCloseGitFile?: (path: string, worktree: string) => void;
		onCloseOverlay?: () => void;
		overlay?: { type: string; scheduleId?: string; segment?: string } | null;
		view?: { worktree: string; exists: boolean } | null;
	}) => (
		<div
			data-testid="chat-panel"
			data-resolved={String(isSessionResolved)}
			data-can-open-sidebar={String(Boolean(onOpenSidebar))}
			data-work-segment={workSegment}
			data-overlay={overlay?.type}
			data-schedule-id={overlay?.scheduleId}
			data-git-segment={overlay?.type === "git" ? overlay.segment : undefined}
			// Absent rather than empty when there is no view: "" is a worktree here.
			data-view-worktree={view?.worktree}
			data-view-exists={view ? String(view.exists) : undefined}
		>
			{sessionId}
			{onOpenSidebar && (
				<button type="button" ref={sidebarToggleRef} onClick={onOpenSidebar}>
					{sidebarKind === "column" ? "Expand sidebar" : "Open sidebar"}
				</button>
			)}
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
			<button type="button" onClick={() => onOpenScheduleDetail?.("s1")}>
				Open s1
			</button>
			<button type="button" onClick={() => onOpenScheduleList?.()}>
				Back to schedules
			</button>
			<button type="button" onClick={() => onSelectGitSegment?.("changes")}>
				Git Changes
			</button>
			<button type="button" onClick={() => onSelectGitSegment?.("history")}>
				Git History
			</button>
			<button type="button" onClick={() => onCloseGitFile?.("src/a.ts", "A")}>
				Discarded src/a.ts
			</button>
			<button type="button" onClick={() => onCloseGitFile?.("src/a.ts", "B")}>
				Discarded src/a.ts in B
			</button>
			<button type="button" onClick={() => onCloseOverlay?.()}>
				Leave the page
			</button>
		</div>
	),
}));

// The sidebar reports the row it would highlight, and fires onCreateSession for
// the manual "+" path. Its rows can also belong to another worktree now, so it
// offers one of each: what opening and deleting them mean is the shell's.
// Whether it is open is the shell's too, so it reports that and offers a close.
vi.mock("./Session", () => ({
	SessionSidebar: ({
		isOpen,
		onClose,
		currentSessionId,
		onCreateSession,
		onSelectSession,
		onDeleteSession,
		onOpenWorkList,
		onOpenScheduleList,
		isExpanded,
	}: {
		isOpen: boolean;
		onClose: () => void;
		currentSessionId: string | null;
		onCreateSession: () => void;
		onSelectSession: (id: string, worktree: string | null) => void;
		onDeleteSession: (id: string, worktree: string | null) => void;
		onOpenWorkList: () => void;
		onOpenScheduleList: () => void;
		isExpanded: boolean;
	}) => (
		<div
			data-testid="session-sidebar"
			data-current-session={currentSessionId}
			data-expanded={String(isExpanded)}
			data-open={String(isOpen)}
		>
			<button type="button" onClick={onClose}>
				{isExpanded ? "Collapse sidebar" : "Close sidebar"}
			</button>
			<button type="button" onClick={onCreateSession}>
				New Chat
			</button>
			<button type="button" onClick={onOpenWorkList}>
				Stories
			</button>
			<button type="button" onClick={onOpenScheduleList}>
				Schedules
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
const repo = vi.hoisted(() => ({ isGitRepo: true as boolean | null }));
vi.mock("../hooks/useWorktree", () => ({
	useWorktree: () => ({
		worktrees: [
			{ name: "A", branch: "A", is_main: false },
			{ name: "B", branch: "B", is_main: false },
		],
		isSuccess: true,
		isGitRepo: repo.isGitRepo,
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
vi.mock("../hooks/useScheduleSubscription", () => ({
	useScheduleSubscription: () => {},
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
// simply not handed an opener while the sidebar is already on screen.
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
		localStorage.clear();
	});

	afterEach(() => {
		viewport.listeners.clear();
		// The collapsed flag would otherwise reach the describes below.
		localStorage.clear();
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: originalMatchMedia,
		});
	});

	// Every width query answers the same way, so the stub describes one viewport
	// rather than an impossible one that is both expanded and compact. Only the
	// three members useMediaQuery actually reads are modelled; anything else
	// would imply coverage that is not here.
	const viewport = { expanded: false, listeners: new Set<() => void>() };
	const setExpanded = (expanded: boolean) => {
		viewport.expanded = expanded;
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: (query: string) => ({
				get matches() {
					return viewport.expanded && query.includes("min-width");
				},
				addEventListener: (_: string, listener: () => void) =>
					viewport.listeners.add(listener),
				removeEventListener: (_: string, listener: () => void) =>
					viewport.listeners.delete(listener),
			}),
		});
	};
	// A window dragged across the breakpoint, after the shell has mounted.
	const resize = (expanded: boolean) =>
		act(() => {
			viewport.expanded = expanded;
			for (const listener of viewport.listeners) listener();
		});
	const sidebarOpen = () =>
		screen.getByTestId("session-sidebar").getAttribute("data-open");

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

	// The drawer is modal: what it is drawn over cannot be reached while it is
	// up, and closing it puts the user back on the button that opened it.
	it("takes the page behind out of reach while the drawer is open", async () => {
		const user = userEvent.setup();
		setExpanded(false);
		renderAppShell("/w/A/s/a1");

		const opener = await screen.findByRole("button", { name: "Open sidebar" });
		expect(screen.getByTestId("chat-panel").closest("[inert]")).toBeNull();

		await user.click(opener);

		expect(screen.getByTestId("session-sidebar")).toHaveAttribute(
			"data-open",
			"true",
		);
		expect(screen.getByTestId("chat-panel").closest("[inert]")).not.toBeNull();
		expect(screen.getByTestId("session-sidebar").closest("[inert]")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Close sidebar" }));

		expect(screen.getByTestId("chat-panel").closest("[inert]")).toBeNull();
		expect(opener).toHaveFocus();
	});

	// The column sits beside the chat, not over it.
	it("leaves the page alone in the expanded tier", async () => {
		setExpanded(true);
		renderAppShell("/w/A/s/a1");

		await waitFor(() => {
			expect(screen.getByTestId("chat-panel")).toHaveTextContent("a1");
		});

		expect(document.querySelector("[inert]")).toBeNull();
	});

	// The column collapses and comes back in place, and the choice outlives a
	// reload — but only the column's: the drawer is never part of it.
	it("collapses the column into the header's button and back", async () => {
		const user = userEvent.setup();
		setExpanded(true);
		renderAppShell("/w/A/s/a1");

		await user.click(
			await screen.findByRole("button", { name: "Collapse sidebar" }),
		);

		expect(sidebarOpen()).toBe("false");
		expect(localStorage.getItem("pockode:sidebar-collapsed")).toBe("true");
		// The pressed button is gone with the column; focus lands on the one
		// that brings it back rather than falling to the body.
		const expand = screen.getByRole("button", { name: "Expand sidebar" });
		expect(expand).toHaveFocus();

		await user.click(expand);

		expect(sidebarOpen()).toBe("true");
		expect(localStorage.getItem("pockode:sidebar-collapsed")).toBe("false");
		expect(
			screen.queryByRole("button", { name: "Expand sidebar" }),
		).not.toBeInTheDocument();
	});

	it("opens collapsed when the column was left collapsed", async () => {
		localStorage.setItem("pockode:sidebar-collapsed", "true");
		setExpanded(true);
		renderAppShell("/w/A/s/a1");

		expect(
			await screen.findByRole("button", { name: "Expand sidebar" }),
		).not.toHaveFocus();
		expect(sidebarOpen()).toBe("false");
	});

	it("keeps the column's state apart from the drawer's across tiers", async () => {
		const user = userEvent.setup();
		localStorage.setItem("pockode:sidebar-collapsed", "true");
		setExpanded(true);
		renderAppShell("/w/A/s/a1");
		await screen.findByRole("button", { name: "Expand sidebar" });

		resize(false);
		// Collapsed on a wide screen is not open on a narrow one, nor shut away.
		expect(sidebarOpen()).toBe("false");
		await user.click(screen.getByRole("button", { name: "Open sidebar" }));
		expect(sidebarOpen()).toBe("true");
		await user.click(screen.getByRole("button", { name: "Close sidebar" }));
		await user.click(screen.getByRole("button", { name: "Open sidebar" }));

		// Grown back with the drawer open: the column is as the user left it,
		// and the drawer did not survive the trip — narrowing again finds it
		// shut rather than reopening it unasked.
		resize(true);
		expect(sidebarOpen()).toBe("false");
		expect(localStorage.getItem("pockode:sidebar-collapsed")).toBe("true");
		resize(false);
		expect(sidebarOpen()).toBe("false");
		expect(document.querySelector("[inert]")).toBeNull();
	});
});

// A git view has nothing to show outside a repository — reached by a saved URL,
// by history, or left open when `.git` went away. It is replaced, not shown as
// an error, and only once the server has actually said so.
describe("AppShell git views outside a git repository", () => {
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

	afterEach(() => {
		repo.isGitRepo = true;
	});

	it("returns to the session the view was opened over", async () => {
		repo.isGitRepo = false;
		const router = renderAppShell("/w/A/unstaged/src/a.ts?session=a1");

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
		);
	});

	it("leaves the view alone while the answer is not in", async () => {
		repo.isGitRepo = null;
		const router = renderAppShell("/w/A/unstaged/src/a.ts?session=a1");

		await screen.findByTestId("chat-panel");
		expect(router.state.location.pathname).toBe("/w/A/unstaged/src/a.ts");
	});
});

// The Git workspace follows the project list's rules (docs/project-ui.md §5):
// the segment is in the URL, `changes` is the absence of the parameter, Back
// walks the segments, and the last Back returns to the chat. Worktree A, for
// the same session adoption as below.
describe("AppShell Git workspace", () => {
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

	afterEach(() => {
		repo.isGitRepo = true;
	});

	const panel = () => screen.getByTestId("chat-panel");
	const search = (router: ReturnType<typeof renderAppShell>) =>
		router.state.location.search as { segment?: string; session?: string };

	it("opens the segment the URL names, and keeps it through the session redirect", async () => {
		const router = renderAppShell("/w/A/git?segment=history");

		await waitFor(() => expect(search(router).session).toBe("a1"));
		expect(router.state.location.pathname).toBe("/w/A/git");
		expect(search(router).segment).toBe("history");
		expect(panel()).toHaveAttribute("data-git-segment", "history");
	});

	it("leaves a history entry per segment, and the last Back returns to the chat", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");
		await waitFor(() => expect(panel()).toHaveTextContent("a1"));

		await user.click(screen.getByRole("button", { name: "Git Changes" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/git"),
		);
		// Changes is the absence of the parameter, never `segment=changes`.
		expect(search(router)).toEqual({ session: "a1" });

		await user.click(screen.getByRole("button", { name: "Git History" }));
		await waitFor(() => expect(search(router).segment).toBe("history"));

		router.history.back();
		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-git-segment", "changes"),
		);

		router.history.back();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
		);
	});

	// Otherwise a second press of the lit segment would cost the reader one more
	// Back to get out.
	it("adds no entry for the segment already on screen", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");
		await waitFor(() => expect(panel()).toHaveTextContent("a1"));

		await user.click(screen.getByRole("button", { name: "Git Changes" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/git"),
		);
		await user.click(screen.getByRole("button", { name: "Git Changes" }));

		router.history.back();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
		);
	});

	// A diff's way back is a step to its list, not `history.back()`: a diff
	// reached from a link has no list behind it in the history.
	it("goes back from a diff opened by link to the list it belongs to", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/unstaged/src/a.ts?session=a1");
		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-overlay", "diff"),
		);

		await user.click(screen.getByRole("button", { name: "Git Changes" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/git"),
		);
		expect(search(router)).toEqual({ session: "a1" });
	});

	it("replaces a discarded diff with the list, so Back skips it", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");
		await waitFor(() => expect(panel()).toHaveTextContent("a1"));
		await act(() =>
			router.navigate({
				to: "/w/$worktree/unstaged/$",
				params: { worktree: "A", _splat: "src/a.ts" },
				search: { session: "a1" },
			}),
		);

		await user.click(
			screen.getByRole("button", { name: "Discarded src/a.ts" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/git"),
		);

		router.history.back();
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
		);
	});

	// The discard answers after the press; a reader who has moved to another
	// diff meanwhile keeps the page they moved to.
	it("leaves alone a page the reader moved to before the discard answered", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/unstaged/src/b.ts?session=a1");
		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-overlay", "diff"),
		);

		await user.click(
			screen.getByRole("button", { name: "Discarded src/a.ts" }),
		);
		await expectPageKept(user, router, "/w/A/unstaged/src/b.ts");
	});

	// The same path in another worktree is another file: a discard in B that
	// answers after the reader switched to A must not take A's diff away — nor
	// the reader back to B.
	it("leaves alone the same path's diff in another worktree", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/unstaged/src/a.ts?session=a1");
		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-overlay", "diff"),
		);

		await user.click(
			screen.getByRole("button", { name: "Discarded src/a.ts in B" }),
		);
		await expectPageKept(user, router, "/w/A/unstaged/src/a.ts");
	});

	/**
	 * A replace would not show yet if checked straight after the press, so a
	 * step is pushed after it and Back walked: it lands on the page that was
	 * there before the press only if nothing replaced it.
	 */
	async function expectPageKept(
		user: ReturnType<typeof userEvent.setup>,
		router: ReturnType<typeof renderAppShell>,
		pathname: string,
	) {
		await user.click(screen.getByRole("button", { name: "Git History" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/git"),
		);
		router.history.back();
		await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
	}

	it("leaves for the chat it was opened over", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/git?segment=branches&session=a1");
		await waitFor(() =>
			expect(panel()).toHaveAttribute("data-git-segment", "branches"),
		);

		await user.click(screen.getByRole("button", { name: "Leave the page" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
		);
	});

	it("is replaced by the chat outside a repository", async () => {
		repo.isGitRepo = false;
		const router = renderAppShell("/w/A/git?segment=history&session=a1");

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/s/a1"),
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
	it("lands on Current from the Stories button even while the archive is open", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/works?segment=closed");

		await waitFor(() => expect(segmentOnScreen()).toBe("closed"));
		await user.click(screen.getByRole("button", { name: "Stories" }));

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

describe("AppShell schedule routes", () => {
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
		// Main has no sessions elsewhere in this file, which makes the shell
		// create one; the routes under test have nothing to do with that.
		worktreeSessions[""] = [session("m1")];
		return () => {
			delete worktreeSessions[""];
		};
	});

	const overlayOnScreen = () =>
		screen.getByTestId("chat-panel").getAttribute("data-overlay");
	const scheduleOnScreen = () =>
		screen.getByTestId("chat-panel").getAttribute("data-schedule-id");

	it.each([
		["/schedules", "schedule-list", null],
		["/w/A/schedules", "schedule-list", null],
		["/schedules/s1", "schedule-detail", "s1"],
		["/w/A/schedules/s1", "schedule-detail", "s1"],
	])("resolves %s", async (path, overlay, scheduleId) => {
		const router = renderAppShell(path);

		await waitFor(() => expect(overlayOnScreen()).toBe(overlay));
		expect(scheduleOnScreen()).toBe(scheduleId);
		expect(router.state.location.pathname).toBe(path);
	});

	it("goes from the sidebar to the list, into a schedule and back, in the worktree it is in", async () => {
		const user = userEvent.setup();
		const router = renderAppShell("/w/A/s/a1");

		await waitFor(() => expect(scheduleOnScreen()).toBeNull());
		await user.click(screen.getByRole("button", { name: "Schedules" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/schedules"),
		);

		await user.click(screen.getByRole("button", { name: "Open s1" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/schedules/s1"),
		);
		expect(scheduleOnScreen()).toBe("s1");

		await user.click(screen.getByRole("button", { name: "Back to schedules" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/w/A/schedules"),
		);
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
