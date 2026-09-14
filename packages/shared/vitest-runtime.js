import { availableParallelism } from "node:os";

/**
 * Runner tuning shared by every frontend project's `vitest.config.ts`.
 *
 * Lives outside `src` because it needs Node types, which the browser package
 * deliberately does not have — the same reason `web/vitest.setup.ts` sits
 * outside its own `src`.
 *
 * Plain JavaScript, unlike everything else here, because a `vitest.config.ts`
 * is not part of the bundle it configures: vite bundles the config file but
 * leaves bare imports external, so node itself loads this one. Node only strips
 * types from 22.18 on, and `.node-version` pins 22.13, so a `.ts` here fails
 * the whole suite at startup on CI while passing on a newer local node. There
 * is no type syntax to lose — `erasableSyntaxOnly` already rules it out for the
 * configs that import this.
 */
export const vitestRuntimeOptions = {
	/**
	 * Vitest defaults this to `cores - 1`, which assumes the suite owns the
	 * machine. On a developer box it usually does not: several agents share it,
	 * and each jsdom worker is a fork carrying its own DOM, so the limit that
	 * bites first is memory, not CPU. Oversubscribing there does not merely slow
	 * the run down, it inverts — on an 8-core / 7 GB host with other agents
	 * working, `web`'s 99 files took 350s with 11 timeout failures at the
	 * default 7 workers and 67s with none at 4, both starting from load average
	 * ~5, and cumulative jsdom environment setup fell from 822s to 224s. Most of
	 * that 822s was workers waiting on each other, not building DOMs.
	 *
	 * A CI runner does own its machine, so the default is right there and
	 * halving would only waste it — GitHub Actions sets `CI`, and vitest reads
	 * an explicit `undefined` as "unset", so this hands the key back rather than
	 * picking a number. Verified by counting the pool's child processes on this
	 * 8-core box: `CI=true` spawns exactly three more than the local run, the
	 * gap between `cores - 1` and `cores / 2`. Compare the difference, not the
	 * raw counts — those carry a constant helper process on top of `maxWorkers`,
	 * and `pgrep` on a shared machine will also pick up other people's vitest.
	 */
	maxWorkers: process.env.CI
		? undefined
		: Math.max(1, Math.floor(availableParallelism() / 2)),

	/**
	 * Unloaded, these tests finish in milliseconds — the margin is for the
	 * scheduler delaying a worker under parallel load, not for slow tests. The
	 * failures this replaces were tests giving up at vitest's 5s default; how
	 * far past it they would have run was never measured, so this is not a
	 * figure fitted to a stall, just a generous multiple of the one bound we
	 * have — still well below anything a human would sit through.
	 */
	testTimeout: 20_000,
	hookTimeout: 20_000,
};
