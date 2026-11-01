import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasHistoryButton } from "./CanvasHistoryButton";

describe("CanvasHistoryButton", () => {
	it.each([
		null,
		0,
	])("is off, and says why, at revision %s", async (revision) => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		render(<CanvasHistoryButton revision={revision} onOpen={onOpen} />);

		const button = screen.getByRole("button", {
			name: "Canvas history: Nothing drawn yet",
		});
		expect(button).toHaveAttribute("aria-disabled", "true");
		// Off, not disabled: it stays where focus can reach it.
		expect(button).toBeEnabled();
		await user.click(button);
		expect(onOpen).not.toHaveBeenCalled();
	});

	// One page is enough: the view then opens on the current one (§15.1).
	it("opens the history once anything is drawn", async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		render(<CanvasHistoryButton revision={1} onOpen={onOpen} />);

		const button = screen.getByRole("button", { name: "Canvas history" });
		expect(button).not.toHaveAttribute("aria-disabled");
		await user.click(button);
		expect(onOpen).toHaveBeenCalledOnce();
	});
});
