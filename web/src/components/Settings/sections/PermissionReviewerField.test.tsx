import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../../lib/agentOptionsStore";
import { useSettingsStore } from "../../../lib/settingsStore";
import PermissionReviewerField from "./PermissionReviewerField";

const updateSettings = vi.fn();

vi.mock("../../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({ actions: { updateSettings } }),
}));

const claudeRow = () =>
	screen.getByRole("button", { name: /^Claude permission reviewer:/ });

beforeEach(() => {
	updateSettings.mockReset().mockResolvedValue(undefined);
	useSettingsStore.setState({ settings: {}, error: null, refresh: null });
	useAgentOptionsStore.setState({
		models: {
			claude: [{ id: "haiku", label: "Haiku" }],
			codex: [{ id: "gpt-5", label: "GPT-5" }],
		},
		efforts: {
			claude: [{ id: "low", label: "Low" }],
			codex: [{ id: "high", label: "High" }],
		},
		error: null,
	});
});

describe("PermissionReviewerField", () => {
	// Only Claude has a reviewer: no row may suggest a Codex one exists.
	it("shows Claude's reviewer engine and no other agent's", () => {
		useSettingsStore.setState({
			settings: {
				permission_reviewer: { claude: { model: "haiku", effort: "low" } },
			},
		});
		render(<PermissionReviewerField valueState="known" />);

		expect(claudeRow()).toHaveTextContent("Claude · Haiku · Low");
		expect(
			screen.queryByRole("button", { name: /Codex/ }),
		).not.toBeInTheDocument();
	});

	it("offers model and effort, but no agent", async () => {
		const user = userEvent.setup();
		render(<PermissionReviewerField valueState="known" />);

		await user.click(claudeRow());

		expect(screen.getByRole("radio", { name: /Haiku/ })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /Low/ })).toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /Codex|GPT-5/ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Agent")).not.toBeInTheDocument();
	});

	// `settings.update` replaces the object, so a change to the model that left
	// the effort out would put the effort back on Auto.
	it("sends the other field along with a change", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({
			settings: { permission_reviewer: { claude: { effort: "low" } } },
		});
		render(<PermissionReviewerField valueState="known" />);

		await user.click(claudeRow());
		await user.click(screen.getByRole("radio", { name: /Haiku/ }));

		expect(updateSettings).toHaveBeenCalledWith({
			permission_reviewer: { claude: { model: "haiku", effort: "low" } },
		});
	});

	it("puts a value back on Auto as empty", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({
			settings: {
				permission_reviewer: { claude: { model: "haiku", effort: "low" } },
			},
		});
		render(<PermissionReviewerField valueState="known" />);

		await user.click(claudeRow());
		// The Effort section's Auto row: the second of the two.
		await user.click(screen.getAllByRole("radio", { name: /Auto/ })[1]);

		expect(updateSettings).toHaveBeenCalledWith({
			permission_reviewer: { claude: { model: "haiku", effort: "" } },
		});
	});

	it("reports a refused change in the panel", async () => {
		const user = userEvent.setup();
		updateSettings.mockRejectedValue(new Error("unknown model"));
		render(<PermissionReviewerField valueState="known" />);

		await user.click(claudeRow());
		await user.click(screen.getByRole("radio", { name: /Haiku/ }));

		expect(await screen.findByRole("alert")).toHaveTextContent("unknown model");
	});

	// Before the snapshot, the resolved Auto would claim a value nobody read.
	it("draws no values and takes no input until the settings arrive", () => {
		useSettingsStore.setState({ settings: null });
		render(<PermissionReviewerField valueState="pending" />);

		expect(
			screen.getByRole("button", {
				name: "Claude permission reviewer: loading",
			}),
		).toBeDisabled();
	});
});
