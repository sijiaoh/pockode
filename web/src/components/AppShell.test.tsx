import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../lib/authStore";
import { useSessionStore } from "../lib/sessionStore";
import {
	resetWorktreeStore,
	useWorktreeStore,
	worktreeActions,
} from "../lib/worktreeStore";
import { routeTree } from "../router";
import type { SessionListChangedNotification } from "../types/message";

// ChatPanel is the attach point; render only the active session id so the test
// can assert the final landing session from the user's perspective.
vi.mock("./Chat", () => ({
	ChatPanel: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="chat-panel">{sessionId}</div>
	),
}));

vi.mock("./Session", () => ({
	SessionSidebar: () => <div data-testid="session-sidebar" />,
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

const session = (id: string) => ({
	id,
	title: id,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	mode: "default" as const,
	agent_type: "codex",
	state: "ended" as const,
	needs_input: false,
	unread: false,
});

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

vi.mock("../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			status: "connected",
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
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

describe("AppShell cross-worktree navigation", () => {
	let unsubscribeSwitch: (() => void) | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		resetWorktreeStore();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
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
});
