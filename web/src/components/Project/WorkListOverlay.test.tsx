import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkStore } from "../../lib/workStore";
import type { Work } from "../../types/work";
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

const createWork = (overrides: Partial<Work>): Work => ({
	id: "work-1",
	type: "story",
	title: "Story",
	status: "open",
	created_at: "2026-03-04T00:00:00Z",
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
					status: "in_progress",
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

	it("sorts closed stories by updated_at in descending order", async () => {
		const user = userEvent.setup();

		useWorkStore.setState({
			works: [
				createWork({
					id: "older-updated",
					type: "story",
					title: "Older Updated Story",
					status: "closed",
					created_at: "2026-03-05T00:00:00Z",
					updated_at: "2026-03-01T00:00:00Z",
				}),
				createWork({
					id: "newer-updated",
					type: "story",
					title: "Newer Updated Story",
					status: "closed",
					created_at: "2026-03-01T00:00:00Z",
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
