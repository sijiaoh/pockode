import { vitestRuntimeOptions } from "@pockode/shared/vitest";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { BROWSER_TEST_FILES } from "./vitest.files";
import { rawPages } from "./vitest.rawPages";

/**
 * The real-browser entry: tests that need an actual layout engine — measured
 * heights, scroll offsets the browser clamps itself — which jsdom fakes or does
 * not have. Separate from `vitest.config.ts` so the jsdom suite stays fast and
 * needs no browsers installed; the two split their files by name, see
 * `vitest.files.ts`.
 *
 * WebKit runs beside Chromium because it is the closest stand-in for iOS
 * Safari, the platform this app is mostly used on.
 */
export default defineConfig({
	// rawPages: a test-only `/api/raw` so workspace pages run under the server's
	// real policy; it reads raw-contract.json, which TestRawPageContract checks
	// against server/filetransfer. Never in vite.config.ts.
	plugins: [react(), tailwindcss(), rawPages()],
	define: {
		__APP_VERSION__: JSON.stringify("test"),
	},
	test: {
		...vitestRuntimeOptions,
		include: [BROWSER_TEST_FILES],
		setupFiles: ["./src/test/browserSetup.ts"],
		browser: {
			enabled: true,
			provider: playwright(),
			// Vitest only defaults to headless under `CI`; the machines that run
			// this locally are mostly agents with no display to open a window on.
			// Watch a run with `--browser.headless=false`.
			headless: true,
			instances: [{ browser: "chromium" }, { browser: "webkit" }],
		},
	},
});
