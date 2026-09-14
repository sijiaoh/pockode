import { act, render, screen, waitFor } from "@testing-library/react";
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
		useSettingsStore.setState({
			settings: { worktree_base_dir: "" },
			error: null,
			refresh: null,
		});
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

	it("shows the default base path as a placeholder when empty", () => {
		render(<WorktreeSection />);

		expect(screen.getByLabelText("Base Path")).toHaveAttribute(
			"placeholder",
			"../<repo>-worktrees",
		);
	});

	it("surfaces the backend validation error and keeps the invalid input for correction", async () => {
		const user = userEvent.setup();
		mockUpdateSettings.mockRejectedValueOnce(
			new Error(
				"worktree base directory must be absolute or start with './', '../', or '~/'",
			),
		);
		render(<WorktreeSection />);

		const input = screen.getByLabelText("Base Path");
		await user.type(input, "relative/path");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"worktree base directory must be absolute or start with",
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

	// An empty field under the default placeholder reads as "not set, using the
	// default" — a claim about settings nobody has been told yet, and one a user
	// who set an absolute path would have to notice to disbelieve.
	describe("before the settings snapshot arrives", () => {
		beforeEach(() => {
			useSettingsStore.setState({ settings: null });
		});

		it("offers no field to type a path nobody knows into", () => {
			render(<WorktreeSection />);

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			// The same path still appears in the help text below, which documents
			// the default rather than claiming this is what is set.
			expect(
				screen.queryByPlaceholderText("../<repo>-worktrees"),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("status", { name: "Base Path: loading" }),
			).toBeInTheDocument();
		});

		// The draft outlives the field: `baseDir` was already "", so the effect
		// that resyncs the input never fires, and Save would go on offering to
		// write a path composed from a snapshot that is not there.
		it("takes Save away with the field a draft was typed into", async () => {
			const user = userEvent.setup();
			useSettingsStore.setState({ settings: { worktree_base_dir: "" } });
			render(<WorktreeSection />);
			await user.type(screen.getByRole("textbox"), "/trees");
			expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

			act(() => {
				useSettingsStore.getState().reset();
			});

			expect(
				screen.queryByRole("button", { name: "Save" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Reset" }),
			).not.toBeInTheDocument();
		});

		it("says so, instead of waiting forever, once the snapshot is known not to be coming", () => {
			useSettingsStore.setState({ error: "subscribe failed" });
			render(<WorktreeSection />);

			expect(screen.getByRole("alert")).toHaveTextContent(
				"Couldn't load settings: subscribe failed",
			);
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		});
	});
});
