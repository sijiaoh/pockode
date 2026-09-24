import { useMediaQuery } from "@pockode/shared";

/**
 * The viewport height below which the answer panel has no room left to be read.
 *
 * **This is the one place in the app where height decides anything**, and it is
 * an exception rather than a third axis — docs/responsive-ui.md says so in its
 * own words, and nothing else may read it. It is not in
 * `packages/shared/src/utils/responsive.ts` beside the width ladder for exactly
 * that reason: that module is the source for decisions every surface makes, and
 * a height gate sitting in it would read as an invitation. It is also web's
 * alone — web-cluster has no answer panel — which is the other half of the
 * shared package's admission test.
 *
 * Where the number comes from, measured on the compact tier with a coarse
 * pointer, which is the phone this exists for (each chrome row is its content
 * plus its padding plus its 1px border):
 *
 * | Row | px |
 * |---|---|
 * | session header (`h-11`) | 45 |
 * | `AttentionStrip` (`py-2` + a `text-xs` line) | 33 |
 * | session action bar (`py-1.5` + a 44px control) | 57 |
 * | `InputBar` (`py-2` + a `min-h-11` textarea) | 61 |
 *
 * That leaves the transcript `H - 196`, the card 85% of it (§3), and the card's
 * body that minus its own header (49) and footer (77) — so
 * `0.85 * (H - 196) - 126`. At `H = 540` the body is 166px: a question and two
 * options, which is the least that can be called readable. Below it the number
 * falls away fast — a 667px phone with a 300px keyboard over it lands at 19px,
 * which is the bug this answers.
 *
 * Folding the action bar and the composer away returns 118px of that same
 * budget to the transcript, so the 19px body becomes 119px.
 *
 * The number is a derivation, not a measurement: nobody has held a phone up to
 * it yet. Re-derive rather than nudge it if a chrome row's height changes.
 */
export const SHORT_VIEWPORT_MAX_HEIGHT = 540;

export const SHORT_VIEWPORT_QUERY = `(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`;

/**
 * True when the viewport is too short for the answer panel to share the screen
 * with the chrome below it.
 *
 * A media query rather than a `visualViewport` reading: `web/index.html` asks
 * for `interactive-widget=resizes-content`, so a soft keyboard shrinks the
 * layout viewport itself and this flips with it — the same event the `dvh`
 * units in this app already follow. That meta tag is load-bearing and nothing
 * about it is local, so `web/tests/heightGate.test.ts` holds it.
 */
export function useShortViewport(): boolean {
	return useMediaQuery(SHORT_VIEWPORT_QUERY);
}
