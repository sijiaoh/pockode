import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../lib/authStore";
import { useSessionStore } from "../lib/sessionStore";
import { useWorkStore } from "../lib/workStore";
import {
	resetWorktreeStore,
	useWorktreeStore,
	worktreeActions,
} from "../lib/worktreeStore";
import { wsActions } from "../lib/wsStore";
import { routeTree } from "../router";
import { makeSessionListItem } from "../test/sessionFixtures";
import type { SessionListChangedNotification } from "../types/message";

// ChatPanel is the attach point; render the session it was handed and whether
// that session has resolved, which together are what the panel needs to show
// the destination rather than the session left behind. `onOpenSidebar` is
// reported as well: whether the header gets a hamburger is decided here, not in
// the header (see MainContainer's Props).
vi.mock("./Chat", () => ({
	ChatPanel: ({
		sessionId,
		isSessionResolved,
		onOpenSidebar,
	}: {
		sessionId: string;
		isSessionResolved: boolean;
		onOpenSidebar?: () => void;
	}) => (
		<div
			data-testid="chat-panel"
			data-resolved={String(isSessionResolved)}
			data-can-open-sidebar={String(Boolean(onOpenSidebar))}
		>
			{sessionId}
		</div>
	),
}));

// The sidebar reports the row it would highlight, and fires onCreateSession for
// the manual "+" path.
vi.mock("./Session", () => ({
	SessionSidebar: ({
		currentSessionId,
		onCreateSession,
		isExpanded,
	}: {
		currentSessionId: string | null;
		onCreateSession: () => void;
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

const session = (id: string) => makeSessionListItem({ id, title: id });

// Session lists are worktree-scoped. B's target session "x" is intentionally NOT
// first so a redirect leaking across the worktree switch would land on "b1".
const worktreeSessions: Record<string, ReturnType<typeof session>[]> = {
	A: [session("a1")],
	B: [session("b1"), session("x")],
};

const mockSubscribe = vi.fn(
	async (_cb: (p: SessionListChangedNotification) => void) => {
		const wt = worktreeActions.getCurrent();
		return { id: `watch-${wt}`, initial: worktreeSessions[wt] ?? [] };
	},
);
const mockUnsubscribe = vi.fn(async () => {});
const mockListModels = vi.fn(async () => ({ claude: [], codex: [] }));
const mockListEfforts = vi.fn(async () => ({ claude: [], codex: [] }));

const ws = vi.hoisted(() => ({ status: "connected" }));

vi.mock("../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			status: ws.status,
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
				listModels: mockListModels,
				listEfforts: mockListEfforts,
			},
		}),
	wsActions: {
		createSession: vi.fn(),
		disconnect: vi.fn(),
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
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
		useAuthStore.setState({ token: "test-token" });
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
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
		useAuthStore.setState({ token: "test-token" });
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
			initial: [session("m1")],
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
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			// The app default, restored between tests because the task-session
			// filter is what one of them turns on.
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ token: "test-token" });
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
	// task-session filter — on by default — hides exactly those from the sidebar
	// list. Resolving the destination against that filtered list would leave it
	// permanently unresolved and then redirect away from it, for the very links
	// this navigation exists to serve.
	it("opens a task session that the sidebar filter hides", async () => {
		useWorkStore.setState({
			works: [
				{
					id: "w1",
					type: "task",
					title: "a task",
					status: "in_progress",
					session_id: "x",
					created_at: "2024-01-01T00:00:00Z",
					updated_at: "2024-01-01T00:00:00Z",
				},
			],
		});

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
		mockSubscribe.mockImplementationOnce(async (_cb) => {
			await new Promise<void>((resolve) => {
				releaseSubscribe = resolve;
			});
			const wt = worktreeActions.getCurrent();
			return { id: `watch-${wt}`, initial: worktreeSessions[wt] ?? [] };
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
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			showTaskSessions: false,
		});
		useWorkStore.setState({ works: [] });
		useAuthStore.setState({ token: "test-token" });
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
