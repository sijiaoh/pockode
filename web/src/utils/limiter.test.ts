import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("createLimiter", () => {
	it("runs at most `max` tasks at once, the newest waiting one next", async () => {
		const limiter = createLimiter(2);
		const gates = [deferred(), deferred(), deferred(), deferred()];
		const started: number[] = [];
		const runs = gates.map((gate, i) =>
			limiter.run(async () => {
				started.push(i);
				await gate.promise;
			}),
		);

		await Promise.resolve();
		expect(started).toEqual([0, 1]);

		gates[1].resolve();
		await runs[1];
		expect(started).toEqual([0, 1, 3]);

		gates[0].resolve();
		await runs[0];
		expect(started).toEqual([0, 1, 3, 2]);

		gates[2].resolve();
		gates[3].resolve();
		await Promise.all(runs);
	});

	it("frees the slot when a task fails", async () => {
		const limiter = createLimiter(1);
		await expect(
			limiter.run(() => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		await expect(limiter.run(async () => "next")).resolves.toBe("next");
	});

	it("drops a waiting task whose caller aborted, without ever running it", async () => {
		const limiter = createLimiter(1);
		const gate = deferred();
		const first = limiter.run(() => gate.promise);

		const controller = new AbortController();
		let ran = false;
		const abandoned = limiter.run(async () => {
			ran = true;
		}, controller.signal);
		controller.abort();
		await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

		const next = limiter.run(async () => "next");
		gate.resolve();
		await first;
		await expect(next).resolves.toBe("next");
		expect(ran).toBe(false);
	});
});
