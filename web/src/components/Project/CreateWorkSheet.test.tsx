import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSettingsStore } from "../../lib/settingsStore";
import type { AgentRole } from "../../types/agentRole";
import type { Work } from "../../types/work";
import CreateWorkSheet from "./CreateWorkSheet";

const createWork = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { createWork } }),
}));

const role = (id: string, name: string): AgentRole => ({
	id,
	name,
	role_prompt: "",
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
});

const created = (id: string): Work => ({
	id,
	type: "story",
	title: "Rebuild the project page",
	status: "open",
	current_step: 0,
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
});

function setRoles(roles: AgentRole[]) {
	useAgentRoleStore.setState({ roles, isLoading: false, error: null });
}

function renderSheet(
	props: Partial<React.ComponentProps<typeof CreateWorkSheet>> = {},
) {
	const onClose = props.onClose ?? vi.fn();
	const onCreated = props.onCreated ?? vi.fn();
	render(
		<CreateWorkSheet
			type={props.type ?? "story"}
			parentId={props.parentId}
			onClose={onClose}
			onCreated={onCreated}
		/>,
	);
	return { onClose, onCreated };
}

async function submitTitle(title: string) {
	const user = userEvent.setup();
	await user.type(screen.getByLabelText("Title"), title);
	await user.click(screen.getByRole("button", { name: "Create" }));
}

describe("CreateWorkSheet", () => {
	beforeEach(() => {
		createWork.mockReset();
		useSettingsStore.setState({ settings: null, error: null });
		setRoles([role("role-1", "Engineer")]);
	});

	it("hands the created work to its caller so the app can land on it", async () => {
		createWork.mockResolvedValue(created("work-9"));
		const { onCreated } = renderSheet();

		await submitTitle("Rebuild the project page");

		expect(createWork).toHaveBeenCalledWith({
			type: "story",
			parent_id: undefined,
			agent_role_id: "role-1",
			title: "Rebuild the project page",
		});
		expect(onCreated).toHaveBeenCalledWith("work-9");
	});

	it("creates a task under the story that opened it", async () => {
		createWork.mockResolvedValue(created("task-2"));
		renderSheet({ type: "task", parentId: "story-1" });

		await submitTitle("Wire the bottom bar");

		expect(createWork).toHaveBeenCalledWith(
			expect.objectContaining({ type: "task", parent_id: "story-1" }),
		);
	});

	// The one thing the user would have to retype is the one thing the server
	// never received, so nothing is cleared and nothing is navigated.
	it("keeps the sheet, the title and the caller put when creating fails", async () => {
		createWork.mockRejectedValue(new Error("work store is read-only"));
		const { onCreated, onClose } = renderSheet();

		await submitTitle("Rebuild the project page");

		expect(screen.getByRole("alert")).toHaveTextContent(
			"work store is read-only",
		);
		expect(screen.getByLabelText("Title")).toHaveValue(
			"Rebuild the project page",
		);
		expect(onCreated).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("says why it cannot ask for a role when none is registered", () => {
		setRoles([]);
		renderSheet();

		expect(screen.getByText("No agent roles registered.")).toBeVisible();
		expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
	});

	// An empty list is not the same fact while the roles are still arriving —
	// the subscription starts out loading and returns to it on every reconnect.
	it("does not claim there are no roles while they are still loading", () => {
		useAgentRoleStore.setState({ roles: [], isLoading: true, error: null });
		renderSheet();

		expect(screen.getByText("Loading roles...")).toBeVisible();
		expect(screen.queryByText("No agent roles registered.")).toBeNull();
	});

	it("shows why the roles could not be loaded", () => {
		useAgentRoleStore.setState({
			roles: [],
			isLoading: false,
			error: "Failed to load agent roles",
		});
		renderSheet();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Failed to load agent roles",
		);
		expect(screen.queryByText("No agent roles registered.")).toBeNull();
	});

	it("preselects the default role when there is more than one", () => {
		setRoles([role("role-1", "Engineer"), role("role-2", "Reviewer")]);
		useSettingsStore.setState({
			settings: { default_agent_role_id: "role-2" },
			error: null,
		});
		renderSheet();

		expect(screen.getByLabelText("Role")).toHaveValue("role-2");
	});

	it("will not submit a title of spaces", async () => {
		renderSheet();
		await userEvent.setup().type(screen.getByLabelText("Title"), "   ");

		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		expect(createWork).not.toHaveBeenCalled();
	});
});
