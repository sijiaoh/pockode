import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { gitChangesViewActions } from "../../lib/gitChangesViewStore";
import type { GitStatus } from "../../types/git";
import ChangesSection from "./ChangesSection";

// What jsdom cannot say: that a file row is laid out by the width of the list
// it is in, not the window's — the path under the name below
// `--container-git-row`, beside it from there on, with the counts still lined
// up against `⋯`.

let status: GitStatus;
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => vi.fn(),
}));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status, isLoading: false, error: null }),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: vi.fn() },
		resolveMutation: { mutateAsync: vi.fn() },
		unstageMutation: { mutateAsync: vi.fn() },
		stageHunkMutation: { mutateAsync: vi.fn() },
		unstageHunkMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: vi.fn() }),
}));
// Reads queries this test does not stand up, and is not a row.
vi.mock("./CommitBar", () => ({ default: () => null }));

const LONG_NAME =
	"a-file-name-long-enough-to-be-cut-in-any-column-there-is.tsx";
const DEEP = "src/components/Git/deeply/nested/folder";

beforeEach(async () => {
	status = {
		staged: [],
		unstaged: [
			{
				path: `${DEEP}/${LONG_NAME}`,
				status: "M",
				lines: { additions: 1200, deletions: 3 },
			},
			{ path: "lib/x.ts", status: "M", lines: { additions: 1, deletions: 0 } },
		],
	};
	gitChangesViewActions.setView("flat");
	// Wider than either list, so the window would call every width here wide.
	await page.viewport(1280, 800);
});

afterEach(async () => {
	await page.viewport(414, 896);
});

function renderAt(width: number) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<div className="flex flex-col" style={{ width, height: 600 }}>
				<ChangesSection
					onSelectFile={() => {}}
					onCloseFile={() => {}}
					onViewHistory={() => {}}
					activeFile={null}
				/>
			</div>
		</QueryClientProvider>,
	);
}

/** A row's name, directory and counts, measured. */
function row(fileName: string, dir: string) {
	const rect = (el: Element) => el.getBoundingClientRect();
	const nameEl = screen.getByTitle(fileName);
	const button = nameEl.closest("button") as HTMLElement;
	const text = nameEl.parentElement as HTMLElement;
	const counts = text.nextElementSibling as HTMLElement;
	return {
		name: rect(nameEl),
		dir: rect(button.querySelector(`[title="${dir}"]`) as Element),
		text: rect(text),
		counts: rect(counts),
	};
}

describe("file row width", () => {
	it("puts the path under the name in a list narrower than the threshold", () => {
		renderAt(599);
		const long = row(LONG_NAME, DEEP);
		expect(long.dir.top).toBeGreaterThanOrEqual(long.name.bottom - 1);
	});

	it("puts the path beside the name from the threshold on, with the counts lined up", () => {
		renderAt(600);
		const long = row(LONG_NAME, DEEP);
		const short = row("x.ts", "lib");

		for (const r of [long, short]) {
			expect(r.dir.top).toBeLessThan(r.name.bottom);
			expect(r.dir.bottom).toBeGreaterThan(r.name.top);
			// The path follows the name; it is not a column.
			expect(r.dir.left - r.name.right).toBeCloseTo(12, 0);
		}
		// A name that would fill the cell stops at 60% of it, leaving the path
		// room; a short one keeps its natural width.
		expect(long.name.width).toBeLessThanOrEqual(long.text.width * 0.6 + 0.5);
		expect(long.name.width).toBeGreaterThan(long.text.width * 0.6 - 1);
		expect(short.name.width).toBeLessThan(short.text.width * 0.3);
		expect(short.counts.right).toBe(long.counts.right);
	});

	it("switches every row of a tree together, however deep", () => {
		gitChangesViewActions.setView("tree");
		renderAt(600);
		// One container for the list: a deep row's cell is narrower by its
		// indent, and still switches with the shallow one.
		for (const r of [row(LONG_NAME, DEEP), row("x.ts", "lib")]) {
			expect(r.dir.top).toBeLessThan(r.name.bottom);
		}
	});
});
