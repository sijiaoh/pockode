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
const codexRow = () =>
	screen.getByRole("button", { name: /^Codex permission reviewer:/ });

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
	it("shows each agent's reviewer engine, Auto where nothing is set", () => {
		useSettingsStore.setState({
			settings: {
				permission_reviewer: { claude: { model: "haiku", effort: "low" } },
			},
		});
		render(<PermissionReviewerField valueState="known" />);

		expect(claudeRow()).toHaveTextContent("Claude · Haiku · Low");
		expect(codexRow()).toHaveTextContent("Codex · Auto");
	});

	// A reviewer runs on its main session's agent; the row configures that
	// agent's reviewer, and switching the agent would mean editing the other row.
	it("offers model and effort, but no agent", async () => {
		const user = userEvent.setup();
		render(<PermissionReviewerField valueState="known" />);

		await user.click(codexRow());

		expect(screen.getByRole("radio", { name: /GPT-5/ })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /High/ })).toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /Claude/ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Agent")).not.toBeInTheDocument();
	});

	// `settings.update` replaces the object, so a change to one agent that left
	// the other out would put the other back on Auto.
	it("sends the other agent's values along with a change", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({
			settings: {
				permission_reviewer: {
					claude: { model: "haiku", effort: "low" },
					codex: { effort: "high" },
				},
			},
		});
		render(<PermissionReviewerField valueState="known" />);

		await user.click(codexRow());
		await user.click(screen.getByRole("radio", { name: /GPT-5/ }));

		expect(updateSettings).toHaveBeenCalledWith({
			permission_reviewer: {
				claude: { model: "haiku", effort: "low" },
				codex: { model: "gpt-5", effort: "high" },
			},
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
		expect(
			screen.getByRole("button", {
				name: "Codex permission reviewer: loading",
			}),
		).toBeDisabled();
	});
});
