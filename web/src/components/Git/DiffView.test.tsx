import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import { gitChangesViewActions } from "../../lib/gitChangesViewStore";
import { gitWriteActions, useGitWriteStore } from "../../lib/gitWriteStore";
import {
	overlayToNavigation,
	REVIEW_FROM_LIST_STATE,
} from "../../lib/navigation";
import type { GitStatus } from "../../types/git";
import DiffView from "./DiffView";

const navigate = vi.fn();
const stage = vi.fn();
const resolve = vi.fn();
const unstage = vi.fn();
const discard = vi.fn();
const diffWatch = vi.fn();
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
		return { data: undefined, isLoading: false };
	},
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
vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill,
		isPending: false,
		error: null,
		dismissError: () => {},
	}),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: stage },
		resolveMutation: { mutateAsync: resolve },
		unstageMutation: { mutateAsync: unstage },
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
