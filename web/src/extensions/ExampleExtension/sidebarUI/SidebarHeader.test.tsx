import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarContainerContext } from "../../../lib/sidebarContainerContext";
import SidebarHeader from "./SidebarHeader";

function renderHeader(isExpanded: boolean, onClose: () => void) {
	render(
		<SidebarContainerContext.Provider
			value={{ isOpen: true, onClose, isExpanded }}
		>
			<SidebarHeader />
		</SidebarContainerContext.Provider>,
	);
}

describe("SidebarHeader", () => {
	it("collapses the column", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderHeader(true, onClose);

		const button = screen.getByRole("button", { name: "Collapse sidebar" });
		expect(button).toHaveAttribute("aria-expanded", "true");
		await user.click(button);

		expect(onClose).toHaveBeenCalled();
	});

	it("closes the drawer", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderHeader(false, onClose);

		const button = screen.getByRole("button", { name: "Close sidebar" });
		expect(button).not.toHaveAttribute("aria-expanded");
		await user.click(button);

		expect(onClose).toHaveBeenCalled();
	});
});
