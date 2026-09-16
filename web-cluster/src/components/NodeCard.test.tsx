import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeStatus, NodeWithStatus } from "../types/node";
import { NodeCard } from "./NodeCard";

function makeNode(
	status: NodeStatus,
	overrides: Partial<NodeWithStatus["status"]> = {},
): NodeWithStatus {
	return {
		id: "n1",
		path: "/home/you/projects/my-app",
		name: "my-app",
		created_at: "2026-09-16T10:00:00Z",
		updated_at: "2026-09-16T10:00:00Z",
		status: { id: "n1", status, ...overrides },
	};
}

function renderCard(
	node: NodeWithStatus,
	props: Partial<Parameters<typeof NodeCard>[0]> = {},
) {
	const handlers = {
		onDismissError: vi.fn(),
		onEdit: vi.fn(),
		onDelete: vi.fn().mockResolvedValue(undefined),
		onStart: vi.fn().mockResolvedValue(true),
		onStop: vi.fn().mockResolvedValue(undefined),
		onCleanup: vi.fn().mockResolvedValue(undefined),
	};
	render(<NodeCard node={node} {...handlers} {...props} />);
	return handlers;
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
	user.click(screen.getByRole("button", { name: "More options for my-app" }));

describe("NodeCard: Open", () => {
	it("targets the remote URL when both are known, keeping local as a second link", () => {
		renderCard(
			makeNode("running", {
				local_url: "http://localhost:9870",
				remote_url: "https://my-app.example",
			}),
		);

		expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
			"href",
			"https://my-app.example",
		);
		expect(screen.getByRole("link", { name: /Local/ })).toHaveAttribute(
			"href",
			"http://localhost:9870",
		);
	});

	it("targets the local URL when it is the only one, and draws no second link", () => {
		renderCard(makeNode("running", { local_url: "http://localhost:9870" }));

		expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
			"href",
			"http://localhost:9870",
		);
		expect(
			screen.queryByRole("link", { name: /Local/ }),
		).not.toBeInTheDocument();
	});
});

describe("NodeCard: which actions a card offers", () => {
	// Start on a stale card is only legal because the backend clears the
	// leftover `server.json` before spawning; before that fix the one-tap route
	// from leftovers to running did not exist, and the card had to offer cleanup
	// as its primary instead.
	it("makes Start the primary on a stale card, with Clean up beside it", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stale"));

		expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Clean up" }),
		).toBeInTheDocument();

		await openMenu(user);
		expect(
			screen.queryByRole("button", { name: "Stop" }),
		).not.toBeInTheDocument();
	});
});

describe("NodeCard: confirmations", () => {
	it("cleans up on tap, without asking", async () => {
		const user = userEvent.setup();
		const { onCleanup } = renderCard(makeNode("stale"));

		await user.click(screen.getByRole("button", { name: "Clean up" }));

		expect(onCleanup).toHaveBeenCalledWith("n1");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("asks before stopping, and says what stopping costs", async () => {
		const user = userEvent.setup();
		const { onStop } = renderCard(
			makeNode("running", { local_url: "http://localhost:9870" }),
		);

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Stop" }));

		expect(onStop).not.toHaveBeenCalled();
		expect(screen.getByText(/Any running AI sessions end/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Stop" }));
		expect(onStop).toHaveBeenCalledWith("n1");
	});

	it("asks before deleting, and names the directory as untouched", async () => {
		const user = userEvent.setup();
		const { onDelete } = renderCard(makeNode("stopped"));

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		expect(onDelete).not.toHaveBeenCalled();
		expect(
			screen.getByText(/The project directory and its files are not touched/),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(onDelete).toHaveBeenCalledWith("n1", { stopFirst: false });
	});

	it("warns that deleting a running node orphans its server, and offers to stop it first", async () => {
		const user = userEvent.setup();
		const { onDelete } = renderCard(
			makeNode("running", { local_url: "http://localhost:9870" }),
		);

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		expect(
			screen.getByText(/you will no longer be able to stop it from here/),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Stop and delete" }));
		expect(onDelete).toHaveBeenCalledWith("n1", { stopFirst: true });
	});

	it("deletes a running node anyway when that is what was chosen", async () => {
		const user = userEvent.setup();
		const { onDelete } = renderCard(
			makeNode("running", { local_url: "http://localhost:9870" }),
		);

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Delete anyway" }));

		expect(onDelete).toHaveBeenCalledWith("n1", { stopFirst: false });
	});
});

describe("NodeCard: errors", () => {
	it("shows the node's own error and hands the dismissal back", async () => {
		const user = userEvent.setup();
		const { onDismissError } = renderCard(makeNode("stale"), {
			error: "Could not clean up this node: node is still running",
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"node is still running",
		);

		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onDismissError).toHaveBeenCalledWith("n1");
	});
});

// The card and the start sheet both have a button reading "Start"; this is the
// sheet's.
const submitStart = (user: ReturnType<typeof userEvent.setup>) =>
	user.click(
		within(screen.getByRole("dialog")).getByRole("button", { name: "Start" }),
	);

describe("NodeCard: the start token", () => {
	// Captured before anything stubs it, so the one test that installs a
	// refusing clipboard cannot leak it into the tests that follow.
	const pristineClipboard = Object.getOwnPropertyDescriptor(
		navigator,
		"clipboard",
	);

	afterEach(() => {
		if (pristineClipboard) {
			Object.defineProperty(navigator, "clipboard", pristineClipboard);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("asks for a token the first time, and generates one on request", async () => {
		const user = userEvent.setup();
		const { onStart } = renderCard(makeNode("stopped"));

		await user.click(screen.getByRole("button", { name: "Start" }));
		const field = screen.getByLabelText("Auth token");
		expect(field).toHaveValue("");

		await user.click(screen.getByRole("button", { name: "Generate" }));

		// 32 characters of `crypto.getRandomValues`, not a placeholder the user
		// then has to edit: the point is that nothing has to be typed.
		expect((field as HTMLInputElement).value).toHaveLength(32);

		const generated = (field as HTMLInputElement).value;
		await submitStart(user);
		expect(onStart).toHaveBeenCalledWith("n1", generated);
	});

	// The token is 32 random characters typed by hand on a phone. Throwing it
	// away on the one outcome where it is still needed is how this used to work.
	it("keeps the sheet and the token when the start fails", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stopped"), {
			onStart: vi.fn().mockResolvedValue(false),
		});

		await user.click(screen.getByRole("button", { name: "Start" }));
		await user.type(screen.getByLabelText("Auth token"), "hunter2hunter2");
		await submitStart(user);

		await waitFor(() =>
			expect(screen.getByLabelText("Auth token")).toHaveValue("hunter2hunter2"),
		);
	});

	// The card's error outlives whatever raised it, and a stale card still
	// offers Start. Echoing a refused *cleanup* into a freshly opened Start
	// sheet would announce a failure for something the user has not done yet.
	it("does not open carrying an error from an action that was not a start", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stale"), {
			error: "Could not clean up this node: permission denied",
		});

		await user.click(screen.getByRole("button", { name: "Start" }));

		const sheet = within(screen.getByRole("dialog"));
		expect(sheet.queryByText(/permission denied/)).not.toBeInTheDocument();

		// And the card's own copy is untouched: it is still the node's last
		// failure, it is just not this sheet's news to break.
		expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
	});

	it("starts on one tap once the session has a token, with no sheet", async () => {
		const user = userEvent.setup();
		let finish: (started: boolean) => void = () => {};
		const onStart = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		renderCard(makeNode("stopped"), { savedToken: "saved-token", onStart });

		await user.click(screen.getByRole("button", { name: /Start/ }));

		expect(screen.queryByLabelText("Auth token")).not.toBeInTheDocument();
		expect(onStart).toHaveBeenCalledWith("n1", "saved-token");
		// Which token the one tap used is not something to leave the user
		// guessing about, so it is said where the node's other runtime facts are.
		expect(screen.getByText("Using the saved node token")).toBeInTheDocument();

		finish(true);
		await waitFor(() =>
			expect(
				screen.queryByText("Using the saved node token"),
			).not.toBeInTheDocument(),
		);
	});

	// The generated token exists nowhere else and the field is masked, so a
	// clipboard that is simply absent — every non-secure context, which is where
	// a self-hosted cluster often lives — would otherwise lose a secret the user
	// needs again to sign in to the server it starts.
	it("shows the token to be written down when the clipboard refuses", async () => {
		const user = userEvent.setup();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: () => Promise.reject(new Error("not a secure context")),
			},
		});
		renderCard(makeNode("stopped"));

		await user.click(screen.getByRole("button", { name: "Start" }));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		const generated = (screen.getByLabelText("Auth token") as HTMLInputElement)
			.value;
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(await screen.findByText(generated)).toBeInTheDocument();
	});

	it("says so and reveals nothing when the copy works", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stopped"));

		await user.click(screen.getByRole("button", { name: "Start" }));
		await user.click(screen.getByRole("button", { name: "Generate" }));
		const generated = (screen.getByLabelText("Auth token") as HTMLInputElement)
			.value;
		await user.click(screen.getByRole("button", { name: "Copy" }));

		expect(await screen.findByText("Copied")).toBeInTheDocument();
		expect(screen.queryByText(generated)).not.toBeInTheDocument();
		expect(await navigator.clipboard.readText()).toBe(generated);
	});

	it("keeps a way back to the sheet once a token is saved", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stopped"), { savedToken: "saved-token" });

		await openMenu(user);
		await user.click(
			screen.getByRole("button", { name: "Start with a different token…" }),
		);

		expect(screen.getByLabelText("Auth token")).toHaveValue("");
	});

	it("offers no such menu item before a token is saved", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stopped"));

		await openMenu(user);

		expect(
			screen.queryByRole("button", { name: /different token/ }),
		).not.toBeInTheDocument();
	});
});

describe("NodeCard: the meta line", () => {
	const agoISO = (ms: number) => new Date(Date.now() - ms).toISOString();
	const running = (extra: Partial<NodeWithStatus["status"]>) =>
		makeNode("running", { local_url: "http://localhost:9870", ...extra });

	it("joins port and uptime with a separator", () => {
		renderCard(
			running({ port: 9870, started_at: agoISO(2 * 3600_000 + 14 * 60_000) }),
		);

		expect(screen.getByText("Port 9870 · up 2h 14m")).toBeInTheDocument();
	});

	// Not "· up 14m": a separator has to go with the part it separated, which is
	// why this is one joined string rather than two spans and a gap.
	it("drops the separator along with the half it separated", () => {
		renderCard(running({ started_at: agoISO(14 * 60_000) }));

		expect(screen.getByText("up 14m")).toBeInTheDocument();
	});

	// A port of 0 is an absent port, not a port. Rendered with `&&` it reached
	// the card as a bare "0", and a running node reporting neither fact left an
	// empty line holding the card's spacing open.
	it("says nothing at all when there is nothing to say", () => {
		renderCard(running({ port: 0 }));

		expect(screen.queryByText("0")).not.toBeInTheDocument();
		expect(screen.queryByText(/Port|up /)).not.toBeInTheDocument();
	});
});

describe("NodeCard: leaving a confirmation", () => {
	// Two words on adjacent sheets, and they mean different things: Back hands
	// the menu back, Cancel drops the whole thing. They were once one behaviour
	// wearing both labels.
	it("returns to the menu from Back", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("running", { local_url: "http://localhost:9870" }));

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Stop" }));
		await user.click(screen.getByRole("button", { name: "Back" }));

		expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
	});

	it("closes outright from Cancel", async () => {
		const user = userEvent.setup();
		renderCard(makeNode("stopped"));

		await openMenu(user);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
