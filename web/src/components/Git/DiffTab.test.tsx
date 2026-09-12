import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitPanelActions } from "../../lib/gitPanelStore";
import type { GitCommit, GitStatus } from "../../types/git";
import DiffTab from "./DiffTab";

const discard = vi.fn();
let status: GitStatus | undefined;
let commits: GitCommit[] = [];

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status, isLoading: false, error: null }),
}));
vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({ data: { commits } }),
}));
vi.mock("../../hooks/useGitWatch", () => ({ useGitWatch: () => undefined }));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: vi.fn() },
		unstageMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: discard }),
}));
vi.mock("../Layout", () => ({ useSidebarRefresh: () => ({ isActive: true }) }));
// Both read queries this test does not stand up; neither takes part in discard.
vi.mock("./BranchBar", () => ({ default: () => null }));
vi.mock("./CommitBar", () => ({ default: () => null }));
vi.mock("./GitCommitSheet", () => ({
	default: ({ amendInitially }: { amendInitially: boolean }) => (
		<div role="dialog">{amendInitially ? "amending" : "committing"}</div>
	),
}));

const STATUS: GitStatus = {
	staged: [{ path: "staged.ts", status: "M" }],
	unstaged: [
		{ path: "src/foo.ts", status: "M" },
		{ path: "notes.txt", status: "?" },
	],
};

function renderTab(
	props: {
		activeFile?: { path: string; staged: boolean } | null;
		onCloseFile?: () => void;
	} = {},
) {
	const onCloseFile = props.onCloseFile ?? vi.fn();
	const { unmount } = render(
		<QueryClientProvider client={new QueryClient()}>
			<DiffTab
				onSelectFile={vi.fn()}
				onSelectCommit={vi.fn()}
				onCloseFile={onCloseFile}
				activeFile={props.activeFile ?? null}
				activeCommitHash={null}
			/>
		</QueryClientProvider>,
	);
	return { onCloseFile, unmount };
}

const confirmButton = (name: string) =>
	screen.getByRole("button", { name, hidden: false });

describe("DiffTab discard", () => {
	beforeEach(() => {
		status = STATUS;
		commits = [];
		gitPanelActions.reset();
		discard.mockReset();
		discard.mockResolvedValue(undefined);
	});

	// Staged rows have no discard button: unstaging first is what the button
	// beside them already does.
	it("offers discard on unstaged rows only", () => {
		renderTab();

		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Delete file" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Discard all changes" }),
		).toBeInTheDocument();
		// One per group, and only the Changes group has a discard-all beside it.
		expect(
			screen.getByRole("button", { name: "Unstage all files" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Stage all files" }),
		).toBeInTheDocument();
	});

	it("discards a tracked file only after the warning is confirmed", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));

		expect(
			screen.getByRole("heading", { name: "Discard changes?" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Your edits to src/foo.ts will be lost. This cannot be undone.",
			),
		).toBeInTheDocument();
		expect(discard).not.toHaveBeenCalled();

		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["src/foo.ts"]);
	});

	// Deleting a file the user never asked git to track is a different outcome
	// from throwing away edits, so it gets its own words.
	it("warns that an untracked file is deleted rather than restored", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("button", { name: "Delete file" }));

		expect(
			screen.getByRole("heading", { name: "Delete file?" }),
		).toBeInTheDocument();
		await user.click(confirmButton("Delete"));

		expect(discard).toHaveBeenCalledWith(["notes.txt"]);
	});

	it("cancelling discards nothing", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Cancel"));

		expect(discard).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("sends every unstaged path from the group header", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(
			screen.getByRole("button", { name: "Discard all changes" }),
		);

		expect(
			screen.getByText(
				"1 file will lose its edits and 1 untracked file will be deleted. This cannot be undone.",
			),
		).toBeInTheDocument();
		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["src/foo.ts", "notes.txt"]);
	});

	const GIT_ERROR =
		"error: unable to unlink old 'src/foo.ts': Permission denied";

	async function failADiscard(user: ReturnType<typeof userEvent.setup>) {
		discard.mockRejectedValue(new Error(GIT_ERROR));
		renderTab();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		return screen.findByRole("alert");
	}

	// Discard starts inline, with no sheet to hold the outcome, so the failure
	// lands in the panel's own banner — and git's text is kept, not paraphrased.
	it("keeps git's own message behind the banner's summary", async () => {
		const user = userEvent.setup();
		const banner = await failADiscard(user);

		expect(banner).toHaveTextContent("Discard failed.");
		expect(screen.queryByText(GIT_ERROR)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Details" }));

		expect(screen.getByText(GIT_ERROR)).toBeInTheDocument();
	});

	it("dismisses the banner", async () => {
		const user = userEvent.setup();
		await failADiscard(user);

		await user.click(screen.getByRole("button", { name: "Dismiss error" }));

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	// The banner holds the most recent failure, and only a retry of that failure
	// clears it: a different file succeeding says nothing about the one that did
	// not, and dropping the message would leave it unexplained.
	it("keeps the banner when a different file discards successfully", async () => {
		const user = userEvent.setup();
		await failADiscard(user);

		discard.mockResolvedValue(undefined);
		await user.click(screen.getByRole("button", { name: "Delete file" }));
		await user.click(confirmButton("Delete"));

		await waitFor(() => expect(discard).toHaveBeenCalledWith(["notes.txt"]));
		expect(screen.getByRole("alert")).toHaveTextContent("Discard failed.");
	});

	// The content area would otherwise sit on a diff that no longer exists.
	it("closes the open file when its own changes are discarded", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderTab({
			activeFile: { path: "src/foo.ts", staged: false },
		});

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		await waitFor(() => expect(onCloseFile).toHaveBeenCalled());
	});

	// Discarding the unstaged edits leaves the staged diff intact, so the file
	// the content area shows still has something to show.
	it("leaves an open staged diff alone", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderTab({
			activeFile: { path: "src/foo.ts", staged: true },
		});

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		await waitFor(() => expect(discard).toHaveBeenCalled());
		expect(onCloseFile).not.toHaveBeenCalled();
	});
});

const COMMITS: GitCommit[] = [
	{
		hash: "9692fc9aaaaaaaa",
		subject: "Add branch bar to git panel",
		author: "sijiaoh",
		date: new Date().toISOString(),
	},
	{
		hash: "1c4b8e0bbbbbbbb",
		subject: "Render every codex_changes event",
		author: "sijiaoh",
		date: new Date().toISOString(),
	},
];

const historyToggle = () => screen.getByRole("button", { name: /History/i });

describe("DiffTab history", () => {
	beforeEach(() => {
		commits = COMMITS;
		gitPanelActions.reset();
	});

	// The diff is the subject whenever there is one; history is what is left to
	// look at when there is not.
	it("collapses while there are changes and expands on a clean tree", () => {
		status = STATUS;
		const { unmount } = renderTab();
		expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
		unmount();

		status = { staged: [], unstaged: [] };
		renderTab();
		expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
	});

	// A section that keeps re-deciding for the user is worse than one that is
	// occasionally in the wrong state.
	it("keeps the user's choice once they have made one", async () => {
		const user = userEvent.setup();
		status = STATUS;
		const { unmount } = renderTab();

		await user.click(historyToggle());
		expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
		unmount();

		status = { staged: [], unstaged: [] };
		renderTab();
		expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
	});
});

describe("DiffTab amend", () => {
	beforeEach(() => {
		status = { staged: [], unstaged: [] };
		commits = COMMITS;
		gitPanelActions.reset();
	});

	// Amend belongs to the commit it replaces, and that commit is HEAD — the
	// first row of the log, and only that row.
	it("offers amend on the HEAD row only", () => {
		renderTab();

		expect(
			screen.getAllByRole("button", { name: "Amend this commit" }),
		).toHaveLength(1);
	});

	it("opens the commit sheet with amend pre-toggled", async () => {
		const user = userEvent.setup();
		renderTab();

		await user.click(screen.getByRole("button", { name: "Amend this commit" }));

		expect(screen.getByRole("dialog")).toHaveTextContent("amending");
	});

	it("has nothing to amend in a repository without commits", () => {
		commits = [];
		renderTab();

		expect(
			screen.queryByRole("button", { name: "Amend this commit" }),
		).not.toBeInTheDocument();
	});
});
