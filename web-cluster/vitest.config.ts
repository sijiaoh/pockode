import { vitestRuntimeOptions } from "@pockode/shared/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		...vitestRuntimeOptions,
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
