import { vitestRuntimeOptions } from "@pockode/shared/vitest";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import { BROWSER_TEST_FILES } from "./vitest.files";

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify("test"),
	},
	test: {
		...vitestRuntimeOptions,
		environment: "jsdom",
		setupFiles: ["./vitest.setup.ts", "./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
		exclude: [...configDefaults.exclude, BROWSER_TEST_FILES],
	},
});
