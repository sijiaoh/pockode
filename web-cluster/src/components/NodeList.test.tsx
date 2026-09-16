import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSessionNodeToken } from "../lib/nodeToken";
import type { NodeWithStatus } from "../types/node";
import { NodeList, POLL_INTERVAL_MS } from "./NodeList";

const staleNode: NodeWithStatus = {
	id: "n1",
	path: "/home/you/projects/my-app",
	name: "my-app",
	created_at: "2026-09-16T10:00:00Z",
	updated_at: "2026-09-16T10:00:00Z",
	status: { id: "n1", status: "stale" },
};

const actions = {
	listNodes: vi.fn(),
	cleanupNode: vi.fn(),
	startNode: vi.fn(),
	stopNode: vi.fn(),
	deleteNode: vi.fn(),
};

// Mutable so a test can speak for the store: the version is rendered by the
// list now that it is no longer pinned to the viewport corner.
const wsState: {
	status: string;
	version: string | null;
	actions: typeof actions;
} = { status: "connected", version: null, actions };

vi.mock("../lib/wsStore", () => ({
	useWSStore: () => wsState,
}));

describe("NodeList: a refused cleanup", () => {
	beforeEach(() => {
		// Faked from before the render, not partway through: a timer this
		// component schedules on mount is only reachable by the fake clock if the
		// clock was already fake when it was scheduled. `shouldAdvanceTime` keeps
		// it moving on its own so testing-library's own waiting, which runs on
		// real time, still resolves.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		actions.listNodes.mockResolvedValue([staleNode]);
		actions.cleanupNode.mockRejectedValue(new Error("node is still running"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("reports it in that node's card, and leaves it there", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<NodeList />);

		await user.click(await screen.findByRole("button", { name: "Clean up" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("node is still running");

		// Errors used to clear themselves after 5s — the one notice class the user
		// has to act on was the one that vanished mid-read. Three of those
		// intervals later it is still on screen.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"node is still running",
		);
	});

	// The refusal is also information about the node: `node is still running`
	// means the card calling itself stale is the thing that is wrong. Refreshing
	// on the failure path is what turns the refusal into a correct card instead
	// of an error sitting on top of a lie.
	it("refreshes the card it just got refused on", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<NodeList />);

		const cleanUp = await screen.findByRole("button", { name: "Clean up" });
		actions.listNodes.mockResolvedValue([
			{
				...staleNode,
				status: {
					id: "n1",
					status: "running",
					local_url: "http://localhost:9870",
				},
			},
		]);
		await user.click(cleanUp);

		// Asserted in this order on purpose: the refreshed card has to be there
		// *by the time* the error is, which is what the awaited refresh on the
		// failure path buys. Waiting for the card instead would be satisfied by
		// the 5s poll a moment later, and would pass with that refresh deleted.
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.getByRole("alert")).toHaveTextContent(
			"node is still running",
		);
		expect(screen.getByRole("link", { name: "Open" })).toBeInTheDocument();
	});

	it("keeps it until the next action on that node succeeds", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<NodeList />);

		await user.click(await screen.findByRole("button", { name: "Clean up" }));
		await screen.findByRole("alert");

		actions.cleanupNode.mockResolvedValue({ id: "n1", status: "stopped" });
		await user.click(screen.getByRole("button", { name: "Clean up" }));

		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
	});
});

function stoppedNode(id: string, name: string): NodeWithStatus {
	return {
		id,
		path: `/home/you/projects/${name}`,
		name,
		created_at: "2026-09-16T10:00:00Z",
		updated_at: "2026-09-16T10:00:00Z",
		status: { id, status: "stopped" },
	};
}

async function cardFor(name: string) {
	const heading = await screen.findByRole("heading", { name });
	return within(heading.closest("div.rounded-lg") as HTMLElement);
}

describe("NodeList: the session's node token", () => {
	beforeEach(() => {
		// Module state, so it outlives a render and would leak between tests.
		forgetSessionNodeToken();
		actions.listNodes.mockResolvedValue([
			stoppedNode("n1", "my-app"),
			stoppedNode("n2", "other-app"),
		]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("asks once, then starts every other node on one tap", async () => {
		const user = userEvent.setup();
		actions.startNode.mockResolvedValue({ id: "n1", status: "running" });
		render(<NodeList />);

		await user.click(
			(await cardFor("my-app")).getByRole("button", { name: "Start" }),
		);
		await user.type(screen.getByLabelText("Auth token"), "node-token");
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Start" }),
		);

		await waitFor(() =>
			expect(actions.startNode).toHaveBeenCalledWith({
				id: "n1",
				token: "node-token",
			}),
		);

		await user.click(
			(await cardFor("other-app")).getByRole("button", { name: "Start" }),
		);

		expect(screen.queryByLabelText("Auth token")).not.toBeInTheDocument();
		expect(actions.startNode).toHaveBeenLastCalledWith({
			id: "n2",
			token: "node-token",
		});
	});

	// A rejected token that got remembered would turn every later Start into a
	// silent one-tap failure — worse than being asked again.
	it("does not remember a token the backend rejected", async () => {
		const user = userEvent.setup();
		actions.startNode.mockRejectedValue(new Error("invalid token"));
		render(<NodeList />);

		await user.click(
			(await cardFor("my-app")).getByRole("button", { name: "Start" }),
		);
		await user.type(screen.getByLabelText("Auth token"), "wrong-token");
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Start" }),
		);

		await screen.findByRole("alert");

		// In the sheet, not only on the card: the sheet stayed open over the card,
		// so an error rendered solely behind it would be a start that failed
		// silently as far as the user can see.
		expect(
			within(screen.getByRole("dialog")).getByText(/invalid token/),
		).toBeInTheDocument();

		// Out of the still-open sheet first: the next card is behind it, and a
		// click that only landed on the overlay would let a remembered token go
		// unnoticed.
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Cancel",
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		await user.click(
			(await cardFor("other-app")).getByRole("button", { name: "Start" }),
		);

		expect(await screen.findByLabelText("Auth token")).toBeInTheDocument();
		expect(actions.startNode).toHaveBeenCalledTimes(1);
	});
});

function nodeOf(
	id: string,
	name: string,
	status: NodeWithStatus["status"]["status"],
): NodeWithStatus {
	return {
		id,
		path: `/home/you/projects/${name}`,
		name,
		created_at: "2026-09-16T10:00:00Z",
		updated_at: "2026-09-16T10:00:00Z",
		status: { id, status },
	};
}

describe("NodeList: sections", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Sections replaced a row of uncountable summary chips: the chip announced a
	// stale node and then left it to be found in a flat list, while a section
	// header both counts and holds the nodes it counted.
	it("puts what needs attention first and counts each section", async () => {
		actions.listNodes.mockResolvedValue([
			nodeOf("n1", "zeta", "stopped"),
			nodeOf("n2", "alpha", "running"),
			nodeOf("n3", "beta", "stale"),
			nodeOf("n4", "aardvark", "stopped"),
		]);
		render(<NodeList />);

		await screen.findByRole("heading", { name: "zeta" });
		expect(
			screen
				.getAllByRole("heading", { level: 2 })
				.map((heading) => heading.textContent),
		).toEqual(["Needs attention", "Running", "Stopped"]);

		// Anchored: `toHaveTextContent("2")` is a substring match, so it would
		// pass just as happily on a header that counted the whole cluster.
		const stopped = screen
			.getByRole("heading", { name: "Stopped" })
			.closest("div") as HTMLElement;
		expect(stopped).toHaveTextContent(/^Stopped2$/);

		// Within a section, by name — registry order is the order they happened to
		// be added in, which is nothing the reader knows.
		expect(
			screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
		).toEqual(["beta", "alpha", "aardvark", "zeta"]);
	});

	it("does not draw a section with nothing in it", async () => {
		actions.listNodes.mockResolvedValue([nodeOf("n1", "only", "stopped")]);
		render(<NodeList />);

		await screen.findByRole("heading", { name: "only" });
		expect(
			screen.queryByRole("heading", { name: "Needs attention" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Running" })).toBeNull();
	});

	// Leftovers arrive in batches — a reboot orphans every node at once — which
	// is the whole argument for the one batch action in this panel. A single
	// stale node does not need it: its own card's Clean up is right there.
	it("offers Clean up all only once cleaning up one by one would be a chore", async () => {
		actions.listNodes.mockResolvedValue([nodeOf("n1", "only", "stale")]);
		const { unmount } = render(<NodeList />);

		await screen.findByRole("heading", { name: "only" });
		expect(
			screen.queryByRole("button", { name: "Clean up all" }),
		).not.toBeInTheDocument();

		unmount();
		actions.listNodes.mockResolvedValue([
			nodeOf("n1", "one", "stale"),
			nodeOf("n2", "two", "stale"),
		]);
		actions.cleanupNode.mockResolvedValue({ id: "n1", status: "stopped" });
		const user = userEvent.setup();
		render(<NodeList />);

		await user.click(
			await screen.findByRole("button", { name: "Clean up all" }),
		);

		await waitFor(() => expect(actions.cleanupNode).toHaveBeenCalledTimes(2));
		expect(actions.cleanupNode).toHaveBeenCalledWith({ id: "n1" });
		expect(actions.cleanupNode).toHaveBeenCalledWith({ id: "n2" });
	});

	// The batch runs against nodes that may each refuse it, and a refusal leaves
	// the section — and this button — on screen. A control that spends one use
	// and stays spent is worse than no batch action at all.
	it("gives the batch button back when the batch is over", async () => {
		actions.listNodes.mockResolvedValue([
			nodeOf("n1", "one", "stale"),
			nodeOf("n2", "two", "stale"),
		]);
		actions.cleanupNode.mockRejectedValue(new Error("node is still running"));
		const user = userEvent.setup();
		render(<NodeList />);

		await user.click(
			await screen.findByRole("button", { name: "Clean up all" }),
		);

		const button = await screen.findByRole("button", { name: "Clean up all" });
		await waitFor(() => expect(button).toBeEnabled());
		expect(await screen.findAllByRole("alert")).toHaveLength(2);
	});

	it("prints the cluster version after the last card rather than over it", async () => {
		actions.listNodes.mockResolvedValue([nodeOf("n1", "only", "stopped")]);
		wsState.version = "1.4.0";
		render(<NodeList />);

		expect(
			await screen.findByText("Pockode cluster v1.4.0"),
		).toBeInTheDocument();
		wsState.version = null;
	});
});

describe("NodeList: polling", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		actions.listNodes.mockResolvedValue([nodeOf("n1", "only", "stopped")]);
	});

	afterEach(() => {
		setHidden(false);
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function setHidden(hidden: boolean) {
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => hidden,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}

	// The poll asks the host to stat every registered project directory. A phone
	// that left this open in a tab it has forgotten about would go on doing that
	// forever, for a list nobody is looking at.
	it("stops asking while the tab is in the background", async () => {
		render(<NodeList />);
		await screen.findByRole("heading", { name: "only" });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
		});
		const whileVisible = actions.listNodes.mock.calls.length;
		expect(whileVisible).toBeGreaterThan(1);

		act(() => setHidden(true));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
		});
		expect(actions.listNodes).toHaveBeenCalledTimes(whileVisible);
	});

	// Catching up on return is the other half: the list on screen is as old as
	// the time spent away, and waiting out a fresh interval before correcting it
	// would show a stale answer at exactly the moment it is read again.
	it("catches up the moment the tab comes back", async () => {
		render(<NodeList />);
		await screen.findByRole("heading", { name: "only" });
		act(() => setHidden(true));
		const whileHidden = actions.listNodes.mock.calls.length;

		act(() => setHidden(false));

		// Well inside one interval: given the whole span of a poll, the poll
		// itself would satisfy this and the catch-up could be deleted unnoticed.
		await waitFor(
			() =>
				expect(actions.listNodes.mock.calls.length).toBeGreaterThan(
					whileHidden,
				),
			{ timeout: POLL_INTERVAL_MS / 5 },
		);
	});
});

describe("NodeList: a half-finished Stop and delete", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// "Stop and delete" is two calls, and only the second one is allowed to fail
	// on its own. When it does, the stop has already happened: a card left
	// saying Running would offer an Open pointing at a server that is no longer
	// there, underneath an error about deleting.
	it("shows the node as it is now, not as it was before the stop", async () => {
		const user = userEvent.setup();
		actions.listNodes.mockResolvedValue([
			{
				...nodeOf("n1", "my-app", "running"),
				status: {
					id: "n1",
					status: "running",
					local_url: "http://localhost:9870",
				},
			},
		]);
		actions.stopNode.mockResolvedValue({ id: "n1", status: "stopped" });
		actions.deleteNode.mockRejectedValue(new Error("registry is read-only"));

		render(<NodeList />);
		await user.click(
			await screen.findByRole("button", { name: "More options for my-app" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		actions.listNodes.mockResolvedValue([nodeOf("n1", "my-app", "stopped")]);
		await user.click(screen.getByRole("button", { name: "Stop and delete" }));

		// Ordered like the refused-cleanup test above: the refreshed card has to
		// be there *by the time* the error is. Waiting for the card on its own
		// would be satisfied by the poll a few seconds later, and would pass with
		// the refresh deleted.
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.getByRole("alert")).toHaveTextContent(
			"registry is read-only",
		);
		expect(
			screen.queryByRole("link", { name: "Open" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
	});
});
