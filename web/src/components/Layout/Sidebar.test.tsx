import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
