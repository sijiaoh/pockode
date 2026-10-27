import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitWriteActions } from "../../lib/gitWriteStore";
import { useWorktreeStore, worktreeActions } from "../../lib/worktreeStore";
import type { GitStatus } from "../../types/git";
import ChangesSection from "./ChangesSection";

const discard = vi.fn();
const stage = vi.fn();
const unstage = vi.fn();
let status: GitStatus | undefined;

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status, isLoading: false, error: null }),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: stage },
		unstageMutation: { mutateAsync: unstage },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: discard }),
}));
// Reads queries this test does not stand up, and takes no part in discard.
vi.mock("./CommitBar", () => ({ default: () => null }));

const STATUS: GitStatus = {
	staged: [{ path: "staged.ts", status: "M" }],
	unstaged: [
		{ path: "src/foo.ts", status: "M" },
		{ path: "notes.txt", status: "?" },
	],
};

function renderSection(
	props: {
		activeFile?: { path: string; staged: boolean } | null;
		onCloseFile?: (path: string, worktree: string) => void;
	} = {},
) {
	const onCloseFile = props.onCloseFile ?? vi.fn();
	const { unmount } = render(
		<QueryClientProvider client={new QueryClient()}>
			<ChangesSection
				onSelectFile={vi.fn()}
				onCloseFile={onCloseFile}
				activeFile={props.activeFile ?? null}
			/>
		</QueryClientProvider>,
	);
	return { onCloseFile, unmount };
}

const confirmButton = (name: string) =>
	screen.getByRole("button", { name, hidden: false });

function resetWrites() {
	gitWriteActions.reset();
	worktreeActions.reset();
	for (const rpc of [discard, stage, unstage]) {
		rpc.mockReset();
		rpc.mockResolvedValue(undefined);
	}
}

describe("ChangesSection discard", () => {
	beforeEach(() => {
		status = STATUS;
		resetWrites();
	});

	// Staged rows have no discard button: unstaging first is what the button
	// beside them already does.
	it("offers discard on unstaged rows only", () => {
		renderSection();

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
		renderSection();

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
		renderSection();

		await user.click(screen.getByRole("button", { name: "Delete file" }));

		expect(
			screen.getByRole("heading", { name: "Delete file?" }),
		).toBeInTheDocument();
		await user.click(confirmButton("Delete"));

		expect(discard).toHaveBeenCalledWith(["notes.txt"]);
	});

	it("cancelling discards nothing", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Cancel"));

		expect(discard).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("sends every unstaged path from the group header", async () => {
		const user = userEvent.setup();
		renderSection();

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
		renderSection();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		return screen.findByRole("alert");
	}

	// Discard starts inline, with no sheet to hold the outcome, so the failure
	// lands in the segment's own banner — and git's text is kept, not paraphrased.
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

	// The workspace would otherwise sit on a diff that no longer exists.
	it("closes the open file when its own changes are discarded", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "src/foo.ts", staged: false },
		});

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith("src/foo.ts", ""),
		);
	});

	// What was open when the discard was confirmed is not what is open when it
	// answers; whether the diff is still the page is the shell's to decide.
	it("reports a discarded file even when another one was open", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "src/other.ts", staged: false },
		});

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith("src/foo.ts", ""),
		);
	});
});

const stageButtons = () =>
	screen.getAllByRole("button", { name: "Stage file" });

describe("ChangesSection staging", () => {
	beforeEach(() => {
		status = STATUS;
		resetWrites();
	});

	// Tapping two rows in a row used to put two git.add requests in flight at
	// once, racing each other for this worktree's index.lock.
	it("does not send a second stage while the first is in flight", async () => {
		const user = userEvent.setup();
		let finishFirst!: () => void;
		stage.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishFirst = resolve;
			}),
		);
		renderSection();

		const [first, second] = stageButtons();
		await user.click(first);
		await user.click(second);

		expect(stage).toHaveBeenCalledTimes(1);

		finishFirst();

		await waitFor(() => expect(stage).toHaveBeenCalledTimes(2));
		expect(stage).toHaveBeenNthCalledWith(1, ["src/foo.ts"]);
		expect(stage).toHaveBeenNthCalledWith(2, ["notes.txt"]);
	});

	// The refusal is the server's own sentence about a request that never ran:
	// there is no git output to put behind Details, and the error code is not
	// something to show a user.
	it("says what the worktree is busy with when the server refuses", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(
			new JSONRPCErrorException(
				"another git operation is running in this worktree: push",
				-32001,
				{ operation: "push" },
			),
		);
		renderSection();

		await user.click(stageButtons()[0]);

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent(
			"This worktree is busy pushing. Try again once it finishes.",
		);
		expect(
			screen.queryByRole("button", { name: "Details" }),
		).not.toBeInTheDocument();
	});

	// git failing is the other path, and it keeps its own words.
	it("keeps git's message when the stage itself failed", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: pathspec did not match"));
		renderSection();

		await user.click(stageButtons()[0]);

		expect(await screen.findByRole("alert")).toHaveTextContent("Stage failed.");
		await user.click(screen.getByRole("button", { name: "Details" }));
		expect(
			screen.getByText("fatal: pathspec did not match"),
		).toBeInTheDocument();
	});
});

describe("ChangesSection banner outliving the list", () => {
	beforeEach(() => {
		status = STATUS;
		resetWrites();
	});

	// Switching segment or leaving the workspace unmounts the list; a failure
	// the user had not put away has to be there when they come back.
	it("is still there after the list is left and come back to", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: pathspec did not match"));
		const { unmount } = renderSection();
		await user.click(stageButtons()[0]);
		await screen.findByRole("alert");

		unmount();
		renderSection();

		expect(screen.getByRole("alert")).toHaveTextContent("Stage failed.");
	});

	// "Stage, then switch straight away": the failure settles with nobody
	// looking, and is the one the user most needs to hear about.
	it("shows a failure that settled while the list was not on screen", async () => {
		const user = userEvent.setup();
		let fail!: (error: Error) => void;
		stage.mockReturnValueOnce(
			new Promise<void>((_, reject) => {
				fail = reject;
			}),
		);
		const { unmount } = renderSection();
		await user.click(stageButtons()[0]);

		unmount();
		await act(async () => fail(new Error("fatal: index.lock exists")));
		renderSection();

		expect(screen.getByRole("alert")).toHaveTextContent("Stage failed.");
	});

	// Its paths are that worktree's: another worktree has nothing to retry.
	it("belongs to the worktree it happened in", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: pathspec did not match"));
		renderSection();
		await user.click(stageButtons()[0]);
		await screen.findByRole("alert");

		act(() => useWorktreeStore.setState({ current: "feature" }));
		expect(screen.queryByRole("alert")).toBeNull();

		act(() => useWorktreeStore.setState({ current: "" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Stage failed.");
	});

	it("is cleared by a retry of the same path that succeeds", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValueOnce(new Error("fatal: pathspec did not match"));
		renderSection();
		await user.click(stageButtons()[0]);
		await screen.findByRole("alert");

		await user.click(stageButtons()[0]);

		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});
});
