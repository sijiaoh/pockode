import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import type { AgentRole } from "../../types/agentRole";
import RoleSelect from "./RoleSelect";

const role = (
	id: string,
	name: string,
	work_type?: AgentRole["work_type"],
): AgentRole => ({
	id,
	name,
	work_type,
	role_prompt: "",
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
});

const optionNames = () =>
	screen.getAllByRole("option").map((o) => o.textContent);

describe("RoleSelect", () => {
	beforeEach(() => {
		useAgentRoleStore.setState({
			roles: [role("r1", "Engineer"), role("r2", "Reviewer")],
			isLoading: false,
			error: null,
		});
	});

	it("offers the empty choice only when it is given a label", () => {
		const { rerender } = render(
			<RoleSelect
				value="r1"
				onChange={vi.fn()}
				emptyLabel="None"
				workType="story"
			/>,
		);
		expect(optionNames()).toEqual(["None", "Engineer", "Reviewer"]);

		rerender(<RoleSelect value="r1" onChange={vi.fn()} workType="story" />);
		expect(optionNames()).toEqual(["Engineer", "Reviewer"]);
	});

	it("hands back the id of the role picked", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<RoleSelect value="r1" onChange={onChange} workType="story" />);

		await user.selectOptions(screen.getByRole("combobox"), "Reviewer");

		expect(onChange).toHaveBeenCalledWith("r2");
	});

	// Without its own row, the browser would show the first option as though it
	// were the one stored.
	it("shows an id with no role behind it as unknown, not as another choice", () => {
		render(
			<RoleSelect
				value="gone"
				onChange={vi.fn()}
				emptyLabel="None"
				workType="story"
			/>,
		);

		expect(screen.getByRole("combobox")).toHaveValue("gone");
		expect(
			screen.getByRole("option", { name: "Unknown role", selected: true }),
		).toBeInTheDocument();
	});

	describe("for one kind of work", () => {
		beforeEach(() => {
			useAgentRoleStore.setState({
				roles: [
					role("pm", "PM", "story"),
					role("r1", "Engineer", "task"),
					role("r2", "Reviewer"),
				],
			});
		});

		it("offers only the roles that take it", () => {
			render(
				<RoleSelect
					value=""
					onChange={vi.fn()}
					emptyLabel="Select role..."
					workType="task"
				/>,
			);
			expect(optionNames()).toEqual(["Select role...", "Engineer", "Reviewer"]);
		});

		// The server keeps an assignment made before the restriction, so the field
		// still shows it — with the reason it is not otherwise on offer.
		it("keeps a stored role that does not take it, saying why", () => {
			render(<RoleSelect value="pm" onChange={vi.fn()} workType="task" />);

			expect(screen.getByRole("combobox")).toHaveValue("pm");
			expect(optionNames()).toEqual([
				"PM — stories only",
				"Engineer",
				"Reviewer",
			]);
		});
	});
});
