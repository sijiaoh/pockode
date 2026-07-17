import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../lib/settingsStore";
import WorktreeSection from "./WorktreeSection";

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

vi.mock("../../../lib/navigation", () => ({
	overlayToNavigation: vi.fn(() => ({})),
	SETUP_HOOK_PATH: "/setup",
}));

const mockUpdateSettings = vi.fn();

vi.mock("../../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({ actions: { updateSettings: mockUpdateSettings } }),
	),
}));

describe("WorktreeSection", () => {
	beforeEach(() => {
		useSettingsStore.setState({ settings: { worktree_base_dir: "" } });
		mockUpdateSettings.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		useSettingsStore.getState().reset();
		vi.clearAllMocks();
	});

	it("shows Save only after the base path is edited and persists the trimmed value", async () => {
		const user = userEvent.setup();
		render(<WorktreeSection />);

		const input = screen.getByLabelText("Base Path");
		expect(
			screen.queryByRole("button", { name: "Save" }),
		).not.toBeInTheDocument();

		await user.type(input, "  /home/me/worktrees  ");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(mockUpdateSettings).toHaveBeenCalledWith({
			worktree_base_dir: "/home/me/worktrees",
		});
	});

	it("surfaces the backend validation error and keeps the invalid input for correction", async () => {
		const user = userEvent.setup();
		mockUpdateSettings.mockRejectedValueOnce(
			new Error("worktree_base_dir must be an absolute path"),
		);
		render(<WorktreeSection />);

		const input = screen.getByLabelText("Base Path");
		await user.type(input, "relative/path");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"worktree_base_dir must be an absolute path",
		);
		expect(input).toHaveValue("relative/path");
	});

	it("resets the input back to the persisted value", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({
			settings: { worktree_base_dir: "/persisted" },
		});
		render(<WorktreeSection />);

		const input = screen.getByLabelText("Base Path");
		await user.clear(input);
		await user.type(input, "/changed");
		await user.click(screen.getByRole("button", { name: "Reset" }));

		await waitFor(() => expect(input).toHaveValue("/persisted"));
		expect(mockUpdateSettings).not.toHaveBeenCalled();
	});
});
