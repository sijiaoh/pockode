import { act, render, screen } from "@testing-library/react";
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
	useSettingsStore.setState({ settings: {}, error: null, refresh: null });
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

	it("reports a rejected mode change", async () => {
		const user = userEvent.setup();
		updateSettings.mockRejectedValue(new Error("snapshot has not arrived"));
		render(<SessionSection />);

		await user.click(screen.getByRole("button", { name: /YOLO/ }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"snapshot has not arrived",
		);
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

	// The resolved defaults are Claude on Auto in Default mode, which is exactly
	// what a user who set none of them would have picked — so showing them before
	// the snapshot lands tells everyone else something false about their own
	// settings, and lets them act on it.
	describe("before the settings snapshot arrives", () => {
		beforeEach(() => {
			useSettingsStore.setState({ settings: null });
		});

		it("names none of the values it has not been told", () => {
			render(<SessionSection />);

			expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
			expect(screen.queryByText(/Auto/)).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /YOLO/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Default/ }),
			).not.toBeInTheDocument();
		});

		it("refuses the engine panel, which has nothing to compose a write from", async () => {
			const user = userEvent.setup();
			render(<SessionSection />);

			await user.click(screen.getByRole("button", { name: /^Engine:/ }));

			expect(screen.queryByRole("radio")).not.toBeInTheDocument();
			expect(updateSettings).not.toHaveBeenCalled();
		});

		it("closes an engine panel that was already open when the snapshot went", async () => {
			const user = userEvent.setup();
			useSettingsStore.setState({ settings: { default_agent_type: "codex" } });
			render(<SessionSection />);
			await user.click(screen.getByRole("button", { name: /^Engine:/ }));
			expect(screen.getByRole("radio", { name: /GPT-5/ })).toBeInTheDocument();

			// What a dropped connection does to it while this page stays mounted.
			act(() => {
				useSettingsStore.getState().reset();
			});

			expect(screen.queryByRole("radio")).not.toBeInTheDocument();
		});

		it("offers a retry once the snapshot is known not to be coming", async () => {
			const user = userEvent.setup();
			const refresh = vi.fn();
			useSettingsStore.setState({ error: "subscribe failed", refresh });
			render(<SessionSection />);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Couldn't load settings: subscribe failed",
			);
			await user.click(screen.getByRole("button", { name: "Retry" }));

			expect(refresh).toHaveBeenCalled();
		});
	});
});
