import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import { getDiffHighlighter } from "../../lib/shikiUtils";
import type { FileChange, GitDiffData, GitShowResult } from "../../types/git";
import CommitDiffView from "./CommitDiffView";

const navigate = vi.fn();
let files: FileChange[] = [];
const NO_CHANGES: GitDiffData = { diff: "", old_content: "", new_content: "" };
const diffRef = vi.hoisted(() => ({
	current: undefined as unknown as GitDiffData,
}));
const insert = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));

vi.mock("../../hooks/useGitCommit", () => ({
	useGitCommit: () => ({
		data: {
			hash: "abc1234def",
			parents: [],
			subject: "Do a thing",
			author: "a",
			date: "d",
			files,
		} satisfies GitShowResult,
	}),
}));

vi.mock("../../hooks/useCommitDiff", () => ({
	useCommitDiff: () => ({
		data: diffRef.current,
		isLoading: false,
		error: null,
	}),
}));

vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill: vi.fn(),
		insert,
		isPending: false,
		error: null,
		dismissError: () => {},
	}),
}));

beforeEach(() => {
	navigate.mockClear();
	insert.mockReset().mockResolvedValue(undefined);
	files = [{ path: "src/app.ts", status: "M" }];
	diffRef.current = NO_CHANGES;
});

function renderView(
	path = "src/app.ts",
	actionsAt?: "top" | "bottom" | "hidden",
) {
	return render(
		<CommitDiffView hash="abc1234def" path={path} actionsAt={actionsAt} />,
	);
}

describe("CommitDiffView", () => {
	// Where `GitWorkspace` places it: the composer is under the page.
	it.each([
		["top", true],
		["bottom", false],
	] as const)("draws its bar at the %s of the page", (at, aboveDiff) => {
		renderView(undefined, at);
		const order = screen
			.getByRole("button", { name: "Next file" })
			.compareDocumentPosition(screen.getByText("No content changes"));
		expect(!!(order & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(aboveDiff);
	});

	it("draws no bar while hidden", () => {
		renderView(undefined, "hidden");
		expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
	});

	it("opens the working-tree file from the path bar", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(
			screen.getByRole("button", { name: "Open current app.ts" }),
		);

		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/files/$",
				params: { _splat: "src/app.ts" },
			}),
		);
	});

	it("goes back to the commit it came from", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(screen.getByRole("button", { name: "Back to commit" }));

		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/commit/$",
				params: { _splat: "abc1234def" },
			}),
		);
	});

	it("opens the commit's own version from the bottom bar", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(
			screen.getByRole("button", { name: "View this file at abc1234" }),
		);

		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/commit/$hash/file/$",
				params: { hash: "abc1234def", _splat: "src/app.ts" },
			}),
		);
	});

	it("opens the file's history from the bottom bar", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(
			screen.getByRole("button", { name: "History of this file" }),
		);

		// The default range, not the one the commit was picked from: this is
		// the file's history now.
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/git",
				search: { segment: "history", file: "src/app.ts" },
			}),
		);
		expect(navigate).toHaveBeenCalledWith(
			expect.not.objectContaining({ replace: true }),
		);
	});

	it("disables the version button for a file the commit deleted, and says why", () => {
		files = [{ path: "src/app.ts", status: "D" }];
		renderView();

		expect(
			screen.getByRole("button", {
				name: "View this file at abc1234 (deleted in this commit)",
			}),
		).toBeDisabled();
	});
});

describe("CommitDiffView line selection", () => {
	// The library measures its line-number column on a canvas, which jsdom
	// lacks; and only wrapped does it draw extend rows without a laid-out table.
	beforeAll(async () => {
		await getDiffHighlighter();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			() =>
				({
					font: "",
					measureText: () => ({ width: 8 }),
				}) as unknown as CanvasRenderingContext2D,
		);
	});
	beforeEach(() => {
		useDiffSettingsStore.setState({ gitDiffWrap: true, hideWhitespace: false });
		const lines = (edit: string) =>
			`${Array.from({ length: 20 }, (_, i) => (i === 9 ? edit : `line ${i + 1}`)).join("\n")}\n`;
		diffRef.current = {
			diff: [
				"--- a/src/app.ts",
				"+++ b/src/app.ts",
				"@@ -7,7 +7,7 @@",
				...[7, 8, 9].map((n) => ` line ${n}`),
				"-line 10",
				"+edit 10",
				...[11, 12, 13].map((n) => ` line ${n}`),
				"",
			].join("\n"),
			old_content: lines("line 10"),
			new_content: lines("edit 10"),
		};
	});

	const gutter = (line: number) =>
		waitFor(() => {
			const cell = document
				.querySelector(`td.diff-line-num [data-line-new-num="${line}"]`)
				?.closest("td");
			if (!cell) throw new Error(`no gutter cell for line ${line}`);
			return cell;
		});

	// The same bar as the review's; what differs is that the draft says the
	// lines are the commit's, so the agent does not take them for the file on
	// disk.
	it("selects by the gutter and hands the lines to the agent as the commit's", async () => {
		const user = userEvent.setup();
		renderView();

		await user.click(await gutter(10));
		await user.keyboard("{Shift>}");
		await user.click(await gutter(12));
		await user.keyboard("{/Shift}");
		expect(
			screen.getByRole("group", { name: "Selected lines" }),
		).toHaveTextContent("Lines 10–12");

		await user.click(screen.getByRole("button", { name: "Ask AI to edit…" }));
		expect(insert).toHaveBeenCalledWith(
			[
				"`src/app.ts`, lines 10–12 (as of commit abc1234def, not the working tree):",
				"",
				"```diff",
				"+edit 10",
				" line 11",
				" line 12",
				"```",
			].join("\n"),
		);
	});

	// Without a pointer the way in is a hunk's Select, as in the review, and
	// the way out puts focus back there rather than on the page's body.
	it("selects a hunk from its bar and gives focus back to it when the bar goes", async () => {
		const user = userEvent.setup();
		renderView();
		const select = await screen.findByRole("button", {
			name: "Select lines 7–13",
		});
		// Nothing to stage in a commit.
		expect(
			screen.queryByRole("button", { name: "Stage lines 7–13" }),
		).toBeNull();

		await user.click(select);
		expect(
			screen.getByRole("group", { name: "Selected lines" }),
		).toHaveTextContent("Lines 7–13");
		expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("group", { name: "Selected lines" })).toBeNull();
		await waitFor(() => expect(select).toHaveFocus());
	});
});
