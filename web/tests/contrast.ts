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

/** A fill colour and the foreground token written to sit on it. */
export interface TokenPair {
	/** Custom property names without the leading `--`. */
	background: string;
	foreground: string;
}

/**
 * The pairs a theme has to get right, checked in every variant that declares
 * them.
 *
 * A pair earns its place here by being a colour and the foreground a theme
 * explicitly pins to it, so the ratio is decidable from two values in one rule.
 * `--th-user-bubble` is the reason this is a list rather than one hard-coded
 * pair: in two light themes it held the same value as `--th-accent` over the
 * same white, so it was the same failing ratio under a second name, over far
 * more area — a whole message body rather than a button — and nothing was
 * watching it.
 */
export const GUARDED_PAIRS: TokenPair[] = [
	{ background: "th-accent", foreground: "th-accent-text" },
	// The hover fill keeps the button's own text colour, so it owes the same
	// floor as the resting fill and borrows the same foreground token. It is
	// listed because it moves whenever the accent does — both were rewritten
	// together in the two light themes — and only one of the two was watched.
	{ background: "th-accent-hover", foreground: "th-accent-text" },
	{ background: "th-user-bubble", foreground: "th-user-bubble-text" },
	// TODO: add `--th-ai-bubble` / `--th-ai-bubble-text` and `--th-code-bg` /
	// `--th-code-text`. Both are this same shape and both cleared AA when the
	// list was last surveyed, so adding them costs a line each.
	//
	// The rest of the survey is deliberately not here. `--th-bg-*` under
	// `--th-text-muted` fails in most variants, and under `--th-success` /
	// `--th-warning` / `--th-error` in every light one; adding those lines turns
	// the suite red until someone picks new colours, which is a separate piece
	// of work with a judgement call in it — the semantic colours are mostly worn
	// by icons, where the floor may be WCAG's non-text 3.0 rather than 4.5.
	// `--th-border` against a background is not a text pair at all and should
	// not be added.
];

/** One rule's values for a pair, named by the selector that declares it. */
export interface ThemeVariant {
	/** The selector as written, so a failure is greppable in the stylesheet. */
	selector: string;
	background: string;
	foreground: string;
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
	return themeRules(css, pair.background, [
		pair.background,
		pair.foreground,
	]).map(({ selector, values }) => ({
		selector,
		background: values[pair.background] ?? "",
		foreground: values[pair.foreground] ?? "",
	}));
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
