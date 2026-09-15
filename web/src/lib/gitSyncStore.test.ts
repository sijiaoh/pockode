import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions, useGitSyncStore } from "./gitSyncStore";

const run = (worktree: string) => useGitSyncStore.getState().runs[worktree];

/** An RPC that never answers, so the run stays in flight for the assertion. */
const pending = () => new Promise<string>(() => {});

describe("gitSyncStore", () => {
	beforeEach(() => {
		gitSyncActions.reset();
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
});
