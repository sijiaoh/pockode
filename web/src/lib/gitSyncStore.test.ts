import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTO_FETCH_FAILURE,
	gitSyncActions,
	useGitSyncStore,
} from "./gitSyncStore";
import { worktreeActions } from "./worktreeStore";

const run = (worktree: string) => useGitSyncStore.getState().runs[worktree];

/** An RPC that never answers, so the run stays in flight for the assertion. */
const pending = () => new Promise<string>(() => {});

describe("gitSyncStore", () => {
	beforeEach(() => {
		gitSyncActions.reset();
		worktreeActions.reset();
	});

	// The guard the sync sheet used to hold: closing the sheet reset it, and the
	// second pull it let through died on the first one's index.lock.
	it("refuses a second operation while one is in flight", () => {
		const pullRPC = vi.fn(pending);

		gitSyncActions.start("", "pull", pullRPC, () => "Pull failed.");
		gitSyncActions.start("", "pull", pullRPC, () => "Pull failed.");

		expect(pullRPC).toHaveBeenCalledTimes(1);
		expect(run("").running).toBe("pull");
	});

	// Two worktrees are two repositories; one being busy says nothing about the
	// other.
	it("guards each worktree separately", () => {
		const rpc = vi.fn(pending);

		gitSyncActions.start("", "pull", rpc, () => "Pull failed.");
		gitSyncActions.start("feature", "pull", rpc, () => "Pull failed.");

		expect(rpc).toHaveBeenCalledTimes(2);
	});

	it("keeps git's own message beside the summary when an operation fails", async () => {
		await gitSyncActions.start(
			"",
			"push",
			() => Promise.reject(new Error("stale info")),
			(detail) => `summary of: ${detail}`,
		);

		expect(run("")).toEqual({
			running: null,
			auto: false,
			outcome: {
				kind: "error",
				summary: "summary of: stale info",
				detail: "stale info",
			},
		});
	});

	// A new run answers the previous outcome's question, so the old one goes
	// before the new one can be reported.
	it("clears the previous outcome when the next operation starts", async () => {
		await gitSyncActions.start(
			"",
			"fetch",
			async () => "Fetched.",
			() => "",
		);
		expect(run("").outcome).toEqual({ kind: "success", message: "Fetched." });

		gitSyncActions.start("", "fetch", pending, () => "");

		expect(run("").outcome).toBeNull();
	});

	// A pull refused because .git was deleted can settle after worktree.changed
	// said so; the Git tab is gone by then, so the banner would first be seen
	// under the repository a later `git init` creates.
	it("drops outcomes, not running operations, when the repository comes or goes", async () => {
		worktreeActions.setIsGitRepo(true);
		await gitSyncActions.start(
			"",
			"pull",
			() => Promise.reject(new Error("not a git repository")),
			() => "Pull failed.",
		);
		gitSyncActions.start("feature", "push", pending, () => "");

		worktreeActions.setIsGitRepo(false);

		expect(run("").outcome).toBeNull();
		expect(run("feature").running).toBe("push");
	});

	describe("automatic fetch", () => {
		// "Fetched." answers a question nobody asked.
		it("leaves nothing behind when it succeeds", async () => {
			await gitSyncActions.startAutoFetch("", async () => {});

			expect(run("")).toEqual({ running: null, outcome: null, auto: true });
		});

		it("keeps git's output under a summary naming the automatic fetch", async () => {
			await gitSyncActions.startAutoFetch("", () =>
				Promise.reject(new Error("fatal: unable to access")),
			);

			expect(run("")).toEqual({
				running: null,
				auto: true,
				outcome: {
					kind: "error",
					summary: AUTO_FETCH_FAILURE,
					detail: "fatal: unable to access",
				},
			});
		});

		it("still names the automatic fetch when the server refused it", async () => {
			await gitSyncActions.startAutoFetch("", () =>
				Promise.reject(
					new JSONRPCErrorException("busy", -32001, { operation: "pull" }),
				),
			);

			expect(run("").outcome).toEqual({
				kind: "error",
				summary: `${AUTO_FETCH_FAILURE} This worktree is busy pulling. Try again once it finishes.`,
				detail: null,
			});
		});

		it("is replaced by the next run, manual or automatic", async () => {
			const fail = () => Promise.reject(new Error("offline"));
			await gitSyncActions.startAutoFetch("", fail);

			gitSyncActions.start("", "pull", pending, () => "");
			expect(run("")).toEqual({ running: "pull", outcome: null, auto: false });

			gitSyncActions.reset();
			await gitSyncActions.startAutoFetch("", fail);
			gitSyncActions.startAutoFetch("", () => new Promise(() => {}));
			expect(run("")).toEqual({ running: "fetch", outcome: null, auto: true });
		});

		it("shares the guard with manual runs", () => {
			const rpc = vi.fn(() => new Promise<void>(() => {}));
			gitSyncActions.start("", "push", pending, () => "");

			gitSyncActions.startAutoFetch("", rpc);

			expect(rpc).not.toHaveBeenCalled();
			expect(run("")).toMatchObject({ running: "push", auto: false });
		});

		// Same rule as every outcome: a later `git init` must not surface it.
		it("drops its failure when the repository comes or goes", async () => {
			worktreeActions.setIsGitRepo(true);
			await gitSyncActions.startAutoFetch("", () =>
				Promise.reject(new Error("offline")),
			);

			worktreeActions.setIsGitRepo(false);

			expect(run("").outcome).toBeNull();
		});
	});
});
