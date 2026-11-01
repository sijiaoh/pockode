import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeStatusInfo, NodeWithStatus } from "../types/node";
import { NodeList } from "./NodeList";

// Restarting nodes from the list: which node is outdated, the strip, every
// `node.restart` refusal, and the older node's stop-and-start
// (docs/restart-ui.md, "web-cluster: restarting nodes").

const actions = {
	listNodes: vi.fn(),
	cleanupNode: vi.fn(),
	startNode: vi.fn(),
	stopNode: vi.fn(),
	deleteNode: vi.fn(),
	restartNode: vi.fn(),
	serverVersion: vi.fn(),
	// The release check is ClusterVersion.update.test.tsx's; here it never answers.
	serverUpdateCheck: vi.fn(() => new Promise(() => {})),
	restartServer: vi.fn(),
};

const wsState = {
	status: "connected",
	version: null,
	restartRequestedAt: null,
	actions,
};

vi.mock("../lib/wsStore", () => ({
	useWSStore: Object.assign(() => wsState, { getState: () => wsState }),
}));

const INSTALLED = "0.17.0";

function node(
	id: string,
	name: string,
	status: Partial<NodeStatusInfo> = {},
	lastUsedAt = "2026-09-16T10:00:00Z",
): NodeWithStatus {
	return {
		id,
		path: `/home/you/projects/${name}`,
		name,
		created_at: "2026-09-16T10:00:00Z",
		updated_at: "2026-09-16T10:00:00Z",
		last_used_at: lastUsedAt,
		status: {
			id,
			status: "running",
			local_url: "http://localhost:9870",
			started_at: "2026-09-16T10:00:00Z",
			...status,
		},
	};
}

/** Running a version other than the installed one. */
const outdated = (id: string, name: string, version = "0.16.0") =>
	node(id, name, { version });
const current = (id: string, name: string) =>
	node(id, name, { version: INSTALLED });
/** Started by a build from before node restarts: no version. */
const older = (id: string, name: string) => node(id, name);

function refused(reason: string, message: string) {
	return Object.assign(new Error(message), {
		code: -32011,
		data: { reason },
	});
}

async function cardFor(name: string) {
	const heading = await screen.findByRole("heading", { name });
	return within(heading.closest("div.rounded-lg") as HTMLElement);
}

/** Waits for the installed read to land and the list to be drawn on it. */
async function renderList(nodes: NodeWithStatus[]) {
	actions.listNodes.mockResolvedValue(nodes);
	render(<NodeList />);
	await screen.findByRole("heading", { name: nodes[0].name });
	await waitFor(() => expect(actions.serverVersion).toHaveBeenCalled());
}

beforeEach(() => {
	actions.serverVersion.mockResolvedValue({
		installed: { path: "/usr/local/bin/pockode", version: INSTALLED },
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("NodeList: which node is outdated", () => {
	it("marks a node running another version, and only that one", async () => {
		await renderList([outdated("n1", "my-app"), current("n2", "api")]);

		const stale = await cardFor("my-app");
		expect(
			await stale.findByText("v0.16.0 · 0.17.0 installed"),
		).toBeInTheDocument();
		expect(stale.getByRole("button", { name: "Restart" })).toBeInTheDocument();

		const fine = await cardFor("api");
		expect(fine.queryByText(/installed/)).not.toBeInTheDocument();
		expect(
			fine.queryByRole("button", { name: "Restart" }),
		).not.toBeInTheDocument();
	});

	it("calls a node without a version an older one", async () => {
		await renderList([older("n1", "legacy")]);

		const card = await cardFor("legacy");
		expect(
			await card.findByText("Older version · 0.17.0 installed"),
		).toBeInTheDocument();
	});

	it("never compares a development build", async () => {
		await renderList([
			node("n1", "my-app", { version: "dev" }),
			outdated("n2", "api"),
		]);

		// The control: the read has landed once the other card is marked.
		await (await cardFor("api")).findByText(/0.17.0 installed/);
		const card = await cardFor("my-app");
		expect(card.queryByText(/installed/)).not.toBeInTheDocument();
	});

	it.each([
		["the request failed", () => Promise.reject(new Error("timed out"))],
		[
			"the file did not run",
			() =>
				Promise.resolve({
					installed: {
						path: "/usr/local/bin/pockode",
						error: "exec format error",
					},
				}),
		],
	])("marks nothing when %s", async (_, read) => {
		actions.serverVersion.mockImplementation(read);
		await renderList([outdated("n1", "my-app"), older("n2", "legacy")]);

		await waitFor(() => expect(actions.serverVersion).toHaveBeenCalled());
		// Lets the read settle and render before the absence is asserted.
		await act(async () => {});
		await act(async () => {});
		expect(screen.queryByText(/installed/)).not.toBeInTheDocument();
		expect(screen.queryByText(/outdated/)).not.toBeInTheDocument();
	});
});

describe("NodeList: restarting one node", () => {
	async function confirmRestart(name: string) {
		const user = userEvent.setup();
		const card = await cardFor(name);
		await user.click(await card.findByRole("button", { name: "Restart" }));
		const sheet = await screen.findByRole("dialog", {
			name: `Restart ${name}?`,
		});
		await user.click(
			await within(sheet).findByRole("button", { name: "Restart" }),
		);
		return { user, sheet };
	}

	it("restarts it and shows it restarting at its place", async () => {
		await renderList([outdated("n1", "my-app")]);
		actions.restartNode.mockResolvedValue({ id: "n1", status: "restarting" });
		actions.listNodes.mockResolvedValue([
			node("n1", "my-app", {
				status: "restarting",
				local_url: undefined,
				restart_requested_at: new Date().toISOString(),
			}),
		]);

		await confirmRestart("my-app");

		expect(actions.restartNode).toHaveBeenCalledWith({ id: "n1" });
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		const card = await cardFor("my-app");
		expect(card.getByRole("button", { name: "Restarting..." })).toBeDisabled();
		// Still under Running: a restart does not move the node.
		expect(
			screen.getByRole("heading", { name: "Running" }),
		).toBeInTheDocument();
	});

	it("keeps the sheet with the reason when the installed file did not run", async () => {
		await renderList([outdated("n1", "my-app")]);
		actions.restartNode.mockRejectedValue(
			refused("not_runnable", "The installed pockode didn't run."),
		);

		const { sheet } = await confirmRestart("my-app");

		expect(await within(sheet).findByRole("alert")).toHaveTextContent(
			"The installed pockode didn't run.",
		);
		expect(
			within(sheet).getByRole("button", { name: "Restart" }),
		).toBeEnabled();
	});

	it("treats another device having asked first as success", async () => {
		await renderList([outdated("n1", "my-app")]);
		actions.restartNode.mockRejectedValue(
			refused("already_restarting", "This node is already restarting."),
		);

		await confirmRestart("my-app");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("puts a node that stopped meanwhile on its card", async () => {
		await renderList([outdated("n1", "my-app")]);
		actions.restartNode.mockRejectedValue(
			refused("not_running", "This node is not running."),
		);

		await confirmRestart("my-app");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not restart this node: This node is not running.",
		);
	});

	// On Windows a node with a version can still lack the restart event.
	it("turns the sheet into the older node's when the cluster cannot ask it", async () => {
		await renderList([outdated("n1", "my-app")]);
		actions.restartNode.mockRejectedValue(
			refused("older_node", "This node was started by an older Pockode."),
		);

		await confirmRestart("my-app");

		expect(
			await screen.findByRole("dialog", { name: "Restart my-app" }),
		).toBeInTheDocument();
		// Turned into, not opened over: no overlay stacks on another.
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
		expect(screen.getByLabelText("Node password")).toBeInTheDocument();
		expect(
			(await cardFor("my-app")).getByText("Older version · 0.17.0 installed"),
		).toBeInTheDocument();
	});

	it("shows the cluster's restart error, and Dismiss hides it for that restart only", async () => {
		const user = userEvent.setup();
		const failed = (at: string) =>
			node("n1", "my-app", {
				status: "stopped",
				local_url: undefined,
				restart_requested_at: at,
				restart_error: "Stopped for the restart and didn't come back.",
			});
		await renderList([failed("2026-09-16T10:00:00Z")]);

		const card = await cardFor("my-app");
		expect(card.getByRole("alert")).toHaveTextContent(
			"Stopped for the restart and didn't come back.",
		);
		await user.click(card.getByRole("button", { name: "Dismiss" }));
		expect(card.queryByRole("alert")).not.toBeInTheDocument();

		// Another restart that fails is news again.
		actions.listNodes.mockResolvedValue([failed("2026-09-16T11:00:00Z")]);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(await card.findByRole("alert")).toBeInTheDocument();
	});
});

describe("NodeList: an older node's stop and start", () => {
	async function openOlderSheet() {
		const user = userEvent.setup();
		await renderList([older("n1", "legacy")]);
		const card = await cardFor("legacy");
		await user.click(await card.findByRole("button", { name: "Restart" }));
		const sheet = await screen.findByRole("dialog", { name: "Restart legacy" });
		await user.type(screen.getByLabelText("Node password"), "pw");
		return { user, sheet };
	}

	it("stops it, then starts it with the typed password — never node.restart", async () => {
		const { user, sheet } = await openOlderSheet();
		actions.stopNode.mockResolvedValue({ id: "n1", status: "stopped" });
		actions.startNode.mockResolvedValue({ id: "n1", status: "running" });
		// The stop's refresh moves the card to Stopped: the sheet outlives that.
		actions.listNodes.mockResolvedValue([
			node("n1", "legacy", { status: "stopped", local_url: undefined }),
		]);

		await user.click(
			within(sheet).getByRole("button", { name: "Stop and start" }),
		);

		await waitFor(() =>
			expect(actions.startNode).toHaveBeenCalledWith({
				id: "n1",
				password: "pw",
			}),
		);
		expect(actions.stopNode).toHaveBeenCalledWith({ id: "n1" });
		expect(actions.stopNode.mock.invocationCallOrder[0]).toBeLessThan(
			actions.startNode.mock.invocationCallOrder[0],
		);
		expect(actions.restartNode).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("keeps the sheet as it was when the stop fails", async () => {
		const { user, sheet } = await openOlderSheet();
		actions.stopNode.mockRejectedValue(new Error("still running"));

		await user.click(
			within(sheet).getByRole("button", { name: "Stop and start" }),
		);

		expect(await within(sheet).findByText(/still running/)).toBeInTheDocument();
		expect(actions.startNode).not.toHaveBeenCalled();
		expect(
			within(sheet).getByRole("button", { name: "Stop and start" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Node password")).toHaveValue("pw");
	});

	it("becomes the Start sheet when the node stopped by itself meanwhile", async () => {
		const { user } = await openOlderSheet();
		actions.listNodes.mockResolvedValue([
			node("n1", "legacy", { status: "stopped", local_url: undefined }),
		]);
		actions.startNode.mockResolvedValue({ id: "n1", status: "running" });

		document.dispatchEvent(new Event("visibilitychange"));
		const start = await screen.findByRole("dialog", { name: "Start legacy" });
		await user.click(within(start).getByRole("button", { name: "Start" }));

		await waitFor(() =>
			expect(actions.startNode).toHaveBeenCalledWith({
				id: "n1",
				password: "pw",
			}),
		);
		expect(actions.stopNode).not.toHaveBeenCalled();
	});

	it("becomes the Start sheet when the start fails", async () => {
		const { user, sheet } = await openOlderSheet();
		actions.stopNode.mockResolvedValue({ id: "n1", status: "stopped" });
		actions.startNode.mockRejectedValue(new Error("port in use"));
		actions.listNodes.mockResolvedValue([
			node("n1", "legacy", { status: "stopped", local_url: undefined }),
		]);

		await user.click(
			within(sheet).getByRole("button", { name: "Stop and start" }),
		);

		const start = await screen.findByRole("dialog", { name: "Start legacy" });
		expect(within(start).getByText(/port in use/)).toBeInTheDocument();
		expect(screen.getByLabelText("Node password")).toHaveValue("pw");

		await user.click(within(start).getByRole("button", { name: "Start" }));
		await waitFor(() => expect(actions.startNode).toHaveBeenCalledTimes(2));
		expect(actions.stopNode).toHaveBeenCalledTimes(1);
	});
});

describe("NodeList: Restart all outdated", () => {
	it("is not drawn for one outdated node", async () => {
		await renderList([outdated("n1", "my-app"), current("n2", "api")]);

		await (await cardFor("my-app")).findByText(/0.17.0 installed/);
		expect(
			screen.queryByRole("button", { name: /Restart all outdated/ }),
		).not.toBeInTheDocument();
	});

	it("counts older nodes as outdated but leaves them out of N", async () => {
		await renderList([
			outdated("n1", "my-app"),
			outdated("n2", "api", "0.15.2"),
			older("n3", "legacy"),
		]);

		expect(
			await screen.findByText(/0.17.0 installed · 3 nodes are outdated/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Restart all outdated (2)" }),
		).toBeInTheDocument();
	});

	it("draws no button when every outdated node is an older one", async () => {
		await renderList([older("n1", "legacy"), older("n2", "old-api")]);

		expect(
			await screen.findByText(/Restart each from its card/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Restart all outdated/ }),
		).not.toBeInTheDocument();
	});

	it("restarts every one, and puts a refusal on that node's card only", async () => {
		const user = userEvent.setup();
		await renderList([
			outdated("n1", "my-app"),
			outdated("n2", "api", "0.15.2"),
			older("n3", "legacy"),
		]);
		actions.restartNode.mockImplementation(async ({ id }: { id: string }) => {
			if (id === "n2") throw new Error("permission denied");
			return { id, status: "restarting" };
		});

		await user.click(
			await screen.findByRole("button", { name: "Restart all outdated (2)" }),
		);
		const sheet = await screen.findByRole("dialog", {
			name: "Restart 2 outdated nodes?",
		});
		expect(within(sheet).getByText(/Not included: legacy/)).toBeInTheDocument();
		await user.click(
			await within(sheet).findByRole("button", { name: "Restart 2" }),
		);

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(actions.restartNode).toHaveBeenCalledTimes(2);
		expect(actions.restartNode).not.toHaveBeenCalledWith({ id: "n3" });
		expect((await cardFor("api")).getByRole("alert")).toHaveTextContent(
			"Could not restart this node: permission denied",
		);
		expect(
			(await cardFor("my-app")).queryByRole("alert"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/1 couldn't restart; its card says why/),
		).toBeInTheDocument();

		// The note points at the card's error; once that is dismissed, so is it.
		await user.click(
			(await cardFor("api")).getByRole("button", { name: "Dismiss" }),
		);
		expect(screen.queryByText(/couldn't restart/)).not.toBeInTheDocument();
	});

	// Under the threshold once the others restart, but the refusal's note is
	// what tells the user to look at that card.
	it("stays to say a refusal happened when it is the last one left", async () => {
		const user = userEvent.setup();
		await renderList([outdated("n1", "my-app"), outdated("n2", "api")]);
		actions.restartNode.mockImplementation(async ({ id }: { id: string }) => {
			if (id === "n2") throw new Error("permission denied");
			return { id, status: "restarting" };
		});

		await user.click(
			await screen.findByRole("button", { name: "Restart all outdated (2)" }),
		);
		actions.listNodes.mockResolvedValue([
			node("n1", "my-app", {
				status: "restarting",
				local_url: undefined,
				restart_requested_at: new Date().toISOString(),
			}),
			outdated("n2", "api"),
		]);
		await user.click(
			await within(screen.getByRole("dialog")).findByRole("button", {
				name: "Restart 2",
			}),
		);

		expect(
			await screen.findByText(/1 couldn't restart; its card says why/),
		).toBeInTheDocument();
	});

	// A node that stopped since the list was drawn is no longer outdated, but
	// its card has the error all the same, and the note has to point at it.
	it("counts a refusal from a node that stopped meanwhile", async () => {
		const user = userEvent.setup();
		await renderList([
			outdated("n1", "my-app"),
			outdated("n2", "api"),
			outdated("n3", "web"),
		]);
		actions.restartNode.mockImplementation(async ({ id }: { id: string }) => {
			if (id === "n2") {
				throw refused("not_running", "This node is not running.");
			}
			return { id, status: "restarting" };
		});

		await user.click(
			await screen.findByRole("button", { name: "Restart all outdated (3)" }),
		);
		const restarting = (id: string, name: string) =>
			node(id, name, {
				status: "restarting",
				local_url: undefined,
				restart_requested_at: new Date().toISOString(),
			});
		actions.listNodes.mockResolvedValue([
			restarting("n1", "my-app"),
			node("n2", "api", { status: "stopped", local_url: undefined }),
			restarting("n3", "web"),
		]);
		await user.click(
			await within(screen.getByRole("dialog")).findByRole("button", {
				name: "Restart 3",
			}),
		);

		expect(
			await screen.findByText(/1 couldn't restart; its card says why/),
		).toBeInTheDocument();
		expect((await cardFor("api")).getByRole("alert")).toHaveTextContent(
			"Could not restart this node: This node is not running.",
		);
	});
});
