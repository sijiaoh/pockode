/**
 * Single source for every responsive decision: the width ladder and the two
 * pointer gates. See docs/responsive-ui.md for the rules these encode.
 *
 * Width decides where things go; pointer decides whether they can be reached.
 * The two axes never cross over.
 */

/**
 * The only two authorized width breakpoints, in px.
 *
 * The three tiers they separate are named by what fits, not by device:
 * `regular` (>= sm) is a mini pad or a half-screen window — still
 * single-column, just with more room to breathe than `compact`. The tiers live
 * as CSS prefixes (none / `sm:` / `lg:`); only the `expanded` boundary has a JS
 * reader, because only that one switches layout shape rather than spacing.
 *
 * px rather than Tailwind's default rem so the CSS prefixes and the matchMedia
 * queries below stay the same number under any root font size — a ladder that
 * shifts in CSS but not in JS is the split this module exists to remove.
 *
 * `web/src/index.css` and `web-cluster/src/index.css` each restate these in an
 * `@theme` block; `web/tests/responsiveTokens.test.ts` keeps both stylesheets
 * derived from here rather than merely resembling it.
 */
export const BREAKPOINTS = {
	/** compact -> regular */
	sm: 640,
	/** regular -> expanded */
	lg: 1024,
} as const;

export const MEDIA_QUERIES = {
	/** >= lg: two columns fit side by side. */
	atLeastExpanded: `(min-width: ${BREAKPOINTS.lg}px)`,

	/**
	 * Can the *primary* input device hover? Gates hover reveal.
	 * Mirrored by the `pointer-fine:` variant in `web/src/index.css`.
	 */
	finePointer: "(hover: hover) and (pointer: fine)",
	/**
	 * Could *any* attached device poke this with a finger? Gates hit-area size.
	 * Mirrored by the `pointer-coarse:` variant in `web/src/index.css`, which is
	 * where every hit-area decision is made today.
	 *
	 * Deliberately not the complement of `finePointer`: a touchscreen laptop
	 * matches both, and should get hover reveal *and* thumb-sized targets.
	 */
	anyCoarsePointer: "(any-pointer: coarse)",
	/** The primary pointer only — see `hasCoarsePointer`. */
	primaryCoarsePointer: "(pointer: coarse)",
} as const;

/**
 * True when the device's *main* input is a finger.
 *
 * Use for behaviour that follows the main input mode: Enter-to-send, keyboard
 * hints. Never for hit-area sizing — a touchscreen laptop is driven by its
 * trackpad and answers false here while still being poked by fingers; sizing is
 * the `pointer-coarse:` variant's job.
 */
export function hasCoarsePointer(): boolean {
	if (typeof window === "undefined") return true;
	return window.matchMedia(MEDIA_QUERIES.primaryCoarsePointer).matches;
}
