import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	gitWriteActions,
	useGitWriteStore,
	WorktreeChangedError,
} from "./gitWriteStore";
import { worktreeActions } from "./worktreeStore";

const writes = (worktree: string) =>
	useGitWriteStore.getState().writes[worktree];

/** A request the test finishes by hand, so the queue's order is observable. */
function deferred() {
	let settle!: (error?: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		settle = (error) => (error ? reject(error) : resolve());
	});
	return { promise, settle };
}

describe("gitWriteStore", () => {
	beforeEach(() => {
		gitWriteActions.reset();
		worktreeActions.reset();
	});

	// The bug this store exists for: two taps in a row used to be two overlapping
	// git writes in one worktree, racing each other for index.lock.
	it("does not start a write while another is running", async () => {
		const first = deferred();
		const firstAction = vi.fn(() => first.promise);
		const second = vi.fn(async () => {});

		const running = gitWriteActions.run("", "toggle", ["a.ts"], firstAction);
		const queued = gitWriteActions.run("", "toggle", ["b.ts"], second);

		await vi.waitFor(() => expect(firstAction).toHaveBeenCalled());
		expect(second).not.toHaveBeenCalled();

		first.settle();
		await running;
		await queued;
		expect(second).toHaveBeenCalledWith(["b.ts"]);
	});

	// A failed stage is the caller's to report; the tap queued behind it was a
	// separate thing the user asked for.
	it("runs what is queued behind a failure, and rejects only its own caller", async () => {
		const failed = gitWriteActions.run("", "toggle", ["a.ts"], async () => {
			throw new Error("index.lock");
		});
		const queued = gitWriteActions.run("", "discard", ["b.ts"], async () => {});

		await expect(failed).rejects.toThrow("index.lock");
		await expect(queued).resolves.toBeUndefined();
	});

	// Two worktrees are two repositories: neither lock nor spinner is shared.
	// A write in the tree the user has left keeps running, which is exactly why
	// the spinners are keyed — it is only an unstarted one that is dropped.
	it("queues each worktree separately", async () => {
		const feature = deferred();
		const other = vi.fn(() => feature.promise);
		const started = vi.fn(() => deferred().promise);

		gitWriteActions.run("", "toggle", ["a.ts"], started);
		await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

		worktreeActions.setCurrent("feature");
		gitWriteActions.run("feature", "toggle", ["a.ts"], other);

		await vi.waitFor(() => expect(other).toHaveBeenCalledOnce());
		expect(writes("").toggling.has("a.ts")).toBe(true);
		expect(writes("feature").toggling.has("a.ts")).toBe(true);
	});

	it("marks a path pending from the moment it is queued until it settles", async () => {
		const first = deferred();
		const running = gitWriteActions.run(
			"",
			"toggle",
			["a.ts"],
			() => first.promise,
		);
		const queued = gitWriteActions.run("", "discard", ["b.ts"], async () => {});

		expect(writes("").toggling.has("a.ts")).toBe(true);
		expect(writes("").discarding.has("b.ts")).toBe(true);

		first.settle();
		await running;
		await queued;

		expect(writes("").toggling.size).toBe(0);
		expect(writes("").discarding.size).toBe(0);
	});

	// The row is disabled while its write is pending, so this is only reachable
	// through a group action — and either way the queued request would do what
	// the running one is already doing.
	it("leaves out a path that already has a write pending", async () => {
		const first = deferred();
		const again = vi.fn(async () => {});

		const running = gitWriteActions.run(
			"",
			"toggle",
			["a.ts"],
			() => first.promise,
		);
		gitWriteActions.run("", "toggle", ["a.ts", "b.ts"], again);

		first.settle();
		await running;
		await vi.waitFor(() => expect(again).toHaveBeenCalled());
		expect(again).toHaveBeenCalledWith(["b.ts"]);
	});

	// A git write names no worktree: the server applies it to whatever the
	// connection is bound to. A queued one that ran after a switch would stage a
	// same-named path in the tree the user has just moved to.
	it("drops a queued write when the worktree changed before its turn", async () => {
		const first = deferred();
		const firstAction = vi.fn(() => first.promise);
		const queuedAction = vi.fn(async () => {});

		const running = gitWriteActions.run("", "toggle", ["a.ts"], firstAction);
		// The one already on its way is not the subject: a request the server has
		// is answered against the worktree it was sent to.
		await vi.waitFor(() => expect(firstAction).toHaveBeenCalledOnce());
		// Attached before the switch, so the rejection is never unhandled.
		const queued = gitWriteActions
			.run("", "toggle", ["b.ts"], queuedAction)
			.catch((e: unknown) => e);

		worktreeActions.setCurrent("feature");
		first.settle();
		await running;

		expect(await queued).toBeInstanceOf(WorktreeChangedError);
		expect(queuedAction).not.toHaveBeenCalled();
		// And it leaves no row spinning in the worktree it was queued for.
		expect(writes("").toggling.size).toBe(0);
	});
});
