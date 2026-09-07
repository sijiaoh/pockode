import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import type { WorkCardMessage, WorkTimelineEntry } from "../../types/message";
import type { Work } from "../../types/work";
import WorkCardItem from "./WorkCardItem";

vi.mock("./MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

const startWork = vi.hoisted(() => vi.fn());

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { actions: unknown }) => unknown) =>
		selector({ actions: { startWork } }),
}));

// delay: null keeps interactions off the macrotask queue; with the default
// pacing these tests can exceed the 5s timeout when the suite saturates the CPU.
const setupUser = () => userEvent.setup({ delay: null });

const createWork = (overrides: Partial<Work> = {}): Work => ({
	id: "work-1",
	type: "task",
	title: "Ship the card",
	status: "in_progress",
	agent_role_id: "role-1",
	current_step: 1,
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

const entry = (
	id: string,
	subtype: string,
	overrides: Partial<WorkTimelineEntry> = {},
): WorkTimelineEntry => ({
	id,
	subtype,
	content: `${subtype} body`,
	...overrides,
});

const createMessage = (
	overrides: Partial<WorkCardMessage> = {},
): WorkCardMessage => ({
	id: "card-1",
	role: "work",
	workId: "work-1",
	workType: "task",
	title: "Ship the card",
	entries: [entry("e1", "kickoff", { step: { current: 1, total: 3 } })],
	createdAt: new Date("2026-03-04T00:00:00Z"),
	...overrides,
});

const seed = (works: Work[], steps: string[] | undefined = ["a", "b", "c"]) => {
	useWorkStore.setState({ works, isLoading: false, error: null });
	useAgentRoleStore.setState({
		roles: [
			{
				id: "role-1",
				name: "Engineer",
				role_prompt: "",
				steps,
				created_at: "2026-03-04T00:00:00Z",
				updated_at: "2026-03-04T00:00:00Z",
			},
		],
		isLoading: false,
		error: null,
	});
};

/** The card's own header button, told apart from the rows inside it. */
const header = () => screen.getByRole("button", { name: /^(Task|Story), / });

describe("WorkCardItem", () => {
	beforeEach(() => {
		startWork.mockReset().mockResolvedValue(undefined);
		seed([createWork()]);
	});

	it("states the live status and step next to the title", () => {
		render(<WorkCardItem message={createMessage()} />);

		expect(
			screen.getByRole("button", {
				name: "Task, In Progress, Step 2/3, Ship the card",
			}),
		).toBeInTheDocument();
	});

	it("follows the work store rather than the messages it was built from", () => {
		render(<WorkCardItem message={createMessage()} />);

		// An interrupt stops a work without producing any message at all, so this
		// is the only path by which the card can learn about it.
		act(() => {
			useWorkStore
				.getState()
				.updateWorks((works) =>
					works.map((w) => ({ ...w, status: "stopped" as const })),
				);
		});

		expect(
			screen.getByRole("button", { name: /^Task, Stopped, Step 2\/3/ }),
		).toBeInTheDocument();
	});

	it("offers a restart once the work is stopped", async () => {
		const user = setupUser();
		seed([createWork({ status: "stopped" })]);
		render(<WorkCardItem message={createMessage()} />);

		await user.click(screen.getByRole("button", { name: "Restart" }));
		expect(startWork).toHaveBeenCalledWith("work-1");
	});

	it("stays in the stream once the work is closed", () => {
		seed([createWork({ status: "closed" })]);
		render(<WorkCardItem message={createMessage()} />);

		expect(
			screen.getByRole("button", { name: /^Task, Closed, 3\/3/ }),
		).toBeInTheDocument();
	});

	it("counts the subtasks a waiting work is blocked on", () => {
		seed([
			createWork({ status: "waiting" }),
			createWork({
				id: "child-1",
				parent_id: "work-1",
				title: "Sub task",
				status: "in_progress",
			}),
		]);
		render(<WorkCardItem message={createMessage()} />);

		expect(
			screen.getByRole("button", { name: /^Task, Waiting, 1 subtask/ }),
		).toBeInTheDocument();
	});

	it("keeps the full prompt body reachable through the timeline", async () => {
		const user = setupUser();
		render(<WorkCardItem message={createMessage()} />);

		await user.click(header());
		await user.click(screen.getByRole("button", { name: "Kickoff" }));

		expect(screen.getByText("kickoff body")).toBeInTheDocument();
	});

	it("collapses a run of auto-continues into one row", async () => {
		const user = setupUser();
		render(
			<WorkCardItem
				message={createMessage({
					entries: [
						entry("e1", "kickoff"),
						entry("e2", "auto_continue"),
						entry("e3", "auto_continue"),
					],
				})}
			/>,
		);

		await user.click(header());
		expect(
			screen.getByRole("button", { name: "Auto-continue ×2" }),
		).toBeInTheDocument();
	});

	it("opens expanded when the work needs input", () => {
		seed([createWork({ status: "needs_input" })]);
		render(<WorkCardItem message={createMessage()} />);

		expect(
			screen.getByRole("button", { name: /^Task, Needs Input/ }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("degrades to what the messages recorded when the work is gone", () => {
		seed([]);
		render(
			<WorkCardItem
				message={createMessage({
					entries: [
						entry("e1", "kickoff", { step: { current: 1, total: 3 } }),
						entry("e2", "step_advance", { step: { current: 2, total: 3 } }),
					],
				})}
			/>,
		);

		// Title and last recorded step survive; the status slot says only that it
		// is unknown, since a deleted work has none to report.
		expect(
			screen.getByRole("button", {
				name: "Task, unknown status, Step 2/3, Ship the card",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("—")).toBeInTheDocument();
	});

	it("opens the work detail from the card", async () => {
		const user = setupUser();
		const onOpenWorkDetail = vi.fn();
		render(
			<WorkCardItem
				message={createMessage()}
				onOpenWorkDetail={onOpenWorkDetail}
			/>,
		);

		await user.click(header());
		await user.click(screen.getByRole("button", { name: "Details" }));

		expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
	});
});
