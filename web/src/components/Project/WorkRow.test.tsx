import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkListItem } from "../../types/work";
import WorkRow from "./WorkRow";

const startWork = vi.fn(() => Promise.resolve());
const stopWork = vi.fn(() => Promise.resolve());
const reopenWork = vi.fn(() => Promise.resolve());

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { startWork, stopWork, reopenWork } }),
}));

// The badge decides for itself whether a worktree is settled enough to name;
// the row only has to place it, so the two answers are given here directly.
let badgeVisible = false;
vi.mock("../Worktree", () => ({
	WorktreeBadge: () => <span>feature-x</span>,
	useWorktreeBadgeVisible: () => badgeVisible,
}));

const work = (overrides: Partial<WorkListItem> = {}): WorkListItem => ({
	id: "work-1",
	type: "story",
	title: "Rebuild the project page",
	status: "active",
	activity: "running",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

/** The line of facts under the title, as the user reads it left to right. */
function metaLine(): string {
	const role = screen.getByText("Engineer");
	return role.closest("div")?.textContent ?? "";
}

function renderRow(props: Partial<Parameters<typeof WorkRow>[0]> = {}) {
	const onOpen = vi.fn();
	const onOpenChat = vi.fn();
	const view = render(
		<WorkRow
			work={work()}
			onOpen={onOpen}
			onOpenChat={onOpenChat}
			{...props}
		/>,
	);
	const rerenderRow = (next: Partial<Parameters<typeof WorkRow>[0]>) =>
		view.rerender(
			<WorkRow
				work={work()}
				onOpen={onOpen}
				onOpenChat={onOpenChat}
				{...props}
				{...next}
			/>,
		);
	return { onOpen, onOpenChat, rerenderRow };
}

describe("WorkRow", () => {
	beforeEach(() => {
		badgeVisible = false;
		vi.clearAllMocks();
	});

	it("opens the work from its title, whatever else the row offers", async () => {
		const user = userEvent.setup();
		const { onOpen } = renderRow({
			work: work({ id: "story-7", session_id: "session-1" }),
		});

		await user.click(
			screen.getByRole("button", {
				name: "Rebuild the project page — Running",
			}),
		);

		expect(onOpen).toHaveBeenCalledWith("story-7");
	});

	// A screen reader walking a list meets a column of identical verbs otherwise.
	it("names the work in both icon controls", () => {
		renderRow({
			work: work({ status: "open", activity: "open", session_id: "s-1" }),
		});

		expect(
			screen.getByRole("button", { name: 'Start "Rebuild the project page"' }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: 'Open chat for "Rebuild the project page"',
			}),
		).toBeInTheDocument();
	});

	it("offers the chat only when the work has a session, in its own worktree", async () => {
		const user = userEvent.setup();
		expect(
			render(
				<WorkRow work={work()} onOpen={vi.fn()} onOpenChat={vi.fn()} />,
			).queryByRole("button", { name: /Open chat/ }),
		).toBeNull();

		const { onOpenChat } = renderRow({
			work: work({ session_id: "session-abc", worktree: "feature-x" }),
		});
		await user.click(
			screen.getByRole("button", {
				name: 'Open chat for "Rebuild the project page"',
			}),
		);

		expect(onOpenChat).toHaveBeenCalledWith("session-abc", "feature-x");
	});

	it("keeps the slots in one order whatever the row is", () => {
		badgeVisible = true;
		renderRow({
			work: work({
				type: "task",
				activity: "needs_answer",
				wait: "user",
			}),
			parentTitle: "Cluster mode",
			roleName: "Engineer",
		});

		expect(metaLine()).toBe("Needs answer·in: Cluster mode·feature-x·Engineer");
	});

	it("rolls its children up into the story's own line", () => {
		renderRow({
			work: work(),
			roleName: "Engineer",
			tasks: [
				work({ id: "t1", type: "task", status: "active" }),
				work({ id: "t2", type: "task", status: "closed" }),
				work({ id: "t3", type: "task", status: "open" }),
			],
		});

		expect(metaLine()).toBe("Engineer·1 active·1/3 tasks");
	});

	// §3.1: the story detail's children section drops the parent slot, and that
	// is the only difference between the two screens' rows.
	it("leaves the parent unnamed when the screen does not pass one", () => {
		renderRow({
			work: work({ type: "task" }),
			roleName: "Engineer",
		});

		expect(metaLine()).toBe("Engineer");
	});

	// The bar already says someone is blocked; slot 1 says what kind of answer is
	// wanted, which only the needs-you leaves have.
	it("writes no activity label for a work nobody is waiting on", () => {
		renderRow({ work: work({ status: "stopped", activity: "stopped" }) });

		expect(screen.queryByText("Stopped")).toBeNull();
	});

	it("dates a row only where the list is sorted by it", () => {
		renderRow({ work: work({ status: "closed", activity: "closed" }) });
		expect(screen.queryByText(/ago|just now|yesterday/)).toBeNull();

		renderRow({
			work: work({ status: "closed", activity: "closed" }),
			showUpdatedAt: true,
		});
		expect(screen.getByText(/ago|just now|yesterday/)).toBeInTheDocument();
	});

	// No row expands: children are listed in exactly one place, the story's
	// detail page.
	it("holds no children and no way to ask for them", () => {
		renderRow({
			work: work(),
			tasks: [work({ id: "t1", type: "task", title: "A child task" })],
		});

		expect(screen.queryByText("A child task")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /expand|collapse/i }),
		).toBeNull();
	});

	it("runs the work's command from the row", async () => {
		const user = userEvent.setup();
		renderRow({ work: work({ status: "active", activity: "idle" }) });

		await user.click(
			screen.getByRole("button", {
				name: 'Stop "Rebuild the project page"',
			}),
		);

		expect(stopWork).toHaveBeenCalledWith("work-1");
	});

	// The confirmation is the one thing here that may read the activity: by the
	// time it is shown the user has already aimed, and what they lose depends on
	// what is happening.
	it("warns that a background task is lost before stopping the turn", async () => {
		const user = userEvent.setup();
		renderRow({ work: work({ status: "active", activity: "background" }) });

		await user.click(
			screen.getByRole("button", {
				name: 'Stop "Rebuild the project page"',
			}),
		);
		expect(stopWork).not.toHaveBeenCalled();

		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Stop" }),
		);
		expect(stopWork).toHaveBeenCalledWith("work-1");
	});

	it("says how many subtasks keep running when a story is stopped", async () => {
		const user = userEvent.setup();
		renderRow({
			tasks: [
				work({ id: "t1", type: "task", status: "active" }),
				work({ id: "t2", type: "task", status: "active" }),
			],
		});

		await user.click(
			screen.getByRole("button", {
				name: 'Stop "Rebuild the project page"',
			}),
		);

		expect(
			screen.getByText("Stop this story? Its 2 active subtasks keep running."),
		).toBeInTheDocument();
		expect(stopWork).not.toHaveBeenCalled();
	});

	// The half of the confirmation that has no visible trace when it breaks: a
	// Cancel that stopped the work anyway would look exactly like a Cancel that
	// worked, until the work was gone.
	it("leaves the work alone when the confirmation is cancelled", async () => {
		const user = userEvent.setup();
		renderRow({ work: work({ status: "active", activity: "background" }) });

		await user.click(
			screen.getByRole("button", {
				name: 'Stop "Rebuild the project page"',
			}),
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(stopWork).not.toHaveBeenCalled();
	});

	// The work can leave `active` while the dialog is open — the engine stops it,
	// an agent closes it — and the command follows the status. A dialog kept
	// across that change would start the work when the user pressed Stop.
	it("drops a pending confirmation when the work stops being stoppable", async () => {
		const user = userEvent.setup();
		const { rerenderRow } = renderRow({
			work: work({ status: "active", activity: "background" }),
		});

		await user.click(
			screen.getByRole("button", {
				name: 'Stop "Rebuild the project page"',
			}),
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		rerenderRow({ work: work({ status: "stopped", activity: "stopped" }) });

		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// The row is the only place this message is ever written: the detail page
	// holds its own command state, and this list unmounts on the way there. The
	// button keeps its verb — a screen reader that loses it loses which of a
	// column of identical buttons it was aiming at — and the message becomes its
	// description, which is the only way back to it once `role="alert"` has
	// spoken: the paragraph is part of no element's accessible name, so someone
	// jumping by button or heading never meets it again.
	it("writes a failed command out on the row, in reach of the button that raised it", async () => {
		const user = userEvent.setup();
		startWork.mockRejectedValueOnce(
			new Error("invalid work: work is already running"),
		);
		renderRow({ work: work({ status: "open", activity: "open" }) });
		const name = 'Start "Rebuild the project page"';

		// Nothing has failed yet, so there is nothing to point at. Asserted on the
		// attribute rather than the description, because a dangling id computes to
		// the same empty description a missing attribute does — the two are only
		// told apart here.
		expect(screen.getByRole("button", { name })).not.toHaveAttribute(
			"aria-describedby",
		);

		await user.click(screen.getByRole("button", { name }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"invalid work: work is already running",
		);
		// Named by the verb, described by the failure: the two are read in that
		// order, and neither has taken the other's place.
		expect(screen.getByRole("button", { name })).toHaveAccessibleDescription(
			"invalid work: work is already running",
		);
	});

	// A message about Start is not a message about Restart. Changing group
	// remounts the row and clears it by itself; this is the other half, where the
	// status changes but the row stays where it is.
	it("drops the message when the status changes under it", async () => {
		const user = userEvent.setup();
		startWork.mockRejectedValueOnce(
			new Error("invalid work: work is already running"),
		);
		const { rerenderRow } = renderRow({
			work: work({ status: "open", activity: "open" }),
		});

		await user.click(
			screen.getByRole("button", {
				name: 'Start "Rebuild the project page"',
			}),
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();

		rerenderRow({ work: work({ status: "stopped", activity: "stopped" }) });

		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("titles itself at the level the screen around it is written in", () => {
		renderRow({ headingLevel: 4 });

		expect(
			screen.getByRole("heading", {
				level: 4,
				name: /Rebuild the project page/,
			}),
		).toBeInTheDocument();
	});
});
