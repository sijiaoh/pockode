import { render, screen } from "@testing-library/react";
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

vi.mock("../ui/BackToChatButton", () => ({
	default: ({ onClick }: { onClick: () => void }) => (
		<button type="button" onClick={onClick}>
			Back to chat
		</button>
	),
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

const renderOverlay = () =>
	render(
		<AgentRoleListOverlay
			onBack={vi.fn()}
			onOpenAgentRoleDetail={onOpenAgentRoleDetail}
		/>,
	);

/** The row, by the accessible name that carries its name and its engine. */
const roleRow = (name: string | RegExp) => screen.getByRole("button", { name });

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
	it("opens a role and sets it as the default from its own row", async () => {
		const user = userEvent.setup();
		renderOverlay();

		await user.click(roleRow(/^Reviewer/));
		expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("r1");

		// Named with the role: a list of identically-worded stars cannot be told
		// apart by anyone reading it one control at a time.
		await user.click(
			screen.getByRole("button", {
				name: 'Set "Reviewer" as the default role',
			}),
		);
		expect(updateSettings).toHaveBeenCalledWith({
			default_agent_role_id: "r1",
		});
	});

	// Deleting a role is a months-apart action and now has one home, at the
	// bottom of the detail page.
	it("offers no delete control on a row", () => {
		renderOverlay();

		expect(
			screen.queryByRole("button", { name: /delete/i }),
		).not.toBeInTheDocument();
	});

	describe("the engine on a row", () => {
		it("says an unset agent follows settings, claiming no model", () => {
			renderOverlay();

			expect(roleRow(/^Reviewer/)).toHaveAccessibleName(
				"Reviewer — Follow settings",
			);
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
			rerender(
				<AgentRoleListOverlay
					onBack={vi.fn()}
					onOpenAgentRoleDetail={onOpenAgentRoleDetail}
				/>,
			);
			expect(screen.getByText("Claude · Auto")).toBeInTheDocument();
		});
	});

	describe("the counts on a row", () => {
		it("writes each as a sentence, singular and plural", () => {
			setRoles([createRole({ steps: ["one"] })], { r1: 3 });
			renderOverlay();

			expect(screen.getByText(/1 step/)).toBeInTheDocument();
			expect(screen.getByText(/3 work items/)).toBeInTheDocument();
		});

		// Absence is the assertion; `0 steps` would spend the line's width on
		// something that never happened.
		it("leaves both out rather than writing zero", () => {
			setRoles([createRole({ steps: [] })], {});
			renderOverlay();

			expect(screen.queryByText(/step/)).not.toBeInTheDocument();
			expect(screen.queryByText(/work item/)).not.toBeInTheDocument();
		});
	});

	describe("the footer", () => {
		it("selects the default role, and reaches None as well", async () => {
			const user = userEvent.setup();
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			renderOverlay();

			const field = screen.getByLabelText("Default role");
			await user.selectOptions(field, "r2");
			expect(updateSettings).toHaveBeenCalledWith({
				default_agent_role_id: "r2",
			});

			useSettingsStore.setState({ settings: { default_agent_role_id: "r2" } });
			await user.selectOptions(screen.getByLabelText("Default role"), "");
			expect(updateSettings).toHaveBeenLastCalledWith({
				default_agent_role_id: "",
			});
		});

		// The sentence describes what the create form will do, so it has to change
		// with what the create form would do.
		it("describes what a new story would start with", () => {
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			const { rerender } = renderOverlay();
			expect(
				screen.getByText("New stories and tasks ask which role to use."),
			).toBeInTheDocument();

			useSettingsStore.setState({ settings: { default_agent_role_id: "r2" } });
			rerender(
				<AgentRoleListOverlay
					onBack={vi.fn()}
					onOpenAgentRoleDetail={onOpenAgentRoleDetail}
				/>,
			);
			expect(
				screen.getByText("New stories and tasks start with this role."),
			).toBeInTheDocument();

			// One role is not a choice, so the create form does not ask — whatever
			// the stored default says.
			setRoles([createRole()]);
			rerender(
				<AgentRoleListOverlay
					onBack={vi.fn()}
					onOpenAgentRoleDetail={onOpenAgentRoleDetail}
				/>,
			);
			expect(
				screen.getByText("New stories and tasks use Reviewer, the only role."),
			).toBeInTheDocument();
		});

		// A stored id with no role behind it is not None: saying None would put an
		// assertion in Settings' mouth that Settings never made.
		it("keeps a dangling default visible rather than showing None", () => {
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			useSettingsStore.setState({
				settings: { default_agent_role_id: "gone" },
			});
			renderOverlay();

			expect(screen.getByLabelText("Default role")).toHaveValue("gone");
			expect(screen.getByRole("option", { name: "Unknown role" })).toBeTruthy();
			expect(
				screen.getByText("New stories and tasks ask which role to use."),
			).toBeInTheDocument();
		});

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
			rerender(
				<AgentRoleListOverlay
					onBack={vi.fn()}
					onOpenAgentRoleDetail={onOpenAgentRoleDetail}
				/>,
			);
			expect(
				screen.queryByRole("button", { name: "Reset to defaults" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Failed to reset: nope",
			);
		});

		// The two failures used to share one paragraph, where whichever came
		// first hid the other.
		it("reports a failed default role change beside the field, not with reset", async () => {
			const user = userEvent.setup();
			updateSettings.mockRejectedValue(new Error("no luck"));
			renderOverlay();

			await user.click(
				screen.getByRole("button", {
					name: 'Set "Reviewer" as the default role',
				}),
			);

			expect(screen.getByRole("alert")).toHaveTextContent("no luck");
		});

		// Both act on a list that is not on screen; Reset would overwrite roles
		// the user cannot see.
		it("withholds Add Role and Reset while the list is not there", () => {
			useAgentRoleStore.setState({
				roles: [],
				workRefCounts: {},
				isLoading: true,
				error: null,
			});
			renderOverlay();

			expect(
				screen.queryByRole("button", { name: /Add Role/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Reset to defaults" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("status")).toHaveAccessibleName(
				"Default role: loading",
			);
		});

		it("points a user who deleted every role at the way back", () => {
			setRoles([]);
			renderOverlay();

			expect(screen.getByText("No agent roles yet")).toBeInTheDocument();
			expect(
				screen.getByText("Add one below, or reset to the defaults."),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Reset to defaults" }),
			).toBeInTheDocument();
			// The create form does not ask which role to use when there are none;
			// it refuses and sends the user back here.
			expect(
				screen.queryByText(/^New stories and tasks/),
			).not.toBeInTheDocument();
		});
	});

	// The list has its own subscription and its own wait; only the stars and the
	// footer's field answer to the settings snapshot.
	describe("before the settings snapshot arrives", () => {
		beforeEach(() => {
			useSettingsStore.setState({ settings: null });
		});

		it("claims no default role, neither one of them nor none", async () => {
			const user = userEvent.setup();
			renderOverlay();

			expect(screen.queryByLabelText("Default role")).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /as the default role$/ }),
			).not.toBeInTheDocument();

			await user.click(
				screen.getByRole("button", {
					name: 'Default role for "Reviewer": loading',
				}),
			);

			expect(updateSettings).not.toHaveBeenCalled();
		});

		// The star keeps the role's name while it waits, too: there is one of
		// these per row, and a column of identical names is a column a screen
		// reader cannot tell apart — whether or not the answer has landed.
		it("names the role in each waiting star, both on the way and not coming", () => {
			setRoles([createRole(), createRole({ id: "r2", name: "Engineer" })]);
			const { rerender } = renderOverlay();

			expect(
				screen.getByRole("button", {
					name: 'Default role for "Engineer": loading',
				}),
			).toBeInTheDocument();

			useSettingsStore.setState({ error: "no snapshot" });
			rerender(
				<AgentRoleListOverlay
					onBack={vi.fn()}
					onOpenAgentRoleDetail={onOpenAgentRoleDetail}
				/>,
			);

			expect(
				screen.getByRole("button", {
					name: 'Default role for "Engineer": unavailable',
				}),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", {
					name: 'Default role for "Reviewer": unavailable',
				}),
			).toBeInTheDocument();
		});

		it("leaves everything that does not depend on that snapshot alone", async () => {
			const user = userEvent.setup();
			renderOverlay();

			await user.click(roleRow(/^Reviewer/));
			expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("r1");

			await user.click(screen.getByRole("button", { name: /Add Role/ }));
			expect(screen.getByPlaceholderText("Role name")).toBeInTheDocument();
		});
	});
});
