import { vi } from "vitest";

/**
 * Replaces the suite's inert `IntersectionObserver` with one that reports
 * everything it is given as on screen. The global stub never reports anything,
 * so an image gated on visibility would never be read.
 */
export function reportEverythingInView(): void {
	globalThis.IntersectionObserver = class {
		callback: IntersectionObserverCallback;
		constructor(callback: IntersectionObserverCallback) {
			this.callback = callback;
		}
		observe(target: Element) {
			this.callback(
				[{ isIntersecting: true, target } as IntersectionObserverEntry],
				this as unknown as IntersectionObserver,
			);
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof globalThis.IntersectionObserver;
}

/**
 * jsdom has no object URLs. These hand out `blob:test/<n>` and record what was
 * revoked, which is what a test of an image's lifetime asserts on.
 */
export function stubObjectUrls() {
	let next = 0;
	const revoked: string[] = [];
	URL.createObjectURL = vi.fn(() => `blob:test/${++next}`);
	URL.revokeObjectURL = vi.fn((url: string) => {
		revoked.push(url);
	});
	return { revoked };
}

/** `fetch`, answering every image read with a few bytes. */
export function stubImageFetch() {
	const fetchMock = vi.fn(async () => new Response("bytes"));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}
