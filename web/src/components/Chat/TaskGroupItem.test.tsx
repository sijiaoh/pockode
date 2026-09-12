import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TaskRun, TaskRunStatus } from "../../types/message";
import TaskGroupItem from "./TaskGroupItem";

const task = (
	toolUseId: string,
	status: TaskRunStatus,
	overrides: Partial<TaskRun> = {},
): TaskRun => ({
	toolUseId,
	description: `${toolUseId} description`,
	subagentType: "Explore",
	status,
	...overrides,
});

describe("TaskGroupItem", () => {
	it("summarizes progress while Tasks are still running", () => {
		render(
			<TaskGroupItem
				tasks={[task("t1", "done"), task("t2", "running"), task("t3", "done")]}
			/>,
		);
		expect(screen.getByText("2/3 done")).toBeInTheDocument();
		expect(screen.getByRole("status", { name: "Task running" })).toBeVisible();
	});

	it("says so plainly once every Task succeeded", () => {
		render(<TaskGroupItem tasks={[task("t1", "done"), task("t2", "done")]} />);
		expect(screen.getByText("2 subtasks · all done")).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("counts failures and interrupts separately", () => {
		render(
			<TaskGroupItem
				tasks={[
					task("t1", "done"),
					task("t2", "failed"),
					task("t3", "interrupted"),
				]}
			/>,
		);
		expect(
			screen.getByText("1/3 done · 1 failed · 1 interrupted"),
		).toBeInTheDocument();
	});

	// A lone Task has no progress worth counting; showing "1/1 done" instead of
	// what it was doing would be a step back from the plain tool strip.
	it("shows the description instead of a count for a single Task", () => {
		render(<TaskGroupItem tasks={[task("t1", "running")]} />);
		expect(screen.getByText("t1 description")).toBeInTheDocument();
	});

	it("opens itself when a Task fails, so the failure is not missed", () => {
		render(
			<TaskGroupItem tasks={[task("t1", "failed"), task("t2", "done")]} />,
		);
		expect(screen.getByLabelText("failed")).toBeVisible();
		expect(screen.getByLabelText("done")).toBeVisible();
	});

	it("stays collapsed until asked otherwise", async () => {
		const user = userEvent.setup();
		render(<TaskGroupItem tasks={[task("t1", "done"), task("t2", "done")]} />);
		expect(screen.queryByLabelText("done")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getAllByLabelText("done")).toHaveLength(2);
	});

	it("gives each state its own icon", () => {
		// The failure below is what opens the group; the four states then have to
		// be told apart at a glance.
		render(
			<TaskGroupItem
				tasks={[
					task("t1", "running"),
					task("t2", "done"),
					task("t3", "failed"),
					task("t4", "interrupted"),
				]}
			/>,
		);
		expect(screen.getByRole("status", { name: "running" })).toBeVisible();
		expect(screen.getByLabelText("done")).toBeVisible();
		expect(screen.getByLabelText("failed")).toBeVisible();
		expect(screen.getByLabelText("interrupted")).toBeVisible();
	});

	// With one Task the header shows its description instead of a tally, so the
	// icon is the only thing separating a finished Task from an abandoned one.
	it("shows a lone Task's outcome in the collapsed header", () => {
		render(<TaskGroupItem tasks={[task("t1", "interrupted")]} />);
		expect(screen.getByLabelText("interrupted")).toBeVisible();
	});

	it("keeps a report that landed after the interrupt readable", async () => {
		const user = userEvent.setup();
		render(
			<TaskGroupItem
				tasks={[
					task("t1", "interrupted", {
						result: "# Late report",
						resultAfterInterrupt: true,
					}),
					task("t2", "done"),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		await user.click(screen.getByText("t1 description"));
		expect(screen.getByText("Late report")).toBeInTheDocument();
		// The report reads as if the Task finished normally unless it says so.
		expect(
			screen.getByText("Returned after the turn was interrupted."),
		).toBeInTheDocument();
	});
});
