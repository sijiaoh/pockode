import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../lib/activity";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import type { AgentRole } from "../../types/agentRole";
import type { Work } from "../../types/work";
import WorkDetailOverlay from "./WorkDetailOverlay";

const mockUseWorkDetailSubscription = vi.fn();

vi.mock("../../hooks/useWorkDetailSubscription", () => ({
	useWorkDetailSubscription: (workId: string) =>
		mockUseWorkDetailSubscription(workId),
}));

vi.mock("../Chat/MarkdownContent", () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

// The sheet has its own tests; here it stands for "the create flow answered
// with an id", which is the wiring this screen owns.
vi.mock("./CreateWorkSheet", () => ({
	default: ({ onCreated }: { onCreated: (workId: string) => void }) => (
		<button type="button" onClick={() => onCreated("new-task")}>
			Pretend to create
		</button>
	),
}));

vi.mock("../Worktree", () => ({
	WorktreeBadge: () => null,
	useWorktreeBadgeVisible: () => false,
}));

const createWork = (overrides: Partial<Work> = {}): Work => ({
	id: "work-1",
	type: "story",
	title: "Story",
	body: "Work description",
	status: "active",
	agent_role_id: "role-1",
	current_step: 0,
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

const createRole = (overrides: Partial<AgentRole> = {}): AgentRole => ({
	id: "role-1",
	name: "Engineer",
	role_prompt: "Build the feature.",
	steps: ["Implement", "Verify"],
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

function expectToAppearBefore(first: Node, second: Node) {
	expect(
		first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
}

const renderWithWork = (work: Work, activity: Activity = "idle") => {
	mockUseWorkDetailSubscription.mockReturnValue({
		work,
		activity,
		comments: [],
		children: [],
		parent: null,
		loading: false,
		error: null,
	});
	return render(
		<WorkDetailOverlay
			workId="work-1"
			onBack={vi.fn()}
			onNavigateToSession={vi.fn()}
			onOpenWorkDetail={vi.fn()}
		/>,
	);
};

describe("WorkDetailOverlay", () => {
	beforeEach(() => {
		mockUseWorkDetailSubscription.mockReset();
		useWorkStore.setState({
			works: [],
			isLoading: false,
			error: null,
		});
		useAgentRoleStore.setState({
			roles: [createRole()],
			isLoading: false,
			error: null,
		});
	});

	// The counter is shared with the chat top bar (utils/workSteps), so it has to
	// stay pinned on this side too.
	describe("step counter", () => {
		it("counts the step an active work sits on", () => {
			renderWithWork(createWork({ status: "active", current_step: 1 }));

			expect(
				screen.getByRole("heading", { name: "Steps (2/2)" }),
			).toBeInTheDocument();
		});

		it("counts every step once the work is closed", () => {
			renderWithWork(createWork({ status: "closed", current_step: 0 }));

			expect(
				screen.getByRole("heading", { name: "Steps (2/2)" }),
			).toBeInTheDocument();
		});

		// An open work sits on no step yet; the list still shows, the counter does not.
		it("omits the counter before the work starts", () => {
			renderWithWork(createWork({ status: "open", current_step: 0 }));

			expect(
				screen.getByRole("heading", { name: "Steps" }),
			).toBeInTheDocument();
			expect(screen.getByText("Implement")).toBeInTheDocument();
		});
	});

	it("renders sections in the expected order", () => {
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			activity: "idle",
			comments: [],
			loading: false,
			error: null,
			children: [],
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={vi.fn()}
			/>,
		);

		const roleHeading = screen.getByRole("heading", { name: "Role" });
		const descriptionHeading = screen.getByRole("heading", {
			name: "Description",
		});
		const stepsHeading = screen.getByRole("heading", { name: /Steps/ });
		const tasksHeading = screen.getByRole("heading", { name: "Tasks" });
		const commentsHeading = screen.getByRole("heading", { name: "Comments" });

		expectToAppearBefore(roleHeading, descriptionHeading);
		expectToAppearBefore(descriptionHeading, stepsHeading);
		expectToAppearBefore(stepsHeading, tasksHeading);
		expectToAppearBefore(tasksHeading, commentsHeading);
	});

	// A story's children come with its detail, not out of the work list: that
	// list is the `Current` segment and holds no closed work, so a closed story
	// read from the archive would otherwise look childless
	// (docs/list-paging-ui.md §2.2).
	it("lists a story's children from its own detail", async () => {
		const user = userEvent.setup();
		const onOpenWorkDetail = vi.fn();
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			activity: "idle",
			comments: [],
			children: [
				{
					id: "task-1",
					type: "task",
					parent_id: "work-1",
					agent_role_id: "role-1",
					title: "Wire it up",
					status: "open",
					activity: "open",
					updated_at: "2026-03-04T00:00:00Z",
				},
			],
			parent: null,
			loading: false,
			error: null,
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={onOpenWorkDetail}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Tasks (0/1)" }),
		).toBeInTheDocument();

		// The shared row names its work and its state in one breath.
		await user.click(screen.getByRole("button", { name: "Wire it up — Open" }));
		expect(onOpenWorkDetail).toHaveBeenCalledWith("task-1");
	});

	// §4: a task lands on its own page too, where its brief gets written.
	it("lands on the new task's detail page after adding one", async () => {
		const user = userEvent.setup();
		const onOpenWorkDetail = vi.fn();
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			activity: "idle",
			comments: [],
			loading: false,
			error: null,
			children: [],
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={onOpenWorkDetail}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Add Task" }));
		await user.click(screen.getByRole("button", { name: "Pretend to create" }));

		expect(onOpenWorkDetail).toHaveBeenCalledWith("new-task");
		expect(
			screen.queryByRole("button", { name: "Pretend to create" }),
		).toBeNull();
	});

	// §8 check 6. Back has one job — undo the step that got here — and the step
	// differs by what opened the page: a story is reached from the list, a task
	// from its story's Tasks section. It was already right before the rewrite and
	// nothing asserted it, which is the shape of thing a rewrite drops.
	describe("going back", () => {
		it("leaves a story for the project list", async () => {
			const user = userEvent.setup();
			const onBack = vi.fn();
			const onOpenWorkDetail = vi.fn();
			mockUseWorkDetailSubscription.mockReturnValue({
				work: createWork(),
				activity: "idle",
				comments: [],
				loading: false,
				error: null,
				children: [],
			});

			render(
				<WorkDetailOverlay
					workId="work-1"
					onBack={onBack}
					onNavigateToSession={vi.fn()}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);

			await user.click(screen.getByRole("button", { name: "Back to project" }));
			expect(onBack).toHaveBeenCalled();
			expect(onOpenWorkDetail).not.toHaveBeenCalled();
		});

		it("leaves a task for the story it belongs to", async () => {
			const user = userEvent.setup();
			const onBack = vi.fn();
			const onOpenWorkDetail = vi.fn();
			mockUseWorkDetailSubscription.mockReturnValue({
				parent: {
					id: "story-1",
					type: "story",
					agent_role_id: "role-1",
					title: "Cluster mode",
					status: "active",
					activity: "running",
					updated_at: "2026-03-04T00:00:00Z",
				},
				work: createWork({ type: "task", parent_id: "story-1" }),
				activity: "idle",
				comments: [],
				loading: false,
				error: null,
				children: [],
			});

			render(
				<WorkDetailOverlay
					workId="work-1"
					onBack={onBack}
					onNavigateToSession={vi.fn()}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "Back to parent story" }),
			);
			expect(onOpenWorkDetail).toHaveBeenCalledWith("story-1");
			expect(onBack).not.toHaveBeenCalled();
		});
	});

	// Usage rides on the detail subscription rather than on Work, so this is also
	// the assertion that the page reads it from there.
	it("puts the usage the subscription carries between steps and tasks", () => {
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			activity: "idle",
			comments: [],
			usage: {
				own: {
					input_tokens: 124_000,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
				},
				total: {
					input_tokens: 1_200_000,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
				},
				descendant_count: 5,
			},
			loading: false,
			error: null,
			children: [],
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={vi.fn()}
			/>,
		);

		const stepsHeading = screen.getByRole("heading", { name: /Steps/ });
		const usageHeading = screen.getByRole("heading", { name: "Usage" });
		const tasksHeading = screen.getByRole("heading", { name: "Tasks" });

		expect(screen.getByText("1.2M")).toBeInTheDocument();
		expectToAppearBefore(stepsHeading, usageHeading);
		expectToAppearBefore(usageHeading, tasksHeading);
	});

	it("keeps steps below the empty description placeholder", () => {
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork({ body: undefined }),
			activity: "idle",
			comments: [],
			loading: false,
			error: null,
			children: [],
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={vi.fn()}
			/>,
		);

		const placeholder = screen.getByRole("button", {
			name: "Add description...",
		});
		const stepsHeading = screen.getByRole("heading", { name: /Steps/ });

		expectToAppearBefore(placeholder, stepsHeading);
	});

	it("keeps steps below the description editor", async () => {
		const user = userEvent.setup();
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			activity: "idle",
			comments: [],
			loading: false,
			error: null,
			children: [],
		});

		render(
			<WorkDetailOverlay
				workId="work-1"
				onBack={vi.fn()}
				onNavigateToSession={vi.fn()}
				onOpenWorkDetail={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Edit description" }));

		const descriptionEditor = screen.getByPlaceholderText("Add description...");
		const stepsHeading = screen.getByRole("heading", { name: /Steps/ });

		expectToAppearBefore(descriptionEditor, stepsHeading);
	});
});

// The agent's own words for what it is waiting for. This page is the only place
// they are shown, and before the work layer carried them the user could not read
// what the agent wanted at all.
describe("the wait line", () => {
	beforeEach(() => {
		mockUseWorkDetailSubscription.mockReset();
		useWorkStore.setState({ works: [], isLoading: false, error: null });
		useAgentRoleStore.setState({
			roles: [createRole()],
			isLoading: false,
			error: null,
		});
	});

	it("shows the agent's reason verbatim", () => {
		renderWithWork(
			createWork({
				status: "active",
				wait: "user",
				wait_reason: "Which database should I use, Postgres or SQLite?",
			}),
		);

		expect(
			screen.getByText("Which database should I use, Postgres or SQLite?"),
		).toBeInTheDocument();
	});

	it("says what a wait on subtasks is, which has no reason to show", () => {
		renderWithWork(createWork({ status: "active", wait: "child" }));

		expect(
			screen.getByText(/Waiting for its subtasks to finish/),
		).toBeInTheDocument();
	});

	it("says nothing about a work that is not waiting", () => {
		const { container } = renderWithWork(createWork({ status: "active" }));

		expect(container.textContent).not.toMatch(/Waiting/);
	});

	// A wait means nothing once the engine has let go of the work, and the store
	// clears it — but a row that drew one anyway would promise a resumption
	// nothing is going to deliver.
	it("says nothing about a stopped work", () => {
		const { container } = renderWithWork(
			createWork({ status: "stopped", wait: "user", wait_reason: "answer me" }),
		);

		expect(container.textContent).not.toMatch(/answer me/);
	});
});
