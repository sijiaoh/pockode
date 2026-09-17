import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../lib/activity";
import type { WorkListItem, WorkStatus } from "../../types/work";
import WorkPrimaryAction from "./WorkPrimaryAction";

const startWork = vi.fn(() => Promise.resolve());
const stopWork = vi.fn(() => Promise.resolve());
const reopenWork = vi.fn(() => Promise.resolve());

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { startWork, stopWork, reopenWork } }),
}));

const work = (
	status: WorkStatus,
	activity: Activity,
): Pick<WorkListItem, "id" | "status" | "activity" | "title"> => ({
	id: "work-1",
	status,
	activity,
	title: "Work",
});

describe("WorkPrimaryAction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// The button is chosen by status alone: one that appeared and vanished as
	// turns settled would be one the user cannot aim at. It is a glyph on every
	// row, so the name it is announced under has to carry both the verb and the
	// work — a screen reader walking a list meets a column of identical verbs
	// otherwise.
	it.each([
		["open", "Start"],
		["active", "Stop"],
		["stopped", "Restart"],
		["closed", "Reopen"],
	] as const)("offers %s work its %s", (status, label) => {
		render(<WorkPrimaryAction work={work(status, "idle")} />);

		expect(
			screen.getByRole("button", { name: `${label} "Work"` }),
		).toBeInTheDocument();
	});

	it("stops an ordinary active work without asking", async () => {
		const user = userEvent.setup();
		render(<WorkPrimaryAction work={work("active", "idle")} />);

		await user.click(screen.getByRole("button", { name: 'Stop "Work"' }));

		expect(stopWork).toHaveBeenCalledWith("work-1");
	});

	// The confirmation is the one thing here that may read the activity: by the
	// time it is shown the user has already aimed, and what they lose depends on
	// what is happening.
	it("warns that a background task is lost before stopping the turn", async () => {
		const user = userEvent.setup();
		render(<WorkPrimaryAction work={work("active", "background")} />);

		await user.click(screen.getByRole("button", { name: 'Stop "Work"' }));
		expect(stopWork).not.toHaveBeenCalled();
		expect(
			screen.getByText(/background tasks will be lost/),
		).toBeInTheDocument();

		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }),
		);
		expect(stopWork).toHaveBeenCalledWith("work-1");
	});

	it("says how many subtasks keep running when a story is stopped", async () => {
		const user = userEvent.setup();
		render(
			<WorkPrimaryAction work={work("active", "idle")} activeChildCount={2} />,
		);

		await user.click(screen.getByRole("button", { name: 'Stop "Work"' }));

		expect(
			screen.getByText("Stop this story? Its 2 active subtasks keep running."),
		).toBeInTheDocument();
		expect(stopWork).not.toHaveBeenCalled();
	});

	it("leaves the work alone when the confirmation is cancelled", async () => {
		const user = userEvent.setup();
		render(
			<WorkPrimaryAction work={work("active", "idle")} activeChildCount={1} />,
		);

		await user.click(screen.getByRole("button", { name: 'Stop "Work"' }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(stopWork).not.toHaveBeenCalled();
	});

	// The work can leave `active` while the dialog is open — the engine stops it,
	// an agent closes it — and the command follows the status. A dialog kept
	// across that change would start the work when the user pressed Stop.
	it("drops a pending confirmation when the work stops being stoppable", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<WorkPrimaryAction work={work("active", "background")} />,
		);

		await user.click(screen.getByRole("button", { name: 'Stop "Work"' }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		rerender(<WorkPrimaryAction work={work("stopped", "stopped")} />);

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: 'Restart "Work"' }),
		).toBeInTheDocument();
	});

	// A glyph has nowhere to write the word, so the failure is what the button is
	// announced as — and it turns the error colour for everyone else.
	it("reports a failure on the button instead of swallowing it", async () => {
		const user = userEvent.setup();
		startWork.mockRejectedValueOnce(new Error("no worktree"));
		render(<WorkPrimaryAction work={work("open", "open")} />);

		await user.click(screen.getByRole("button", { name: 'Start "Work"' }));

		expect(
			await screen.findByRole("button", { name: "no worktree" }),
		).toBeInTheDocument();
	});
});
