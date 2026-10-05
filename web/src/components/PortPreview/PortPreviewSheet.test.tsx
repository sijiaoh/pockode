import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortPreviewStore } from "../../lib/portPreviewStore";
import PortPreviewSheet from "./PortPreviewSheet";

const REMOTE_URL = "https://abc123.cloud.pockode.com";

describe("PortPreviewSheet", () => {
	beforeEach(() => {
		localStorage.clear();
		usePortPreviewStore.setState({ recentPorts: [] });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("opens the preview of the typed port and closes", async () => {
		const open = vi
			.spyOn(window, "open")
			.mockReturnValue({ opener: window } as unknown as Window);
		const onClose = vi.fn();
		render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={onClose} />);

		await userEvent.setup().type(screen.getByLabelText("Port"), "5173{Enter}");

		expect(open).toHaveBeenCalledWith(
			"https://abc123-5173.cloud.pockode.com/",
			"_blank",
		);
		expect(onClose).toHaveBeenCalled();
		expect(usePortPreviewStore.getState().recentPorts).toEqual([5173]);
	});

	it("refuses a port out of range", async () => {
		render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={vi.fn()} />);

		await userEvent.setup().type(screen.getByLabelText("Port"), "70000");

		expect(screen.getByLabelText("Port")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
	});

	it("stays open with a link to the port when the tab is blocked", async () => {
		vi.spyOn(window, "open").mockReturnValue(null);
		const onClose = vi.fn();
		render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={onClose} />);

		const user = userEvent.setup();

		await user.type(screen.getByLabelText("Port"), "5173{Enter}");

		expect(onClose).not.toHaveBeenCalled();
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("The browser blocked the new tab");
		expect(
			screen.getByRole("link", { name: "localhost:5173" }),
		).toHaveAttribute("href", "https://abc123-5173.cloud.pockode.com/");

		// A retry that is blocked again is a new alert, so it is announced again.
		await user.keyboard("{Enter}");
		expect(screen.getByRole("alert")).not.toBe(alert);
	});

	it("keeps focus in the sheet as recent ports are removed", async () => {
		usePortPreviewStore.setState({ recentPorts: [5173, 6006] });
		render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={vi.fn()} />);
		const user = userEvent.setup();

		await user.click(
			screen.getByRole("button", { name: "Remove localhost:5173 from recent" }),
		);
		expect(
			screen.getByRole("button", { name: "Remove localhost:6006 from recent" }),
		).toHaveFocus();

		await user.click(
			screen.getByRole("button", { name: "Remove localhost:6006 from recent" }),
		);
		expect(screen.getByLabelText("Port")).toHaveFocus();
		expect(usePortPreviewStore.getState().recentPorts).toEqual([]);
	});
});
