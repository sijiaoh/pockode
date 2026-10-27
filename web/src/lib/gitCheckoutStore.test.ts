import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitCheckoutActions, useGitCheckoutStore } from "./gitCheckoutStore";
import { worktreeActions } from "./worktreeStore";

const run = (worktree: string) => useGitCheckoutStore.getState().runs[worktree];

/** A request that never answers, so the switch stays in flight. */
const pending = () => new Promise<void>(() => {});

describe("gitCheckoutStore", () => {
	beforeEach(() => {
		gitCheckoutActions.reset();
		worktreeActions.reset();
	});

	// The Branches segment can be left and re-entered mid-switch; coming back
	// must not let a second switch start on top of the first.
	it("refuses a second switch while one is in flight", () => {
		const rpc = vi.fn(pending);

		gitCheckoutActions.start("", "topic", rpc);
		gitCheckoutActions.start("", "main", rpc);

		expect(rpc).toHaveBeenCalledTimes(1);
		expect(run("").switchingTo).toBe("topic");
	});

	it("guards each worktree separately", () => {
		const rpc = vi.fn(pending);

		gitCheckoutActions.start("", "topic", rpc);
		gitCheckoutActions.start("feature", "topic", rpc);

		expect(rpc).toHaveBeenCalledTimes(2);
	});

	it("files a failure under the worktree the switch was started in", async () => {
		await gitCheckoutActions.start("feature", "topic", () =>
			Promise.reject(new Error("fatal: boom")),
		);

		expect(run("feature")).toEqual({
			switchingTo: null,
			error: { summary: "Could not switch to topic.", detail: "fatal: boom" },
		});
		expect(run("")).toBeUndefined();
	});

	// The next switch is a new question; the old answer stops being the one
	// on screen as soon as it is asked.
	it("puts the last failure away when the next switch starts", async () => {
		await gitCheckoutActions.start("", "topic", () =>
			Promise.reject(new Error("boom")),
		);

		gitCheckoutActions.start("", "main", pending);

		expect(run("")).toEqual({ switchingTo: "main", error: null });
	});

	// The check moving and the branch name changing are the report.
	it("leaves nothing behind when a switch succeeds", async () => {
		await gitCheckoutActions.start("", "topic", async () => {});

		expect(run("")).toEqual({ switchingTo: null, error: null });
	});

	it("dismisses a failure", async () => {
		await gitCheckoutActions.start("", "topic", () =>
			Promise.reject(new Error("boom")),
		);

		gitCheckoutActions.dismissError("");

		expect(run("").error).toBeNull();
	});

	// A failure about a repository that has gone would otherwise come back after
	// `git init`; the guard stays until its own request settles.
	it("clears failures, but not what is running, when the repository changes", async () => {
		await gitCheckoutActions.start("", "topic", () =>
			Promise.reject(new Error("boom")),
		);
		gitCheckoutActions.start("feature", "topic", pending);

		worktreeActions.setIsGitRepo(false);

		expect(run("").error).toBeNull();
		expect(run("feature").switchingTo).toBe("topic");
	});
});
