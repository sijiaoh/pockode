import { JSONRPCErrorException } from "json-rpc-2.0";
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

		expect(run("feature")).toMatchObject({
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

		expect(run("")).toMatchObject({ switchingTo: "main", error: null });
	});

	// The check moving and the branch name changing are the report.
	it("leaves nothing behind when a switch succeeds", async () => {
		await gitCheckoutActions.start("", "topic", async () => {});

		expect(run("")).toMatchObject({ switchingTo: null, error: null });
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

	describe("deleting a branch", () => {
		// Its confirm closes either way, so a refusal nobody sees would read as
		// a delete that happened.
		it("refuses a second delete while one is in flight, and says so", () => {
			const rpc = vi.fn(pending);

			gitCheckoutActions.startDelete("", "spike", rpc);
			gitCheckoutActions.startDelete("", "old", rpc);

			expect(rpc).toHaveBeenCalledTimes(1);
			expect(run("").deleting).toBe("spike");
			expect(run("").deleteError?.summary).toBe(
				"Could not delete old. Deleting spike is still in progress.",
			);
		});

		// The confirm awaits it, and closes either way: the failure is kept to be
		// pinned in the list, not thrown back into the dialog.
		it("resolves on failure and keeps git's words", async () => {
			await expect(
				gitCheckoutActions.startDelete("", "spike", () =>
					Promise.reject(new Error("error: cannot lock ref")),
				),
			).resolves.toBe(false);

			expect(run("")).toMatchObject({
				deleting: null,
				deleteError: {
					summary: "Could not delete spike.",
					detail: "error: cannot lock ref",
				},
			});
		});

		// The branch's detail leaves for the list on this, and only on this.
		it("resolves to whether the branch was deleted", async () => {
			await expect(
				gitCheckoutActions.startDelete("", "spike", () => Promise.resolve()),
			).resolves.toBe(true);

			const rpc = vi.fn(pending);
			gitCheckoutActions.startDelete("", "spike", rpc);
			await expect(
				gitCheckoutActions.startDelete("", "old", rpc),
			).resolves.toBe(false);
		});

		it("tells the user to look again when the branch moved", async () => {
			await gitCheckoutActions.startDelete("", "spike", () =>
				Promise.reject(new JSONRPCErrorException("changed", -32009)),
			);

			expect(run("").deleteError).toEqual({
				summary:
					"spike has changed since. Open its menu again to see what deleting it would lose.",
				detail: null,
			});
		});

		it("says when the branch is already gone", async () => {
			await gitCheckoutActions.startDelete("", "spike", () =>
				Promise.reject(
					new JSONRPCErrorException("gone", -32009, { gone: true }),
				),
			);

			expect(run("").deleteError?.summary).toBe("spike no longer exists.");
		});

		it("names where a checked-out branch is held", async () => {
			await gitCheckoutActions.startDelete("", "topic", () =>
				Promise.reject(
					new JSONRPCErrorException("checked out", -32010, {
						worktree: "review",
					}),
				),
			);
			expect(run("").deleteError).toEqual({
				summary: "Could not delete topic: it is checked out in review.",
				detail: null,
			});

			await gitCheckoutActions.startDelete("", "main", () =>
				Promise.reject(
					new JSONRPCErrorException("current", -32010, { worktree: "" }),
				),
			);
			expect(run("").deleteError?.summary).toBe(
				"Could not delete main: it is the current branch.",
			);
		});

		it("names the branch in a refusal", async () => {
			await gitCheckoutActions.startDelete("", "spike", () =>
				Promise.reject(
					new JSONRPCErrorException("busy", -32001, { operation: "fetch" }),
				),
			);

			expect(run("").deleteError).toEqual({
				summary:
					"Could not delete spike. This worktree is busy fetching. Try again once it finishes.",
				detail: null,
			});
		});

		it("keeps a switch's failure and a delete's apart", async () => {
			await gitCheckoutActions.start("", "topic", () =>
				Promise.reject(new Error("boom")),
			);
			await gitCheckoutActions.startDelete("", "spike", async () => {});

			expect(run("").error).not.toBeNull();
			expect(run("").deleteError).toBeNull();
		});
	});
});
