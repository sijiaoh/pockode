import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { worktreeActions } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import WorktreeBadge from "./WorktreeBadge";

let mockWorktrees: WorktreeInfo[] = [];

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => selector({ status: "connected" })),
	wsActions: {
		listWorktrees: () => Promise.resolve(mockWorktrees),
	},
}));

function renderBadge(worktree: string | undefined) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return render(<WorktreeBadge worktree={worktree} />, { wrapper: Wrapper });
}

afterEach(() => {
	worktreeActions.reset();
	mockWorktrees = [];
});

describe("WorktreeBadge", () => {
	it("shows the stored name for a feature worktree", () => {
		renderBadge("feat-login");
		expect(screen.getByLabelText("Worktree: feat-login")).toHaveTextContent(
			"feat-login",
		);
	});

	it("shows the main branch name for the default worktree", async () => {
		mockWorktrees = [
			{ name: "", path: "/repo", branch: "main", is_main: true },
		];
		renderBadge("");
		const badge = await screen.findByLabelText(
			"Runs on default (main) worktree",
		);
		await waitFor(() => expect(badge).toHaveTextContent("main"));
	});

	it("falls back to a neutral label before the list loads", () => {
		renderBadge("");
		expect(
			screen.getByLabelText("Runs on default (main) worktree"),
		).toHaveTextContent("Default");
	});

	it("renders nothing on the default worktree in a non-git project", async () => {
		worktreeActions.setIsGitRepo(false);
		const { container } = renderBadge("");
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});
});
