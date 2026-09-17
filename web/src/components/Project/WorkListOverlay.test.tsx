import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectPanelActions } from "../../lib/projectPanelStore";
import { useWorkStore } from "../../lib/workStore";
import type { WorkListItem } from "../../types/work";
import WorkListOverlay from "./WorkListOverlay";

vi.mock("../ui/BackToChatButton", () => ({
	default: ({ onClick }: { onClick: () => void }) => (
		<button type="button" onClick={onClick}>
			Back to chat
		</button>
	),
}));

// The sheet has its own tests; here it stands for "the create flow answered
// with an id", which is the wiring this screen owns.
vi.mock("./CreateWorkSheet", () => ({
	default: ({ onCreated }: { onCreated: (workId: string) => void }) => (
		<button type="button" onClick={() => onCreated("new-work")}>
			Pretend to create
		</button>
	),
}));

vi.mock("../Worktree", () => ({
	WorktreeBadge: () => null,
	useWorktreeBadgeVisible: () => false,
}));

const createWork = (overrides: Partial<WorkListItem>): WorkListItem => ({
	id: "work-1",
	type: "story",
	title: "Story",
	status: "open",
	activity: "open",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

function setWorks(works: WorkListItem[]) {
	useWorkStore.setState({ works, isLoading: false, error: null });
}

function renderList() {
	const onOpenWorkDetail = vi.fn();
	const onNavigateToSession = vi.fn();
	const view = render(
		<WorkListOverlay
			onBack={vi.fn()}
			onOpenWorkDetail={onOpenWorkDetail}
			onNavigateToSession={onNavigateToSession}
		/>,
	);
	return { ...view, onOpenWorkDetail, onNavigateToSession };
}

/** Every row title on screen, top to bottom — which is what the groups decide. */
function rowTitles(): string[] {
	return screen
		.queryAllByRole("heading", { level: 3 })
		.map((h) => h.textContent ?? "");
}

function groupOf(title: string): string {
	const headings = screen.getAllByRole("heading", { level: 2 });
	const row = screen.getByRole("heading", { level: 3, name: title });
	const before = headings.filter(
		(h) => h.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
	);
	const heading = before[before.length - 1];
	if (!heading) throw new Error(`"${title}" is under no group heading`);
	// The count badge trails the label.
	return (heading.textContent ?? "").replace(/\d+$/, "");
}

describe("WorkListOverlay", () => {
	beforeEach(() => {
		setWorks([]);
		projectPanelActions.reset();
	});

	// §2.2: the group's promise is that what is in it is for the user to do, so
	// the thing to do has to be what is in it.
	it("gives a task that needs a person its own row, and not its story's", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Cluster mode",
				status: "active",
				activity: "waiting_children",
			}),
			createWork({
				id: "t1",
				type: "task",
				parent_id: "s1",
				title: "Wire the relay",
				status: "active",
				activity: "needs_answer",
			}),
		]);

		renderList();

		expect(groupOf("Wire the relay")).toBe("Needs you");
		expect(groupOf("Cluster mode")).toBe("In progress");
	});

	it("names the story a task left, whatever state that story is in", () => {
		setWorks([
			createWork({ id: "s1", title: "Cluster mode", status: "closed" }),
			createWork({
				id: "t1",
				type: "task",
				parent_id: "s1",
				title: "Wire the relay",
				status: "stopped",
				activity: "stopped",
			}),
		]);

		renderList();

		expect(groupOf("Wire the relay")).toBe("Not running");
		expect(screen.getByText("in: Cluster mode")).toBeInTheDocument();
	});

	// A running, idle, open or closed task has nobody waiting on it, so it is
	// its story's business and is reached through the story.
	it("rolls every other task into its story's row", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Cluster mode",
				status: "active",
				activity: "running",
			}),
			createWork({
				id: "t1",
				type: "task",
				parent_id: "s1",
				title: "A running task",
				status: "active",
				activity: "running",
			}),
			createWork({
				id: "t2",
				type: "task",
				parent_id: "s1",
				title: "A finished task",
				status: "closed",
				activity: "closed",
			}),
		]);

		renderList();

		expect(rowTitles()).toEqual(["Cluster mode"]);
		expect(screen.getByText("1 active")).toBeInTheDocument();
		expect(screen.getByText("1/2 tasks")).toBeInTheDocument();
	});

	// §2.3: `open` and `stopped` differ in how they got there, not in what the
	// user does about them.
	it("holds the work nothing is happening to in one group", () => {
		setWorks([
			createWork({ id: "s1", title: "Never started", status: "open" }),
			createWork({
				id: "s2",
				title: "Handed back",
				status: "stopped",
				activity: "stopped",
			}),
		]);

		renderList();

		expect(groupOf("Never started")).toBe("Not running");
		expect(groupOf("Handed back")).toBe("Not running");
		expect(
			screen.getByRole("button", { name: 'Restart "Handed back"' }),
		).toBeInTheDocument();
	});

	// A stale stopped work at the top of *Needs you* would teach the user that
	// the group's count is not a number of things to do.
	it("keeps a stopped work out of Needs you", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Handed back",
				status: "stopped",
				activity: "stopped",
			}),
		]);

		renderList();

		expect(screen.queryByText("Needs you")).not.toBeInTheDocument();
	});

	it("counts the rows in a group, not the work under them", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Cluster mode",
				status: "active",
				activity: "running",
			}),
			createWork({
				id: "t1",
				type: "task",
				parent_id: "s1",
				title: "A running task",
				status: "active",
				activity: "running",
			}),
		]);

		renderList();

		expect(
			screen.getByRole("heading", { level: 2, name: /In progress/ }),
		).toHaveTextContent("In progress1");
	});

	// Grouping reads `status` plus the single needsUser predicate, never the
	// full activity: a list that regrouped on every phase change would reorder
	// itself while being read.
	it("keeps an active work in one group whatever its turn is doing", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Background Story",
				status: "active",
				activity: "background",
			}),
			createWork({
				id: "s2",
				title: "Coordinating Story",
				status: "active",
				activity: "waiting_children",
			}),
		]);

		renderList();

		expect(screen.queryByText("Needs you")).not.toBeInTheDocument();
		expect(groupOf("Background Story")).toBe("In progress");
		expect(groupOf("Coordinating Story")).toBe("In progress");
	});

	it("renders no group it has no rows for", () => {
		setWorks([createWork({ id: "s1", title: "Never started" })]);

		renderList();

		expect(
			screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
		).toEqual(["Not running1"]);
	});

	// §2.3 and §8.3: the one thing collapsing was for was getting the archive
	// out of the way, and the archive is a segment now.
	it("offers nothing to expand or collapse", () => {
		setWorks([
			createWork({
				id: "s1",
				title: "Cluster mode",
				status: "active",
				activity: "running",
			}),
			createWork({
				id: "t1",
				type: "task",
				parent_id: "s1",
				title: "A running task",
				status: "active",
				activity: "running",
			}),
		]);

		renderList();

		expect(
			screen.queryByRole("button", {
				name: /expand|collapse|Needs you|progress|Not running/i,
			}),
		).toBeNull();
		expect(screen.queryByRole("button", { expanded: true })).toBeNull();
		expect(screen.queryByRole("button", { expanded: false })).toBeNull();
	});

	// §2.1: finished work is the other segment, not a group at the bottom of a
	// long scroll.
	it("keeps closed work out of Current and lists it under Closed, newest first", async () => {
		const user = userEvent.setup();
		setWorks([
			createWork({
				id: "older",
				title: "Older Story",
				status: "closed",
				activity: "closed",
				updated_at: "2026-03-01T00:00:00Z",
			}),
			createWork({
				id: "newer",
				title: "Newer Story",
				status: "closed",
				activity: "closed",
				updated_at: "2026-03-05T00:00:00Z",
			}),
			// A finished task is looked for inside its story, so it is a row in
			// neither segment (§6).
			createWork({
				id: "t1",
				type: "task",
				parent_id: "newer",
				title: "A finished task",
				status: "closed",
				activity: "closed",
			}),
			createWork({ id: "s1", title: "Never started" }),
		]);

		renderList();
		expect(rowTitles()).toEqual(["Never started"]);

		await user.click(screen.getByRole("button", { name: "Closed" }));

		expect(rowTitles()).toEqual(["Newer Story", "Older Story"]);
		// The archive is flat: no groups, and no story's tasks under it.
		expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
	});

	it("dates the archive it sorts, and nothing else", async () => {
		const user = userEvent.setup();
		setWorks([
			createWork({
				id: "closed",
				title: "Older Story",
				status: "closed",
				activity: "closed",
			}),
			createWork({ id: "s1", title: "Never started" }),
		]);

		renderList();
		expect(screen.queryByText(/ago|just now|yesterday/)).toBeNull();

		await user.click(screen.getByRole("button", { name: "Closed" }));
		expect(screen.getByText(/ago|just now|yesterday/)).toBeInTheDocument();
	});

	// §5: the screen unmounts on the way into a work detail, so the choice
	// cannot live in the component.
	it("remembers the segment across a trip into a detail page", async () => {
		const user = userEvent.setup();
		setWorks([
			createWork({
				id: "closed",
				title: "Older Story",
				status: "closed",
				activity: "closed",
			}),
		]);

		const { unmount } = renderList();
		await user.click(screen.getByRole("button", { name: "Closed" }));
		unmount();

		renderList();

		expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(rowTitles()).toEqual(["Older Story"]);
	});

	it("navigates to a work's chat using the work's own worktree", async () => {
		const user = userEvent.setup();
		setWorks([
			createWork({
				id: "s1",
				title: "Story In Feature Worktree",
				status: "active",
				activity: "running",
				worktree: "feature-x",
				session_id: "session-abc",
			}),
		]);

		const { onNavigateToSession } = renderList();

		await user.click(
			screen.getByRole("button", {
				name: 'Open chat for "Story In Feature Worktree"',
			}),
		);

		expect(onNavigateToSession).toHaveBeenCalledWith(
			"session-abc",
			"feature-x",
		);
	});

	it("opens the detail from a row", async () => {
		const user = userEvent.setup();
		setWorks([createWork({ id: "s1", title: "Never started" })]);

		const { onOpenWorkDetail } = renderList();
		await user.click(
			screen.getByRole("button", { name: "Never started — Open" }),
		);

		expect(onOpenWorkDetail).toHaveBeenCalledWith("s1");
	});

	// §4: nothing is created into a list position the user then has to find.
	it("lands on the new story's detail page after creating one", async () => {
		const user = userEvent.setup();
		const { onOpenWorkDetail } = renderList();

		await user.click(screen.getByRole("button", { name: "New Story" }));
		await user.click(screen.getByRole("button", { name: "Pretend to create" }));

		expect(onOpenWorkDetail).toHaveBeenCalledWith("new-work");
		expect(
			screen.queryByRole("button", { name: "Pretend to create" }),
		).toBeNull();
	});

	// The form it replaces scrolled away exactly when the list was long.
	it("keeps the create control reachable in either segment", async () => {
		const user = userEvent.setup();
		renderList();

		expect(screen.getByRole("button", { name: "New Story" })).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Closed" }));
		expect(screen.getByRole("button", { name: "New Story" })).toBeVisible();
	});

	describe("with nothing to show", () => {
		it("says so per segment", async () => {
			const user = userEvent.setup();

			renderList();
			expect(screen.getByText("Nothing on the go.")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Closed" }));
			expect(screen.getByText("Nothing finished yet.")).toBeInTheDocument();
			expect(screen.queryByText("Nothing on the go.")).toBeNull();
		});

		it("keeps the segments usable while the list loads and when it fails", () => {
			useWorkStore.setState({ works: [], isLoading: true, error: null });
			const { unmount } = renderList();
			expect(screen.getByRole("button", { name: "Closed" })).toBeEnabled();
			unmount();

			useWorkStore.setState({
				works: [],
				isLoading: false,
				error: "Subscription failed",
			});
			renderList();
			expect(screen.getByText("Subscription failed")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Closed" })).toBeEnabled();
		});
	});
});
