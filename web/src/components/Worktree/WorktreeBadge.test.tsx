import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { worktreeActions } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import WorktreeBadge from "./WorktreeBadge";

let mockWorktrees: WorktreeInfo[] = [];

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => selector({ status: "connected" })),
	wsActions: {
		listWorktrees: () => Promise.resolve({ worktrees: mockWorktrees }),
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
	it("links a feature worktree to its root", () => {
		renderBadge("feat-login");
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
		renderBadge("");
		const link = await screen.findByRole("link", {
			name: "Open main worktree",
		});
		await waitFor(() => expect(link).toHaveTextContent("main"));
		expect(link).toHaveAttribute("href", "/");
	});

	it("falls back to a neutral label before the list loads", () => {
		renderBadge("");
		expect(
			screen.getByRole("link", { name: "Open main worktree" }),
		).toHaveTextContent("Default");
	});

	it("renders nothing on the default worktree in a non-git project", async () => {
		worktreeActions.setIsGitRepo(false);
		const { container } = renderBadge("");
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});
});
