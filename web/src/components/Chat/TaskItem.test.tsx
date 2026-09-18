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

	// Unlike a tool call, which fails as ordinary trial and error and prints its
	// last line on the row: a subagent failing is rare, and this body is the only
	// account of what went wrong.
	it("opens itself when the Task fails, so the failure is not missed", () => {
		render(
			<TaskItem run={task("error", { result: "Agent type not found" })} />,
		);
		expect(screen.getByText("Agent type not found")).toBeVisible();
	});

	// Because the body is already open, the shared row's failure line would only
	// be a second and worse copy of what is under it — the tail of a markdown
	// report, drawn in mono.
	it("does not repeat the report on the row of a failed Task", () => {
		render(
			<TaskItem
				run={task("error", { result: "# Report\n\n- could not find it" })}
			/>,
		);
		// The list item is in the body, rendered as markdown. The verbatim source
		// line is what the row would have shown.
		expect(screen.queryByText("- could not find it")).toBeNull();
		expect(screen.getByText("could not find it")).toBeVisible();
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

	describe("a subagent that went to the background", () => {
		// No `result` while it is still running: the outcome only arrives with
		// the notification, and the helper's default report is not one.
		const background = {
			fromBackground: true,
			result: undefined,
			placeholderResult: "Agent running in background with ID: bsbvhgo40",
		};

		// The body used to draw this text as the subagent's own report, which
		// asserts the agent read something it never did: what arrived is the
		// notification that said how the task ended, and the subagent's report
		// never reached this client at all.
		it("labels the outcome instead of passing it off as the report", async () => {
			const user = userEvent.setup();
			render(
				<TaskItem
					run={task("success", {
						...background,
						result: "Background agent completed (exit code 0)",
					})}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Outcome · after the turn")).toBeVisible();
			// Twice over: the settled row hands its second line to the outcome,
			// and the body is where it is labelled.
			expect(
				screen.getAllByText("Background agent completed (exit code 0)"),
			).toHaveLength(2);
			// Not "the subagent reported nothing": its report does not come back
			// here at all once the call handed the agent a placeholder.
			expect(
				screen.getByText(
					"A backgrounded subagent's own report does not come back to the transcript.",
				),
			).toBeVisible();
		});

		// It is what the agent actually read when the call returned, and it was
		// drawn nowhere at all before.
		it("shows what it handed the agent while it carried on", async () => {
			const user = userEvent.setup();
			render(<TaskItem run={task("background", background)} />);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Returned to the agent")).toBeVisible();
			expect(screen.getByText(/bsbvhgo40/)).toBeVisible();
		});

		// A background row is by definition not at the tail of the transcript,
		// and this body has a `useEffect` that opens itself on failure — the one
		// place somebody could plausibly hang "and when a fetch arrives" too.
		it("does not open itself when a fetch arrives", () => {
			const { rerender } = render(
				<TaskItem run={task("background", background)} />,
			);
			rerender(
				<TaskItem
					run={task("background", {
						...background,
						fetches: [{ id: "f1", result: "explored 12 files" }],
					})}
				/>,
			);
			expect(screen.getByRole("button", { expanded: false })).toBeVisible();
			expect(screen.queryByText("Fetched output")).toBeNull();
		});

		// The same account of the same thing as on an ordinary tool row: one
		// shared section, not a second way of saying it per renderer.
		it("reads what a later call fetched of it", async () => {
			const user = userEvent.setup();
			render(
				<TaskItem
					run={task("background", {
						...background,
						fetches: [{ id: "f1", result: "explored 12 files" }],
					})}
				/>,
			);

			expect(screen.getByText("explored 12 files")).toBeVisible();
			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Fetched output")).toBeVisible();
		});
	});
});
