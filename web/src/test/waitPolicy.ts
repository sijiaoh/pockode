import { configure } from "@testing-library/react";
import { inject, vi } from "vitest";

declare module "vitest" {
	export interface ProvidedContext {
		/** `WAIT_TIMEOUT_MS` in `packages/shared/vitest-runtime.js`. */
		waitTimeout: number;
	}
}

/**
 * Puts every wait that config cannot reach under the suite's one wait timeout.
 * Imported by both setup files, so a new test gets it without asking.
 *
 * testing-library has `configure`. `vi.waitFor` and `vi.waitUntil` have no
 * setting at all — each falls back to a hard-coded 1s — so they are wrapped
 * here, on the one `vi` object every test file imports. A timeout the caller
 * writes, as a number or as `timeout`, is passed through untouched: a test that
 * means to fail fast still can.
 */
const timeout = inject("waitTimeout");
// A config that does not spread `vitestRuntimeOptions` provides nothing, and an
// undefined timeout would quietly mean each library's own 1s again.
if (typeof timeout !== "number") {
	throw new Error(
		"waitTimeout is not provided: spread vitestRuntimeOptions from @pockode/shared/vitest into this Vitest config",
	);
}

configure({ asyncUtilTimeout: timeout });

type WaitOptions = Parameters<typeof vi.waitFor>[1];

function withSuiteTimeout(options: WaitOptions): WaitOptions {
	if (typeof options === "number") return options;
	return { ...options, timeout: options?.timeout ?? timeout };
}

const { waitFor, waitUntil } = vi;
vi.waitFor = ((callback, options) =>
	waitFor(callback, withSuiteTimeout(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback, options) =>
	waitUntil(callback, withSuiteTimeout(options))) as typeof vi.waitUntil;
