import { LayerHistoryContext } from "@pockode/shared";
import { createMemoryHistory } from "@tanstack/react-router";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layerHistoryFor } from "../../lib/layerHistory";
import Sidebar from "./Sidebar";

// Stands in for the answer panel, which listens on `window` precisely so that
// it is asked after every `document` listener has had the press.
let unhandled = 0;
const behind = (e: KeyboardEvent) => {
	if (e.key === "Escape" && !e.defaultPrevented) unhandled += 1;
};
window.addEventListener("keydown", behind);
afterEach(() => {
	unhandled = 0;
});

describe("Sidebar", () => {
	// The drawer opens from the session header, which stays lit under the chat's
	// answer panel — so the drawer can be the thing on top while a panel that
	// also closes on Escape sits behind it. Marking the press is what keeps one
	// press to one surface (docs/answering-ui.md §4, "Who owns Escape").
	it("closes on Escape and marks the press handled", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();

		render(
			<Sidebar isOpen onClose={onClose} isExpanded={false}>
				<p>sessions</p>
			</Sidebar>,
		);
		expect(screen.getByText("sessions")).toBeInTheDocument();

		await user.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(unhandled).toBe(0);
	});

	// Material's navigation drawer: the back gesture puts it away before it
	// ever leaves the page (docs/project-ui.md §5.2).
	it("closes the drawer on Back, leaving the page", async () => {
		const history = createMemoryHistory({ initialEntries: ["/a", "/b"] });
		const onClose = vi.fn();
		render(
			<LayerHistoryContext value={layerHistoryFor(history)}>
				<Sidebar isOpen onClose={onClose} isExpanded={false}>
					<p>sessions</p>
				</Sidebar>
			</LayerHistoryContext>,
		);
		await waitFor(() => expect(history.location.state.__TSR_index).toBe(2));

		act(() => history.back());

		expect(onClose).toHaveBeenCalledOnce();
		expect(history.location.pathname).toBe("/b");
	});

	// The drawer becomes the column, which is part of the page: its entry goes,
	// and no resize ever raises one.
	it("takes the drawer's entry back as it becomes the column", async () => {
		const history = createMemoryHistory({ initialEntries: ["/a", "/b"] });
		const sidebar = (expanded: boolean) => (
			<LayerHistoryContext value={layerHistoryFor(history)}>
				<Sidebar isOpen onClose={() => {}} isExpanded={expanded}>
					<p>sessions</p>
				</Sidebar>
			</LayerHistoryContext>
		);
		const { rerender } = render(sidebar(false));
		await waitFor(() => expect(history.location.state.__TSR_index).toBe(2));

		rerender(sidebar(true));

		await waitFor(() => expect(history.location.state.__TSR_index).toBe(1));
		expect(history.location.pathname).toBe("/b");
	});

	// Closed, it is a drawer nobody can see: the key belongs to whatever is on
	// screen instead.
	it("leaves Escape alone while it is closed", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();

		render(
			<Sidebar isOpen={false} onClose={onClose} isExpanded={false}>
				<p>sessions</p>
			</Sidebar>,
		);

		await user.keyboard("{Escape}");

		expect(onClose).not.toHaveBeenCalled();
		expect(unhandled).toBe(1);
	});

	// A modal: focus goes in with it, onto the panel that names it rather than
	// onto whichever control the content puts first. Handing it back is the
	// shell's (AppShell.test.tsx), since only the shell saw the opener.
	it("is a modal dialog that takes focus as it opens", () => {
		const { rerender } = render(
			<Sidebar isOpen={false} onClose={vi.fn()} isExpanded={false}>
				<button type="button">New Session</button>
			</Sidebar>,
		);
		expect(document.body).toHaveFocus();

		rerender(
			<Sidebar isOpen onClose={vi.fn()} isExpanded={false}>
				<button type="button">New Session</button>
			</Sidebar>,
		);

		const dialog = screen.getByRole("dialog", { name: "Sidebar" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toContainElement(document.activeElement as HTMLElement);
		expect(
			screen.getByRole("button", { name: "New Session" }),
		).not.toHaveFocus();
	});

	// The column is part of the page, not drawn over it.
	it("is no dialog in the expanded tier", () => {
		render(
			<Sidebar isOpen onClose={vi.fn()} isExpanded>
				<button type="button">New Session</button>
			</Sidebar>,
		);

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.body).toHaveFocus();
	});

	// Hidden, not unmounted: what the user left open inside comes back with it.
	it("keeps its content mounted while the column is collapsed", () => {
		render(
			<Sidebar isOpen={false} onClose={vi.fn()} isExpanded>
				<p>sessions</p>
			</Sidebar>,
		);

		// jsdom has no stylesheet, so `display: none` is read off the class.
		expect(screen.getByText("sessions").closest("aside")).toHaveClass("hidden");
	});

	// Expanding within the tier is a press, so focus follows it onto the
	// column; arriving in the tier with the column already shown is not.
	it("takes focus when expanded back, and only then", () => {
		const renderSidebar = (isOpen: boolean, isExpanded: boolean) => (
			<Sidebar isOpen={isOpen} onClose={vi.fn()} isExpanded={isExpanded}>
				<button type="button">New Session</button>
			</Sidebar>
		);
		const { rerender } = render(renderSidebar(false, false));

		rerender(renderSidebar(true, true));
		expect(document.body).toHaveFocus();

		rerender(renderSidebar(false, true));
		rerender(renderSidebar(true, true));
		expect(
			screen.getByRole("complementary", { name: "Sidebar" }),
		).toHaveFocus();
	});
});

describe("Sidebar resize handle", () => {
	afterEach(() => {
		localStorage.clear();
	});

	const renderExpanded = () =>
		render(
			<Sidebar isOpen onClose={vi.fn()} isExpanded>
				<p>sessions</p>
			</Sidebar>,
		);

	it("is announced as the column's adjustable edge", () => {
		renderExpanded();

		const handle = screen.getByRole("separator", { name: "Resize sidebar" });
		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		expect(handle).toHaveAttribute("aria-valuenow", "320");
		expect(handle).toHaveAttribute("aria-valuemin", "280");
		expect(handle).toHaveAttribute("aria-valuemax", "500");
		const column = document.getElementById(
			handle.getAttribute("aria-controls") ?? "",
		);
		expect(column).toContainElement(screen.getByText("sessions"));
		expect(column).toHaveStyle({ width: "320px" });
	});

	// Each press is final, so it is kept the way a released drag is.
	it("resizes from the keyboard within the limits and remembers the width", async () => {
		const user = userEvent.setup();
		renderExpanded();
		const handle = screen.getByRole("separator", { name: "Resize sidebar" });

		await user.tab();
		expect(handle).toHaveFocus();

		await user.keyboard("{ArrowRight}");
		expect(handle).toHaveAttribute("aria-valuenow", "336");
		expect(localStorage.getItem("pockode:sidebar-width")).toBe("336");

		await user.keyboard("{ArrowLeft}{ArrowLeft}");
		expect(handle).toHaveAttribute("aria-valuenow", "304");

		await user.keyboard("{End}{ArrowRight}");
		expect(handle).toHaveAttribute("aria-valuenow", "500");
		expect(localStorage.getItem("pockode:sidebar-width")).toBe("500");

		await user.keyboard("{Home}{ArrowLeft}");
		expect(handle).toHaveAttribute("aria-valuenow", "280");
		expect(localStorage.getItem("pockode:sidebar-width")).toBe("280");
	});

	it("leaves modified arrows to the browser", async () => {
		const user = userEvent.setup();
		renderExpanded();
		const handle = screen.getByRole("separator", { name: "Resize sidebar" });
		handle.focus();

		await user.keyboard(
			"{Alt>}{ArrowLeft}{/Alt}{Control>}{ArrowRight}{/Control}",
		);

		expect(handle).toHaveAttribute("aria-valuenow", "320");
		expect(localStorage.getItem("pockode:sidebar-width")).toBeNull();
	});

	// Collapsing takes the handle away mid-drag, so no release ever reaches it.
	it("ends a drag the column is collapsed under", () => {
		const renderSidebar = (isOpen: boolean) => (
			<Sidebar isOpen={isOpen} onClose={vi.fn()} isExpanded>
				<p>sessions</p>
			</Sidebar>
		);
		const { rerender } = render(renderSidebar(true));
		const handle = screen.getByRole("separator", { name: "Resize sidebar" });
		handle.setPointerCapture = vi.fn();

		fireEvent.pointerDown(handle, { pointerId: 1 });
		expect(document.body.style.cursor).toBe("col-resize");

		rerender(renderSidebar(false));
		expect(document.body.style.cursor).toBe("");
		expect(document.body.style.userSelect).toBe("");
	});

	it("opens at the width it was left at", () => {
		localStorage.setItem("pockode:sidebar-width", "400");
		renderExpanded();

		expect(
			screen.getByRole("separator", { name: "Resize sidebar" }),
		).toHaveAttribute("aria-valuenow", "400");
	});
});
