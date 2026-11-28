import { defineConfig } from "vitest/config";
import browserConfig from "./vitest.browser.config";

/**
 * The streaming-cost benchmark (`src/bench/`), kept out of both test entries:
 * it builds a 24k-call session and takes minutes, and its numbers are read by
 * a person, not asserted. Chromium only — it throttles the CPU through the
 * DevTools protocol and reads render times through the React DevTools hook.
 *
 *   pnpm exec vitest run --config vitest.bench.config.ts
 *
 * `BENCH_CPU_THROTTLE=4` asks Chrome for a fourfold CPU throttle — a
 * direction, not a phone (docs/testing.md#the-streaming-cost-benchmark);
 * `BENCH_TURNS` and `BENCH_EVENTS` size the session and the sample;
 * `BENCH_LABEL` names the results file under `bench-results/`;
 * `BENCH_TRACE=1` adds a traced pass per case, totalling style, layout and
 * paint events — what the CPU profile shows only as `(program)`;
 * `BENCH_CSS` injects a stylesheet, to try a rule before writing it;
 * `BENCH_LONG_ONLY=1` skips the no-history pass;
 * `BENCH_PAGES` caps how many older pages the paging pass asks for (`-t
 * "pages back"` runs that pass alone);
 * `BENCH_REACT=production` runs it on React's production profiling build
 * instead of the development build every test uses.
 *
 * Spread rather than `mergeConfig`, which would append to the browser entry's
 * `include`, `setupFiles` and `instances` instead of replacing them.
 */
const test = browserConfig.test ?? {};

const production = process.env.BENCH_REACT === "production";
// Read by Vite's dependency optimizer when it bundles React, which picks its
// build by it; set here, before the optimizer runs.
if (production) process.env.NODE_ENV = "production";

export default defineConfig({
	...browserConfig,
	resolve: {
		alias: {
			...browserConfig.resolve?.alias,
			// The production build that still times each fiber, which the
			// commit profiler reads.
			...(production ? { "react-dom/client": "react-dom/profiling" } : {}),
		},
	},
	optimizeDeps: {
		...browserConfig.optimizeDeps,
		// Named up front: no test imports `react-dom/client` itself, and one
		// discovered mid-run makes Vite reload the page onto a second copy of
		// React.
		include: [production ? "react-dom/profiling" : "react-dom/client"],
	},
	// Each build bundled apart, so neither run picks up the other's React.
	cacheDir: production ? "node_modules/.vite-bench-production" : undefined,
	define: {
		...browserConfig.define,
		__BENCH__: JSON.stringify({
			cpuThrottle: Number(process.env.BENCH_CPU_THROTTLE ?? 1),
			turns: Number(process.env.BENCH_TURNS ?? 300),
			events: Number(process.env.BENCH_EVENTS ?? 60),
			label: process.env.BENCH_LABEL ?? "baseline",
			trace: process.env.BENCH_TRACE === "1",
			css: process.env.BENCH_CSS ?? "",
			longOnly: process.env.BENCH_LONG_ONLY === "1",
			pages: Number(process.env.BENCH_PAGES ?? 300),
		}),
	},
	test: {
		...test,
		include: ["src/bench/**/*.bench.tsx"],
		// The profiler's hook has to be in place before the browser setup
		// imports testing-library, which loads react-dom.
		setupFiles: ["./src/bench/setup.ts", "./src/test/browserSetup.ts"],
		testTimeout: 1_800_000,
		hookTimeout: 600_000,
		browser: {
			...test.browser,
			instances: [{ browser: "chromium" }],
			viewport: { width: 390, height: 844 },
		},
	},
});
