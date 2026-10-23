import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useScheduleStore } from "../../lib/scheduleStore";
import { makeSchedule } from "../../test/scheduleFixtures";
import type { AgentRole } from "../../types/agentRole";
import CreateScheduleSheet from "./CreateScheduleSheet";

const createSchedule = vi.fn();
let worktree = "";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { createSchedule } }),
}));

vi.mock("../../hooks/useRouteState", () => ({
	useCurrentWorktree: () => worktree,
}));

const role = (
	id: string,
	name: string,
	work_type?: AgentRole["work_type"],
): AgentRole => ({
	id,
	name,
	work_type,
	role_prompt: "",
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
});

function setRoles(
	roles: AgentRole[],
	state: { isLoading: boolean; error: string | null } = {
		isLoading: false,
		error: null,
	},
) {
	useAgentRoleStore.setState({ roles, ...state });
}

function renderSheet() {
	const onClose = vi.fn();
	const onCreated = vi.fn();
	render(<CreateScheduleSheet onClose={onClose} onCreated={onCreated} />);
	return { onClose, onCreated };
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Title"), "Nightly audit");
	await user.type(screen.getByLabelText("Prompt"), "Audit the dependencies.");
}

const createButton = () => screen.getByRole("button", { name: "Create" });

describe("CreateScheduleSheet", () => {
	beforeEach(() => {
		createSchedule.mockReset();
		worktree = "";
		useScheduleStore.getState().setSchedules([], {
			name: "UTC",
			offset_seconds: 0,
		});
		setRoles([role("any", "Engineer"), role("job", "Auditor", "job")]);
	});

	it("makes the schedule in the current worktree and lands on it", async () => {
		const user = userEvent.setup();
		worktree = "feature-x";
		createSchedule.mockResolvedValue(
			makeSchedule({ id: "sched-9", title: "Nightly audit" }),
		);
		const { onCreated } = renderSheet();

		expect(screen.getByText("Runs in feature-x")).toBeInTheDocument();
		await fill(user);
		await user.click(createButton());

		// The field reports nothing until touched, so the cron it opened on is
		// the one sent; the jobs-only role is preselected; enabled is left out.
		expect(createSchedule).toHaveBeenCalledWith({
			title: "Nightly audit",
			prompt: "Audit the dependencies.",
			agent_role_id: "job",
			cron: "0 9 * * *",
			worktree: "feature-x",
		});
		expect(onCreated).toHaveBeenCalledWith("sched-9");
		// In the store before the list notification, so the detail page it lands
		// on does not read the new schedule as deleted.
		expect(useScheduleStore.getState().schedules.map((s) => s.id)).toContain(
			"sched-9",
		);
	});

	it("sends no worktree from main", async () => {
		const user = userEvent.setup();
		createSchedule.mockResolvedValue(makeSchedule());
		renderSheet();

		expect(screen.getByText("Runs in main")).toBeInTheDocument();
		await fill(user);
		await user.click(createButton());
		expect(createSchedule.mock.calls[0][0]).not.toHaveProperty("worktree");
	});

	it("offers Create only once all four fields are complete", async () => {
		const user = userEvent.setup();
		setRoles([role("a", "A"), role("b", "B")]);
		renderSheet();

		expect(createButton()).toBeDisabled();
		await fill(user);
		// Two roles that take anything: nothing to preselect.
		expect(createButton()).toBeDisabled();
		await user.selectOptions(screen.getByLabelText("Role"), "b");
		expect(createButton()).toBeEnabled();

		// A weekly period with no day spells nothing yet.
		await user.click(screen.getByRole("button", { name: "Weekly" }));
		await user.click(screen.getByRole("button", { name: "Mon" }));
		expect(createButton()).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Fri" }));
		expect(createButton()).toBeEnabled();
	});

	it("keeps the sheet and everything typed when the server refuses", async () => {
		const user = userEvent.setup();
		createSchedule.mockRejectedValue(
			new Error('invalid cron: minute field "61": 61 is out of range 0-59'),
		);
		const { onCreated } = renderSheet();

		await fill(user);
		await user.click(createButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			'minute field "61"',
		);
		expect(onCreated).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Title")).toHaveValue("Nightly audit");
		expect(screen.getByLabelText("Prompt")).toHaveValue(
			"Audit the dependencies.",
		);
		expect(createButton()).toBeEnabled();
	});

	it("holds the period still while it creates", async () => {
		const user = userEvent.setup();
		createSchedule.mockReturnValue(new Promise(() => {}));
		renderSheet();

		await fill(user);
		await user.click(screen.getByRole("button", { name: "Weekly" }));
		await user.click(createButton());
		expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
	});

	it("keeps a picked role when the roles change, and drops one that stops taking jobs", async () => {
		const user = userEvent.setup();
		setRoles([role("a", "A"), role("b", "B")]);
		renderSheet();

		await user.selectOptions(screen.getByLabelText("Role"), "b");
		// One jobs-only role arriving would be preselected, but never over a pick.
		act(() =>
			setRoles([role("a", "A"), role("b", "B"), role("job", "Auditor", "job")]),
		);
		expect(screen.getByLabelText("Role")).toHaveValue("b");

		// Restricted elsewhere while the sheet is open: the server would refuse it.
		act(() => setRoles([role("a", "A"), role("b", "B", "story")]));
		expect(screen.getByLabelText("Role")).toHaveValue("a");
	});

	it("offers Create for a custom cron only once it has five fields", async () => {
		const user = userEvent.setup();
		renderSheet();
		await fill(user);

		await user.click(screen.getByRole("button", { name: "Custom" }));
		const cron = screen.getByLabelText("Cron expression");
		await user.clear(cron);
		await user.type(cron, "0 9 1 *");
		expect(createButton()).toBeDisabled();
		await user.type(cron, " *");
		expect(createButton()).toBeEnabled();
	});

	it("keeps the form and the period being written through a role reload", async () => {
		const user = userEvent.setup();
		createSchedule.mockResolvedValue(makeSchedule());
		renderSheet();
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Weekly" }));
		await user.click(screen.getByRole("button", { name: "Fri" }));

		// What a reconnect does to the app-wide role store.
		act(() => useAgentRoleStore.setState({ roles: [], isLoading: true }));
		expect(screen.getByRole("button", { name: "Fri" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(createButton()).toBeDisabled();

		act(() =>
			setRoles([role("any", "Engineer"), role("job", "Auditor", "job")]),
		);
		await user.click(createButton());
		expect(createSchedule.mock.calls[0][0].cron).toBe("0 9 * * 1,5");
	});

	it("sends the period it shows after a failed role reload brings the form back", async () => {
		const user = userEvent.setup();
		createSchedule.mockResolvedValue(makeSchedule());
		renderSheet();
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Weekly" }));
		await user.click(screen.getByRole("button", { name: "Fri" }));

		act(() =>
			setRoles([], { isLoading: false, error: "Failed to load roles" }),
		);
		act(() =>
			setRoles([role("any", "Engineer"), role("job", "Auditor", "job")]),
		);
		// The field opened again on its default, and that is what is sent.
		expect(screen.getByRole("button", { name: "Daily" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await user.click(createButton());
		expect(createSchedule.mock.calls[0][0].cron).toBe("0 9 * * *");
	});

	describe("without a role that takes jobs", () => {
		it("says the roles are still loading", () => {
			setRoles([], { isLoading: true, error: null });
			renderSheet();
			expect(screen.getByText("Loading roles...")).toBeInTheDocument();
		});

		it("says the roles could not be loaded", () => {
			setRoles([], { isLoading: false, error: "Failed to load roles" });
			renderSheet();
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Failed to load roles",
			);
		});

		it("says there are none", () => {
			setRoles([]);
			renderSheet();
			expect(
				screen.getByText("No agent roles registered."),
			).toBeInTheDocument();
		});

		it("names the restriction to change when every role is kept from jobs", () => {
			setRoles([role("s", "Planner", "story"), role("t", "Engineer", "task")]);
			renderSheet();
			expect(screen.getByText("No agent role takes jobs.")).toBeInTheDocument();
			expect(
				screen.getByText(/Set a role to take jobs in/),
			).toBeInTheDocument();
		});
	});
});
