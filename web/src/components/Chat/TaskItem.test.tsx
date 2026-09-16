import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ToolRun, ToolRunStatus } from "../../types/message";
import TaskItem from "./TaskItem";

const task = (
	status: ToolRunStatus,
	overrides: Partial<ToolRun> = {},
): ToolRun => ({
	id: "t1",
	name: "Agent",
	input: { description: "find usages", subagent_type: "Explore" },
	status,
	result: "# Report",
	...overrides,
});

describe("TaskItem", () => {
	it("says what the Task is doing and who is doing it", () => {
		render(<TaskItem run={task("running")} />);
		expect(screen.getByText("find usages")).toBeVisible();
		expect(screen.getByText("Explore")).toBeVisible();
		expect(screen.getByRole("status", { name: "Task running" })).toBeVisible();
	});

	it("gives each finished state its own icon", () => {
		const { rerender } = render(<TaskItem run={task("success")} />);
		expect(screen.getByLabelText("succeeded")).toBeVisible();

		rerender(<TaskItem run={task("interrupted")} />);
		expect(screen.getByLabelText("interrupted")).toBeVisible();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the report out of the way until asked for it", async () => {
		const user = userEvent.setup();
		render(<TaskItem run={task("success")} />);
		expect(screen.queryByText("Report")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Report")).toBeVisible();
	});

	// The brief is only visible here, but it is the longest thing in the row and
	// the least often wanted.
	it("keeps the prompt behind a second click", async () => {
		const user = userEvent.setup();
		render(
			<TaskItem
				run={task("success", {
					input: { description: "find usages", prompt: "explore the repo" },
				})}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.queryByText("explore the repo")).not.toBeInTheDocument();

		await user.click(screen.getByText("Prompt"));
		expect(screen.getByText("explore the repo")).toBeVisible();
	});

	it("opens itself when the Task fails, so the failure is not missed", () => {
		render(
			<TaskItem run={task("error", { result: "Agent type not found" })} />,
		);
		expect(screen.getByText("Agent type not found")).toBeVisible();
	});

	// A Task that was just spawned can still be opened — the brief it was given
	// is worth reading before the report exists — and says plainly that the
	// report is not there yet.
	it("says so when there is no report yet", async () => {
		const user = userEvent.setup();
		render(<TaskItem run={task("running", { result: undefined })} />);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/No report yet/)).toBeVisible();
	});

	// The row above has settled: saying the subagent "is still working" there
	// would contradict the glyph beside it, and a failure that came back empty
	// opens itself, so this is the sentence the reader is shown.
	it("does not claim a settled Task is still working", () => {
		render(<TaskItem run={task("error", { result: undefined })} />);
		expect(screen.queryByText(/still working/)).toBeNull();
		expect(
			screen.getByText("The subagent failed without reporting anything."),
		).toBeVisible();
	});

	it("keeps a report that landed after the interrupt readable", async () => {
		const user = userEvent.setup();
		render(<TaskItem run={task("interrupted", { result: "# Late report" })} />);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Late report")).toBeVisible();
		// The report reads as if the Task finished normally unless it says so.
		expect(
			screen.getByText("Returned after the turn was interrupted."),
		).toBeVisible();
	});
});
