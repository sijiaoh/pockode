import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSettingsStore } from "../../lib/settingsStore";
import type { AgentRole } from "../../types/agentRole";
import AgentRoleListOverlay from "./AgentRoleListOverlay";

const updateSettings = vi.fn();
const createAgentRole = vi.fn();
const resetAgentRoleDefaults = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			actions: {
				updateSettings,
				createAgentRole,
				resetAgentRoleDefaults,
			},
		}),
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));

const onOpenAgentRoleDetail = vi.fn();

const createRole = (overrides: Partial<AgentRole> = {}): AgentRole => ({
	id: "r1",
	name: "Reviewer",
	role_prompt: "",
	created_at: "2026-09-14T00:00:00Z",
	updated_at: "2026-09-14T00:00:00Z",
	...overrides,
});

const setRoles = (
	roles: AgentRole[],
	workRefCounts: Record<string, number> = {},
) =>
	useAgentRoleStore.setState({
		roles,
		workRefCounts,
		isLoading: false,
		error: null,
	});

const overlay = () => (
	<AgentRoleListOverlay
		onBack={vi.fn()}
		onOpenAgentRoleDetail={onOpenAgentRoleDetail}
	/>
);
const renderOverlay = () => render(overlay());

/** The card, by the name it starts with: its accessible name is its content. */
const roleRow = (name: string) =>
	screen.getByRole("button", { name: new RegExp(`^${name},`) });

const field = () => screen.getByLabelText("Default story role");

beforeEach(() => {
	vi.clearAllMocks();
	updateSettings.mockResolvedValue(undefined);
	resetAgentRoleDefaults.mockResolvedValue(undefined);
	setRoles([createRole()]);
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

describe("AgentRoleListOverlay", () => {
	it("is headed Agent Roles, with the way back to chat", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		render(
			<AgentRoleListOverlay
				onBack={onBack}
				onOpenAgentRoleDetail={onOpenAgentRoleDetail}
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "Agent Roles" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Back to chat" }));
		expect(onBack).toHaveBeenCalled();
	});

	it("opens a role from its card", async () => {
		const user = userEvent.setup();
		renderOverlay();

		await user.click(roleRow("Reviewer"));
		expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("r1");
	});

	// Deleting a role is a months-apart action and has one home, at the bottom
	// of the detail page.
	it("offers no delete control on a card", () => {
		renderOverlay();

		expect(
			screen.queryByRole("button", { name: /delete/i }),
		).not.toBeInTheDocument();
	});

	describe("the groups", () => {
		it("groups roles by what they run, stories first, and leaves empty groups out", () => {
			setRoles([
				createRole({ id: "e1", name: "Engineer", work_type: "task" }),
				createRole({ id: "pm", name: "PM", work_type: "story" }),
				createRole({ id: "d1", name: "Designer", work_type: "task" }),
			]);
			renderOverlay();

			const headings = screen
				.getAllByRole("heading", { level: 2 })
				.map((h) => h.textContent);
			expect(headings).toEqual([
				"Default story role",
				"Story roles1",
				"Task roles2",
			]);

			const tasks = screen
				.getByRole("heading", { name: /Task roles/ })
				.closest("section");
			expect(tasks).not.toBeNull();
			if (tasks) {
				expect(
					within(tasks)
						.getAllByRole("button")
						.map((b) => b.textContent?.split(",")[0]),
				).toEqual(["Engineer", "Designer"]);
			}
		});

		it("puts roles that run either kind last", () => {
			setRoles([
				createRole({ id: "r1", name: "Reviewer" }),
				createRole({ id: "e1", name: "Engineer", work_type: "task" }),
			]);
			renderOverlay();

			const headings = screen
				.getAllByRole("heading", { level: 2 })
				.map((h) => h.textContent);
			expect(headings.slice(1)).toEqual(["Task roles1", "Story & task roles1"]);
		});
	});

	describe("a card", () => {
		it("says what the role is for with the first line of its prompt", () => {
			setRoles([
				createRole({ role_prompt: "# You are the **PM**\n\nPlan things." }),
			]);
			renderOverlay();

			expect(screen.getByText("You are the PM")).toBeInTheDocument();
		});

		// A role with no prompt does nothing useful, so the gap is shown.
		it("says when a role has no prompt", () => {
			renderOverlay();

			expect(screen.getByText("No role prompt")).toBeInTheDocument();
		});

		it("reads as it is drawn", () => {
			setRoles([createRole({ role_prompt: "Reviews diffs.", steps: ["one"] })]);
			renderOverlay();

			// jsdom's name computation drops the space after each spoken comma
			// that a browser keeps, hence `\s*`.
			expect(roleRow("Reviewer")).toHaveAccessibleName(
				/^Reviewer,\s*Reviews diffs\.,\s*Follow settings,\s*1 step$/,
			);
		});

		it("says an unset agent follows settings, claiming no model", () => {
			renderOverlay();

			expect(screen.getByText("Follow settings")).toBeInTheDocument();
			expect(screen.queryByText(/Auto/)).not.toBeInTheDocument();
		});

		it("names the agent, the model and the effort once they are set", () => {
			setRoles([
				createRole({ agent_type: "claude", model: "opus", effort: "high" }),
			]);
			renderOverlay();

			expect(screen.getByText("Claude · Opus · High")).toBeInTheDocument();
		});

		// An unset effort is the absence of a level, not a level named Auto — an
		// unset model is Auto. The detail page draws exactly this distinction,
		// and one line written twice is how the two start disagreeing.
		it("names an unset model Auto and drops an unset effort", () => {
			setRoles([createRole({ agent_type: "claude", model: "opus" })]);
			const { rerender } = renderOverlay();
			expect(screen.getByText("Claude · Opus")).toBeInTheDocument();

			setRoles([createRole({ agent_type: "claude" })]);
			rerender(overlay());
			expect(screen.getByText("Claude · Auto")).toBeInTheDocument();
		});

		it("writes each count as a phrase, singular and plural", () => {
			setRoles([createRole({ steps: ["one"] })], { r1: 3 });
			renderOverlay();

			expect(screen.getByText("1 step")).toBeInTheDocument();
			expect(screen.getByText("3 work items")).toBeInTheDocument();
		});

		// The group heading says it; the card does not repeat it.
		it("leaves the work type out", () => {
			setRoles([createRole({ work_type: "task" })]);
			renderOverlay();

			expect(
				screen.queryByText(/(stories|tasks) only/i),
			).not.toBeInTheDocument();
		});

		// Absence is the assertion; `0 steps` would spend the line's width on
		// something that never happened.
		it("leaves both counts out rather than writing zero", () => {
			setRoles([createRole({ steps: [] })], {});
			renderOverlay();

			expect(screen.queryByText(/step/)).not.toBeInTheDocument();
			expect(screen.queryByText(/work item/)).not.toBeInTheDocument();
		});

		it("marks the default story role, and only that one", () => {
			setRoles([
				createRole({ id: "pm", name: "PM", work_type: "story" }),
				createRole({ id: "r1", name: "Reviewer" }),
			]);
			useSettingsStore.setState({ settings: { default_agent_role_id: "pm" } });
			renderOverlay();

			expect(roleRow("PM")).toHaveAccessibleName(
				/^PM,\s*Default\s*story role,/,
			);
			expect(
				within(roleRow("Reviewer")).queryByText("Default"),
			).not.toBeInTheDocument();
		});

		// Only a settings file edited by hand gets here, and new stories ignore
		// it: marking the row would claim a default that does nothing.
		it("does not mark a task-only role a stale setting names", () => {
			setRoles([
				createRole({ id: "pm", name: "PM", work_type: "story" }),
				createRole({ id: "e1", name: "Engineer", work_type: "task" }),
			]);
			useSettingsStore.setState({ settings: { default_agent_role_id: "e1" } });
			renderOverlay();

			expect(screen.queryByText("Default")).not.toBeInTheDocument();
		});
	});

	describe("the default story role", () => {
		it("selects the default story role, and reaches None as well", async () => {
			const user = userEvent.setup();
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			const { rerender } = renderOverlay();

			await user.selectOptions(field(), "r2");
			expect(updateSettings).toHaveBeenCalledWith({
				default_agent_role_id: "r2",
			});

			useSettingsStore.setState({ settings: { default_agent_role_id: "r2" } });
			rerender(overlay());
			await user.selectOptions(field(), "");
			expect(updateSettings).toHaveBeenLastCalledWith({
				default_agent_role_id: "",
			});
		});

		// The server refuses a role that cannot run stories as the default.
		it("offers only roles that can run stories", () => {
			setRoles([
				createRole({ id: "pm", name: "PM", work_type: "story" }),
				createRole({ id: "e1", name: "Engineer", work_type: "task" }),
				createRole({ id: "r1", name: "Reviewer" }),
			]);
			renderOverlay();

			expect(
				[...field().querySelectorAll("option")].map((o) => o.textContent),
			).toEqual(["None", "PM", "Reviewer"]);
		});

		// The sentence describes what the create form will do, so it has to
		// change with what the create form would do.
		it("describes what a new story would start with", () => {
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			const { rerender } = renderOverlay();
			expect(
				screen.getByText("New stories ask which role to use."),
			).toBeInTheDocument();

			useSettingsStore.setState({ settings: { default_agent_role_id: "r2" } });
			rerender(overlay());
			expect(
				screen.getByText("New stories start with this role."),
			).toBeInTheDocument();

			// One role is not a choice, so the create form does not ask — whatever
			// the stored default says.
			setRoles([createRole()]);
			rerender(overlay());
			expect(
				screen.getByText(
					"New stories use Reviewer, the only role that runs stories.",
				),
			).toBeInTheDocument();
		});

		it("says when no role runs stories, and offers nothing to pick", () => {
			setRoles([createRole({ id: "e1", name: "Engineer", work_type: "task" })]);
			renderOverlay();

			expect(
				screen.getByText(
					"No role runs stories. Set a role to run Stories (or Both), or add one.",
				),
			).toBeInTheDocument();
			expect(field()).toBeDisabled();
		});

		// Only a settings file edited by hand gets here; the stored value stays
		// visible, with what it does — nothing — said beside it.
		it("names a task-only default and says new stories ignore it", () => {
			setRoles([
				createRole({ id: "pm", name: "PM", work_type: "story" }),
				createRole({ id: "r1", name: "Reviewer" }),
				createRole({ id: "e1", name: "Engineer", work_type: "task" }),
			]);
			useSettingsStore.setState({ settings: { default_agent_role_id: "e1" } });
			renderOverlay();

			expect(field()).toHaveValue("e1");
			expect(
				screen.getByText(
					"Engineer can't run stories, so new stories ignore it. Pick a story role.",
				),
			).toBeInTheDocument();
		});

		// A stored id with no role behind it is not None: saying None would put
		// an assertion in Settings' mouth that Settings never made.
		it("keeps a dangling default visible rather than showing None", () => {
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			useSettingsStore.setState({
				settings: { default_agent_role_id: "gone" },
			});
			renderOverlay();

			expect(field()).toHaveValue("gone");
			expect(
				screen.getByText(
					"The saved default no longer exists. New stories ask which role to use.",
				),
			).toBeInTheDocument();
		});

		it("reports a failed change beside the field", async () => {
			const user = userEvent.setup();
			updateSettings.mockRejectedValue(new Error("no luck"));
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			renderOverlay();

			await user.selectOptions(field(), "r2");

			expect(await screen.findByRole("alert")).toHaveTextContent("no luck");
		});

		// The list has its own subscription; only this field answers to the
		// settings snapshot, and "None" first would claim there is no default.
		it("claims nothing before the settings snapshot arrives", async () => {
			const user = userEvent.setup();
			useSettingsStore.setState({ settings: null });
			renderOverlay();

			expect(
				screen.queryByLabelText("Default story role"),
			).not.toBeInTheDocument();
			expect(screen.getByRole("status")).toHaveAccessibleName(
				"Default story role: loading",
			);

			await user.click(roleRow("Reviewer"));
			expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("r1");
		});

		it("says why when the snapshot is not coming", () => {
			useSettingsStore.setState({ settings: null, error: "no snapshot" });
			renderOverlay();

			expect(screen.getByRole("alert")).toHaveTextContent(
				"Couldn't load settings: no snapshot",
			);
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
		});
	});

	describe("creating a role", () => {
		it("opens the new role sheet and lands on the role it made", async () => {
			const user = userEvent.setup();
			createAgentRole.mockResolvedValue(createRole({ id: "new" }));
			renderOverlay();

			await user.click(screen.getByRole("button", { name: "New Role" }));
			await user.type(screen.getByLabelText("Name"), "Reviewer 2");
			await user.click(screen.getByRole("button", { name: "Create" }));

			expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("new");
			expect(
				screen.queryByRole("dialog", { name: "New Role" }),
			).not.toBeInTheDocument();
		});

		// Creating does not depend on the list, as `New Story` does not.
		it("stays available while the list is loading", () => {
			useAgentRoleStore.setState({ roles: [], isLoading: true, error: null });
			renderOverlay();

			expect(screen.getByRole("button", { name: "New Role" })).toBeEnabled();
		});
	});

	describe("resetting", () => {
		it("confirms before resetting, and reports a refusal on its own line", async () => {
			const user = userEvent.setup();
			resetAgentRoleDefaults.mockRejectedValue(new Error("nope"));
			const { rerender } = renderOverlay();

			await user.click(
				screen.getByRole("button", { name: "Reset to defaults" }),
			);
			await user.click(screen.getByRole("button", { name: "Reset" }));

			expect(resetAgentRoleDefaults).toHaveBeenCalled();
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Failed to reset: nope",
			);

			// The reason outlives the button that raised it: a reset in flight when
			// the socket drops takes the list — and that button — away with it.
			useAgentRoleStore.setState({ isLoading: true });
			rerender(overlay());
			expect(
				screen.queryByRole("button", { name: "Reset to defaults" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Failed to reset: nope",
			);
		});

		// Reset would overwrite roles the user cannot see.
		it("is withheld while the list is not there", () => {
			useAgentRoleStore.setState({
				roles: [],
				workRefCounts: {},
				isLoading: false,
				error: "subscribe failed",
			});
			renderOverlay();

			expect(
				screen.queryByRole("button", { name: "Reset to defaults" }),
			).not.toBeInTheDocument();
			expect(screen.getByText("subscribe failed")).toBeInTheDocument();
		});

		it("points a user who deleted every role at both ways back", () => {
			setRoles([]);
			renderOverlay();

			expect(screen.getByText("No agent roles")).toBeInTheDocument();
			expect(
				screen.getByText(
					"Create one with the button below, or reset to the built-in roles.",
				),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Reset to defaults" }),
			).toBeInTheDocument();
			// The create form does not ask which role to use when there are none;
			// it refuses and sends the user back here.
			expect(
				screen.queryByLabelText("Default story role"),
			).not.toBeInTheDocument();
		});
	});
});
