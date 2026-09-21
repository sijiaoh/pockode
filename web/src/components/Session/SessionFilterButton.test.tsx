import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionViewWorktree } from "../../lib/rpc/sessionView";
import { CURRENT_WORKTREE_FILTER } from "../../lib/sessionFilter";
import { useSessionStore } from "../../lib/sessionStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import SessionFilterButton from "./SessionFilterButton";

const sessionViewWorktrees = vi.fn<() => Promise<SessionViewWorktree[]>>();
const wsState = { actions: { sessionViewWorktrees } };
vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
	wsActions: { listWorktrees: vi.fn() },
}));

vi.mock("../../hooks/useWorktreeList", () => ({
	useWorktreeList: () => [
		{ name: "", branch: "main", path: "/repo", is_main: true },
		{ name: "feature-x", branch: "feature-x", path: "/wt/x", is_main: false },
	],
}));

function renderButton() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<SessionFilterButton />
		</QueryClientProvider>,
	);
}

async function openPanel() {
	const user = userEvent.setup();
	renderButton();
	await user.click(screen.getByRole("button", { name: /Filter sessions/ }));
	return user;
}

describe("SessionFilterButton", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({ worktreeFilter: CURRENT_WORKTREE_FILTER });
		useWorktreeStore.setState({ current: "feature-x" });
		sessionViewWorktrees.mockResolvedValue([
			// The worktree the user is standing in: already "This worktree", and
			// listing it again would make one list reachable two ways.
			{ worktree: "feature-x", exists: true, session_count: 9 },
			{ worktree: "", exists: true, session_count: 4 },
			{ worktree: "old-fix", exists: false, session_count: 3 },
		]);
	});

	it("offers every worktree that still has sessions, the deleted ones included", async () => {
		await openPanel();

		expect(
			await screen.findByRole("radio", { name: /main/ }),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /old-fix/ })).toBeInTheDocument();
		expect(screen.getByText("Deleted")).toBeInTheDocument();
	});

	it("does not offer the worktree the user is already in", async () => {
		await openPanel();

		await screen.findByRole("radio", { name: /main/ });
		expect(
			screen.queryByRole("radio", { name: /feature-x/ }),
		).not.toBeInTheDocument();
	});

	// The count is the only warning that deleting the last session takes the
	// worktree out of this panel for good.
	it("shows how many sessions each one holds", async () => {
		await openPanel();

		expect(await screen.findByText("3")).toBeInTheDocument();
	});

	it("says which of the two a worktree is, in words, for a screen reader", async () => {
		await openPanel();

		expect(
			await screen.findByRole("radio", { name: /old-fix, deleted worktree/ }),
		).toBeInTheDocument();
	});

	it("selects a worktree", async () => {
		const user = await openPanel();

		await user.click(await screen.findByRole("radio", { name: /old-fix/ }));

		expect(useSessionStore.getState().worktreeFilter).toEqual({
			kind: "worktree",
			worktree: "old-fix",
		});
	});

	it("goes back to this worktree", async () => {
		useSessionStore.setState({
			worktreeFilter: { kind: "worktree", worktree: "old-fix" },
		});
		const user = await openPanel();

		await user.click(screen.getByRole("radio", { name: "This worktree" }));

		expect(useSessionStore.getState().worktreeFilter).toEqual(
			CURRENT_WORKTREE_FILTER,
		);
	});

	// Nothing else on screen says the list is somebody else's once the panel is
	// closed, and the filter is not persisted.
	it("says on the button itself that the list is not this worktree's", async () => {
		useSessionStore.setState({
			worktreeFilter: { kind: "worktree", worktree: "old-fix" },
		});
		renderButton();

		expect(
			await screen.findByRole("button", {
				name: "Filter sessions, showing worktree old-fix",
			}),
		).toBeInTheDocument();
	});

	// On a phone the panel is a sheet over the very list the choice changed.
	it("closes once a worktree is picked, and stays open for the toggle", async () => {
		const user = await openPanel();

		await user.click(await screen.findByRole("radio", { name: /old-fix/ }));
		expect(screen.queryByRole("radio")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Filter sessions/ }));
		await user.click(await screen.findByText("Show task sessions"));
		expect(screen.getByText("Show task sessions")).toBeInTheDocument();
	});

	// One choice, not two: the headings separate the deleted from the live, and
	// a radio group per heading would make picking one of each possible.
	it("keeps every worktree in one choice", async () => {
		await openPanel();

		await screen.findByRole("radio", { name: /old-fix/ });
		expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
	});

	// The panel caps its own height and clips what it cannot fit, so a machine
	// with a screen's worth of worktrees must be able to reach the last of them.
	it("scrolls the worktrees rather than clipping them", async () => {
		sessionViewWorktrees.mockResolvedValue(
			Array.from({ length: 40 }, (_, i) => ({
				worktree: `topic-${i}`,
				exists: true,
				session_count: 1,
			})),
		);
		await openPanel();

		const scroller = (await screen.findByRole("radiogroup"))
			.parentElement as HTMLElement;
		expect(scroller).toHaveClass("overflow-y-auto");
	});

	it("leaves the worktree section out when there is nowhere else to look", async () => {
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "feature-x", exists: true, session_count: 9 },
		]);
		await openPanel();

		expect(await screen.findByText("Show task sessions")).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
	});

	// The last other worktree can lose its last session while its list is the
	// one on screen. Hiding the section then would leave the only way back to
	// this worktree's own list behind a worktree switch.
	it("keeps the worktree section while a choice is still in force", async () => {
		useSessionStore.setState({ worktreeFilter: { kind: "all" } });
		sessionViewWorktrees.mockResolvedValue([
			{ worktree: "feature-x", exists: true, session_count: 9 },
		]);
		const user = await openPanel();

		await user.click(
			await screen.findByRole("radio", { name: "This worktree" }),
		);
		expect(useSessionStore.getState().worktreeFilter).toEqual(
			CURRENT_WORKTREE_FILTER,
		);
	});
});
