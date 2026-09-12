import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, GitShowResult } from "../../types/git";
import CommitDiffView from "./CommitDiffView";

const navigate = vi.fn();
let files: FileChange[] = [];

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
			subject: "Do a thing",
			author: "a",
			date: "d",
			files,
		} satisfies GitShowResult,
	}),
}));

vi.mock("../../hooks/useCommitDiff", () => ({
	useCommitDiff: () => ({
		data: { path: "src/app.ts", diff: "", old_content: "", new_content: "" },
		isLoading: false,
		error: null,
	}),
}));

vi.mock("./DiffContent", () => ({ default: () => <div /> }));

beforeEach(() => {
	navigate.mockClear();
	files = [{ path: "src/app.ts", status: "M" }];
});

function renderView(path = "src/app.ts") {
	return render(<CommitDiffView hash="abc1234def" path={path} />);
}

describe("CommitDiffView", () => {
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
