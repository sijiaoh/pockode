import { vitestRuntimeOptions } from "@pockode/shared/vitest";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	// The build's version, which the store compares with the cluster's at
	// `auth`; the store tests' cluster answers with the same value.
	define: {
		__APP_VERSION__: JSON.stringify("test"),
	},
	test: {
		...vitestRuntimeOptions,
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
