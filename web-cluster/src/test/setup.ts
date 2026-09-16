import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Raised from testing-library's 1s default for the same reason vitest's
// `testTimeout` is raised in the shared runner config: under parallel load a
// worker can simply be waiting its turn. Kept below `testTimeout` so a missing
// element still fails with testing-library's DOM dump rather than a bare
// "test timed out".
configure({ asyncUtilTimeout: 5_000 });

// `Sheet` reads the width ladder through `useIsExpanded`, which jsdom has no
// implementation of at all. Reporting no match puts every sheet in its drawer
// form, which is the form the phone gets and so the one worth testing by
// default.
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: (query: string) => ({
		matches: false,
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
