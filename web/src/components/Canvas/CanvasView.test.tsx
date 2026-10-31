import { LayerHistoryContext } from "@pockode/shared";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { layerHistoryFor } from "../../lib/layerHistory";
import {
	permissionRequestActions,
	usePermissionRequestStore,
} from "../../lib/permissionRequestStore";
import type { SessionTurn } from "../../types/message";
import { type CanvasPermissions, CanvasView } from "./CanvasView";

// No canvas in the store, so no frame: what is under test here is the
// permission layer drawn in the column, not the page.

const IDLE: SessionTurn = { phase: "idle", open: false, since: "" };
const BLOCKED: SessionTurn = {
	phase: "blocked",
	open: true,
	since: "",
	blockers: [{ kind: "permission", request_id: "a", raised_at: "" }],
};

const permissions = (turn: SessionTurn): CanvasPermissions => ({
	turn,
	turnKnown: true,
	transcript: new Map(),
	isCodex: false,
	onRespond: vi.fn(),
});

function ui(turn: SessionTurn, shown = true) {
	return (
		<>
			<button type="button">Header</button>
			<CanvasView
				sessionId="s1"
				shown={shown}
				turnRunning={false}
				onSend={async () => {}}
				permissions={permissions(turn)}
			/>
		</>
	);
}

describe("CanvasView's permission panel", () => {
	beforeEach(() => {
		usePermissionRequestStore.setState({
			sessionId: null,
			records: {},
			outcomes: {},
			unreadable: {},
		});
		permissionRequestActions.reset("s1", [
			{
				requestId: "a",
				toolName: "Bash",
				toolInput: { command: "npm test" },
				toolUseId: "tool-a",
			},
		]);
	});

	it("takes focus as it opens only if the block took it away", () => {
		const { rerender, unmount } = render(ui(IDLE));
		rerender(ui(BLOCKED));
		expect(screen.getByRole("dialog")).toHaveFocus();
		unmount();

		const second = render(ui(IDLE));
		screen.getByRole("button", { name: "Header" }).focus();
		second.rerender(ui(BLOCKED));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Header" })).toHaveFocus();
	});

	it("hides to the banner, which takes focus, and Show brings it back focused", async () => {
		const user = userEvent.setup();
		render(ui(BLOCKED));
		await user.click(screen.getByRole("button", { name: /Hide/ }));
		const banner = screen.getByRole("button", {
			name: /1 permission request waiting/,
		});
		expect(banner).toHaveFocus();
		expect(banner).toHaveAccessibleName(/npm test/);

		await user.click(banner);
		expect(screen.getByRole("dialog")).toHaveFocus();
	});

	it("is left as it was by a navigation away and back, and collapsed by Back", async () => {
		const history = createMemoryHistory({ initialEntries: ["/session"] });
		const view = (shown: boolean) => (
			<LayerHistoryContext value={layerHistoryFor(history)}>
				{ui(BLOCKED, shown)}
			</LayerHistoryContext>
		);
		const { rerender } = render(view(true));
		await waitFor(() =>
			expect(history.location.state).toHaveProperty("pockodeLayers"),
		);

		// A file link in a card: the navigation goes back over the panel's
		// entry first.
		history.push("/file");
		await waitFor(() => expect(history.location.pathname).toBe("/file"));
		// Long enough for an entry pushed a tick late to have been pushed.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(history.location.state).not.toHaveProperty("pockodeLayers");
		rerender(view(false));
		rerender(view(true));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await waitFor(() =>
			expect(history.location.state).toHaveProperty("pockodeLayers"),
		);
		history.back();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			screen.getByRole("button", { name: /permission request waiting/ }),
		).toBeInTheDocument();
	});

	it("claims Escape where a navigation landing under it left it uncounted", async () => {
		const user = userEvent.setup();
		const history = createMemoryHistory({ initialEntries: ["/session"] });
		render(
			<LayerHistoryContext value={layerHistoryFor(history)}>
				{ui(BLOCKED)}
			</LayerHistoryContext>,
		);
		await waitFor(() =>
			expect(history.location.state).toHaveProperty("pockodeLayers"),
		);
		// The open session's own row, tapped in the drawer: the panel stays on
		// the screen without its entry.
		history.push("/session");
		await waitFor(() =>
			expect(history.location.state).not.toHaveProperty("pockodeLayers"),
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		// Where `ChatPanel` listens for its interrupt.
		const interrupt = vi.fn();
		const onKey = (e: KeyboardEvent) => {
			if (!e.defaultPrevented) interrupt();
		};
		document.addEventListener("keydown", onKey);
		try {
			await user.keyboard("{Escape}");
		} finally {
			document.removeEventListener("keydown", onKey);
		}
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(interrupt).not.toHaveBeenCalled();
	});
});
