import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewWorktree } from "../../lib/rpc/sessionView";
import { CURRENT_WORKTREE_FILTER } from "../../lib/sessionFilter";
import { useSessionStore } from "../../lib/sessionStore";
import { makeSessionListItem } from "../../test/sessionFixtures";
import type { SessionListItem, SessionListPage } from "../../types/message";
import { SidebarContext } from "../Layout/SidebarContext";
import SessionsTab from "./SessionsTab";

const mockRefresh = vi.fn();
const sessionState = {
	sessions: [] as SessionListItem[],
	isLoading: false,
	isReloading: false,
};

vi.mock("../../hooks/useSession", () => ({
	useSession: () => ({ ...sessionState, refresh: mockRefresh }),
}));

const sessionViewWorktrees = vi.fn<() => Promise<SessionViewWorktree[]>>();
const sessionViewList =
	vi.fn<
		(
			worktree: string,
			excludeWorkSessions: boolean,
			cursor?: string,
		) => Promise<SessionListPage>
	>();

const wsState = {
	status: "connected",
	actions: { sessionViewWorktrees, sessionViewList },
};
vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
	wsActions: { listWorktrees: vi.fn() },
}));

// The worktree list is the other half of a row's origin: it says whether the
// worktree is still there, and what to call the main one.
vi.mock("../../hooks/useWorktreeList", () => ({
	useWorktreeList: () => [
		{ name: "", branch: "main", path: "/repo", is_main: true },
		{ name: "feature-x", branch: "feature-x", path: "/wt/x", is_main: false },
	],
}));

const session = (id: string) => makeSessionListItem({ id, title: id });

const testClient = () =>
	new QueryClient({ defaultOptions: { queries: { retry: false } } });

// The sidebar bumps refreshSignal when it opens; raising it is how a test asks
// the tab to refresh.
function tab(
	refreshSignal: number,
	isSwitchingWorktree: boolean,
	onSelectSession = vi.fn(),
) {
	return (
		// Retries off: the app's client retries these reads, and the wait between
		// attempts is not the behaviour under test here.
		<QueryClientProvider client={testClient()}>
			<SidebarContext.Provider value={{ activeTab: "sessions", refreshSignal }}>
				<SessionsTab
					currentSessionId="a1"
					onSelectSession={onSelectSession}
					onCreateSession={vi.fn()}
					onDeleteSession={vi.fn()}
					isSwitchingWorktree={isSwitchingWorktree}
				/>
			</SidebarContext.Provider>
		</QueryClientProvider>
	);
}

describe("SessionsTab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionState.sessions = [session("a1")];
		sessionState.isLoading = false;
		sessionState.isReloading = false;
		useSessionStore.setState({ worktreeFilter: CURRENT_WORKTREE_FILTER });
		sessionViewWorktrees.mockResolvedValue([]);
		sessionViewList.mockResolvedValue({ sessions: [] });
	});

	// Refreshing mid-switch resubscribes over a connection still bound to the
	// worktree being left, and the list that comes back looks authoritative
	// enough to release AppShell's redirect effect — which then bounces the user
	// off the session they were navigating to.
	it("does not refresh a list that belongs to the worktree being left", () => {
		const { rerender } = render(tab(0, true));

		rerender(tab(1, true));

		expect(mockRefresh).not.toHaveBeenCalled();
	});

	// The window the guard exists for. Once the store worktree has caught up,
	// isSwitchingWorktree is already false and AppShell's own gate on the redirect
	// effect is open; isReloading is all that still marks the list as the previous
	// worktree's.
	it("does not refresh once the switch has landed but the new list has not", () => {
		sessionState.isReloading = true;
		const { rerender } = render(tab(0, false));

		rerender(tab(1, false));

		expect(mockRefresh).not.toHaveBeenCalled();
	});

	it("refreshes when the list is the current worktree's", () => {
		const { rerender } = render(tab(0, false));

		rerender(tab(1, false));

		expect(mockRefresh).toHaveBeenCalledTimes(1);
	});

	// A session created now would land in whichever worktree the connection is
	// still bound to, which is not the one the user is on their way to.
	it("blocks new chats while the worktree switch is in flight", () => {
		render(tab(0, true));

		expect(screen.getByRole("button", { name: /New Chat/ })).toBeDisabled();
	});
});

describe("SessionsTab showing another worktree", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionState.sessions = [session("a1")];
		sessionState.isLoading = false;
		sessionState.isReloading = false;
		useSessionStore.setState({
			worktreeFilter: { kind: "worktree", worktree: "feature-x" },
			showTaskSessions: false,
		});
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "feature-x", exists: true, session_count: 1 },
		]);
		sessionViewList.mockResolvedValue({
			sessions: [makeSessionListItem({ id: "x1", title: "Over there" })],
		});
	});

	it("reads that worktree's list instead of the live one", async () => {
		render(tab(0, false));

		expect(await screen.findByText("Over there")).toBeInTheDocument();
		// The live list's row is not merged in: the two lists are never both.
		expect(screen.queryByText("a1")).not.toBeInTheDocument();
		expect(sessionViewList).toHaveBeenCalledWith("feature-x", true, undefined);
	});

	// The difference between the two kinds of row — one switches worktree, one
	// can only be read — is announced once for the list rather than on every row.
	it("says what opening a row from this list will do", async () => {
		render(tab(0, false));

		expect(
			await screen.findByText(
				'Sessions in "feature-x". Opening one switches to that worktree.',
			),
		).toBeInTheDocument();
	});

	it("says the worktree is gone when it is", async () => {
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "gone", exists: false, session_count: 1 },
		]);
		useSessionStore.setState({
			worktreeFilter: { kind: "worktree", worktree: "gone" },
		});

		render(tab(0, false));

		expect(
			await screen.findByText(
				'"gone" was deleted. Its sessions can only be read.',
			),
		).toBeInTheDocument();
	});

	it("hands the row's worktree back when one is opened", async () => {
		const onSelectSession = vi.fn();
		const user = userEvent.setup();
		render(tab(0, false, onSelectSession));

		await user.click(await screen.findByText("Over there"));

		expect(onSelectSession).toHaveBeenCalledWith("x1", "feature-x");
	});

	// An empty list under a filter must not claim the worktree has never been
	// used — it is saying something about somewhere else entirely.
	it("names the worktree when its list is empty", async () => {
		sessionViewList.mockResolvedValue({ sessions: [] });

		render(tab(0, false));

		expect(
			await screen.findByText('No sessions in "feature-x".'),
		).toBeInTheDocument();
	});

	// The last session of a deleted worktree taking that worktree out of the
	// filter is the whole reason the panel prints a count beside it.
	it("falls back once the worktree has no sessions left", async () => {
		sessionViewWorktrees.mockResolvedValue([]);

		render(tab(0, false));

		await waitFor(() =>
			expect(useSessionStore.getState().worktreeFilter).toEqual(
				CURRENT_WORKTREE_FILTER,
			),
		);
	});

	// "All worktrees" has nothing left to span once this worktree is the only
	// one with sessions, and the panel stops offering worktree rows at the same
	// moment — so a selection left standing here would be one the user could no
	// longer undo, on a snapshot of the list they already have live.
	it("falls back from All worktrees once no other worktree has sessions", async () => {
		useSessionStore.setState({ worktreeFilter: { kind: "all" } });
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "", exists: true, session_count: 2 },
		]);

		render(tab(0, false));

		await waitFor(() =>
			expect(useSessionStore.getState().worktreeFilter).toEqual(
				CURRENT_WORKTREE_FILTER,
			),
		);
	});

	// The current worktree is always in the source list and is never one of the
	// places to go, so it must not be what keeps "All worktrees" alive.
	it("keeps All worktrees while another worktree still has sessions", async () => {
		useSessionStore.setState({ worktreeFilter: { kind: "all" } });
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "", exists: true, session_count: 2 },
			{ worktree: "feature-x", exists: false, session_count: 1 },
		]);

		render(tab(0, false));

		expect(
			await screen.findByText(
				"Sessions from every worktree. Opening one may switch worktree.",
			),
		).toBeInTheDocument();
		expect(useSessionStore.getState().worktreeFilter).toEqual({ kind: "all" });
	});

	// An empty list left behind by a failed read is not evidence the worktree
	// has no sessions, and the filter is the user's selection.
	it("keeps the selection when the source list could not be read", async () => {
		sessionViewWorktrees.mockRejectedValue(new Error("no answer"));

		render(tab(0, false));

		expect(await screen.findByText("Over there")).toBeInTheDocument();
		expect(useSessionStore.getState().worktreeFilter).toEqual({
			kind: "worktree",
			worktree: "feature-x",
		});
	});

	// "All worktrees" is the one filter that cannot be read without the source
	// list, so its failure is the list's failure rather than an empty list.
	it("says why All worktrees could not be read", async () => {
		useSessionStore.setState({ worktreeFilter: { kind: "all" } });
		sessionViewWorktrees.mockRejectedValue(new Error("no answer"));

		render(tab(0, false));

		expect(await screen.findByText("no answer")).toBeInTheDocument();
		expect(screen.queryByText("No sessions.")).not.toBeInTheDocument();
	});

	it("says why a list could not be read, rather than showing an empty one", async () => {
		sessionViewList.mockRejectedValue(new Error("worktree data unreadable"));

		render(tab(0, false));

		expect(
			await screen.findByText("worktree data unreadable"),
		).toBeInTheDocument();
	});
});
