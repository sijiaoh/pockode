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

afterEach(() => {
	cleanup();
});
