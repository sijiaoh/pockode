import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import { gitChangesViewActions } from "../../lib/gitChangesViewStore";
import { gitWriteActions, useGitWriteStore } from "../../lib/gitWriteStore";
import {
	overlayToNavigation,
	REVIEW_FROM_LIST_STATE,
} from "../../lib/navigation";
import { getDiffHighlighter } from "../../lib/shikiUtils";
import type { GitDiffData, GitStatus } from "../../types/git";
import DiffView from "./DiffView";

const navigate = vi.fn();
const stage = vi.fn();
const resolve = vi.fn();
const unstage = vi.fn();
const discard = vi.fn();
const diffWatch = vi.fn();
const stageHunk = vi.fn();
const unstageHunk = vi.fn();
const refreshDiff = vi.fn();
const diffRef = vi.hoisted(() => ({
	current: { data: undefined as GitDiffData | undefined, snapshot: 1 },
}));
const statusRef = vi.hoisted(() => ({
	current: undefined as GitStatus | undefined,
}));
const expandedRef = vi.hoisted(() => ({ current: false }));
// The working-tree file a conflicted path is read from.
const contentsRef = vi.hoisted(() => ({
	current: {
		data: undefined as unknown,
		isLoading: false,
		isFetching: false,
		error: null,
		// What a re-read finds on disk; the cached `data` unless a test says.
		onDisk: undefined as unknown,
		refetch: async () => ({
			data: contentsRef.current.onDisk ?? contentsRef.current.data,
			isError: false,
		}),
	},
}));
const prefill = vi.hoisted(() => vi.fn());

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => expandedRef.current,
}));

// Where the URL is, ahead of the props while the router renders a move; null
// for "still on the page being rendered".
const urlRef = vi.hoisted(() => ({ current: null as string | null }));
// The state of the review's history entry: marked when pushed from the list.
const historyStateRef = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));
const back = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => {
	let built = "";
	return {
		history: {
			get location() {
				return { state: historyStateRef.current };
			},
			back,
			subscribe: () => () => {},
		},
		buildLocation: (nav: { to: string; params?: unknown }) => {
			built = `${nav.to} ${JSON.stringify(nav.params)}`;
			return { pathname: built };
		},
		get latestLocation() {
			return { pathname: urlRef.current ?? built };
		},
	};
});

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useRouter: () => router,
}));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));
vi.mock("../../hooks/useGitDiffWatch", () => ({
	useGitDiffWatch: (opts: unknown) => {
		diffWatch(opts);
		return {
			...diffRef.current,
			isLoading: false,
			refresh: refreshDiff,
			currentSnapshot: () => diffRef.current.snapshot,
		};
	},
}));
vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill,
		isPending: false,
		error: null,
		dismissError: () => {},
	}),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({
		data: statusRef.current,
		isPending: statusRef.current === undefined,
	}),
}));
vi.mock("../../hooks/useContents", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useContents")>()),
	useContents: () => contentsRef.current,
}));
vi.mock("../../hooks/useFSWatch", () => ({ useFSWatch: () => {} }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQueryClient: () => ({
		invalidateQueries: () => {},
		getQueryData: (key: readonly string[]) =>
			key[0] === "git-status"
				? statusRef.current
				: { head: { branch: "feature", detached: false } },
	}),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: stage },
		resolveMutation: { mutateAsync: resolve },
		unstageMutation: { mutateAsync: unstage },
		stageHunkMutation: { mutateAsync: stageHunk },
		unstageHunkMutation: { mutateAsync: unstageHunk },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: discard }),
}));
vi.mock("./GitCommitSheet", () => ({
	default: ({ onCommitted }: { onCommitted: () => void }) => (
		<div role="dialog" aria-label="Commit">
			<button type="button" onClick={onCommitted}>
				commit now
			</button>
		</div>
	),
}));

function deferred() {
	let reject: (e: unknown) => void = () => {};
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const failures = () => useGitWriteStore.getState().failures;
const writesSettled = () =>
	waitFor(() =>
		expect(useGitWriteStore.getState().writes[""]?.toggling.size ?? 0).toBe(0),
	);

const toFile = (path: string, staged: boolean) => ({
	...overlayToNavigation({ type: "diff", path, staged }, "", null, {
		replace: true,
	}),
	state: true,
});
const toList = () =>
	overlayToNavigation({ type: "git", segment: "changes" }, "", null, {
		replace: true,
	});

beforeEach(() => {
	navigate.mockReset();
	back.mockReset();
	historyStateRef.current = {};
	stage.mockReset().mockResolvedValue(undefined);
	resolve.mockReset().mockResolvedValue(undefined);
	unstage.mockReset().mockResolvedValue(undefined);
	discard.mockReset().mockResolvedValue(undefined);
	diffWatch.mockReset();
	prefill.mockReset().mockResolvedValue(undefined);
	Object.assign(contentsRef.current, {
		data: undefined,
		isLoading: false,
		isFetching: false,
		error: null,
		onDisk: undefined,
	});
	stageHunk.mockReset().mockResolvedValue(undefined);
	unstageHunk.mockReset().mockResolvedValue(undefined);
	refreshDiff.mockReset();
	diffRef.current = { data: undefined, snapshot: 1 };
	gitWriteActions.reset();
	expandedRef.current = false;
	urlRef.current = null;
	localStorage.clear();
	gitChangesViewActions.setView("flat");
	useDiffSettingsStore.setState({ gitDiffSplit: false });
	statusRef.current = {
		staged: [{ path: "b.ts", status: "M" }],
		unstaged: [
			{ path: "a.ts", status: "M" },
			{ path: "c.ts", status: "?" },
		],
	};
});

describe("DiffView review toolbar", () => {
	it("places the file in the list's order and moves by replacing", async () => {
		const user = userEvent.setup();
		render(<DiffView path="b.ts" staged={true} />);

		expect(screen.getByText("File 2 of 3")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Next file" }));
		expect(navigate).toHaveBeenLastCalledWith(toFile("c.ts", false));
		await user.click(screen.getByRole("button", { name: "Previous file" }));
		expect(navigate).toHaveBeenLastCalledWith(toFile("a.ts", false));
	});

	// The order is the list's, whichever way the list is drawn: in the tree a
	// folder comes before the files beside it.
	it("walks the tree's order when the list is a tree", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [],
			unstaged: [
				{ path: "a.ts", status: "M" },
				{ path: "b/c.ts", status: "M" },
			],
		};
		gitChangesViewActions.setView("tree");
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.getByText("File 2 of 2")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next file" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Previous file" }));
		expect(navigate).toHaveBeenLastCalledWith(toFile("b/c.ts", false));
	});

	it("disables previous on the first file and next on the last", () => {
		render(<DiffView path="a.ts" staged={false} />);
		expect(
			screen.getByRole("button", { name: "Previous file" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next file" })).toBeEnabled();
	});
});

describe("DiffView split view", () => {
	it("is offered at expanded, inline until chosen", async () => {
		const user = userEvent.setup();
		expandedRef.current = true;
		render(<DiffView path="a.ts" staged={false} />);

		const toggle = screen.getByRole("button", { name: "Side by side" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		await user.click(toggle);

		expect(screen.getByRole("button", { name: "Inline" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	// No width for two columns, so no switch for them either.
	it("is not offered below expanded", () => {
		useDiffSettingsStore.setState({ gitDiffSplit: true });
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			screen.queryByRole("button", { name: /^(Side by side|Inline)$/ }),
		).toBeNull();
	});
});

describe("DiffView bottom buttons", () => {
	it("stages and goes on to the next file", async () => {
		const user = userEvent.setup();
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Stage & next" }));

		expect(stage).toHaveBeenCalledWith(["a.ts"]);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(toFile("b.ts", true)),
		);
	});

	// The router renders the move to the next file after the refreshed status
	// has reached this page, which still names the staged file: following that
	// file to its staged side then would undo the move.
	it("is not pulled back to the staged file by a status that lands late", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Stage & next" }));
		await waitFor(() =>
			expect(navigate).toHaveBeenLastCalledWith(toFile("b.ts", true)),
		);
		statusRef.current = {
			staged: [
				{ path: "a.ts", status: "M" },
				{ path: "b.ts", status: "M" },
			],
			unstaged: [{ path: "c.ts", status: "?" }],
		};
		rerender(<DiffView path="a.ts" staged={false} />);

		expect(navigate).toHaveBeenLastCalledWith(toFile("b.ts", true));
	});

	it("stages the last file and stays, offering the commit", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<DiffView path="c.ts" staged={false} />);
		stage.mockImplementation(async () => {
			statusRef.current = {
				staged: [
					{ path: "b.ts", status: "M" },
					{ path: "c.ts", status: "A" },
				],
				unstaged: [{ path: "a.ts", status: "M" }],
			};
			rerender(<DiffView path="c.ts" staged={false} />);
		});

		await user.click(screen.getByRole("button", { name: "Stage" }));

		expect(
			await screen.findByRole("button", { name: "Commit 2 files" }),
		).toBeEnabled();
		await writesSettled();
		// Only the route following the file to the side it now has.
		expect(navigate.mock.calls).toEqual([[toFile("c.ts", true)]]);
	});

	it("shows why Commit is disabled when only submodule files are staged", () => {
		statusRef.current = {
			staged: [],
			unstaged: [],
			submodules: {
				lib: { staged: [{ path: "x.ts", status: "M" }], unstaged: [] },
			},
		};
		render(<DiffView path="lib/x.ts" staged={true} />);

		const commit = screen.getByRole("button", { name: "Commit" });
		expect(commit).toBeDisabled();
		expect(commit).toHaveAccessibleDescription(
			/Only submodule files are staged/,
		);
		expect(screen.getByText(/Only submodule files are staged/)).toBeVisible();
	});

	// Wide, the bottom is the composer's: the buttons join the toolbar, and
	// a hint goes with them.
	it("moves into the toolbar when placed at the top", () => {
		statusRef.current = {
			staged: [],
			unstaged: [],
			submodules: {
				lib: { staged: [{ path: "x.ts", status: "M" }], unstaged: [] },
			},
		};
		const { rerender } = render(
			<DiffView path="lib/x.ts" staged={true} actionsAt="top" />,
		);
		const toolbar = screen.getByRole("button", {
			name: "Next file",
		}).parentElement;
		const commit = screen.getByRole("button", { name: "Commit" });
		expect(toolbar).toContainElement(commit);
		expect(commit).toHaveAccessibleDescription(
			/Only submodule files are staged/,
		);
		expect(screen.getByText(/Only submodule files are staged/)).toBeVisible();

		statusRef.current = {
			staged: [],
			unstaged: [
				{ path: "a.ts", status: "M" },
				{ path: "b.ts", status: "M" },
			],
		};
		rerender(<DiffView path="a.ts" staged={false} actionsAt="top" />);
		expect(toolbar).toContainElement(
			screen.getByRole("button", { name: "Stage & next" }),
		);
		expect(toolbar).toContainElement(
			screen.getByRole("button", { name: "Discard file" }),
		);
	});

	it("draws no buttons while hidden", () => {
		render(<DiffView path="a.ts" staged={false} actionsAt="hidden" />);
		expect(screen.queryByRole("button", { name: "Stage & next" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Discard file" })).toBeNull();
	});

	it("leaves for the list by replacing, from the header's back", async () => {
		const user = userEvent.setup();
		render(<DiffView path="a.ts" staged={false} showBack />);

		await user.click(screen.getByRole("button", { name: "Back to changes" }));
		expect(navigate).toHaveBeenCalledWith(toList());
	});

	// Pushed from the list, the review goes back to it rather than replacing
	// itself with a second copy of it, which would leave a Back that does
	// nothing on screen.
	describe("pushed from the list", () => {
		// A key of its own per test: a key backed from stays guarded until the
		// window leaves it, which this fake history never does.
		let entry = 0;
		beforeEach(() => {
			entry += 1;
			historyStateRef.current = {
				...REVIEW_FROM_LIST_STATE,
				__TSR_key: `review-${entry}`,
			};
		});

		it("goes back to the list from the header's back, once", async () => {
			const user = userEvent.setup();
			render(<DiffView path="a.ts" staged={false} showBack />);

			const button = screen.getByRole("button", { name: "Back to changes" });
			await user.click(button);
			await user.click(button);
			expect(back).toHaveBeenCalledTimes(1);
			expect(navigate).not.toHaveBeenCalled();
		});

		it("goes back to the list after committing", async () => {
			const user = userEvent.setup();
			statusRef.current = {
				staged: [{ path: "b.ts", status: "M" }],
				unstaged: [],
			};
			render(<DiffView path="b.ts" staged={true} />);

			await user.click(screen.getByRole("button", { name: "Commit 1 file" }));
			await user.click(screen.getByRole("button", { name: "commit now" }));
			expect(back).toHaveBeenCalledTimes(1);
			expect(navigate).not.toHaveBeenCalled();
		});

		it("goes back to the list after discarding the last file", async () => {
			const user = userEvent.setup();
			render(<DiffView path="c.ts" staged={false} />);

			await user.click(screen.getByRole("button", { name: "Delete file" }));
			await user.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Delete",
				}),
			);
			await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
			expect(navigate).not.toHaveBeenCalled();
		});
	});

	// Staging would record the markers as the resolution, unstaging would
	// throw the conflict away, and git refuses to discard it.
	it("offers no stage, unstage or discard on a conflicted file", () => {
		statusRef.current = {
			staged: [
				{ path: "a.ts", status: "U" },
				{ path: "b.ts", status: "M" },
			],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
		};
		render(<DiffView path="a.ts" staged={false} />);

		for (const name of [/Stage/, "Unstage", "Discard file"]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
	});

	it("offers Next and Unstage on a fully staged file", async () => {
		const user = userEvent.setup();
		render(<DiffView path="b.ts" staged={true} />);

		await user.click(screen.getByRole("button", { name: "Unstage" }));
		expect(unstage).toHaveBeenCalledWith(["b.ts"]);
		expect(navigate).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(navigate).toHaveBeenCalledWith(toFile("c.ts", false));
	});

	it("unstages a rename together with its source", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [{ path: "new.ts", status: "R", orig_path: "old.ts" }],
			unstaged: [],
		};
		render(<DiffView path="new.ts" staged={true} />);

		await user.click(screen.getByRole("button", { name: "Unstage" }));
		expect(unstage).toHaveBeenCalledWith(["new.ts", "old.ts"]);
	});

	it("commits from the last staged file and ends the review", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [{ path: "b.ts", status: "M" }],
			unstaged: [],
		};
		render(<DiffView path="b.ts" staged={true} />);

		await user.click(screen.getByRole("button", { name: "Commit 1 file" }));
		await user.click(screen.getByRole("button", { name: "commit now" }));

		expect(navigate).toHaveBeenCalledWith(toList());
	});

	it("discards the side on screen after confirming, then moves on", async () => {
		const user = userEvent.setup();
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Discard file" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/Your edits to a\.ts/)).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Discard" }));

		expect(discard).toHaveBeenCalledWith(["a.ts"]);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(toFile("b.ts", true)),
		);
	});

	it("deletes an untracked last file and returns to the list", async () => {
		const user = userEvent.setup();
		render(<DiffView path="c.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Delete file" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Delete",
			}),
		);

		await waitFor(() => expect(navigate).toHaveBeenCalledWith(toList()));
	});
});

describe("DiffView sides", () => {
	it("opens a partly staged file's sides from a switch", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [{ path: "a.ts", status: "M" }],
			unstaged: [{ path: "a.ts", status: "M" }],
		};
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.getByText("Partly staged")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Discard file" })).toBeEnabled();
		await user.click(screen.getByRole("button", { name: "Staged" }));
		expect(navigate).toHaveBeenCalledWith(toFile("a.ts", true));
	});

	it("follows a partly staged file to its unstaged side once unstaged", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [{ path: "a.ts", status: "M" }],
			unstaged: [{ path: "a.ts", status: "M" }],
		};
		const { rerender } = render(<DiffView path="a.ts" staged={true} />);
		unstage.mockImplementation(async () => {
			statusRef.current = {
				staged: [],
				unstaged: [{ path: "a.ts", status: "M" }],
			};
			rerender(<DiffView path="a.ts" staged={true} />);
		});

		await user.click(screen.getByRole("button", { name: "Unstage" }));

		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(toFile("a.ts", false)),
		);
		expect(screen.queryByText("Partly staged")).toBeNull();
	});

	it("follows the route to the side that still exists", () => {
		render(<DiffView path="a.ts" staged={true} />);

		expect(diffWatch).toHaveBeenLastCalledWith(
			expect.objectContaining({ path: "a.ts", staged: false }),
		);
		expect(navigate).toHaveBeenCalledWith(toFile("a.ts", false));
	});

	// The shell moves a review on from a file discarded in the list; a status
	// that reaches this page before the router renders that move must not send
	// the reader back to what is left of the file.
	it("does not follow once the URL has moved on without it", () => {
		statusRef.current = {
			staged: [{ path: "a.ts", status: "M" }],
			unstaged: [
				{ path: "a.ts", status: "M" },
				{ path: "b.ts", status: "M" },
			],
		};
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);

		urlRef.current = "/w/unstaged/b.ts";
		statusRef.current = {
			staged: [{ path: "a.ts", status: "M" }],
			unstaged: [{ path: "b.ts", status: "M" }],
		};
		rerender(<DiffView path="a.ts" staged={false} />);

		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("DiffView when the file stops changing", () => {
	it("stays, says so, and offers the next file", async () => {
		const user = userEvent.setup();
		render(<DiffView path="0.ts" staged={false} />);

		expect(
			screen.getByText("This file no longer has changes"),
		).toBeInTheDocument();
		expect(screen.getByText("– / 3")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Discard|Unstage/ }),
		).toBeNull();
		expect(diffWatch).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: false }),
		);
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(navigate).toHaveBeenCalledWith(toFile("a.ts", false));
	});

	it("keeps a deleted file's title plain once its deletion is committed", () => {
		statusRef.current = {
			staged: [{ path: "gone.ts", status: "D" }],
			unstaged: [],
		};
		const { rerender } = render(<DiffView path="gone.ts" staged />);
		expect(screen.queryByRole("button", { name: "Open gone.ts" })).toBeNull();

		statusRef.current = { staged: [], unstaged: [] };
		rerender(<DiffView path="gone.ts" staged />);

		expect(
			screen.getByText("This file no longer has changes"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open gone.ts" })).toBeNull();
	});

	it("offers the way back once the tree is clean", async () => {
		const user = userEvent.setup();
		statusRef.current = { staged: [], unstaged: [] };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Back to changes" }));
		expect(navigate).toHaveBeenCalledWith(toList());
	});
});

describe("DiffView stage answered after the reader left", () => {
	// Back to the list mid-stage: the review is gone, so the failure goes to
	// the Changes list's banner rather than to nobody.
	it("hands a late failure to the Changes list", async () => {
		const user = userEvent.setup();
		const pending = deferred();
		stage.mockReturnValue(pending.promise);
		const { unmount } = render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Stage & next" }));
		unmount();
		pending.reject(new Error("fatal: index.lock exists"));

		await waitFor(() =>
			expect(failures()[""]).toMatchObject({ paths: ["a.ts"] }),
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	// Going on to the next file would take the reader away from wherever they
	// went meanwhile.
	it("does not navigate for a stage that succeeds after the reader left", async () => {
		const user = userEvent.setup();
		const pending = deferred();
		stage.mockReturnValue(pending.promise);
		const { unmount } = render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Stage & next" }));
		unmount();
		pending.resolve();

		await writesSettled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("keeps a failure on the review while it is on screen", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: index.lock exists"));
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Stage & next" }));

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(failures()).toEqual({});
		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("DiffView conflict view", () => {
	const textFile = (content: string) => ({
		name: "a.ts",
		type: "file",
		path: "a.ts",
		size: content.length,
		mime: "text/plain",
		content,
		encoding: "text",
	});
	const MARKED = [
		"const a = 1;",
		"<<<<<<< HEAD",
		"const b = old;",
		"=======",
		"const b = new;",
		">>>>>>> 9692fc9 (Add branch bar)",
		"",
	].join("\n");

	beforeEach(() => {
		statusRef.current = {
			staged: [
				{ path: "a.ts", status: "U" },
				{ path: "b.ts", status: "M" },
			],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
			operation: {
				kind: "merge",
				commit: { hash: "4be1f20aaaa", subject: "Bump", ref: "main" },
			},
		};
	});

	it("shows the working-tree file with its markers, not a diff", () => {
		contentsRef.current.data = textFile(MARKED);
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.getByText("<<<<<<< HEAD")).toBeInTheDocument();
		expect(screen.getByText("1 conflict")).toBeInTheDocument();
		expect(diffWatch).toHaveBeenLastCalledWith(
			expect.objectContaining({ enabled: false }),
		);
		expect(
			screen.queryByRole("button", { name: "Hide whitespace changes" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Ask agent to resolve the conflicts",
			}),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
	});

	it("goes back to the list from the last file", async () => {
		const user = userEvent.setup();
		contentsRef.current.data = textFile(MARKED);
		statusRef.current = {
			staged: [{ path: "a.ts", status: "U" }],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
		};
		render(<DiffView path="a.ts" staged={false} showBack />);

		const leave = within(
			screen.getByRole("button", { name: "Ask agent to resolve the conflicts" })
				.parentElement as HTMLElement,
		).getByRole("button", { name: "Back to changes" });
		await user.click(leave);
		expect(navigate).toHaveBeenCalledWith(toList());
	});

	it("hands the conflicts to the agent with the state at the press", async () => {
		const user = userEvent.setup();
		contentsRef.current.data = textFile(MARKED);
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(
			screen.getByRole("button", {
				name: "Ask agent to resolve the conflicts",
			}),
		);
		expect(prefill).toHaveBeenCalledWith(
			expect.stringMatching(
				/^The repository is in the middle of a merge of main into feature, stopped on conflicts in:\n- a\.ts\n/,
			),
		);
	});

	// Resolved by hand: nothing left that staging would record as a resolution.
	it("marks a file with no paired marker left resolved, and stays on it", async () => {
		const user = userEvent.setup();
		contentsRef.current.data = textFile("const b = new;\n=======\n");
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			screen.getByText(
				"No conflict markers left. The file stays conflicted until it is marked resolved.",
			),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Mark resolved" }));
		expect(resolve).toHaveBeenCalledWith(["a.ts"]);
		expect(stage).not.toHaveBeenCalled();
		await writesSettled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("does not offer Mark resolved while the file is being re-read", () => {
		contentsRef.current.data = textFile("resolved\n");
		contentsRef.current.isFetching = true;
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
	});

	// The cache can be a moment behind the disk: the agent wrote markers back.
	it("stages nothing when the re-read at the press finds markers", async () => {
		const user = userEvent.setup();
		contentsRef.current.data = textFile("resolved\n");
		contentsRef.current.onDisk = textFile(MARKED);
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Mark resolved" }));
		expect(resolve).not.toHaveBeenCalled();
	});

	// Shown plain, since they do not pair up — and still not a resolution.
	it("does not offer Mark resolved while an unpaired marker is left", () => {
		contentsRef.current.data = textFile("<<<<<<< HEAD\nx\n>>>>>>> t\n");
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
		expect(
			screen.getByText(
				"Conflict markers are left that do not pair up. Fix them in the file, or ask the agent.",
			),
		).toBeInTheDocument();
	});

	it("shows an SVG's markers as text, not a picture", () => {
		contentsRef.current.data = { ...textFile(MARKED), mime: "image/svg+xml" };
		render(<DiffView path="a.ts" staged={false} />);

		expect(screen.getByText("<<<<<<< HEAD")).toBeInTheDocument();
	});

	it("reports a failed Mark resolved on the layer", async () => {
		const user = userEvent.setup();
		resolve.mockRejectedValue(new Error("index.lock exists"));
		contentsRef.current.data = textFile("resolved\n");
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: "Mark resolved" }));
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(failures()).toEqual({});
	});

	it("shows a card, and no Mark resolved, for a file deleted on one side", async () => {
		const user = userEvent.setup();
		statusRef.current = {
			staged: [{ path: "a.ts", status: "D" }],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
		};
		contentsRef.current.data = textFile("still here\n");
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			screen.getByText("One side deleted this file and the other changed it."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Open file" }));
		expect(navigate).toHaveBeenCalledWith(
			overlayToNavigation({ type: "file", path: "a.ts" }, "", null),
		);
	});

	it("offers no Open file once both sides deleted it", () => {
		statusRef.current = {
			staged: [{ path: "a.ts", status: "D" }],
			unstaged: [{ path: "a.ts", status: "D" }],
			conflicted: ["a.ts"],
		};
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			screen.getByText("Both sides deleted this file."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
	});

	it("shows a card for a binary file", () => {
		contentsRef.current.data = {
			...textFile(""),
			size: 10,
			content: "",
			encoding: "none",
			omitted: "binary",
		};
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			screen.getByText("Binary file — the conflict cannot be shown."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
	});
});

const lines = (length: number, edits: Record<number, string> = {}) =>
	`${Array.from({ length }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;
const hunkAt = (at: number, text: string) =>
	[
		`@@ -${at - 3},7 +${at - 3},7 @@`,
		...[3, 2, 1].map((d) => ` line ${at - d}`),
		`-line ${at}`,
		`+${text}`,
		...[1, 2, 3].map((d) => ` line ${at + d}`),
	].join("\n");
/** a.ts with lines 10 and 30 changed, or only those of `at`. */
const diffOf = (at: number[], hunkIds: string[] | undefined): GitDiffData => ({
	diff: `--- a/a.ts\n+++ b/a.ts\n${at.map((n) => hunkAt(n, `edit ${n}`)).join("\n")}\n`,
	old_content: lines(40),
	new_content: lines(40, Object.fromEntries(at.map((n) => [n, `edit ${n}`]))),
	hunk_ids: hunkIds,
});

// The library measures its line-number column on a canvas, which jsdom lacks;
// and only wrapped does it draw extend rows without a laid-out table.
function withDiffLibrary() {
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
	});
}

describe("DiffView hunk staging", () => {
	withDiffLibrary();

	const stageButton = (name: string) => screen.findByRole("button", { name });
	const anyStageButton = () =>
		screen.queryByRole("button", { name: /^(Stage|Unstage) (removed )?lines/ });

	it("stages a hunk, and keeps it busy until a diff read after the write", async () => {
		const user = userEvent.setup();
		diffRef.current = {
			data: diffOf([10, 20, 30], ["h1", "h2", "h3"]),
			snapshot: 1,
		};
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);

		const first = await stageButton("Stage lines 7–13");
		expect(first).toHaveTextContent("Stage");
		await user.click(first);

		expect(stageHunk).toHaveBeenCalledWith({ path: "a.ts", hunkId: "h1" });
		await waitFor(() => expect(refreshDiff).toHaveBeenCalledOnce());
		// The write has answered; the diff on screen still has the hunk.
		await writesSettled();
		expect(first).toHaveAttribute("aria-busy", "true");
		expect(
			screen.getByRole("button", { name: "Stage lines 17–23" }),
		).not.toHaveAttribute("aria-busy");
		// And the file's own actions wait for nothing more than the write.
		expect(screen.getByRole("button", { name: "Stage & next" })).toBeEnabled();

		diffRef.current = { data: diffOf([20, 30], ["h2", "h3"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);

		expect(await stageButton("Stage lines 17–23")).not.toHaveAttribute(
			"aria-busy",
		);
		expect(
			screen.queryByRole("button", { name: "Stage lines 7–13" }),
		).toBeNull();
	});

	// A notification may have been read before the write; only a snapshot
	// asked for after it says what the write did.
	it("stays busy through a notification that still has the hunk", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);
		await user.click(await stageButton("Stage lines 7–13"));
		await writesSettled();

		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		rerender(<DiffView path="a.ts" staged={false} />);
		expect(await stageButton("Stage lines 7–13")).toHaveAttribute(
			"aria-busy",
			"true",
		);

		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);
		await waitFor(async () =>
			expect(await stageButton("Stage lines 7–13")).not.toHaveAttribute(
				"aria-busy",
			),
		);
	});

	// Two presses answered before one diff: the place goes to the hunk after
	// the second, found by ID — by index it would be the one after that.
	it("keeps the place for the hunk after the last pressed one", async () => {
		const user = userEvent.setup();
		// A bar's top is its index's hundreds, so where the page scrolled to
		// says which bar it lined up.
		const rect = vi
			.spyOn(Element.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: Element) {
				const index = this.getAttribute("data-hunk-bar");
				return { top: index === null ? 0 : Number(index) * 100 } as DOMRect;
			});
		try {
			diffRef.current = {
				data: diffOf([4, 12, 20, 28, 36], ["a", "x", "b", "y", "z"]),
				snapshot: 1,
			};
			const { container, rerender } = render(
				<DiffView path="a.ts" staged={false} />,
			);
			await user.click(await stageButton("Stage lines 1–7"));
			await user.click(await stageButton("Stage lines 17–23"));
			await writesSettled();
			const scroller = container.querySelector<HTMLElement>(".overflow-auto");
			if (!scroller) throw new Error("no scroll box");
			// jsdom lays nothing out, so it has no scroll position to keep.
			let scrollTop = 1000;
			Object.defineProperty(scroller, "scrollTop", {
				get: () => scrollTop,
				set: (value: number) => {
					scrollTop = value;
				},
			});

			diffRef.current = {
				data: diffOf([12, 28, 36], ["x", "y", "z"]),
				snapshot: 2,
			};
			rerender(<DiffView path="a.ts" staged={false} />);

			// "b" was at 200; "y" is now at 100.
			await waitFor(() => expect(scroller.scrollTop).toBe(900));
		} finally {
			rect.mockRestore();
		}
	});

	// The pressed button leaves with its hunk; a keyboard user goes on from
	// the button that took its place rather than from the top of the page.
	it("hands focus to the next hunk's button once the staged one leaves", async () => {
		const user = userEvent.setup();
		diffRef.current = {
			data: diffOf([10, 20, 30], ["h1", "h2", "h3"]),
			snapshot: 1,
		};
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);

		(await stageButton("Stage lines 7–13")).focus();
		await user.keyboard(" ");
		await waitFor(() => expect(refreshDiff).toHaveBeenCalledOnce());

		diffRef.current = { data: diffOf([20, 30], ["h2", "h3"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);

		const next = await stageButton("Stage lines 17–23");
		await waitFor(() => expect(next).toHaveFocus());
	});

	// The hunk left behind is the whole side, staged by the bottom bar, so its
	// bar has no button of its own to take the focus.
	it("hands focus to the last hunk's Select once it is the only one", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		const { rerender } = render(<DiffView path="a.ts" staged={false} />);

		(await stageButton("Stage lines 7–13")).focus();
		await user.keyboard(" ");
		await waitFor(() => expect(refreshDiff).toHaveBeenCalledOnce());

		diffRef.current = { data: diffOf([30], ["h2"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);

		const select = await screen.findByRole("button", {
			name: "Select lines 27–33",
		});
		await waitFor(() => expect(select).toHaveFocus());
		expect(anyStageButton()).toBeNull();
	});

	// Staging a side's only hunk is the bottom bar's Stage under another name.
	it("offers no hunk button when the side has a single hunk", async () => {
		diffRef.current = { data: diffOf([10], ["h1"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		expect(
			await screen.findByRole("button", { name: "Select lines 7–13" }),
		).toBeInTheDocument();
		expect(anyStageButton()).toBeNull();
	});

	it("unstages from the staged side", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10, 30], ["s1", "s2"]), snapshot: 1 };
		render(<DiffView path="b.ts" staged />);

		const staged = await stageButton("Unstage lines 7–13");
		expect(staged).toHaveTextContent("Unstage");
		await user.click(staged);

		expect(unstageHunk).toHaveBeenCalledWith({ path: "b.ts", hunkId: "s1" });
		expect(stageHunk).not.toHaveBeenCalled();
	});

	it("disables the file's actions while a hunk of it is in flight", async () => {
		const user = userEvent.setup();
		const pending = deferred();
		stageHunk.mockReturnValue(pending.promise);
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(await stageButton("Stage lines 7–13"));

		expect(screen.getByRole("button", { name: "Stage & next" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Discard file" })).toBeDisabled();
		pending.resolve();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Stage & next" }),
			).toBeEnabled(),
		);
	});

	it("says a stale hunk is stale, rereads the diff and does not retry", async () => {
		const user = userEvent.setup();
		stageHunk.mockRejectedValue(
			new JSONRPCErrorException("hunk is no longer in the diff", -32005),
		);
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(await stageButton("Stage lines 7–13"));

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent(
			"This part of the file changed before it could be staged.",
		);
		expect(
			within(banner).queryByRole("button", { name: "Details" }),
		).toBeNull();
		expect(refreshDiff).toHaveBeenCalledOnce();
		expect(stageHunk).toHaveBeenCalledOnce();
		// Nothing was written, so the button is pressable again at once.
		expect(
			screen.getByRole("button", { name: "Stage lines 7–13" }),
		).not.toHaveAttribute("aria-busy");
	});

	it("reports any other failure with git's words", async () => {
		const user = userEvent.setup();
		stageHunk.mockRejectedValue(new Error("error: patch failed"));
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(await stageButton("Stage lines 7–13"));

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent("Stage failed.");
		await user.click(within(banner).getByRole("button", { name: "Details" }));
		expect(banner).toHaveTextContent("error: patch failed");
	});

	// Staging part of a conflicted file would end its conflict unresolved, so
	// the page offers no hunk to stage, even with a diff carrying IDs at hand.
	it("draws no hunk buttons for a conflicted file", async () => {
		statusRef.current = {
			staged: [{ path: "a.ts", status: "U" }],
			unstaged: [{ path: "a.ts", status: "U" }],
			conflicted: ["a.ts"],
		};
		contentsRef.current.data = {
			name: "a.ts",
			type: "file",
			path: "a.ts",
			size: 14,
			mime: "text/plain",
			content: "<<<<<<< HEAD\n",
			encoding: "text",
		};
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		expect(await screen.findByText("<<<<<<< HEAD")).toBeInTheDocument();
		expect(anyStageButton()).toBeNull();
		expect(screen.queryByText("Lines 7–13")).toBeNull();
	});

	// The file conflicted after its diff was read: the server refuses the hunk
	// as it refuses staging the whole file, and says so in the same words.
	it("says a hunk of a file that has since conflicted was not staged", async () => {
		const user = userEvent.setup();
		stageHunk.mockRejectedValue(
			new JSONRPCErrorException(
				"can't stage a.ts: unresolved conflicts",
				-32007,
				{
					action: "stage",
					paths: ["a.ts"],
				},
			),
		);
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(await stageButton("Stage lines 7–13"));

		const banner = await screen.findByRole("alert");
		expect(banner).toHaveTextContent(
			"Nothing was staged: a.ts has unresolved conflicts.",
		);
		expect(
			within(banner).queryByRole("button", { name: "Details" }),
		).toBeNull();
	});

	// The server decides which hunks can be applied as shown; without IDs the
	// bars stay, for their range, but carry no button.
	it("draws no button where the server sent no IDs, and says why when whitespace is hidden", async () => {
		useDiffSettingsStore.setState({ hideWhitespace: true });
		diffRef.current = { data: diffOf([10, 30], undefined), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		expect(await screen.findByText("Lines 7–13")).toBeInTheDocument();
		expect(anyStageButton()).toBeNull();
		expect(
			screen.getByText("Show whitespace to stage parts of this file"),
		).toBeInTheDocument();
	});
});

describe("DiffView line selection", () => {
	withDiffLibrary();

	/** The gutter cell of a new-side line, as unified view draws it. */
	const gutter = async (line: number) => {
		await screen.findByText("Lines 7–13");
		const number = document.querySelector(
			`td.diff-line-num [data-line-new-num="${line}"]`,
		);
		const cell = number?.closest("td");
		if (!cell) throw new Error(`no gutter cell for line ${line}`);
		return cell;
	};
	const bar = () => screen.queryByRole("group", { name: "Selected lines" });
	const showFile = () => {
		diffRef.current = { data: diffOf([10], ["h1"]), snapshot: 1 };
		return render(<DiffView path="a.ts" staged={false} />);
	};

	it("selects by a click on a number, extends by Shift-click, and hands the lines to the agent", async () => {
		const user = userEvent.setup();
		showFile();

		await user.click(await gutter(10));
		expect(bar()).toHaveTextContent("Line 10");
		expect(screen.getByText("Line 10 selected")).toBeInTheDocument();

		await user.keyboard("{Shift>}");
		await user.click(await gutter(12));
		await user.keyboard("{/Shift}");
		expect(bar()).toHaveTextContent("Lines 10–12");

		await user.click(screen.getByRole("button", { name: "Ask AI to edit…" }));
		expect(prefill).toHaveBeenCalledWith(
			[
				"`a.ts`, lines 10–12 (working tree):",
				"",
				"```diff",
				"+edit 10",
				" line 11",
				" line 12",
				"```",
			].join("\n"),
		);
	});

	// The bar stays up while the composer holds the keyboard, so that code can
	// be put into the message being typed; a press that took the caret would
	// drop the keyboard instead.
	it("leaves the caret in the field being typed in, even with the review's buttons hidden", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10], ["h1"]), snapshot: 1 };
		render(
			<>
				<DiffView path="a.ts" staged={false} actionsAt="hidden" />
				<textarea aria-label="Message" />
			</>,
		);
		await user.click(await gutter(10));
		const field = screen.getByRole("textbox", { name: "Message" });
		field.focus();

		await user.click(screen.getByRole("button", { name: "Copy" }));
		await user.click(screen.getByRole("button", { name: "Ask AI to edit…" }));
		expect(prefill).toHaveBeenCalled();
		expect(field).toHaveFocus();
	});

	// Touch has no Shift: each tap moves the far end.
	it("extends by a second tap under a finger, and clears on the only line tapped again", async () => {
		const user = userEvent.setup();
		showFile();
		const tap = async (line: number) =>
			user.pointer({ keys: "[TouchA]", target: await gutter(line) });

		await tap(8);
		await tap(12);
		expect(bar()).toHaveTextContent("Lines 8–12");
		await tap(11);
		expect(bar()).toHaveTextContent("Lines 8–11");
		await tap(8);
		await tap(8);
		expect(bar()).toBeNull();
	});

	it("copies the new side's code without markers, and says when the copy failed", async () => {
		const user = userEvent.setup();
		showFile();
		await user.click(await gutter(9));
		await user.keyboard("{Shift>}");
		await user.click(await gutter(11));
		await user.keyboard("{/Shift}");

		const write = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("denied"));
		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(write).toHaveBeenCalledWith("line 9\nedit 10\nline 11");
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Copied" }));
		expect(
			await screen.findByRole("button", { name: "Copy failed" }),
		).toBeInTheDocument();
		// Still there for Ask AI to follow.
		expect(bar()).toHaveTextContent("Lines 9–11");
	});

	// The click that ends a drag lands on whatever holds both ends; it is the
	// drag's, not a click outside.
	it("selects what a mouse drag down the gutter passes over, and marks it", async () => {
		showFile();
		const from = await gutter(8);
		const to = await gutter(11);

		fireEvent.pointerDown(from, { pointerType: "mouse", button: 0 });
		fireEvent.pointerMove(await gutter(9), {
			pointerType: "mouse",
			buttons: 1,
		});
		fireEvent.pointerMove(to, { pointerType: "mouse", buttons: 1 });
		fireEvent.pointerUp(to, { pointerType: "mouse" });
		const table = to.closest("table");
		if (!table) throw new Error("no table");
		// Past the task in which the outside-click listener is attached.
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireEvent.click(table);

		expect(bar()).toHaveTextContent("Lines 8–11");
		await waitFor(async () =>
			expect(await gutter(11)).toHaveAttribute("data-line-selected"),
		);
		expect(await gutter(12)).not.toHaveAttribute("data-line-selected");
	});

	it("selects a whole hunk from its bar and moves focus to Copy", async () => {
		const user = userEvent.setup();
		showFile();

		await user.click(
			await screen.findByRole("button", { name: "Select lines 7–13" }),
		);
		expect(bar()).toHaveTextContent("Lines 7–13");
		expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
	});

	it("clears on Escape, unless something else already claimed the key", async () => {
		const user = userEvent.setup();
		showFile();
		await user.click(await gutter(10));

		const claim = (event: KeyboardEvent) => event.preventDefault();
		window.addEventListener("keydown", claim, { capture: true });
		fireEvent.keyDown(document, { key: "Escape" });
		window.removeEventListener("keydown", claim, { capture: true });
		expect(bar()).not.toBeNull();

		const allowedDefault = fireEvent.keyDown(document, { key: "Escape" });
		expect(allowedDefault).toBe(false);
		expect(bar()).toBeNull();
	});

	it("clears on a click on the code, but not on a control", async () => {
		const user = userEvent.setup();
		showFile();
		await user.click(await gutter(10));

		// Wrap is a control, and redrawing the same rows keeps them.
		await user.click(screen.getByRole("button", { name: "Don't wrap lines" }));
		expect(bar()).not.toBeNull();

		useDiffSettingsStore.setState({ gitDiffWrap: true });
		const code = (await gutter(8)).nextElementSibling;
		if (!code) throw new Error("no code cell for line 8");
		await user.click(code);
		expect(bar()).toBeNull();
	});

	it("keeps the selection through a refresh that leaves its rows alone, and says so when it goes", async () => {
		const user = userEvent.setup();
		const { rerender } = showFile();
		await user.click(await gutter(10));

		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);
		expect(bar()).toHaveTextContent("Line 10");

		diffRef.current = { data: diffOf([30], ["h2"]), snapshot: 3 };
		rerender(<DiffView path="a.ts" staged={false} />);
		await waitFor(() => expect(bar()).toBeNull());
		expect(
			screen.getByText("Selection cleared — the file changed"),
		).toBeInTheDocument();
	});

	it("clears when whitespace is hidden, since the rows may be others", async () => {
		const user = userEvent.setup();
		showFile();
		await user.click(await gutter(10));

		await user.click(
			screen.getByRole("button", { name: "Hide whitespace changes" }),
		);
		expect(bar()).toBeNull();
	});
	const cellOf = (selector: string) => {
		const cell = document.querySelector(selector)?.closest("td");
		if (!cell) throw new Error(`no cell for ${selector}`);
		return cell;
	};

	it("selects a removed line by its old number", async () => {
		const user = userEvent.setup();
		showFile();
		await gutter(10);

		await user.click(cellOf('td.diff-line-num [data-line-old-num="10"]'));
		expect(bar()).toHaveTextContent("Removed line 10");
	});

	it("runs across a collapsed gap, marking it and writing it as a count", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);

		await user.click(await gutter(12));
		await user.keyboard("{Shift>}");
		await user.click(await gutter(28));
		await user.keyboard("{/Shift}");
		expect(bar()).toHaveTextContent("Lines 12–28");
		const gaps = [...document.querySelectorAll("tr.diff-line-hunk")];
		expect(
			gaps.filter((gap) => gap.hasAttribute("data-line-selected")),
		).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: "Ask AI to edit…" }));
		expect(prefill.mock.calls[0][0]).toContain(
			"\n line 13\n… 13 unchanged lines …\n line 27\n",
		);
	});

	it("keeps a drag that came back to the line it started on", async () => {
		showFile();
		const start = await gutter(10);
		fireEvent.pointerDown(start, { pointerType: "mouse", button: 0 });
		fireEvent.pointerMove(await gutter(12), {
			pointerType: "mouse",
			buttons: 1,
		});
		fireEvent.pointerMove(start, { pointerType: "mouse", buttons: 1 });
		fireEvent.pointerUp(start, { pointerType: "mouse" });
		fireEvent.click(start);

		expect(bar()).toHaveTextContent("Line 10");
	});

	// Released outside the window, a drag gets no click of its own; the next
	// press is somebody else's and must go through.
	it("does not swallow the next click when a drag ended without one", async () => {
		const user = userEvent.setup();
		showFile();
		fireEvent.pointerDown(await gutter(8), { pointerType: "mouse", button: 0 });
		fireEvent.pointerMove(await gutter(11), {
			pointerType: "mouse",
			buttons: 1,
		});
		fireEvent.pointerUp(document.body, { pointerType: "mouse" });
		const write = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue(undefined);

		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(write).toHaveBeenCalledWith("line 8\nline 9\nedit 10\nline 11");
	});

	// Released over an iframe, the page hears no pointerup at all: the button
	// is up by the next move, and hovering must not go on selecting.
	it("ends a drag whose release the page never heard", async () => {
		showFile();
		fireEvent.pointerDown(await gutter(8), { pointerType: "mouse", button: 0 });
		fireEvent.pointerMove(await gutter(9), {
			pointerType: "mouse",
			buttons: 1,
		});
		fireEvent.pointerMove(await gutter(11), {
			pointerType: "mouse",
			buttons: 0,
		});
		fireEvent.pointerMove(await gutter(12), {
			pointerType: "mouse",
			buttons: 0,
		});

		expect(bar()).toHaveTextContent("Lines 8–9");
	});

	it("waits through a lost connection rather than saying the file changed", async () => {
		const user = userEvent.setup();
		const { rerender } = showFile();
		await user.click(await gutter(10));

		diffRef.current = { data: undefined, snapshot: 1 };
		rerender(<DiffView path="a.ts" staged={false} />);
		diffRef.current = { data: diffOf([10], ["h1"]), snapshot: 2 };
		rerender(<DiffView path="a.ts" staged={false} />);

		expect(bar()).toHaveTextContent("Line 10");
		expect(
			screen.queryByText("Selection cleared — the file changed"),
		).toBeNull();
	});

	it("puts focus back on the hunk's Select when the bar goes with it", async () => {
		const user = userEvent.setup();
		showFile();
		const select = await screen.findByRole("button", {
			name: "Select lines 7–13",
		});
		await user.click(select);
		expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();

		await user.keyboard("{Escape}");
		expect(bar()).toBeNull();
		await waitFor(() => expect(select).toHaveFocus());
	});

	// A range of unchanged lines only is in no hunk: focus goes to the bar of
	// the last hunk before it, not to the top of the file.
	it("returns focus to the nearest hunk before a selection of unchanged lines", async () => {
		const user = userEvent.setup();
		diffRef.current = { data: diffOf([10, 30], ["h1", "h2"]), snapshot: 1 };
		render(<DiffView path="a.ts" staged={false} />);
		await gutter(33);
		const gaps = document.querySelectorAll("tr.diff-line-hunk");
		await user.click(gaps[gaps.length - 1]);

		await user.click(await gutter(36));
		await user.click(screen.getByRole("button", { name: "Clear selection" }));
		expect(bar()).toBeNull();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Select lines 27–33" }),
			).toHaveFocus(),
		);
	});

	it("selects on one side in split view, by that side's numbers", async () => {
		const user = userEvent.setup();
		expandedRef.current = true;
		useDiffSettingsStore.setState({ gitDiffSplit: true });
		showFile();
		await screen.findByText("Lines 7–13");

		await user.click(cellOf('td.diff-line-old-num [data-line-num="9"]'));
		await user.keyboard("{Shift>}");
		await user.click(cellOf('td.diff-line-old-num [data-line-num="10"]'));
		await user.keyboard("{/Shift}");
		expect(bar()).toHaveTextContent("Old lines 9–10");
		expect(cellOf('td.diff-line-old-num [data-line-num="9"]')).toHaveAttribute(
			"data-line-selected",
		);
		expect(
			cellOf('td.diff-line-new-num [data-line-num="9"]'),
		).not.toHaveAttribute("data-line-selected");

		// The other side's numbers start again there.
		await user.click(cellOf('td.diff-line-new-num [data-line-num="11"]'));
		expect(bar()).toHaveTextContent("Line 11");
	});
});
