import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortPreviewStore } from "../../lib/portPreviewStore";
import { wsActions } from "../../lib/wsStore";
import PortPreviewSheet from "./PortPreviewSheet";

const REMOTE_URL = "https://abc123.cloud.pockode.com";
const PREVIEW_5173 = "https://abc123-5173.cloud.pockode.com/";
const LOGIN_5173 = `${PREVIEW_5173}__pockode/preview/login?ticket=t1`;

function openTab() {
	const tab = { opener: window, closed: false, location: { replace: vi.fn() } };
	const open = vi
		.spyOn(window, "open")
		.mockReturnValue(tab as unknown as Window);
	return { open, replace: tab.location.replace };
}

describe("PortPreviewSheet", () => {
	beforeEach(() => {
		localStorage.clear();
		usePortPreviewStore.setState({ recentPorts: [] });
		vi.spyOn(wsActions, "portPreviewTicket").mockResolvedValue("t1");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("opens the typed port logged in and closes", async () => {
		const { open, replace } = openTab();
		const onClose = vi.fn();
		render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={onClose} />);

		await userEvent.setup().type(screen.getByLabelText("Port"), "5173{Enter}");

		expect(open).toHaveBeenCalledWith("", "_blank");
		await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(LOGIN_5173));
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
		).toHaveAttribute("href", PREVIEW_5173);

		// A retry that is blocked again is a new alert, so it is announced again.
		await user.keyboard("{Enter}");
		expect(screen.getByRole("alert")).not.toBe(alert);
	});

	// fireEvent rather than userEvent: its return value is whether the link's
	// own navigation went ahead, which is the fallback under test.
	describe("a recent port", () => {
		beforeEach(() => {
			usePortPreviewStore.setState({ recentPorts: [5173] });
		});

		function link() {
			return screen.getByRole("link", { name: "localhost:5173" });
		}

		it("opens logged in on a plain click, keeping the ticket out of the link", async () => {
			const { replace } = openTab();
			const onClose = vi.fn();
			render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={onClose} />);

			expect(link()).toHaveAttribute("href", PREVIEW_5173);
			expect(fireEvent.click(link())).toBe(false);

			await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(LOGIN_5173));
			expect(link()).toHaveAttribute("href", PREVIEW_5173);
			expect(onClose).toHaveBeenCalled();
		});

		it("falls back to the link when the tab is blocked", () => {
			vi.spyOn(window, "open").mockReturnValue(null);
			const onClose = vi.fn();
			render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={onClose} />);

			expect(fireEvent.click(link())).toBe(true);
			expect(onClose).toHaveBeenCalled();
		});

		it("leaves a modified click to the link", () => {
			const { open } = openTab();
			render(<PortPreviewSheet remoteUrl={REMOTE_URL} onClose={vi.fn()} />);

			expect(fireEvent.click(link(), { ctrlKey: true })).toBe(true);
			expect(open).not.toHaveBeenCalled();
			expect(wsActions.portPreviewTicket).not.toHaveBeenCalled();
		});
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
