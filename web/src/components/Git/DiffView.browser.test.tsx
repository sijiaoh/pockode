import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../../types/git";
import DiffView from "./DiffView";

// What jsdom cannot say: that the review's actions fit its toolbar at a width
// under the narrowest main area `expanded` gives a detail (`DETAIL_MIN_WIDTH`),
// the folder giving way rather than a button.

const statusRef = vi.hoisted(() => ({
	current: undefined as GitStatus | undefined,
}));

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => true,
}));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => () => {},
	useRouter: () => ({
		history: {
			location: { state: {} },
			back: () => {},
			subscribe: () => () => {},
		},
		buildLocation: () => ({ pathname: "" }),
		latestLocation: { pathname: "" },
	}),
}));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));
vi.mock("../../hooks/useGitDiffWatch", () => ({
	useGitDiffWatch: () => ({
		data: undefined,
		snapshot: 1,
		isLoading: false,
		refresh: () => {},
		currentSnapshot: () => 1,
	}),
}));
vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill: () => {},
		insert: () => {},
		isPending: false,
		error: null,
		dismissError: () => {},
	}),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: statusRef.current, isPending: false }),
}));
vi.mock("../../hooks/useFSWatch", () => ({ useFSWatch: () => {} }));

// Under the narrowest main area at `expanded`: about 524px, at 1024 beside the
// sidebar at its 500px maximum (docs/git-ui.md#where-a-details-actions-go).
const DETAIL_MIN_WIDTH = 480;
const PATH = "packages/some/deeply/nested/folder/structure/a-long-file-name.ts";

function renderAt(path: string, status: GitStatus) {
	statusRef.current = status;
	render(
		<QueryClientProvider client={new QueryClient()}>
			<div className="flex flex-col" style={{ width: DETAIL_MIN_WIDTH }}>
				<DiffView path={path} staged={false} actionsAt="top" />
			</div>
		</QueryClientProvider>,
	);
	return screen.getByRole("button", { name: "Next file" })
		.parentElement as HTMLElement;
}

function expectWithin(toolbar: HTMLElement, button: HTMLElement) {
	const row = toolbar.getBoundingClientRect();
	const box = button.getBoundingClientRect();
	expect(box.left).toBeGreaterThanOrEqual(row.left);
	expect(box.right).toBeLessThanOrEqual(row.right);
}

describe("DiffView actions in the toolbar", () => {
	it.each([
		["Discard file", "Stage & next", { path: PATH, status: "M" }],
		["Delete file", "Stage & next", { path: PATH, status: "?" }],
	] as const)("fits %s and %s at the narrowest detail", (secondary, primary, file) => {
		const toolbar = renderAt(PATH, {
			staged: [],
			unstaged: [file, { path: "z.ts", status: "M" }],
		});

		expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
		for (const name of [secondary, primary, "Previous file", /wrap lines/i]) {
			expectWithin(toolbar, screen.getByRole("button", { name }));
		}
	});
});
