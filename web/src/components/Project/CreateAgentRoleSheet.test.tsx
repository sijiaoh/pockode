import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import type { AgentRole } from "../../types/agentRole";
import CreateAgentRoleSheet from "./CreateAgentRoleSheet";

const createAgentRole = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { createAgentRole } }),
}));

const created = (id: string): AgentRole => ({
	id,
	name: "Reviewer",
	role_prompt: "",
	created_at: "2026-10-08T00:00:00Z",
	updated_at: "2026-10-08T00:00:00Z",
});

function renderSheet() {
	const onCreated = vi.fn();
	render(<CreateAgentRoleSheet onClose={vi.fn()} onCreated={onCreated} />);
	return { onCreated };
}

describe("CreateAgentRoleSheet", () => {
	beforeEach(() => {
		createAgentRole.mockReset();
		useAgentRoleStore.getState().reset();
	});

	// Most new roles are for story agents to hand tasks to: nobody creates a
	// task by hand, and the default story role usually exists already.
	it("makes a task role unless told otherwise, and hands it to its caller", async () => {
		const user = userEvent.setup();
		createAgentRole.mockResolvedValue(created("r9"));
		const { onCreated } = renderSheet();

		expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(
			screen.getByText("Picked by story agents for the tasks they create."),
		).toBeInTheDocument();

		await user.type(screen.getByLabelText("Name"), "  Reviewer ");
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(createAgentRole).toHaveBeenCalledWith({
			name: "Reviewer",
			role_prompt: "",
			work_type: "task",
		});
		expect(onCreated).toHaveBeenCalledWith("r9");
		// The detail page it lands on reads the list store, and the list
		// notification may still be on its way.
		expect(useAgentRoleStore.getState().roles.map((r) => r.id)).toEqual(["r9"]);
	});

	it("sends no work type for Both, the value that means either", async () => {
		const user = userEvent.setup();
		createAgentRole.mockResolvedValue(created("r9"));
		renderSheet();

		await user.click(screen.getByRole("button", { name: "Both" }));
		await user.type(screen.getByLabelText("Name"), "Generalist");
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(createAgentRole).toHaveBeenCalledWith({
			name: "Generalist",
			role_prompt: "",
		});
	});

	it("will not create a role without a name", () => {
		renderSheet();

		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
	});

	it("keeps the sheet and the name on a refusal, and says why", async () => {
		const user = userEvent.setup();
		createAgentRole.mockRejectedValue(new Error("name taken"));
		const { onCreated } = renderSheet();

		await user.type(screen.getByLabelText("Name"), "Reviewer");
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("name taken");
		expect(screen.getByLabelText("Name")).toHaveValue("Reviewer");
		expect(onCreated).not.toHaveBeenCalled();
	});
});
