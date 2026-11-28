import { waitFor as waitForDom } from "@testing-library/react";
import { describe, expect, inject, it, vi } from "vitest";

// Every one of these defaults to 1s on its own, so a condition that only comes
// true past that shows whether the suite's timeout reached it. Concurrent, so
// the file costs one such wait rather than one per API.
const PAST_LIBRARY_DEFAULT_MS = 1_200;

function trueAfter(ms: number) {
	const start = performance.now();
	return () => performance.now() - start >= ms;
}

function assertTrue(check: () => boolean) {
	return () => {
		if (!check()) throw new Error("not yet");
	};
}

describe.concurrent("wait timeout policy", () => {
	it("reaches vi.waitFor", async () => {
		await vi.waitFor(assertTrue(trueAfter(PAST_LIBRARY_DEFAULT_MS)));
	});

	it("reaches vi.waitFor given only an interval", async () => {
		await vi.waitFor(assertTrue(trueAfter(PAST_LIBRARY_DEFAULT_MS)), {
			interval: 20,
		});
	});

	it("reaches vi.waitUntil", async () => {
		await vi.waitUntil(trueAfter(PAST_LIBRARY_DEFAULT_MS));
	});

	it("reaches expect.poll", async ({ expect }) => {
		await expect.poll(trueAfter(PAST_LIBRARY_DEFAULT_MS)).toBe(true);
	});

	it("reaches testing-library's waitFor", async () => {
		await waitForDom(assertTrue(trueAfter(PAST_LIBRARY_DEFAULT_MS)));
	});

	it("leaves a timeout the caller writes alone", async ({ expect }) => {
		const never = () => {
			throw new Error("never");
		};
		// Bounded by the suite's timeout rather than by 50ms: what shows the
		// written value won is giving up before the default would have, and that
		// margin survives a loaded machine.
		const start = performance.now();
		await Promise.all([
			expect(vi.waitFor(never, 50)).rejects.toThrow("never"),
			expect(vi.waitFor(never, { timeout: 50 })).rejects.toThrow("never"),
			expect(vi.waitUntil(() => false, 50)).rejects.toThrow(),
		]);
		expect(performance.now() - start).toBeLessThan(inject("waitTimeout"));
	});
});

// Not concurrent: the global `expect` is the one a test file reaches for.
it("reaches the global expect.poll", async () => {
	await expect.poll(trueAfter(PAST_LIBRARY_DEFAULT_MS)).toBe(true);
});
