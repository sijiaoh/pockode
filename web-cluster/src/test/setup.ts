import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, inject } from "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** `WAIT_TIMEOUT_MS` in `packages/shared/vitest-runtime.js`. */
		waitTimeout: number;
	}
}

// The shared wait timeout, why it is raised and why it stays below
// `testTimeout`, are at `WAIT_TIMEOUT_MS`. Only testing-library is set here:
// nothing in this project calls `vi.waitFor`, which `web` has to wrap.
const waitTimeout = inject("waitTimeout");
// A config that does not spread `vitestRuntimeOptions` provides nothing, and an
// undefined timeout makes every testing-library wait give up at once.
if (typeof waitTimeout !== "number") {
	throw new Error(
		"waitTimeout is not provided: spread vitestRuntimeOptions from @pockode/shared/vitest into this Vitest config",
	);
}
configure({ asyncUtilTimeout: waitTimeout });

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
