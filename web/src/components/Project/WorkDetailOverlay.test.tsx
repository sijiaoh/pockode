import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("./CreateWorkForm", () => ({
	default: () => <div data-testid="create-work-form" />,
}));

vi.mock("./WorkListOverlay", () => ({
	StartButton: () => <button type="button">Start</button>,
}));

const createWork = (overrides: Partial<Work> = {}): Work => ({
	id: "work-1",
	type: "story",
	title: "Story",
	body: "Work description",
	status: "in_progress",
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

	it("renders sections in the expected order", () => {
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork(),
			comments: [],
			loading: false,
			error: null,
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

	it("keeps steps below the empty description placeholder", () => {
		mockUseWorkDetailSubscription.mockReturnValue({
			work: createWork({ body: undefined }),
			comments: [],
			loading: false,
			error: null,
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
			comments: [],
			loading: false,
			error: null,
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
