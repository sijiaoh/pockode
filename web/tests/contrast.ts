/**
 * WCAG 2.x contrast, and the discovery of the theme variants it is applied to.
 *
 * Lives outside `src` for the same reason touchTarget.ts and sourceScan.ts do:
 * the check reads the stylesheet as text, which needs Node types the app
 * project deliberately does not have.
 */

import { declaration, styleRules } from "./css";

/** WCAG 2.x AA for normal-size text. The guarded pairs are all read as text. */
export const AA_FLOOR = 4.5;

/**
 * WCAG 2.x AA for anything that is not text — 1.4.11, non-text contrast.
 *
 * Icons, borders and focus rings owe this and not `AA_FLOOR`, which is what
 * makes "move the hue off the label and onto the border" a fix rather than a
 * relocation of the same failure.
 */
export const NON_TEXT_FLOOR = 3;

/**
 * The smallest CIELab ΔL* between neighbouring rungs of the text ladder —
 * `--th-text-muted` to `--th-text-secondary`, and that to `--th-text-primary`.
 *
 * Contrast alone cannot express what "muted" is for. Every way of raising a
 * muted colour's ratio against the page moves it towards the body text, so a
 * check that only measured contrast would wave through — and eventually invite
 * — a muted that has been pushed all the way onto secondary: green suite, and
 * the tier gone.
 *
 * 13 is not picked from the air: it is the tightest step the shipping themes
 * already hold. Ember light left the factory at 12.9, mint light at 13.2,
 * aurora light at 14.8, and all three are legible today. Rounding to 13 keeps
 * the themes that already pass from being repainted to satisfy a wider number.
 */
export const TEXT_TIER_STEP = 13;

/** A fill colour and the foreground token written to sit on it. */
export interface TokenPair {
	/** Custom property names without the leading `--`. */
	background: string;
	foreground: string;
	/**
	 * The opaque fill `background` is painted onto, when `background` is itself
	 * translucent. `--th-overlay-hover` is `rgba(…)` — a hover state is not a
	 * colour the stylesheet holds anywhere, it is one the compositor makes, and
	 * without this the pair could only be written by hard-coding the blend.
	 */
	onto?: string;
}

/**
 * The pairs a theme has to get right, checked in every variant that declares
 * them.
 *
 * A pair earns its place here by being decidable from one rule: a fill, and a
 * foreground that is read on it. `--th-user-bubble` is the reason this is a
 * list rather than one hard-coded pair: in two light themes it held the same
 * value as `--th-accent` over the same white, so it was the same failing ratio
 * under a second name, over far more area — a whole message body rather than a
 * button — and nothing was watching it.
 *
 * Two of the original assumptions have since been paid for and are worth
 * naming, because both are places a reader will expect a shortcut that is not
 * there. A foreground need not be pinned to one fill: `--th-text-muted` is worn
 * on every surface the app has, so it appears under several. And a fill need
 * not be a value the stylesheet holds: `onto` lets a translucent one name the
 * surface it is painted on, which is the only way a hover state can be written
 * here at all.
 */
export const GUARDED_PAIRS: TokenPair[] = [
	{ background: "th-accent", foreground: "th-accent-text" },
	// The hover fill keeps the button's own text colour, so it owes the same
	// floor as the resting fill and borrows the same foreground token. It is
	// listed because it moves whenever the accent does — both were rewritten
	// together in the two light themes — and only one of the two was watched.
	{ background: "th-accent-hover", foreground: "th-accent-text" },
	{ background: "th-user-bubble", foreground: "th-user-bubble-text" },
	// `--th-text-muted` is the first foreground here that no single fill owns.
	// It is body text — timestamps, paths, counts, diff hunk headers, all of it
	// `text-xs`, none of it large enough for WCAG's large-text relief — and it
	// is written on every surface the app has, so the floor it owes is the floor
	// on the *worst* of them. Guarding it against `--th-bg-primary` alone — the
	// most forgiving surface in either mode, being the one furthest from the
	// text — is how eleven variants sat below AA while looking like seven, and
	// like six to anyone counting only the ten this stylesheet holds.
	{ background: "th-bg-primary", foreground: "th-text-muted" },
	{ background: "th-bg-secondary", foreground: "th-text-muted" },
	{ background: "th-bg-tertiary", foreground: "th-text-muted" },
	// Mermaid's loading and error lines are muted, and they render inside the
	// assistant bubble. In the dark variants this is the same value as
	// `--th-bg-tertiary`; in void and mint light it is darker than it.
	{ background: "th-ai-bubble", foreground: "th-text-muted" },
	// The worst surface of all, and the one no listing of the stylesheet's own
	// colours would ever show: the collapsible headers in Chat are muted text on
	// `bg-th-bg-secondary` under `hover:bg-th-overlay-hover`. The overlay is
	// black at 6-8% in light and white at 10% in dark, so in both directions it
	// pushes the backdrop towards the text. Hover is a state a person reads in,
	// not one they are excused from.
	{
		background: "th-overlay-hover",
		foreground: "th-text-muted",
		onto: "th-bg-secondary",
	},
	// TODO: add `--th-ai-bubble` under its own `--th-ai-bubble-text`, and
	// `--th-code-bg` / `--th-code-text`. The bubble appears above only as a
	// surface muted is read on; the body text a theme actually pins to it is
	// still unwatched. Both cleared AA when the list was last surveyed, so
	// adding them costs a line each.
	//
	// The rest of the survey is deliberately not here. `--th-success` /
	// `--th-warning` / `--th-error` over `--th-bg-*` fail in every light
	// variant; adding those lines turns the suite red until someone picks new
	// colours, which is a separate piece of work with a judgement call in it —
	// the semantic colours are mostly worn by icons, where the floor may be
	// WCAG's non-text 3.0 rather than 4.5. `--th-border` against a background is
	// not a text pair at all and should not be added.
];

/** How a pair reads in a test name, distinct even when two share a fill. */
export function pairName(pair: TokenPair): string {
	const fill = pair.onto
		? `--${pair.background} on --${pair.onto}`
		: `--${pair.background}`;
	return `${fill} under --${pair.foreground}`;
}

/** One rule's values for a pair, named by the selector that declares it. */
export interface ThemeVariant {
	/** The selector as written, so a failure is greppable in the stylesheet. */
	selector: string;
	background: string;
	foreground: string;
	/** The same rule's value for `TokenPair.onto`, when the pair names one. */
	onto?: string;
}

/** sRGB 0-255 per channel. Fractional after compositing. */
export type Rgb = [number, number, number];

/**
 * Hex only, deliberately. Every theme variant is written as hex today; a
 * variant that switches to `rgb()` or a `var()` alias should fail loudly here
 * rather than be skipped, because a skipped variant is an unguarded variant.
 */
export function parseColor(value: string): Rgb | undefined {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
	if (!hex) return undefined;
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

/**
 * `rgba(r, g, b, a)` only, and deliberately so, for the same reason
 * `parseColor` takes hex only: the overlay tokens are all written this way
 * today, and a token that switches notation should fail loudly here rather than
 * be skipped — a skipped surface is an unguarded surface.
 */
export function parseAlphaColor(
	value: string,
): { color: Rgb; alpha: number } | undefined {
	const parts = /^rgba\(([^)]*)\)$/i.exec(value.trim())?.[1].split(",");
	if (parts?.length !== 4) return undefined;
	// `Number("")` is 0, so a trailing comma would otherwise read `rgba(0,0,0,)`
	// as a fully transparent overlay — which composites to the bare surface and
	// reports a hover state's ratio as the resting one. Exactly the silence this
	// parser exists to refuse.
	const [r, g, b, alpha] = parts.map((p) =>
		p.trim() === "" ? Number.NaN : Number(p),
	);
	if ([r, g, b, alpha].some(Number.isNaN)) return undefined;
	if (alpha < 0 || alpha > 1) return undefined;
	if ([r, g, b].some((c) => c < 0 || c > 255)) return undefined;
	return { color: [r, g, b], alpha };
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: Rgb): number {
	const [lr, lg, lb] = [r, g, b].map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG 2.x contrast ratio, 1 to 21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every rule in the stylesheet that declares `anchor`, with whichever of
 * `names` that same rule declares — discovered rather than listed, so a theme
 * added later is guarded without anyone remembering this file exists.
 *
 * Never from the cascade: a rule that overrode only the anchor would silently
 * be read with another theme's foreground, and resolving that properly means
 * implementing the cascade. Callers assert the set they need is complete
 * instead.
 */
export function themeRules(
	css: string,
	anchor: string,
	names: string[],
): { selector: string; values: Record<string, string | undefined> }[] {
	return styleRules(css)
		.filter((rule) => declaration(rule.body, anchor) !== undefined)
		.map((rule) => ({
			selector: rule.selector.replace(/\s+/g, " "),
			values: Object.fromEntries(
				names.map((name) => [name, declaration(rule.body, name)]),
			),
		}));
}

/**
 * Every variant in the stylesheet that declares `pair`. A rule counts as a
 * variant when it declares the pair's background; see `themeRules`.
 */
export function themeVariants(css: string, pair: TokenPair): ThemeVariant[] {
	const names = [pair.background, pair.foreground];
	if (pair.onto) names.push(pair.onto);
	return themeRules(css, pair.background, names).map(
		({ selector, values }) => ({
			selector,
			background: values[pair.background] ?? "",
			foreground: values[pair.foreground] ?? "",
			...(pair.onto ? { onto: values[pair.onto] ?? "" } : {}),
		}),
	);
}

/**
 * `over` painted on `base` at `alpha`, the arithmetic a browser does for
 * `bg-th-accent/10`: a tint is not a colour the stylesheet holds, it is one the
 * compositor makes, and the only thing text on it is ever read against.
 *
 * Channel-wise in sRGB rather than in linear light, because that is what simple
 * alpha compositing over an opaque backdrop does — the values are already in
 * the space they are blended in. Deliberately not rounded back to 8-bit: the
 * rounding is the compositor's business and dropping it here would move a ratio
 * in the third decimal for no gain in truth.
 *
 * `base` must be opaque. Two tints stacked (a chip on a tinted card) is
 * composite applied twice, which is what a caller that knows its layers does.
 */
export function composite(over: Rgb, base: Rgb, alpha: number): Rgb {
	return base.map((b, i) => over[i] * alpha + b * (1 - alpha)) as Rgb;
}

/**
 * The opaque colour a variant's background actually paints — which, for a
 * translucent token, is not a colour the stylesheet holds anywhere.
 *
 * `undefined` when either half is unreadable, so a caller reports the values it
 * was given rather than a ratio against a colour it guessed.
 */
export function backdrop(variant: ThemeVariant): Rgb | undefined {
	if (variant.onto === undefined) return parseColor(variant.background);
	const base = parseColor(variant.onto);
	const tint = parseAlphaColor(variant.background);
	return base && tint ? composite(tint.color, base, tint.alpha) : undefined;
}

/**
 * CIELab L*, 0 to 100 — perceptual lightness, which is what "one tier dimmer"
 * means and what a contrast ratio cannot say.
 *
 * Built on the WCAG luminance above because they are the same quantity: that
 * sum of linearised channels *is* CIE Y against a D65 white of 1, so anything
 * wrong with one is wrong with both and shows up in the ratios too.
 */
export function lightness(rgb: Rgb): number {
	const y = luminance(rgb);
	const d = 6 / 29;
	const f = y > d ** 3 ? Math.cbrt(y) : y / (3 * d ** 2) + 4 / 29;
	return 116 * f - 16;
}
