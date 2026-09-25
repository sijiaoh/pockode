import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Raised from testing-library's 1s default for the same reason vitest's
// `testTimeout` is raised in the shared runner config: under parallel load a
// worker can simply be waiting its turn. Kept below `testTimeout` so a missing
// element still fails with testing-library's DOM dump rather than a bare
// "test timed out".
configure({ asyncUtilTimeout: 5_000 });

// Mock ResizeObserver for components that use it
globalThis.ResizeObserver = class ResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
};

// Mock IntersectionObserver for components that use it
globalThis.IntersectionObserver = class IntersectionObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof globalThis.IntersectionObserver;

// Mock window.matchMedia for theme detection
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: (query: string) => ({
		matches: query === "(prefers-color-scheme: dark)",
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
	}),
});

/**
 * jsdom has no layout, so its `scrollTop` setter is a no-op and every read
 * returns 0. Left alone, that makes a test blind to the one thing a scrolling
 * container does: a browser clamps what you write to `scrollHeight -
 * clientHeight`, so "scroll to the bottom" lands *at* the bottom of the content
 * as it is this frame, and content that grows afterwards leaves the view above
 * it. Without the clamp `el.scrollTop = el.scrollHeight` reads back as a
 * position past the end, "am I at the bottom?" is true forever, and follow-the-
 * tail bugs cannot be written down as tests at all.
 *
 * Reads clamp as well as writes, and keep what they clamped to: content that
 * shrinks under the view — a card collapsing below it — pulls the view up with
 * it and does not give the position back when the content grows again. A
 * browser does that at the next layout; here it happens at the next read, which
 * is the first moment anything could tell the difference.
 *
 * Global rather than per-suite because it is jsdom's gap, not one component's:
 * the same class of thing as the two observers above. Heights still have to be
 * supplied per test — see `stubScrollBox` — and an element given its own
 * `scrollTop` property shadows this and keeps whatever it had.
 */
const scrollOffsets = new WeakMap<Element, number>();
function clampScrollTop(el: HTMLElement, value: number): number {
	const max = Math.max(0, el.scrollHeight - el.clientHeight);
	const clamped = Math.min(Math.max(value, 0), max);
	scrollOffsets.set(el, clamped);
	return clamped;
}
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
	configurable: true,
	get(this: HTMLElement) {
		return clampScrollTop(this, scrollOffsets.get(this) ?? 0);
	},
	set(this: HTMLElement, value: number) {
		clampScrollTop(this, value);
	},
});

/**
 * jsdom implements `inert` as an attribute and nothing else: a button inside an
 * inert subtree still takes focus there, while a browser drops the `focus()`
 * call silently, per the spec. Left alone, every test about what a keyboard user
 * can reach under a backdrop passes on code that reaches nothing — the same
 * class of gap as the missing layout above, and global for the same reason:
 * `inert` is the app's one way of saying "covered", and it is said in more than
 * one place.
 *
 * Only the call is blocked. A browser also blurs whatever was already focused
 * when `inert` arrives; that half is not needed by anything here, and guessing
 * at it would mean watching attribute mutations.
 */
const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function focus(
	this: HTMLElement,
	options?: FocusOptions,
) {
	if (this.closest("[inert]")) return;
	nativeFocus.call(this, options);
};

afterEach(() => {
	cleanup();
});
