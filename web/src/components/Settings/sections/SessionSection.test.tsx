import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../../lib/agentOptionsStore";
import { useSettingsStore } from "../../../lib/settingsStore";
import SessionSection from "./SessionSection";

const updateSettings = vi.fn();

vi.mock("../../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({ actions: { updateSettings } }),
}));

beforeEach(() => {
	updateSettings.mockReset().mockResolvedValue(undefined);
	useSettingsStore.setState({ settings: {} });
	useAgentOptionsStore.setState({
		models: {
			claude: [{ id: "opus", label: "Opus" }],
			codex: [{ id: "gpt-5", label: "GPT-5" }],
		},
		efforts: { claude: [{ id: "high", label: "High" }] },
		error: null,
	});
});

describe("SessionSection", () => {
	// The server reads an unset default agent as its built-in one and judges the
	// default model against it, so a user who never picked an agent is still
	// shown the one their sessions really start on — and can set a model on it.
	it("reports an unset default agent as the built-in one", async () => {
		const user = userEvent.setup();
		render(<SessionSection />);

		expect(screen.getByRole("button", { name: /^Engine:/ })).toHaveTextContent(
			"Claude · Auto",
		);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		await user.click(screen.getByRole("radio", { name: /Opus/ }));

		expect(updateSettings).toHaveBeenCalledWith({ default_model: "opus" });
	});

	// The whole engine is replaced at once and the server refuses a model left
	// over from the agent it was picked on, so the pair has to go out empty with
	// the switch rather than be dropped afterwards.
	it("clears the model and effort when the default agent changes", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({
			settings: {
				default_agent_type: "claude",
				default_model: "opus",
				default_effort: "high",
			},
		});
		render(<SessionSection />);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		await user.click(screen.getByRole("radio", { name: /Codex/ }));

		expect(updateSettings).toHaveBeenCalledWith({
			default_agent_type: "codex",
			default_model: "",
			default_effort: "",
		});
	});

	it("offers no row that defers the global engine to anything else", async () => {
		const user = userEvent.setup();
		render(<SessionSection />);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));

		expect(
			screen.queryByRole("radio", { name: /Follow settings/ }),
		).not.toBeInTheDocument();
	});

	it("reports a rejected engine choice without changing the shown value", async () => {
		const user = userEvent.setup();
		updateSettings.mockRejectedValue(new Error("model needs an agent type"));
		render(<SessionSection />);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		await user.click(screen.getByRole("radio", { name: /Opus/ }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"model needs an agent type",
		);
		expect(screen.getByRole("button", { name: /^Engine:/ })).toHaveTextContent(
			"Claude · Auto",
		);
	});
});
