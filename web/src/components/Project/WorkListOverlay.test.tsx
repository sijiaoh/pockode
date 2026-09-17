import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("./CreateWorkForm", () => ({
	default: () => <div data-testid="create-work-form" />,
}));

vi.mock("../Worktree", () => ({
	WorktreeBadge: () => null,
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

describe("WorkListOverlay", () => {
	beforeEach(() => {
		useWorkStore.setState({
			works: [],
			isLoading: false,
			error: null,
		});
	});

	it("always expands tasks for non-closed stories without a toggle button", () => {
		useWorkStore.setState({
			works: [
				createWork({
					id: "story-in-progress",
					type: "story",
					title: "In Progress Story",
					status: "active",
				}),
				createWork({
					id: "task-1",
					type: "task",
					parent_id: "story-in-progress",
					title: "Task one",
					status: "closed",
				}),
				createWork({
					id: "task-2",
					type: "task",
					parent_id: "story-in-progress",
					title: "Task two",
					status: "closed",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		expect(screen.getByText("Task one")).toBeInTheDocument();
		expect(screen.getByText("Task two")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Expand tasks|Collapse tasks/i }),
		).not.toBeInTheDocument();
	});

	it("navigates to a story's chat using the story's own worktree", async () => {
		const user = userEvent.setup();
		const onNavigateToSession = vi.fn();

		useWorkStore.setState({
			works: [
				createWork({
					id: "story-other-worktree",
					type: "story",
					title: "Story In Feature Worktree",
					status: "active",
					worktree: "feature-x",
					session_id: "session-abc",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={onNavigateToSession}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Chat" }));

		expect(onNavigateToSession).toHaveBeenCalledWith(
			"session-abc",
			"feature-x",
		);
	});

	it("sorts closed stories by updated_at in descending order", async () => {
		const user = userEvent.setup();

		useWorkStore.setState({
			works: [
				createWork({
					id: "older-updated",
					type: "story",
					title: "Older Updated Story",
					status: "closed",
					updated_at: "2026-03-01T00:00:00Z",
				}),
				createWork({
					id: "newer-updated",
					type: "story",
					title: "Newer Updated Story",
					status: "closed",
					updated_at: "2026-03-05T00:00:00Z",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Closed/i }));

		const newerStory = screen.getByText("Newer Updated Story");
		const olderStory = screen.getByText("Older Updated Story");

		// Verify newer updated story appears before older updated story in DOM order
		expect(
			newerStory.compareDocumentPosition(olderStory) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// Five groups, and the one with something for the user to do comes first
	// (docs/lifecycle-ui.md §6.1).
	it("puts a story waiting on the user in its own group, above the rest", () => {
		useWorkStore.setState({
			works: [
				createWork({
					id: "running",
					title: "Running Story",
					status: "active",
					activity: "running",
				}),
				createWork({
					id: "asking",
					title: "Asking Story",
					status: "active",
					activity: "needs_answer",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		const needsYou = screen.getByRole("button", { name: /Needs you/ });
		const active = screen.getByRole("button", { name: /^Active/ });
		expect(
			needsYou.compareDocumentPosition(active) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Asking Story/ }),
		).toBeInTheDocument();
	});

	// Grouping reads `status` plus the single needsUser predicate, never the full
	// activity: a list that regrouped on every phase change would reorder itself
	// while being read.
	it("keeps an active work in one group whatever its turn is doing", () => {
		useWorkStore.setState({
			works: [
				createWork({
					id: "waiting-on-a-machine",
					title: "Background Story",
					status: "active",
					activity: "background",
				}),
				createWork({
					id: "waiting-on-tasks",
					title: "Coordinating Story",
					status: "active",
					activity: "waiting_children",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /Needs you/ }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Active/ })).toBeInTheDocument();
	});

	it("names the leaf a row is on, not the status behind it", () => {
		useWorkStore.setState({
			works: [
				createWork({
					id: "asking",
					title: "Asking Story",
					status: "active",
					activity: "needs_permission",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Asking Story — Needs permission" }),
		).toBeInTheDocument();
	});

	it("keeps tasks collapsed by default for closed stories and allows expanding", async () => {
		const user = userEvent.setup();

		useWorkStore.setState({
			works: [
				createWork({
					id: "story-closed",
					type: "story",
					title: "Closed Story",
					status: "closed",
				}),
				createWork({
					id: "task-closed-1",
					type: "task",
					parent_id: "story-closed",
					title: "Closed task",
					status: "closed",
				}),
			],
			isLoading: false,
			error: null,
		});

		render(
			<WorkListOverlay
				onBack={vi.fn()}
				onOpenWorkDetail={vi.fn()}
				onNavigateToSession={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Closed/i }));
		expect(screen.getByText("Closed Story")).toBeInTheDocument();
		expect(screen.queryByText("Closed task")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Expand tasks" }));
		expect(screen.getByText("Closed task")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Collapse tasks" }),
		).toBeInTheDocument();
	});
});
