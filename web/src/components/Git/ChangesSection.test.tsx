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
	default: ({ onReview }: { onReview: () => void }) => (
		<button type="button" onClick={onReview}>
			Review
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
	} = {},
) {
	const onCloseFile = props.onCloseFile ?? vi.fn();
	const onSelectFile = vi.fn();
	const onViewHistory = vi.fn();
	const client = new QueryClient();
	const ui = () => (
		<QueryClientProvider client={client}>
			<ChangesSection
				onSelectFile={onSelectFile}
				onCloseFile={onCloseFile}
				onViewHistory={onViewHistory}
				activeFile={props.activeFile ?? null}
			/>
		</QueryClientProvider>
	);
	const { unmount, rerender } = render(ui());
	// Stands for a status refresh: the mocked query is read on every render.
	const refresh = () => rerender(ui());
	return { onCloseFile, onSelectFile, onViewHistory, unmount, refresh };
}

const confirmButton = (name: string) =>
	screen.getByRole("button", { name, hidden: false });

const checkbox = (name: string) => screen.getByRole("checkbox", { name });

async function openMenu(
	user: ReturnType<typeof userEvent.setup>,
	path: string,
) {
	await user.click(
		screen.getByRole("button", { name: `More actions for ${path}` }),
	);
	return screen.getByRole("dialog");
}

async function discardFromMenu(
	user: ReturnType<typeof userEvent.setup>,
	path: string,
	item = "Discard changes",
) {
	const sheet = await openMenu(user, path);
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

	// A staged-only file has nothing to discard; it is unstaged first.
	it("offers discard only for files with unstaged changes", async () => {
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
		await user.click(checkbox("Stage src/foo.ts"));

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

	it("sends every unstaged path from the header's menu", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(
			screen.getByRole("button", { name: "More actions for all changes" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Discard all changes…" }),
		);

		expect(
			screen.getByText(
				"1 file will lose its edits and 1 untracked file will be deleted. This cannot be undone.",
			),
		).toBeInTheDocument();
		await user.click(confirmButton("Discard"));

		expect(discard).toHaveBeenCalledWith(["notes.txt", "src/foo.ts"]);
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
	it("passes over the other files a discard all leaves unchanged", async () => {
		const user = userEvent.setup();
		const { onCloseFile } = renderSection({
			activeFile: { path: "notes.txt", staged: false },
		});

		await user.click(
			screen.getByRole("button", { name: "More actions for all changes" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Discard all changes…" }),
		);
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

		await user.click(
			screen.getByRole("button", { name: "More actions for all changes" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Discard all changes…" }),
		);
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
	checkbox("Stage src/foo.ts"),
	checkbox("Stage notes.txt"),
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

describe("ChangesSection checkboxes", () => {
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

	it("shows a file's staging as its checkbox, partial staging as mixed", () => {
		renderSection();

		expect(checkbox("Stage a/full.ts")).toHaveAttribute("aria-checked", "true");
		expect(checkbox("Stage a/part.ts")).toHaveAttribute(
			"aria-checked",
			"mixed",
		);
		expect(checkbox("Stage b/none.ts")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	// A hunk staged in the review moves the file: its row waits for that as it
	// waits for a write of the whole file.
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

		expect(checkbox("Stage a/part.ts")).toHaveAttribute("aria-busy", "true");
		expect(checkbox("Stage b/none.ts")).not.toHaveAttribute("aria-busy");

		await act(async () => {
			finish();
			await running;
		});
		expect(checkbox("Stage a/part.ts")).not.toHaveAttribute("aria-busy");
	});

	// Mixed goes to checked: a partial staging made on purpose is not thrown
	// away by a press that means "include this file".
	it("stages the rest of a mixed file and unstages a checked one", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(checkbox("Stage a/part.ts"));
		await waitFor(() => expect(stage).toHaveBeenCalledWith(["a/part.ts"]));

		await user.click(checkbox("Stage a/full.ts"));
		await waitFor(() => expect(unstage).toHaveBeenCalledWith(["a/full.ts"]));
	});

	it("stages everything unstaged from select all, in one request", async () => {
		const user = userEvent.setup();
		renderSection();

		const all = checkbox("Stage all 3 files");
		expect(all).toHaveAttribute("aria-checked", "mixed");
		await user.click(all);

		await waitFor(() =>
			expect(stage).toHaveBeenCalledWith(["a/part.ts", "b/none.ts"]),
		);
		expect(stage).toHaveBeenCalledTimes(1);
	});

	it("unstages everything once every file is fully staged", async () => {
		const user = userEvent.setup();
		status = {
			staged: [
				{ path: "a.ts", status: "M" },
				{ path: "b.ts", status: "A" },
			],
			unstaged: [],
		};
		renderSection();

		await user.click(checkbox("Stage all 2 files"));

		await waitFor(() => expect(unstage).toHaveBeenCalledWith(["a.ts", "b.ts"]));
	});

	// A folder writes the files the list shows under it, never `git add <dir>`.
	it("stages a folder's files by path, and still does so collapsed", async () => {
		const user = userEvent.setup();
		gitChangesViewActions.setView("tree");
		renderSection();

		const folder = screen.getByRole("button", { name: "a" });
		expect(folder).toHaveAttribute("aria-expanded", "true");
		await user.click(folder);
		expect(folder).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("checkbox", { name: "Stage a/part.ts" }),
		).toBeNull();

		const box = checkbox("Stage folder a, 2 files");
		expect(box).toHaveAttribute("aria-checked", "mixed");
		await user.click(box);

		await waitFor(() => expect(stage).toHaveBeenCalledWith(["a/part.ts"]));
	});
});

describe("ChangesSection rows", () => {
	beforeEach(() => {
		resetWrites();
	});

	it("names each file's change in words and sums both sides' lines", () => {
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

		const row = (path: string) =>
			screen.getByRole("button", { name: `Review ${path}` });
		expect(row("docs/new.md")).toHaveTextContent("Renamed from old.md");
		expect(row("docs/new.md")).toHaveTextContent("+2 −1");
		expect(row("lib/x.ts")).toHaveTextContent("+7 −2");
		expect(row("gone.ts")).toHaveTextContent("Deleted");
		expect(row("gone.ts")).toHaveTextContent("−14");
		expect(row("gone.ts")).not.toHaveTextContent("+0");
		expect(row("logo.png")).toHaveTextContent("UntrackedBinary");
		// The row's name stands in for its text, so a screen reader hears the
		// rest as the description.
		expect(row("gone.ts")).toHaveAccessibleDescription("Deleted −14");
		expect(row("logo.png")).toHaveAccessibleDescription("Untracked Binary");
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

	// The unstaged side is what staging would add; a fully staged file has
	// only the other.
	it("opens a file on the side that still has something to stage", async () => {
		const user = userEvent.setup();
		status = STATUS;
		const { onSelectFile } = renderSection();

		await user.click(screen.getByRole("button", { name: "Review src/foo.ts" }));
		expect(onSelectFile).toHaveBeenLastCalledWith("src/foo.ts", false);

		await user.click(screen.getByRole("button", { name: "Review staged.ts" }));
		expect(onSelectFile).toHaveBeenLastCalledWith("staged.ts", true);
	});

	it("reviews from the first file in list order", async () => {
		const user = userEvent.setup();
		status = STATUS;
		const { onSelectFile } = renderSection();

		await user.click(screen.getByRole("button", { name: "Review" }));

		expect(onSelectFile).toHaveBeenCalledWith("notes.txt", false);
	});

	it("points a clean tree at history", async () => {
		const user = userEvent.setup();
		status = { staged: [], unstaged: [] };
		const { onViewHistory } = renderSection();

		expect(screen.getByText("No changes")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).toBeNull();
		await user.click(screen.getByRole("button", { name: "View history" }));
		expect(onViewHistory).toHaveBeenCalled();
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
