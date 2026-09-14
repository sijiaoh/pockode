import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSettingsStore } from "../../lib/settingsStore";
import AgentRoleListOverlay from "./AgentRoleListOverlay";

const updateSettings = vi.fn();
const deleteAgentRole = vi.fn();
const createAgentRole = vi.fn();
const resetAgentRoleDefaults = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			actions: {
				updateSettings,
				deleteAgentRole,
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

const renderOverlay = () =>
	render(
		<AgentRoleListOverlay
			onBack={vi.fn()}
			onOpenAgentRoleDetail={onOpenAgentRoleDetail}
		/>,
	);

beforeEach(() => {
	vi.clearAllMocks();
	updateSettings.mockResolvedValue(undefined);
	useAgentRoleStore.setState({
		roles: [
			{
				id: "r1",
				name: "Reviewer",
				role_prompt: "",
				created_at: "2026-09-14T00:00:00Z",
				updated_at: "2026-09-14T00:00:00Z",
			},
		],
		isLoading: false,
		error: null,
	});
	useSettingsStore.setState({ settings: {}, error: null, refresh: null });
});

describe("AgentRoleListOverlay", () => {
	it("sets a role as the default", async () => {
		const user = userEvent.setup();
		renderOverlay();

		await user.click(screen.getByRole("button", { name: "Set as default" }));

		expect(updateSettings).toHaveBeenCalledWith({
			default_agent_role_id: "r1",
		});
	});

	// The list has its own subscription and its own wait; only the star and the
	// line at the bottom answer to the settings snapshot.
	describe("before the settings snapshot arrives", () => {
		beforeEach(() => {
			useSettingsStore.setState({ settings: null });
		});

		it("claims no default role, neither one of them nor none", async () => {
			const user = userEvent.setup();
			renderOverlay();

			expect(screen.queryByText(/None \(always ask\)/)).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /as default$/ }),
			).not.toBeInTheDocument();

			await user.click(
				screen.getByRole("button", { name: "Default role: loading" }),
			);

			expect(updateSettings).not.toHaveBeenCalled();
		});

		it("leaves everything that does not depend on that snapshot alone", async () => {
			const user = userEvent.setup();
			renderOverlay();

			await user.click(screen.getByRole("button", { name: "Reviewer" }));
			expect(onOpenAgentRoleDetail).toHaveBeenCalledWith("r1");

			await user.click(screen.getByRole("button", { name: "Delete" }));
			expect(screen.getByText('Delete "Reviewer"?')).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Cancel" }));

			await user.click(screen.getByRole("button", { name: /Add Role/ }));
			expect(screen.getByPlaceholderText("Role name")).toBeInTheDocument();
		});
	});
});
