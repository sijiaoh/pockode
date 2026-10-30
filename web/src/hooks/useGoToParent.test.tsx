import {
	createMemoryHistory,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { entryKeyOf, historyTrailFor } from "../lib/historyTrail";
import { FRESH_VISIT_STATE } from "../lib/scrollMemory";
import { routeTree } from "../router";
import { memoryStorage } from "../test/memoryStorage";
import type { OverlayState } from "../types/overlay";
import { useGoToParent } from "./useGoToParent";

const CHAT = "/w/A/s/a1";
const CHANGES = "/w/A/git?session=a1";
const HISTORY = "/w/A/git?session=a1&segment=history";
const BRANCHES = "/w/A/git?session=a1&segment=branches";
const diff = (path: string) => `/w/A/unstaged/${path}?session=a1`;
const X = "x".repeat(40);
const Y = "y".repeat(40);
const commit = (hash: string, query = "") =>
	`/w/A/commit/${hash}?session=a1${query}`;
const commitDiff = (path: string) => `/w/A/commit/${X}/diff/${path}?session=a1`;

/**
 * A router over a memory history that has been through `visited`, oldest
 * first, with the trail watching from the first entry on — as the app's is.
 */
function setup(visited: string[]) {
	const history = createMemoryHistory({ initialEntries: [visited[0]] });
	const router = createRouter({ routeTree, history });
	historyTrailFor(history);
	for (const href of visited.slice(1)) history.push(href);
	const wrapper = ({ children }: { children: ReactNode }) => (
		// biome-ignore lint/suspicious/noExplicitAny: test router uses a memory history
		<RouterContextProvider router={router as any}>
			{children}
		</RouterContextProvider>
	);
	const { result } = renderHook(() => useGoToParent(), { wrapper });
	const up = async (overlay: OverlayState, worktree = "A") => {
		await act(async () => {
			result.current({ worktree, overlay });
			// The rewrite waits a microtask after the move, and the router's
			// navigation is asynchronous.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	const here = () => history.location.href;
	// What Back would walk through from here, nearest first.
	const behind = () => {
		const seen: string[] = [];
		while (history.canGoBack()) {
			history.back();
			seen.push(history.location.href);
		}
		return seen;
	};
	const press = (overlay: OverlayState) =>
		act(() => result.current({ worktree: "A", overlay }));
	return { history, up, press, here, behind };
}

const diffOf = (path: string): OverlayState => ({
	type: "diff",
	path,
	staged: false,
});

describe("useGoToParent", () => {
	// The report: after paging through the review, ← lands on the list, and
	// the files paged through are not on the way back.
	it("goes back to the list past every file paged through", async () => {
		const { up, here, behind } = setup([
			CHAT,
			CHANGES,
			diff("a.ts"),
			diff("b.ts"),
			diff("c.ts"),
		]);

		await up(diffOf("c.ts"));
		expect(here()).toBe(CHANGES);
		expect(behind()).toEqual([CHAT]);
	});

	// The chat's review row: no list behind the review.
	it("puts the list in place of the files when it is not behind them", async () => {
		const { up, here, behind, history } = setup([
			CHAT,
			diff("a.ts"),
			diff("b.ts"),
		]);

		await up(diffOf("b.ts"));
		expect(here()).toBe(CHANGES);
		// A page in another's place, not scrolled to where that one was.
		expect(history.location.state).toMatchObject(FRESH_VISIT_STATE);
		expect(behind()).toEqual([CHAT]);
	});

	// A link, a reload with nothing known: never past the start of the trail.
	it("replaces a deep-linked page with its parent", async () => {
		const { up, here, history } = setup([diff("a.ts"), diff("b.ts")]);

		await up(diffOf("b.ts"));
		expect(here()).toBe(CHANGES);
		expect(history.canGoBack()).toBe(false);
	});

	it("knows nothing behind an entry the trail did not see", async () => {
		const history = createMemoryHistory({
			initialEntries: [CHAT, CHANGES, diff("a.ts")],
		});
		const router = createRouter({ routeTree, history });
		historyTrailFor(history);
		const { result } = renderHook(() => useGoToParent(), {
			wrapper: ({ children }) => (
				// biome-ignore lint/suspicious/noExplicitAny: test router uses a memory history
				<RouterContextProvider router={router as any}>
					{children}
				</RouterContextProvider>
			),
		});

		await act(async () => {
			result.current({ worktree: "A", overlay: diffOf("a.ts") });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(history.location.href).toBe(CHANGES);
		// Replaced in place: the entry behind is the one it was.
		history.back();
		expect(history.location.href).toBe(CHANGES);
	});

	// Paging the commit's files, then ← three times: each lands on the
	// parent, and Back never returns to the page just left.
	it("climbs from a commit's file to the commit, the list and the chat", async () => {
		const { up, here, behind } = setup([
			CHAT,
			HISTORY,
			commit(X),
			commitDiff("a.ts"),
			commitDiff("b.ts"),
			commitDiff("c.ts"),
		]);

		await up({ type: "commit-diff", hash: X, path: "c.ts" });
		expect(here()).toBe(commit(X));
		await up({ type: "commit", hash: X });
		expect(here()).toBe(HISTORY);
		await up({ type: "git", segment: "history" });
		expect(here()).toBe(CHAT);
		expect(behind()).toEqual([]);
	});

	it("goes from a commit's version of a file to its diff, then the commit", async () => {
		const { up, here } = setup([
			HISTORY,
			commit(X),
			commitDiff("a.ts"),
			`/w/A/commit/${X}/file/a.ts?session=a1`,
		]);

		await up({ type: "commit-file", hash: X, path: "a.ts" });
		expect(here()).toBe(commitDiff("a.ts"));
		await up({ type: "commit-diff", hash: X, path: "a.ts" });
		expect(here()).toBe(commit(X));
	});

	// Up is not Back: a parent commit goes up to the list, not to its child.
	it("goes from a parent commit to the list, past the child", async () => {
		const { up, here, behind } = setup([CHAT, HISTORY, commit(X), commit(Y)]);

		await up({ type: "commit", hash: Y });
		expect(here()).toBe(HISTORY);
		expect(behind()).toEqual([CHAT]);
	});

	// The History query edited while the commit was open is written onto the
	// commit's URL; the list it goes up to is that one.
	it("lands on the list's entry with the query the commit carries", async () => {
		const { up, here, behind, history } = setup([
			CHAT,
			`${HISTORY}&q=old`,
			commit(X, "&q=new"),
		]);

		await up({
			type: "commit",
			hash: X,
			history: { scope: "current", q: "new" },
		});
		expect(here()).toBe(`${HISTORY}&q=new`);
		// Its own entry brought up to date, so the list keeps its place.
		expect(history.location.state).not.toMatchObject(FRESH_VISIT_STATE);
		expect(behind()).toEqual([CHAT]);
	});

	it("goes from a branch's commit to the branch, then the list", async () => {
		const branch = "/w/A/branch/topic?session=a1";
		const { up, here, behind } = setup([
			CHAT,
			BRANCHES,
			branch,
			commit(X, "&branch=topic"),
		]);
		const topic = { ref: "topic", remote: false };

		await up({ type: "commit", hash: X, branch: topic });
		expect(here()).toBe(branch);
		await up({ type: "branch", ...topic });
		expect(here()).toBe(BRANCHES);
		expect(behind()).toEqual([CHAT]);
	});

	// The narrow list's ← skips the segments walked through to the chat.
	it("goes from a list to the chat past the other segments", async () => {
		const { up, here, behind } = setup([CHAT, CHANGES, HISTORY, BRANCHES]);

		await up({ type: "git", segment: "branches" });
		expect(here()).toBe(CHAT);
		expect(behind()).toEqual([]);
	});

	// Another worktree's pages are not under this one's chat.
	it("goes up to the worktree's own chat after a switch", async () => {
		const { up, here, behind } = setup([CHAT, CHANGES, "/w/B/git?session=b1"]);

		await up({ type: "git", segment: "changes" }, "B");
		expect(here()).toBe("/w/B/s/b1");
		expect(behind()).toEqual([CHANGES, CHAT]);
	});

	// A double tap, or an answer for a page the reader has left: the second
	// press is from a page no longer on screen.
	it("moves nobody from a page that is not the one on screen", async () => {
		const { up, here } = setup([CHAT, CHANGES, diff("a.ts"), diff("b.ts")]);

		await up(diffOf("b.ts"));
		await up(diffOf("b.ts"));
		expect(here()).toBe(CHANGES);

		await up(diffOf("a.ts"));
		expect(here()).toBe(CHANGES);
	});

	// Without a session the chat is the worktree's home.
	it("goes back to the worktree's home from a list with no session", async () => {
		const { up, here, history } = setup(["/w/A/", "/w/A/git"]);

		await up({ type: "git", segment: "changes" });
		expect(here()).toBe("/w/A/");
		expect(history.canGoBack()).toBe(false);
		history.forward();
		expect(here()).toBe("/w/A/git");
	});

	// Another session of the worktree is still its chat; the URL is put
	// right to the one the page named.
	it("lands on the chat's entry and names the page's session", async () => {
		const { up, here } = setup([
			"/w/A/s/a0",
			"/w/A/git?session=a0",
			"/w/A/git?session=a1",
		]);

		await up({ type: "git", segment: "changes" });
		expect(here()).toBe(CHAT);
	});

	// Further back than the browser may still keep, a `go()` could do nothing:
	// the walk stops short of it, and the parent replaces the oldest page it
	// reached.
	it("walks no further back than the browser keeps", async () => {
		const files = Array.from({ length: 45 }, (_, i) => diff(`f${i}.ts`));
		const { up, here, history } = setup([CHAT, CHANGES, ...files]);

		await up(diffOf("f44.ts"));
		expect(here()).toBe(CHANGES);
		history.back();
		expect(here()).toBe(diff("f3.ts"));
	});

	// The browser dropped the entry after all: ← must not be left dead, and
	// is not pressed twice meanwhile.
	it("puts the parent in place when the move never lands", async () => {
		vi.useFakeTimers();
		try {
			const { press, here, history } = setup([CHAT, CHANGES, diff("a.ts")]);
			const go = vi.spyOn(history, "go").mockImplementation(() => {});

			press(diffOf("a.ts"));
			expect(go).toHaveBeenCalledWith(-1);
			expect(here()).toBe(diff("a.ts"));
			// A second press while the first is under way goes nowhere more.
			press(diffOf("a.ts"));
			expect(go).toHaveBeenCalledTimes(1);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(here()).toBe(CHANGES);
		} finally {
			vi.useRealTimers();
		}
	});

	// After a reload, going to an entry from before it loads the app afresh,
	// which may be slow to begin. The fallback puts the parent in place
	// meanwhile, and the rewrite is still owed to the document that arrives.
	it("keeps the rewrite for the next document when its load is slow", async () => {
		vi.useFakeTimers();
		try {
			const storage = memoryStorage();
			const before = createMemoryHistory({ initialEntries: [diff("a.ts")] });
			historyTrailFor(before, storage);
			const aKey = entryKeyOf(before.location);
			before.push(diff("b.ts"));

			const history = createMemoryHistory({
				initialEntries: [diff("a.ts"), diff("b.ts")],
			});
			Object.assign(history.location.state, {
				__TSR_key: entryKeyOf(before.location),
			});
			historyTrailFor(history, storage);
			const router = createRouter({ routeTree, history });
			const { result } = renderHook(() => useGoToParent(), {
				wrapper: ({ children }: { children: ReactNode }) => (
					// biome-ignore lint/suspicious/noExplicitAny: test router uses a memory history
					<RouterContextProvider router={router as any}>
						{children}
					</RouterContextProvider>
				),
			});
			const go = vi.spyOn(history, "go").mockImplementation(() => {});

			act(() => result.current({ worktree: "A", overlay: diffOf("b.ts") }));
			expect(go).toHaveBeenCalledWith(-1);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(history.location.href).toBe(CHANGES);

			const arrived = createMemoryHistory({ initialEntries: [diff("a.ts")] });
			Object.assign(arrived.location.state, { __TSR_key: aKey });
			historyTrailFor(arrived, storage);
			expect(arrived.location.href).toBe(CHANGES);
		} finally {
			vi.useRealTimers();
		}
	});
});
