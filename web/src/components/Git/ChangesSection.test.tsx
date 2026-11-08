import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitChangesViewActions } from "../../lib/gitChangesViewStore";
import { gitWriteActions } from "../../lib/gitWriteStore";
import { useWorktreeStore, worktreeActions } from "../../lib/worktreeStore";
import type { GitStatus } from "../../types/git";
import ChangesSection from "./ChangesSection";

const discard = vi.fn();
const stage = vi.fn();
const unstage = vi.fn();
const navigate = vi.fn();
let status: GitStatus | undefined;

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status, isLoading: false, error: null }),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: stage },
		resolveMutation: { mutateAsync: vi.fn() },
		unstageMutation: { mutateAsync: unstage },
		stageHunkMutation: { mutateAsync: vi.fn() },
		unstageHunkMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: discard }),
}));
// Reads queries this test does not stand up; its own test covers it.
vi.mock("./CommitBar", () => ({
	default: ({
		discardUnstaged,
	}: {
		discardUnstaged: {
			onDiscard: () => void;
			busy: boolean;
			nothingUnstaged: boolean;
		} | null;
	}) =>
		discardUnstaged && (
			<button
				type="button"
				aria-disabled={
					discardUnstaged.busy || discardUnstaged.nothingUnstaged || undefined
				}
				onClick={discardUnstaged.onDiscard}
			>
				Discard unstaged…
			</button>
		),
}));

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
		onCloseFile?: (
			path: string,
			worktree: string,
			next: { path: string; staged: boolean } | null,
		) => void;
		onShowFileHistory?: (path: string) => void;
	} = {},
) {
	const onCloseFile = props.onCloseFile ?? vi.fn();
	const onSelectFile = vi.fn();
	const client = new QueryClient();
	const ui = () => (
		<QueryClientProvider client={client}>
			<ChangesSection
				onSelectFile={onSelectFile}
				onCloseFile={onCloseFile}
				activeFile={props.activeFile ?? null}
				onShowFileHistory={props.onShowFileHistory}
			/>
		</QueryClientProvider>
	);
	const { unmount, rerender } = render(ui());
	// Stands for a status refresh: the mocked query is read on every render.
	const refresh = () => rerender(ui());
	return { onCloseFile, onSelectFile, unmount, refresh };
}

const confirmButton = (name: string) =>
	screen.getByRole("button", { name, hidden: false });

const button = (name: string) => screen.getByRole("button", { name });

const discardUnstagedButton = () => button("Discard unstaged…");

type Group = "Conflicts" | "Unstaged" | "Staged";

/** A group of the list, by its name; the count follows it in the label. */
const group = (name: Group) =>
	screen.getByRole("region", { name: new RegExp(`^${name} \\d+$`) });

/**
 * `name`, or `name` with the side a partly staged file's rows add to tell
 * them apart — for queries already scoped to one group.
 */
const inGroup = (name: string) => (accessibleName: string) =>
	[name, `${name}, staged`, `${name}, unstaged`].includes(accessibleName);

async function openMenu(
	user: ReturnType<typeof userEvent.setup>,
	path: string,
	from?: Group,
) {
	await user.click(
		within(from ? group(from) : document.body).getByRole("button", {
			name: from
				? inGroup(`More actions for ${path}`)
				: `More actions for ${path}`,
		}),
	);
	return screen.getByRole("dialog");
}

async function discardFromMenu(
	user: ReturnType<typeof userEvent.setup>,
	path: string,
	item = "Discard changes",
) {
	const sheet = await openMenu(user, path, "Unstaged");
	await user.click(within(sheet).getByRole("button", { name: item }));
}

function resetWrites() {
	gitWriteActions.reset();
	worktreeActions.reset();
	gitChangesViewActions.setView("flat");
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

	// Staged is never discarded; a staged file is unstaged first.
	it("offers discard only from an unstaged row", async () => {
		const user = userEvent.setup();
		renderSection();

		const staged = await openMenu(user, "staged.ts");
		expect(
			within(staged).getByRole("button", { name: "Open file" }),
		).toBeInTheDocument();
		expect(
			within(staged).queryByRole("button", { name: /Discard|Delete/ }),
		).not.toBeInTheDocument();
		await user.keyboard("{Escape}");

		const untracked = await openMenu(user, "notes.txt");
		expect(
			within(untracked).getByRole("button", { name: "Delete file" }),
		).toBeInTheDocument();
	});

	// The file has unstaged changes, but not on the row the sheet came from.
	it("offers no discard from the staged row of a partly staged file", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/foo.ts", status: "M" }],
			unstaged: [{ path: "src/foo.ts", status: "M" }],
		};
		renderSection();

		const staged = await openMenu(user, "src/foo.ts", "Staged");
		expect(
			within(staged).queryByRole("button", { name: /Discard|Delete/ }),
		).not.toBeInTheDocument();
		await user.keyboard("{Escape}");

		const unstaged = await openMenu(user, "src/foo.ts", "Unstaged");
		expect(
			within(unstaged).getByRole("button", { name: "Discard changes" }),
		).toBeInTheDocument();
	});

	// An untracked file has never been committed, so has no history to list.
	it("opens a file's history from its menu, except an untracked file's", async () => {
		const user = userEvent.setup();
		renderSection();

		const untracked = await openMenu(user, "notes.txt");
		expect(
			within(untracked).queryByRole("button", {
				name: "History of this file",
			}),
		).not.toBeInTheDocument();
		await user.keyboard("{Escape}");

		const staged = await openMenu(user, "staged.ts");
		await user.click(
			within(staged).getByRole("button", { name: "History of this file" }),
		);
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/git",
				search: { segment: "history", file: "staged.ts" },
			}),
		);
		expect(navigate).toHaveBeenCalledWith(
			expect.not.objectContaining({ replace: true }),
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	// The sidebar's list beside a review turns to History itself: navigating
	// to the History list would replace the review beside it.
	it("hands a file's history to its owner instead, when it has one", async () => {
		const user = userEvent.setup();
		const onShowFileHistory = vi.fn();
		navigate.mockClear();
		renderSection({ onShowFileHistory });

		const staged = await openMenu(user, "staged.ts");
		await user.click(
			within(staged).getByRole("button", { name: "History of this file" }),
		);
		expect(onShowFileHistory).toHaveBeenCalledWith("staged.ts");
		expect(navigate).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	// The write queue drops a path it already holds: a discard let through now
	// would report success for a write that never ran.
	it("holds discard back while the file has a write in flight", async () => {
		const user = userEvent.setup();
		let finish!: () => void;
		stage.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		renderSection();
		await user.click(button("Stage src/foo.ts"));

		const sheet = await openMenu(user, "src/foo.ts");
		const item = within(sheet).getByRole("button", { name: /Discard changes/ });
		expect(item).toHaveAttribute("aria-disabled", "true");
		await user.click(item);
		expect(
			screen.queryByRole("heading", { name: "Discard changes?" }),
		).toBeNull();

		await act(async () => finish());
		await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
	});

	it("discards a tracked file only after the warning is confirmed", async () => {
		const user = userEvent.setup();
		renderSection();

		await discardFromMenu(user, "src/foo.ts");

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

		await discardFromMenu(user, "notes.txt", "Delete file");

		expect(
			screen.getByRole("heading", { name: "Delete file?" }),
		).toBeInTheDocument();
		await user.click(confirmButton("Delete"));

		expect(discard).toHaveBeenCalledWith(["notes.txt"]);
	});

	it("cancelling discards nothing", async () => {
		const user = userEvent.setup();
		renderSection();

		await discardFromMenu(user, "src/foo.ts");
		await user.click(confirmButton("Cancel"));

		expect(discard).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("sends every unstaged path from the bottom bar", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(discardUnstagedButton());

		expect(
			screen.getByText(
				"The unstaged edits in 1 file will be lost and 1 untracked file will be deleted. Staged changes are kept. This cannot be undone.",
			),
		).toBeInTheDocument();
		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["notes.txt", "src/foo.ts"]);
	});

	// git's discard restores the file to its index: what is staged stays.
	it("discards only the unstaged side of a partly staged file", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/foo.ts", status: "M" }],
			unstaged: [{ path: "src/foo.ts", status: "M" }],
		};
		renderSection();

		await user.click(discardUnstagedButton());
		expect(
			screen.getByText(
				"Your unstaged edits to src/foo.ts will be lost. Its staged changes are kept. This cannot be undone.",
			),
		).toBeInTheDocument();
		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["src/foo.ts"]);
	});

	it("tells the row menu's discard of a partly staged file what it keeps", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/foo.ts", status: "M" }],
			unstaged: [{ path: "src/foo.ts", status: "M" }],
		};
		renderSection();

		await discardFromMenu(user, "src/foo.ts");

		expect(
			screen.getByRole("heading", { name: "Discard unstaged changes?" }),
		).toBeInTheDocument();
	});

	// Held, not hidden: it still shows where discarding lives.
	it("holds the discard when every file is staged", () => {
		status = { staged: STATUS.staged, unstaged: [] };
		renderSection();

		expect(discardUnstagedButton()).toHaveAttribute("aria-disabled", "true");
	});

	// The write queue drops a path it already holds: a discard now would skip
	// the file being written and say nothing.
	it("holds the discard while a file is being written", async () => {
		const user = userEvent.setup();
		let finish!: () => void;
		stage.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		renderSection();

		await user.click(button("Stage src/foo.ts"));
		expect(discardUnstagedButton()).toHaveAttribute("aria-disabled", "true");

		await act(async () => finish());
		await waitFor(() =>
			expect(discardUnstagedButton()).not.toHaveAttribute("aria-disabled"),
		);
	});

	const GIT_ERROR =
		"error: unable to unlink old 'src/foo.ts': Permission denied";

	async function failADiscard(user: ReturnType<typeof userEvent.setup>) {
		discard.mockRejectedValue(new Error(GIT_ERROR));
		renderSection();

		await discardFromMenu(user, "src/foo.ts");
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
		await discardFromMenu(user, "notes.txt", "Delete file");
		await user.click(confirmButton("Delete"));

		await waitFor(() => expect(discard).toHaveBeenCalledWith(["notes.txt"]));
		expect(screen.getByRole("alert")).toHaveTextContent("Discard failed.");
	});

	// A review of the file goes on to whatever follows it in the list, on the
	// side the review would open it on.
	it("names the file after the discarded one", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "src/foo.ts", staged: false },
		});

		await discardFromMenu(user, "src/foo.ts");
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith("src/foo.ts", "", {
				path: "staged.ts",
				staged: true,
			}),
		);
	});

	// The list has not heard of the discard when it answers: a file it left
	// with no changes at all must not be what the review moves on to.
	it("passes over the other files a discard of the unstaged leaves unchanged", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "notes.txt", staged: false },
		});

		await user.click(discardUnstagedButton());
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith("notes.txt", "", {
				path: "staged.ts",
				staged: true,
			}),
		);
	});

	// A partly staged file keeps its row: it is still a file to walk past.
	it("keeps a discarded file that is still staged in the order", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/foo.ts", status: "M" }],
			unstaged: [
				{ path: "notes.txt", status: "?" },
				{ path: "src/foo.ts", status: "M" },
			],
		};
		const { onCloseFile } = renderSection();

		await user.click(discardUnstagedButton());
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith("notes.txt", "", {
				path: "src/foo.ts",
				staged: true,
			}),
		);
		expect(onCloseFile).toHaveBeenCalledWith("src/foo.ts", "", null);
	});

	// What was open when the discard was confirmed is not what is open when it
	// answers; whether the diff is still the page is the shell's to decide.
	it("reports a discarded file even when another one was open", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "src/other.ts", staged: false },
		});

		await discardFromMenu(user, "src/foo.ts");
		await user.click(confirmButton("Discard"));

		await waitFor(() =>
			expect(onCloseFile).toHaveBeenCalledWith(
				"src/foo.ts",
				"",
				expect.anything(),
			),
		);
	});
});

const stageButtons = () => [
	button("Stage src/foo.ts"),
	button("Stage notes.txt"),
];

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
		// Busy, but still focusable: `disabled` would drop the focus.
		expect(first).toHaveAttribute("aria-busy", "true");
		expect(first).not.toBeDisabled();

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

describe("ChangesSection groups", () => {
	beforeEach(() => {
		status = {
			staged: [
				{ path: "a/full.ts", status: "M" },
				{ path: "a/part.ts", status: "M" },
			],
			unstaged: [
				{ path: "a/part.ts", status: "M" },
				{ path: "b/none.ts", status: "M" },
			],
		};
		resetWrites();
	});

	// By label: the role query would compute every button's name per call.
	const rowsIn = (name: Group) =>
		within(group(name))
			.queryAllByLabelText(/^Review /)
			.map((row) => row.getAttribute("aria-label"));

	it("lists each side of a file in its own group, a partly staged file in both", () => {
		renderSection();

		expect(rowsIn("Unstaged")).toEqual([
			"Review a/part.ts, unstaged",
			"Review b/none.ts",
		]);
		expect(rowsIn("Staged")).toEqual([
			"Review a/full.ts",
			"Review a/part.ts, staged",
		]);
		// Counted by path, so the partly staged file counts once.
		expect(screen.getByText("3 files")).toBeInTheDocument();
	});

	it("keeps both groups up when one is empty, and says it is", () => {
		status = { staged: [{ path: "a.ts", status: "M" }], unstaged: [] };
		renderSection();

		expect(within(group("Unstaged")).getByText("No unstaged changes."));
		expect(
			within(group("Unstaged")).queryByRole("button", { name: /^Stage all/ }),
		).toBeNull();
		expect(rowsIn("Staged")).toEqual(["Review a.ts"]);
	});

	// A hunk staged in the review moves the file: both of its rows wait for
	// that as they wait for a write of the whole file.
	it("shows a file busy while one of its hunks is being staged", async () => {
		renderSection();
		let finish!: () => void;
		const write = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let running!: Promise<void>;
		act(() => {
			running = gitWriteActions.runHunk("", "a/part.ts", "h1", () => write);
		});

		expect(button("Stage a/part.ts")).toHaveAttribute("aria-busy", "true");
		expect(button("Unstage a/part.ts")).toHaveAttribute("aria-busy", "true");
		expect(button("Stage b/none.ts")).not.toHaveAttribute("aria-busy");

		await act(async () => {
			finish();
			await running;
		});
		expect(button("Stage a/part.ts")).not.toHaveAttribute("aria-busy");
	});

	it("stages an unstaged row and unstages a staged one, each its own side", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(button("Stage a/part.ts"));
		await waitFor(() => expect(stage).toHaveBeenCalledWith(["a/part.ts"]));

		await user.click(button("Unstage a/part.ts"));
		await waitFor(() => expect(unstage).toHaveBeenCalledWith(["a/part.ts"]));
	});

	// Restoring the new path alone would split the rename into two rows.
	it("unstages a staged rename together with its source", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "new.ts", status: "R", orig_path: "old.ts" }],
			unstaged: [],
		};
		renderSection();

		await user.click(button("Unstage new.ts"));

		await waitFor(() =>
			expect(unstage).toHaveBeenCalledWith(["new.ts", "old.ts"]),
		);
	});

	it("stages every unstaged row from the group's header, in one request", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(button("Stage all 2 unstaged files"));

		await waitFor(() =>
			expect(stage).toHaveBeenCalledWith(["a/part.ts", "b/none.ts"]),
		);
		expect(stage).toHaveBeenCalledTimes(1);
	});

	it("unstages every staged row from the group's header, in one request", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(button("Unstage all 2 staged files"));

		await waitFor(() =>
			expect(unstage).toHaveBeenCalledWith(["a/full.ts", "a/part.ts"]),
		);
		expect(unstage).toHaveBeenCalledTimes(1);
	});

	// A folder writes the files the group shows under it, never `git add <dir>`.
	it("stages a folder's files by path, and still does so collapsed", async () => {
		const user = userEvent.setup();
		gitChangesViewActions.setView("tree");
		renderSection();

		const folder = within(group("Unstaged")).getByRole("button", { name: "a" });
		expect(folder).toHaveAttribute("aria-expanded", "true");
		await user.click(folder);
		expect(folder).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("button", { name: "Stage a/part.ts" }),
		).toBeNull();
		// Each group's tree folds on its own.
		expect(
			within(group("Staged")).getByRole("button", { name: "a" }),
		).toHaveAttribute("aria-expanded", "true");

		await user.click(button("Stage folder a, 1 file"));
		await waitFor(() => expect(stage).toHaveBeenCalledWith(["a/part.ts"]));

		await user.click(button("Unstage folder a, 2 files"));
		await waitFor(() =>
			expect(unstage).toHaveBeenCalledWith(["a/full.ts", "a/part.ts"]),
		);
	});

	// The row leaves from under the button; the focus must not go with it.
	/**
	 * The next stage answers with `next` already on screen: `useGitStage`'s
	 * writes answer once the status they invalidated has been read again.
	 */
	const answerWith = (refresh: () => void, next: GitStatus) =>
		stage.mockImplementationOnce(async () => {
			status = next;
			refresh();
		});

	it("hands the focus on to the row that takes the moved one's place", async () => {
		const user = userEvent.setup();
		const { refresh } = renderSection();

		answerWith(refresh, {
			staged: [
				{ path: "a/full.ts", status: "M" },
				{ path: "a/part.ts", status: "M" },
			],
			unstaged: [{ path: "b/none.ts", status: "M" }],
		});
		button("Stage a/part.ts").focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(button("Stage b/none.ts")).toHaveFocus());

		answerWith(refresh, {
			staged: [
				{ path: "a/full.ts", status: "M" },
				{ path: "a/part.ts", status: "M" },
				{ path: "b/none.ts", status: "M" },
			],
			unstaged: [],
		});
		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Unstaged 0" })).toHaveFocus(),
		);
	});

	it("hands the focus back up the group when the last row moves", async () => {
		const user = userEvent.setup();
		const { refresh } = renderSection();

		answerWith(refresh, {
			staged: [
				{ path: "a/full.ts", status: "M" },
				{ path: "a/part.ts", status: "M" },
				{ path: "b/none.ts", status: "M" },
			],
			unstaged: [{ path: "a/part.ts", status: "M" }],
		});
		button("Stage b/none.ts").focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(button("Stage a/part.ts")).toHaveFocus());
	});

	// The hand-off is the press's: once the focus is elsewhere, or the write
	// failed and left the row in place, a later move must not take the focus.
	it("leaves the focus alone once it has gone elsewhere", async () => {
		const user = userEvent.setup();
		// Still writing, so nothing but the focus leaving drops the hand-off.
		stage.mockReturnValueOnce(new Promise(() => {}));
		const { refresh } = renderSection();

		button("Stage a/part.ts").focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(stage).toHaveBeenCalled());
		const flat = button("Flat list");
		flat.focus();
		flat.blur();
		status = {
			...status,
			unstaged: [{ path: "b/none.ts", status: "M" }],
		} as GitStatus;
		refresh();

		expect(document.body).toHaveFocus();
	});

	// Edited again before the status was read: the row stayed, and its later
	// move is not this press's.
	it("drops the hand-off when the write leaves the row in place", async () => {
		const user = userEvent.setup();
		const { refresh } = renderSection();

		button("Stage a/part.ts").focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(stage).toHaveBeenCalled());
		await act(() => new Promise((resolve) => setTimeout(resolve)));
		(document.activeElement as HTMLElement).blur();
		status = {
			...status,
			unstaged: [{ path: "b/none.ts", status: "M" }],
		} as GitStatus;
		refresh();

		expect(document.body).toHaveFocus();
	});

	it("drops the hand-off when the write fails", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: index.lock exists"));
		const { refresh } = renderSection();

		button("Stage a/part.ts").focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("alert");
		(document.activeElement as HTMLElement).blur();
		status = {
			...status,
			unstaged: [{ path: "b/none.ts", status: "M" }],
		} as GitStatus;
		refresh();

		expect(document.body).toHaveFocus();
	});
});

describe("ChangesSection conflicts", () => {
	beforeEach(() => {
		status = {
			staged: [
				{ path: "src/clash.ts", status: "U" },
				{ path: "done.ts", status: "M" },
			],
			unstaged: [
				{ path: "src/clash.ts", status: "U" },
				{ path: "notes.txt", status: "M" },
			],
			conflicted: ["src/clash.ts"],
			operation: { kind: "merge" },
		};
		resetWrites();
	});

	// One tap must not record the markers as the resolution.
	it("draws a conflicted file in its own group without a stage button", () => {
		renderSection();

		expect(
			screen.queryByRole("button", { name: /Stage src\/clash.ts/ }),
		).toBeNull();
		expect(
			within(group("Conflicts")).getByLabelText(
				"Review src/clash.ts, conflicted",
			),
		).toBeInTheDocument();
		const row = screen.getByRole("button", {
			name: "Review src/clash.ts, conflicted",
		});
		expect(row).toHaveAccessibleDescription(/Conflict/);
	});

	it("offers no discard for a conflicted file", async () => {
		const user = userEvent.setup();
		renderSection();

		const sheet = await openMenu(user, "src/clash.ts");

		expect(
			within(sheet).getByRole("button", { name: "Open file" }),
		).toBeEnabled();
		expect(
			within(sheet).queryByRole("button", { name: /Discard|Delete/ }),
		).toBeNull();
	});

	it("passes conflicts over in staging all", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(button("Stage all 1 unstaged file"));

		await waitFor(() => expect(stage).toHaveBeenCalledWith(["notes.txt"]));
	});

	it("passes conflicts over in discarding the unstaged", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(discardUnstagedButton());
		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["notes.txt"]);
	});

	// The gutter stays, empty, so the column of buttons stays aligned.
	it("gives a folder of conflicts no stage button", () => {
		gitChangesViewActions.setView("tree");
		renderSection();

		expect(button("src")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Stage folder src/ }),
		).toBeNull();
	});

	it("has nothing to stage or discard when every file is conflicted", () => {
		status = {
			staged: [{ path: "a.ts", status: "U" }],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
		};
		renderSection();

		expect(screen.queryByRole("button", { name: /^(Un)?[Ss]tage/ })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Discard unstaged…" }),
		).toBeNull();
	});
});

describe("ChangesSection rows", () => {
	beforeEach(() => {
		resetWrites();
	});

	it("names each row's change in words, by its own side's lines", () => {
		status = {
			staged: [
				{
					path: "docs/new.md",
					status: "R",
					orig_path: "docs/old.md",
					lines: { additions: 2, deletions: 1 },
				},
				{
					path: "lib/x.ts",
					status: "M",
					lines: { additions: 3, deletions: 0 },
				},
			],
			unstaged: [
				{
					path: "lib/x.ts",
					status: "M",
					lines: { additions: 4, deletions: 2 },
				},
				{
					path: "gone.ts",
					status: "D",
					lines: { additions: 0, deletions: 14 },
				},
				{ path: "logo.png", status: "?", binary: true },
			],
		};
		renderSection();

		const row = (path: string, from: Group = "Unstaged") =>
			within(group(from)).getByRole("button", {
				name: inGroup(`Review ${path}`),
			});
		expect(row("docs/new.md", "Staged")).toHaveTextContent(
			"Renamed from old.md",
		);
		expect(row("docs/new.md", "Staged")).toHaveTextContent("+2 −1");
		expect(row("lib/x.ts", "Staged")).toHaveTextContent("+3");
		expect(row("lib/x.ts")).toHaveTextContent("+4 −2");
		expect(row("gone.ts")).toHaveTextContent("Deleted");
		expect(row("gone.ts")).toHaveTextContent("−14");
		expect(row("gone.ts")).not.toHaveTextContent("+0");
		expect(row("logo.png")).toHaveTextContent("UntrackedBinary");
		// The row's name stands in for its text, so a screen reader hears the
		// rest as the description.
		expect(row("gone.ts")).toHaveAccessibleDescription("Deleted −14");
		expect(row("logo.png")).toHaveAccessibleDescription("Untracked Binary");
	});

	// Hover only: every one of these is also in the row's name or description.
	it("gives each text that can be cut its full value as a title", () => {
		status = {
			staged: [
				{
					path: "src/components/Git/next.tsx",
					status: "R",
					orig_path: "lib/prev.tsx",
				},
			],
			unstaged: [],
		};
		renderSection();

		const row = screen.getByRole("button", {
			name: "Review src/components/Git/next.tsx",
		});
		expect(within(row).getByTitle("next.tsx")).toHaveTextContent("next.tsx");
		expect(within(row).getByTitle("src/components/Git")).toHaveTextContent(
			"src/components/Git",
		);
		expect(
			within(row).getByTitle("Renamed from lib/prev.tsx"),
		).toBeInTheDocument();
	});

	it("marks a submodule's files", () => {
		status = {
			staged: [],
			unstaged: [],
			submodules: {
				"vendor/sdk": { staged: [], unstaged: [{ path: "a.ts", status: "?" }] },
			},
		};
		renderSection();

		expect(
			screen.getByRole("button", { name: "Review vendor/sdk/a.ts" }),
		).toHaveTextContent("Untracked · Submodule");
	});

	it("opens a row on its own group's side, and lights only that row", async () => {
		const user = userEvent.setup();
		status = {
			staged: [{ path: "src/foo.ts", status: "M" }],
			unstaged: [{ path: "src/foo.ts", status: "M" }],
		};
		const { onSelectFile } = renderSection({
			activeFile: { path: "src/foo.ts", staged: true },
		});
		const row = (from: Group) =>
			within(group(from)).getByRole("button", {
				name: `Review src/foo.ts, ${from.toLowerCase()}`,
			});

		await user.click(row("Unstaged"));
		expect(onSelectFile).toHaveBeenLastCalledWith("src/foo.ts", false);
		await user.click(row("Staged"));
		expect(onSelectFile).toHaveBeenLastCalledWith("src/foo.ts", true);

		expect(row("Staged")).toHaveAttribute("aria-current", "true");
		expect(row("Unstaged")).not.toHaveAttribute("aria-current");
	});

	// History is one segment away; the empty list does not point there again.
	it("says only that a clean tree has no changes", () => {
		status = { staged: [], unstaged: [] };
		renderSection();

		expect(screen.getByText("No changes")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("region")).toBeNull();
	});

	// The sheet is about a file; once the file has no changes it has nothing
	// to offer, and must not spring back if the path changes again later.
	it("closes a file's menu for good when the file stops having changes", async () => {
		const user = userEvent.setup();
		status = STATUS;
		const { refresh } = renderSection();
		await openMenu(user, "notes.txt");

		status = { ...STATUS, unstaged: [STATUS.unstaged[0]] };
		refresh();
		expect(screen.queryByRole("dialog")).toBeNull();

		status = STATUS;
		refresh();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("copies a file's path from its menu", async () => {
		const user = userEvent.setup();
		status = STATUS;
		renderSection();

		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue(undefined);

		const sheet = await openMenu(user, "src/foo.ts");
		await user.click(within(sheet).getByRole("button", { name: "Copy path" }));

		expect(writeText).toHaveBeenCalledWith("src/foo.ts");
		expect(
			await within(sheet).findByRole("button", { name: "Copied" }),
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
