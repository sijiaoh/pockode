import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	HISTORY_SEARCH_DEBOUNCE_MS,
	isHeadCommit,
} from "../../lib/commitHistory";
import type { GitCommit, GitLogResult } from "../../types/git";
import type { HistoryQuery, OverlayState } from "../../types/overlay";
import type { CommitMenuTarget } from "./CommitActions";
import HistorySection from "./HistorySection";

interface LogState {
	pages: GitLogResult[];
	hasNextPage: boolean;
	isFetchNextPageError: boolean;
	isRefetchError?: boolean;
	isFetching: boolean;
	error: Error | null;
}

let log: LogState;
const fetchNextPage = vi.fn();
const refetch = vi.fn();
const navigate = vi.fn();
let routeOverlay: OverlayState = null;

vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({
		data: { pages: log.pages },
		isLoading: false,
		error: log.error,
		hasNextPage: log.hasNextPage,
		isFetchingNextPage: false,
		isFetching: log.isFetching,
		isFetchNextPageError: log.isFetchNextPageError,
		isRefetchError: log.isRefetchError ?? false,
		fetchNextPage,
		refetch,
	}),
}));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({
		worktree: "",
		sessionId: null,
		overlay: routeOverlay,
	}),
}));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));
// The menu is CommitActions' to test; here only which commit it is opened
// for, and what is known about it.
vi.mock("./CommitActions", () => ({
	default: ({ target }: { target: CommitMenuTarget | null }) =>
		target && (
			<div role="dialog">
				{`Menu for ${target.commit.subject}, HEAD: ${isHeadCommit(target.commit)}, in HEAD's history: ${String(target.inHeadHistory)}`}
			</div>
		),
}));

/** jsdom lays nothing out: give the list's scroller a phone's screen. */
function layOut() {
	const isScroller = (el: HTMLElement) =>
		el.classList.contains("overflow-y-auto");
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? 600 : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? 300 : 0;
		},
	);
}

function renderSection(
	history: HistoryQuery = { scope: "current" },
	activeHash: string | null = null,
) {
	const section = () => (
		<HistorySection
			history={history}
			activeHash={activeHash}
			onSelectCommit={vi.fn()}
		/>
	);
	const { rerender } = render(section());
	return { rerender: () => rerender(section()) };
}

function commit(
	hash: string,
	parents: string[],
	extra: Partial<GitCommit> = {},
) {
	return {
		hash: hash.padEnd(40, "0"),
		parents: parents.map((p) => p.padEnd(40, "0")),
		subject: `Subject ${hash}`,
		author: "sijiaoh",
		date: new Date().toISOString(),
		...extra,
	} satisfies GitCommit;
}

function page(commits: GitCommit[], extra: Partial<GitLogResult> = {}) {
	return { commits, next: null, ...extra } satisfies GitLogResult;
}

const HEAD_REFS = [
	{ name: "HEAD", type: "head" as const },
	{ name: "topic", type: "branch" as const, current: true },
];

describe("HistorySection", () => {
	beforeEach(() => {
		layOut();
		navigate.mockReset();
		routeOverlay = null;
		fetchNextPage.mockReset();
		refetch.mockReset();
		log = {
			pages: [
				page(
					[
						commit("bbb", ["aaa"], { refs: HEAD_REFS, unpushed: true }),
						commit("aaa", []),
					],
					{ default_branch: "master", unpushed_count: 1 },
				),
			],
			hasNextPage: false,
			isFetchNextPageError: false,
			isFetching: false,
			error: null,
		};
	});

	it("names each row in words, since the graph is hidden from a screen reader", () => {
		renderSection();

		expect(
			screen.getByRole("button", {
				name: "Commit bbb0000: Subject bbb. Not pushed. Branch topic.",
			}),
		).toBeInTheDocument();
	});

	it("labels the range with the repository's default branch", () => {
		renderSection();

		expect(
			screen.getByRole("button", { name: "Show: Current + master" }),
		).toBeInTheDocument();
	});

	it("switches the range from its sheet, in the URL", async () => {
		const user = userEvent.setup();
		renderSection();

		await user.click(screen.getByRole("button", { name: /^Show:/ }));
		const sheet = screen.getByRole("dialog");
		expect(
			within(sheet).getByRole("button", { name: /^Current \+ master/ }),
		).toHaveAttribute("aria-current", "true");
		await user.click(
			within(sheet).getByRole("button", { name: /^All branches/ }),
		);

		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				search: { segment: "history", scope: "all" },
			}),
		);
	});

	it("counts the range's unpushed commits, and says nothing at zero", () => {
		renderSection();
		expect(screen.getByText("↑1 unpushed")).toBeInTheDocument();
	});

	it("has no count without unpushed commits", () => {
		log.pages[0].unpushed_count = 0;
		renderSection();
		expect(screen.queryByText(/unpushed/)).not.toBeInTheDocument();
	});

	// All branches: another branch's newer commit comes first, and HEAD's
	// history is told from the rows above each commit, not from its position.
	it("opens a row's menu, knowing whether HEAD reaches the commit", async () => {
		const user = userEvent.setup();
		log.pages = [
			page([
				commit("ccc", ["aaa"], { refs: [{ name: "other", type: "branch" }] }),
				commit("bbb", ["aaa"], { refs: HEAD_REFS }),
				commit("aaa", []),
			]),
		];
		renderSection({ scope: "all" });

		await user.click(
			screen.getByRole("button", { name: "Actions for commit ccc0000" }),
		);
		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Menu for Subject ccc, HEAD: false, in HEAD's history: false",
		);

		await user.click(
			screen.getByRole("button", { name: "Actions for commit aaa0000" }),
		);
		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Menu for Subject aaa, HEAD: false, in HEAD's history: true",
		);
	});

	// A commit made while the menu is up moves HEAD off the commit it was
	// opened for, and amend is HEAD's.
	it("keeps an open menu up to date with the list", async () => {
		const user = userEvent.setup();
		const { rerender } = renderSection();
		await user.click(
			screen.getByRole("button", { name: "Actions for commit bbb0000" }),
		);
		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Menu for Subject bbb, HEAD: true",
		);

		log.pages = [
			page([
				commit("ccc", ["bbb"], { refs: HEAD_REFS }),
				commit("bbb", ["aaa"]),
				commit("aaa", []),
			]),
		];
		rerender();

		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Menu for Subject bbb, HEAD: false, in HEAD's history: true",
		);
	});

	// An amend rewrites HEAD: the commit the menu names is no longer HEAD, and
	// amending from it would amend another.
	it("stops offering a rewritten commit as HEAD", async () => {
		const user = userEvent.setup();
		const { rerender } = renderSection();
		await user.click(
			screen.getByRole("button", { name: "Actions for commit bbb0000" }),
		);

		log.pages = [
			page([commit("ddd", ["aaa"], { refs: HEAD_REFS }), commit("aaa", [])]),
		];
		rerender();

		expect(screen.getByRole("dialog")).toHaveTextContent(
			"Menu for Subject bbb, HEAD: false, in HEAD's history: undefined",
		);
	});

	// Search results are not each other's parents: nothing tells it there.
	it("leaves HEAD's history unknown in a filtered list", async () => {
		const user = userEvent.setup();
		log.pages = [page([commit("ccc", ["aaa"])])];
		renderSection({ scope: "current", q: "x" });

		await user.click(
			screen.getByRole("button", { name: "Actions for commit ccc0000" }),
		);
		expect(screen.getByRole("dialog")).toHaveTextContent(
			"in HEAD's history: undefined",
		);
	});

	it("says when a repository has no commits", () => {
		log.pages = [page([])];
		renderSection();

		expect(screen.getByText("No commits yet")).toBeInTheDocument();
	});

	it("ends at the beginning of history", () => {
		renderSection();
		expect(screen.getByText("Beginning of history")).toBeInTheDocument();
	});

	it("ends a shallow clone where the clone does", () => {
		log.pages[0].shallow = true;
		renderSection();
		expect(
			screen.getByText("Older history isn't in this clone"),
		).toBeInTheDocument();
	});

	it("asks for the next page when the end is on screen", () => {
		log.hasNextPage = true;
		renderSection();

		expect(screen.getByText("Loading older commits…")).toBeInTheDocument();
		expect(fetchNextPage).toHaveBeenCalled();
	});

	// fetchNextPage cancels whatever is in flight, and a re-read after
	// git.changed is what would be lost.
	it("waits for a re-read to finish before asking for the next page", () => {
		log.hasNextPage = true;
		log.isFetching = true;
		renderSection();

		expect(screen.getByText("Loading older commits…")).toBeInTheDocument();
		expect(fetchNextPage).not.toHaveBeenCalled();
	});

	// A cursor whose commits were garbage-collected fails the same way every
	// time; re-reading from the top takes fresh cursors.
	it("keeps the rows when the next page fails, and retries from the top", async () => {
		const user = userEvent.setup();
		log.hasNextPage = true;
		log.isFetchNextPageError = true;
		log.error = new Error("bad object");
		renderSection();

		expect(screen.getByText(/Couldn't load older commits/)).toHaveTextContent(
			"bad object",
		);
		expect(screen.getByText("Subject aaa")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("says a failed re-read rather than listing stale rows as current", async () => {
		const user = userEvent.setup();
		log.isRefetchError = true;
		log.error = new Error("git exploded");
		renderSection();

		expect(screen.getByText(/Couldn't refresh history/)).toHaveTextContent(
			"git exploded",
		);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("tells a screen reader which commit is open", () => {
		renderSection({ scope: "current" }, "aaa".padEnd(40, "0"));

		expect(
			screen.getByRole("button", { name: /^Commit aaa0000/ }),
		).toHaveAttribute("aria-current", "true");
		expect(
			screen.getByRole("button", { name: /^Commit bbb0000/ }),
		).not.toHaveAttribute("aria-current");
	});

	describe("search and file filter", () => {
		// The debounce is the code's own timer, so the test owns the clock
		// (docs/testing.md#frontend-a-debounce-is-yours-to-run-out).
		function typeSlowly(field: HTMLElement, text: string) {
			let value = "";
			for (const char of text) {
				value += char;
				fireEvent.change(field, { target: { value } });
				act(() => vi.advanceTimersByTime((HISTORY_SEARCH_DEBOUNCE_MS * 2) / 3));
			}
		}

		it("searches commit messages from the header, writing the URL with replace once typing settles", () => {
			vi.useFakeTimers();
			try {
				renderSection();

				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				const field = screen.getByRole("searchbox", {
					name: "Search commit messages",
				});
				expect(field).toHaveFocus();
				typeSlowly(field, "lane");
				expect(navigate).not.toHaveBeenCalled();
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));

				expect(navigate).toHaveBeenCalledTimes(1);
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						search: { segment: "history", q: "lane" },
						replace: true,
					}),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("takes a field of only spaces for no search", () => {
			vi.useFakeTimers();
			try {
				renderSection();

				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				typeSlowly(screen.getByRole("searchbox"), "  ");
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));

				expect(navigate).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		// A row pressed before the search settled: the write lands on the
		// commit's page, rather than replacing it with the list.
		it("settles a search onto the commit opened meanwhile", () => {
			vi.useFakeTimers();
			try {
				const props = { activeHash: null, onSelectCommit: vi.fn() };
				const { rerender } = render(
					<HistorySection history={{ scope: "current" }} {...props} />,
				);
				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				fireEvent.change(screen.getByRole("searchbox"), {
					target: { value: "lane" },
				});
				routeOverlay = { type: "commit", hash: "a".repeat(40) };
				rerender(<HistorySection history={{ scope: "current" }} {...props} />);
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));

				expect(navigate).toHaveBeenCalledTimes(1);
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						to: "/commit/$",
						params: { _splat: "a".repeat(40) },
						search: { q: "lane" },
						replace: true,
					}),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a character typed while the last search was landing", () => {
			vi.useFakeTimers();
			try {
				const props = { activeHash: null, onSelectCommit: vi.fn() };
				const { rerender } = render(
					<HistorySection history={{ scope: "current" }} {...props} />,
				);
				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				const field = screen.getByRole("searchbox");
				fireEvent.change(field, { target: { value: "ab" } });
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));
				fireEvent.change(field, { target: { value: "abc" } });
				rerender(
					<HistorySection history={{ scope: "current", q: "ab" }} {...props} />,
				);

				expect(field).toHaveValue("abc");
			} finally {
				vi.useRealTimers();
			}
		});

		it("puts the cursor back in a search row already open", async () => {
			const user = userEvent.setup();
			renderSection({ scope: "current", q: "lane" });

			await user.click(
				screen.getByRole("button", { name: "Search commit messages" }),
			);
			expect(screen.getByRole("searchbox")).toHaveFocus();
		});

		it("closes the search on Escape, claiming the key, and hands focus back", async () => {
			const user = userEvent.setup();
			const below = vi.fn();
			document.addEventListener("keydown", below);
			try {
				renderSection({ scope: "current", q: "lane" });

				await user.click(screen.getByRole("searchbox"));
				await user.keyboard("{Escape}");

				expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						search: { segment: "history" },
						replace: true,
					}),
				);
				expect(below).not.toHaveBeenCalled();
				expect(
					screen.getByRole("button", { name: "Search commit messages" }),
				).toHaveFocus();
			} finally {
				document.removeEventListener("keydown", below);
			}
		});

		// Mid-composition Escape cancels the composition, not the search — and
		// is still claimed, so nothing below closes on it either.
		it("leaves Escape to an IME composition", () => {
			const below = vi.fn();
			document.addEventListener("keydown", below);
			try {
				renderSection({ scope: "current", q: "lane" });

				fireEvent.keyDown(screen.getByRole("searchbox"), {
					key: "Escape",
					isComposing: true,
					keyCode: 229,
				});

				expect(screen.getByRole("searchbox")).toHaveValue("lane");
				expect(navigate).not.toHaveBeenCalled();
				expect(below).not.toHaveBeenCalled();
			} finally {
				document.removeEventListener("keydown", below);
			}
		});

		it("cancels a search whose write has not landed yet", () => {
			vi.useFakeTimers();
			try {
				renderSection();
				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				fireEvent.change(screen.getByRole("searchbox"), {
					target: { value: "lane" },
				});
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));
				navigate.mockClear();

				// The URL still has no `q`: the write above is on its way.
				fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						search: { segment: "history" },
						replace: true,
					}),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("applies the same search typed again right after Cancel", () => {
			vi.useFakeTimers();
			try {
				const props = { activeHash: null, onSelectCommit: vi.fn() };
				const { rerender } = render(
					<HistorySection
						history={{ scope: "current", q: "lane" }}
						{...props}
					/>,
				);
				fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
				rerender(<HistorySection history={{ scope: "current" }} {...props} />);
				navigate.mockClear();

				fireEvent.click(
					screen.getByRole("button", { name: "Search commit messages" }),
				);
				fireEvent.change(screen.getByRole("searchbox"), {
					target: { value: "lane" },
				});
				act(() => vi.advanceTimersByTime(HISTORY_SEARCH_DEBOUNCE_MS));

				expect(navigate).toHaveBeenCalledWith(
					expect.objectContaining({
						search: { segment: "history", q: "lane" },
						replace: true,
					}),
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("closes the search row when the URL drops the search", () => {
			const props = { activeHash: null, onSelectCommit: vi.fn() };
			const { rerender } = render(
				<HistorySection history={{ scope: "current", q: "lane" }} {...props} />,
			);
			// History of this file, from a page opened over this search.
			rerender(
				<HistorySection
					history={{ scope: "current", file: "src/a.ts" }}
					{...props}
				/>,
			);

			expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		});

		it("changes the range under a commit open beside the list, keeping it open", async () => {
			const user = userEvent.setup();
			routeOverlay = { type: "commit", hash: "a".repeat(40) };
			renderSection();

			await user.click(screen.getByRole("button", { name: /^Show:/ }));
			await user.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: /^All branches/,
				}),
			);

			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({
					to: "/commit/$",
					params: { _splat: "a".repeat(40) },
					search: { scope: "all" },
				}),
			);
		});

		it("opens the search row with the text of a URL that carries one", () => {
			renderSection({ scope: "current", q: "lane" });

			expect(screen.getByRole("searchbox")).toHaveValue("lane");
			expect(screen.getByRole("searchbox")).not.toHaveFocus();
		});

		it("puts a search typed elsewhere into the field", () => {
			const { rerender } = render(
				<HistorySection
					history={{ scope: "current", q: "lane" }}
					activeHash={null}
					onSelectCommit={vi.fn()}
				/>,
			);
			rerender(
				<HistorySection
					history={{ scope: "current", q: "fold" }}
					activeHash={null}
					onSelectCommit={vi.fn()}
				/>,
			);

			expect(screen.getByRole("searchbox")).toHaveValue("fold");
		});

		it("drops the search and closes the row on Cancel", async () => {
			const user = userEvent.setup();
			renderSection({ scope: "all", q: "lane" });

			await user.click(screen.getByRole("button", { name: "Cancel" }));

			expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({
					search: { segment: "history", scope: "all" },
					replace: true,
				}),
			);
		});

		it("draws no graph while searching, and says why", () => {
			renderSection({ scope: "current", q: "lane" });

			expect(
				screen.getByText(/^No graph while searching — /),
			).toBeInTheDocument();
			// It counts the range, not the matches.
			expect(screen.queryByText(/unpushed/)).not.toBeInTheDocument();
			expect(screen.getByText("No more matches")).toBeInTheDocument();
		});

		it("shows the file filter as a chip that clears it with a push", async () => {
			const user = userEvent.setup();
			renderSection({ scope: "current", file: "web/src/App.tsx" });

			expect(screen.getByText("web/src/App.tsx")).toBeInTheDocument();
			expect(
				screen.getByText(/^No graph while filtering — /),
			).toBeInTheDocument();
			// No search row of its own: the file filter is reached from a file.
			expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

			await user.click(
				screen.getByRole("button", { name: "Clear file filter" }),
			);
			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({ search: { segment: "history" } }),
			);
			expect(navigate).not.toHaveBeenCalledWith(
				expect.objectContaining({ replace: true }),
			);
		});

		it("says both when searching within a file's history", () => {
			renderSection({ scope: "current", q: "lane", file: "a.ts" });

			expect(
				screen.getByText(/^No graph while searching and filtering — /),
			).toBeInTheDocument();
		});

		it("offers all branches when nothing matches", async () => {
			const user = userEvent.setup();
			log.pages = [page([])];
			renderSection({ scope: "current", q: "lane", file: "src/a.ts" });

			expect(
				screen.getByText('No commits changed a.ts matching "lane"'),
			).toBeInTheDocument();
			await user.click(
				screen.getByRole("button", { name: "Look in all branches" }),
			);
			expect(navigate).toHaveBeenCalledWith(
				expect.objectContaining({
					search: {
						segment: "history",
						scope: "all",
						q: "lane",
						file: "src/a.ts",
					},
				}),
			);
		});

		it("has nowhere wider to look in all branches", () => {
			log.pages = [page([])];
			renderSection({ scope: "all", file: "src/a.ts" });

			expect(screen.getByText("No commits changed a.ts")).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Look in all branches" }),
			).not.toBeInTheDocument();
		});
	});
});
