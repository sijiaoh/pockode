import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkStore } from "../../lib/workStore";
import { worktreeActions } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import type { Work, WorkStatus } from "../../types/work";
import WorktreeBadge from "./WorktreeBadge";

let mockWorktrees: WorktreeInfo[] = [];

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => selector({ status: "connected" })),
	wsActions: {
		listWorktrees: () => Promise.resolve(mockWorktrees),
	},
}));

// TanStack's `<Link>` needs a router context; render a plain anchor that
// surfaces its navigation target so tests can assert where the badge points.
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: AnchorHTMLAttributes<HTMLAnchorElement> & {
		to: string;
		params?: Record<string, string>;
	}) => (
		<a href={to} data-params={JSON.stringify(params ?? null)} {...rest}>
			{children}
		</a>
	),
}));

function makeWork(overrides: Partial<Work> & { status: WorkStatus }): Work {
	return {
		id: "work-1",
		type: "story",
		title: "Work",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

/** Renders the badge for `work`; `others` populates the store's work list. */
function renderBadge(work: Work, others: Work[] = []) {
	useWorkStore.setState({ works: [work, ...others] });
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return render(<WorktreeBadge work={work} />, { wrapper: Wrapper });
}

function renderStartedBadge(worktree: string | undefined) {
	return renderBadge(makeWork({ status: "in_progress", worktree }));
}

afterEach(() => {
	worktreeActions.reset();
	useWorkStore.getState().reset();
	mockWorktrees = [];
});

describe("WorktreeBadge", () => {
	it("links a feature worktree to its root", () => {
		renderStartedBadge("feat-login");
		const link = screen.getByRole("link", { name: "Open worktree feat-login" });
		expect(link).toHaveTextContent("feat-login");
		expect(link).toHaveAttribute("href", "/w/$worktree/");
		expect(link).toHaveAttribute(
			"data-params",
			JSON.stringify({ worktree: "feat-login" }),
		);
	});

	it("links the default worktree to the index route", async () => {
		mockWorktrees = [
			{ name: "", path: "/repo", branch: "main", is_main: true },
		];
		renderStartedBadge("");
		const link = await screen.findByRole("link", {
			name: "Open main worktree",
		});
		await waitFor(() => expect(link).toHaveTextContent("main"));
		expect(link).toHaveAttribute("href", "/");
	});

	it("falls back to a neutral label before the list loads", () => {
		renderStartedBadge("");
		expect(
			screen.getByRole("link", { name: "Open main worktree" }),
		).toHaveTextContent("Default");
	});

	it("renders nothing for an unstarted top-level work", () => {
		const { container } = renderBadge(
			makeWork({ status: "open", worktree: "feat-login" }),
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the worktree of an open task under a started story", () => {
		const story = makeWork({
			id: "story-1",
			status: "in_progress",
			worktree: "feat-login",
		});
		renderBadge(
			makeWork({
				id: "task-1",
				type: "task",
				parent_id: story.id,
				status: "open",
				worktree: "feat-login",
			}),
			[story],
		);
		expect(
			screen.getByRole("link", { name: "Open worktree feat-login" }),
		).toBeInTheDocument();
	});

	it("shows the worktree of a started task under an unstarted story", () => {
		const story = makeWork({ id: "story-1", status: "open" });
		renderBadge(
			makeWork({
				id: "task-1",
				type: "task",
				parent_id: story.id,
				status: "in_progress",
				worktree: "feat-login",
			}),
			[story],
		);
		expect(
			screen.getByRole("link", { name: "Open worktree feat-login" }),
		).toBeInTheDocument();
	});

	it("renders nothing for an open task under an unstarted story", () => {
		const story = makeWork({
			id: "story-1",
			status: "open",
			worktree: "feat-login",
		});
		const { container } = renderBadge(
			makeWork({
				id: "task-1",
				type: "task",
				parent_id: story.id,
				status: "open",
				worktree: "feat-login",
			}),
			[story],
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("falls back to the work's own status when its parent is unknown", () => {
		const { container } = renderBadge(
			makeWork({
				id: "task-1",
				type: "task",
				parent_id: "missing-story",
				status: "open",
				worktree: "feat-login",
			}),
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing on the default worktree in a non-git project", async () => {
		worktreeActions.setIsGitRepo(false);
		const { container } = renderStartedBadge("");
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});
});
