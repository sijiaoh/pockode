import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { canvasActions } from "../../lib/canvasStore";
import { useWSStore } from "../../lib/wsStore";
import type { CanvasHistoryEntry, CanvasSnapshot } from "../../types/canvas";
import { CanvasHistorySheet } from "./CanvasHistorySheet";

const entry = (revision: number): CanvasHistoryEntry => ({
	revision,
	change_kind: revision === 1 ? "render" : "update",
	drawn_at: "2026-10-31T14:02:00Z",
	bytes: 10,
});

const snapshot = (revision: number): CanvasSnapshot => ({
	revision,
	html: `<p>${revision}</p>`,
	change: { kind: "render" },
	drawn_at: "2026-10-31T14:02:00Z",
});

const actions = useWSStore.getState().actions;
let canvasHistory: MockInstance<typeof actions.canvasHistory>;
let canvasSnapshot: MockInstance<typeof actions.canvasSnapshot>;

beforeEach(() => {
	// Offline, as the WebSocket starts in tests: a frame is drawn at once,
	// with no capability for the project to wait for. The reads are spied.
	canvasActions.receive("s1", { revision: 3 });
	canvasHistory = vi
		.spyOn(actions, "canvasHistory")
		.mockResolvedValue([entry(3), entry(2), entry(1)]);
	canvasSnapshot = vi
		.spyOn(actions, "canvasSnapshot")
		.mockImplementation(async (_, revision) => snapshot(revision));
});

afterEach(() => {
	vi.restoreAllMocks();
	canvasActions.forget("s1");
});

function renderSheet(
	initialRevision: number | null,
	{
		canFork = true,
		initialWasCurrent,
	}: { canFork?: boolean; initialWasCurrent?: boolean } = {},
) {
	const props = {
		sessionId: "s1",
		initialRevision,
		initialWasCurrent,
		onClose: vi.fn(),
		onGoToCanvas: vi.fn(),
		onFork: canFork ? vi.fn() : undefined,
	};
	render(
		<QueryClientProvider client={new QueryClient()}>
			<CanvasHistorySheet {...props} />
		</QueryClientProvider>,
	);
	return { user: userEvent.setup(), ...props };
}

const forkButton = () => screen.getByRole("button", { name: "Fork" });

const page = (revision: number) =>
	screen.findByTitle(`Canvas revision ${revision}`);
const stepper = () =>
	screen.getByRole("button", { name: /^Revision \d+ of \d+$/ });

describe("CanvasHistorySheet", () => {
	it("opens from the panel on the newest earlier page, read-only", async () => {
		renderSheet(null);

		expect(await page(2)).toBeInTheDocument();
		expect(stepper()).toHaveTextContent("Revision 2 of 3");
		expect(screen.getByText(/^Revision 2 · updated · /)).toBeInTheDocument();
		expect(screen.getByText("Earlier version · read-only")).toBeInTheDocument();
	});

	it("steps to the older and newer pages, stopping at the ends", async () => {
		const { user } = renderSheet(2);
		await page(2);

		await user.click(screen.getByRole("button", { name: "Older page" }));
		expect(await page(1)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Older page" })).toBeDisabled();
		// Not dropped out of the sheet with the button that had it.
		expect(stepper()).toHaveFocus();

		await user.click(screen.getByRole("button", { name: "Newer page" }));
		expect(screen.getByRole("button", { name: "Newer page" })).toHaveFocus();
		await user.click(screen.getByRole("button", { name: "Newer page" }));
		expect(await page(3)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Newer page" })).toBeDisabled();
		expect(stepper()).toHaveFocus();
	});

	it("offers canvas view from the current page", async () => {
		const { user, onGoToCanvas } = renderSheet(3);
		await page(3);

		expect(
			screen.getByText("Current page · read-only here"),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Go to canvas" }));
		expect(onGoToCanvas).toHaveBeenCalledOnce();
	});

	// The user chose this page: a new one does not move the view (§15.3).
	it("stays on a page a newer one replaced, and offers the newest", async () => {
		const { user } = renderSheet(3);
		await page(3);

		canvasHistory.mockResolvedValue([entry(4), entry(3), entry(2), entry(1)]);
		act(() => canvasActions.receive("s1", { revision: 4 }));
		expect(
			await screen.findByText("Earlier version · a newer page was drawn"),
		).toBeInTheDocument();
		expect(await page(3)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Newest" }));
		expect(await page(4)).toBeInTheDocument();
		expect(stepper()).toHaveFocus();
		expect(stepper()).toHaveTextContent("Revision 4 of 4");
	});

	it("knows a newer page replaced it when the current one was only known after it opened", async () => {
		canvasActions.forget("s1");
		renderSheet(3);
		await page(3);

		act(() => canvasActions.receive("s1", { revision: 3 }));
		expect(
			await screen.findByText("Current page · read-only here"),
		).toBeInTheDocument();
		act(() => canvasActions.receive("s1", { revision: 4 }));
		expect(
			await screen.findByText("Earlier version · a newer page was drawn"),
		).toBeInTheDocument();
	});

	describe("the revision list", () => {
		it("opens a page picked from it", async () => {
			const { user } = renderSheet(2);
			await page(2);

			await user.click(stepper());
			const open = screen.getByRole("button", { name: /^Revision 2 ·/ });
			expect(open).toHaveAttribute("aria-current", "true");
			expect(open).toHaveFocus();
			expect(
				screen.getByRole("button", { name: "Revision 3 · current" }),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: /^Revision 1 ·/ }));
			expect(await page(1)).toBeInTheDocument();
			expect(stepper()).toHaveFocus();
		});

		// A layer of its own: Escape returns to the page, and the view stays.
		it("puts itself away on Escape, leaving the view up", async () => {
			const { user, onClose } = renderSheet(2);
			await page(2);

			await user.click(stepper());
			await user.keyboard("{Escape}");
			expect(await page(2)).toBeInTheDocument();
			expect(stepper()).toHaveFocus();
			expect(onClose).not.toHaveBeenCalled();

			await user.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalledOnce();
		});

		it("puts itself away on Escape from the footer too", async () => {
			const { user, onClose } = renderSheet(2);
			await page(2);

			await user.click(stepper());
			stepper().focus();
			await user.keyboard("{Escape}");
			expect(await page(2)).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe("a read failing", () => {
		// Show draws its page without the list, so the list's failure is said
		// beside the page rather than lost behind it.
		it("says the list could not be read under a page Show opened, with Retry", async () => {
			canvasHistory.mockRejectedValueOnce(new Error("internal error"));
			const { user } = renderSheet(2);
			await page(2);

			expect(
				await screen.findByText("The list could not be read: internal error"),
			).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Older page" })).toBeDisabled();
			await user.click(screen.getByRole("button", { name: "Retry" }));
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Older page" }),
				).toBeEnabled(),
			);
		});

		it("offers Retry, which reads it again", async () => {
			canvasSnapshot.mockRejectedValueOnce(new Error("internal error"));
			const { user } = renderSheet(2);

			expect(await screen.findByText("internal error")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Retry" }));
			expect(await page(2)).toBeInTheDocument();
		});

		// Reachable through Show only, since the list leaves it out (§15.5).
		it("offers no Retry for a page lost from disk", async () => {
			const lost =
				"the canvas has no such revision: revision 2 was lost from disk";
			canvasSnapshot.mockRejectedValueOnce(
				new JSONRPCErrorException(lost, JSONRPCErrorCode.InvalidParams),
			);
			canvasHistory.mockResolvedValue([entry(3), entry(1)]);
			renderSheet(2);

			expect(await screen.findByText(lost)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Older page" }),
				).toBeEnabled(),
			);
		});

		it("says so when the list comes back empty", async () => {
			canvasHistory.mockResolvedValue([]);
			renderSheet(null);

			expect(
				await screen.findByText("No page of this canvas could be read."),
			).toBeInTheDocument();
		});
	});

	describe("Fork", () => {
		it("forks from the page shown, naming it for the fork sheet", async () => {
			const { user, onFork } = renderSheet(2);
			await page(2);
			await waitFor(() =>
				expect(forkButton()).toHaveAttribute("aria-disabled", "false"),
			);

			await user.click(forkButton());
			expect(onFork).toHaveBeenCalledWith({
				revision: 2,
				description: expect.stringMatching(/^Canvas · revision 2 · updated · /),
				wasCurrent: false,
			});
		});

		// Said before the user asks, beside the button and to a screen reader
		// with it (§15.6).
		it.each([
			["pending", "Can't fork from this page until its call returns."],
			[
				"no_record",
				"Can't fork from this page: its call was never recorded in the conversation.",
			],
			[
				"superseded",
				"Can't fork from this page: a later page was drawn before its call returned.",
			],
			[
				"subagent",
				"Can't fork from this page: a subagent drew it, and a fork can't be cut inside a subagent's run.",
			],
		] as const)("says why it cannot fork a %s page", async (blocked, reason) => {
			canvasHistory.mockResolvedValue([
				entry(3),
				{ ...entry(2), fork_blocked: blocked },
				entry(1),
			]);
			const { user, onFork } = renderSheet(2);
			await page(2);

			expect(await screen.findByText(reason)).toBeInTheDocument();
			expect(forkButton()).toHaveAttribute("aria-disabled", "true");
			expect(forkButton()).toHaveAccessibleDescription(reason);
			await user.click(forkButton());
			expect(onFork).not.toHaveBeenCalled();
		});

		it("cannot fork a page that could not be read", async () => {
			canvasSnapshot.mockRejectedValueOnce(new Error("internal error"));
			renderSheet(2);

			expect(
				await screen.findByText("This page could not be read."),
			).toBeInTheDocument();
			expect(forkButton()).toHaveAttribute("aria-disabled", "true");
		});

		it("waits, without a reason, for the list", async () => {
			canvasHistory.mockReturnValue(new Promise(() => {}));
			renderSheet(2);
			await page(2);

			expect(forkButton()).toHaveAttribute("aria-disabled", "true");
			expect(forkButton()).not.toHaveAccessibleDescription();
		});

		// Back from the fork sheet's Cancel, on a page that was current when
		// Fork was pressed and has since been replaced (§15.4).
		it("hands over, and takes back, that the page was the current one", async () => {
			const { user, onFork } = renderSheet(3);
			await page(3);
			await waitFor(() =>
				expect(forkButton()).toHaveAttribute("aria-disabled", "false"),
			);
			await user.click(forkButton());
			expect(onFork).toHaveBeenCalledWith(
				expect.objectContaining({ revision: 3, wasCurrent: true }),
			);
		});

		it("reopens on a page that was current, saying a newer one was drawn", async () => {
			act(() => canvasActions.receive("s1", { revision: 4 }));
			renderSheet(3, { initialWasCurrent: true });
			await page(3);

			expect(
				screen.getByText("Earlier version · a newer page was drawn"),
			).toBeInTheDocument();
		});

		it("is not drawn where no fork could be made", async () => {
			renderSheet(2, { canFork: false });
			await page(2);

			expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
		});

		// Nothing pushes a `pending` clearing: the result's record is what
		// says so (§15.3).
		it("comes on once a pending page's call has returned", async () => {
			canvasHistory.mockResolvedValue([
				{ ...entry(3), fork_blocked: "pending" },
				entry(2),
				entry(1),
			]);
			renderSheet(3);
			await page(3);
			expect(
				await screen.findByText(
					"Can't fork from this page until its call returns.",
				),
			).toBeInTheDocument();

			canvasHistory.mockResolvedValue([entry(3), entry(2), entry(1)]);
			act(() => canvasActions.callSettled());
			await waitFor(() =>
				expect(forkButton()).toHaveAttribute("aria-disabled", "false"),
			);
		});
	});
});
