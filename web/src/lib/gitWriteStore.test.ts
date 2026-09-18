import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitWriteActions, useGitWriteStore } from "./gitWriteStore";

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
	it("queues each worktree separately", async () => {
		const feature = deferred();
		const other = vi.fn(() => feature.promise);

		gitWriteActions.run("", "toggle", ["a.ts"], () => deferred().promise);
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
});
