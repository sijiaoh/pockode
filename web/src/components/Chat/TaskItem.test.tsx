import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TaskRun, TaskRunStatus } from "../../types/message";
import TaskItem from "./TaskItem";

const task = (
	status: TaskRunStatus,
	overrides: Partial<TaskRun> = {},
): TaskRun => ({
	toolUseId: "t1",
	description: "find usages",
	subagentType: "Explore",
	status,
	result: "# Report",
	...overrides,
});

describe("TaskItem", () => {
	it("says what the Task is doing and who is doing it", () => {
		render(<TaskItem task={task("running")} />);
		expect(screen.getByText("find usages")).toBeVisible();
		expect(screen.getByText("Explore")).toBeVisible();
		expect(screen.getByRole("status", { name: "Task running" })).toBeVisible();
	});

	it("gives each finished state its own icon", () => {
		const { rerender } = render(<TaskItem task={task("done")} />);
		expect(screen.getByLabelText("done")).toBeVisible();

		rerender(<TaskItem task={task("interrupted")} />);
		expect(screen.getByLabelText("interrupted")).toBeVisible();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the report out of the way until asked for it", async () => {
		const user = userEvent.setup();
		render(<TaskItem task={task("done", { prompt: "go" })} />);
		expect(screen.queryByText("Report")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Report")).toBeVisible();
	});

	// The brief is only visible here, but it is the longest thing in the row and
	// the least often wanted.
	it("keeps the prompt behind a second click", async () => {
		const user = userEvent.setup();
		render(<TaskItem task={task("done", { prompt: "explore the repo" })} />);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.queryByText("explore the repo")).not.toBeInTheDocument();

		await user.click(screen.getByText("Prompt"));
		expect(screen.getByText("explore the repo")).toBeVisible();
	});

	it("opens itself when the Task fails, so the failure is not missed", () => {
		render(
			<TaskItem task={task("failed", { result: "Agent type not found" })} />,
		);
		expect(screen.getByText("Agent type not found")).toBeVisible();
	});

	// A Task that was just spawned has nothing to show yet, and a chevron
	// promising otherwise is a dead click.
	it("cannot be opened before there is anything under it", () => {
		render(<TaskItem task={task("running", { result: undefined })} />);
		expect(screen.queryByRole("button", { expanded: false })).toBeNull();
	});

	it("keeps a report that landed after the interrupt readable", async () => {
		const user = userEvent.setup();
		render(
			<TaskItem
				task={task("interrupted", {
					result: "# Late report",
					resultAfterInterrupt: true,
				})}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Late report")).toBeVisible();
		// The report reads as if the Task finished normally unless it says so.
		expect(
			screen.getByText("Returned after the turn was interrupted."),
		).toBeVisible();
	});
});
