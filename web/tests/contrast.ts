/**
 * WCAG 2.x contrast, and the discovery of the theme variants it is applied to.
 *
 * Lives outside `src` for the same reason touchTarget.ts and sourceScan.ts do:
 * the check reads the stylesheet as text, which needs Node types the app
 * project deliberately does not have.
 */

/** WCAG 2.x AA for normal-size text. The guarded pairs are all read as text. */
export const AA_FLOOR = 4.5;

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

/** sRGB 0-255 per channel. */
type Rgb = [number, number, number];

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

/** Comments are stripped first so a brace or a colon inside one cannot be read as code. */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The last declaration of `--name` in a rule's own body, matching the cascade,
 * and ignoring both `--color-name` and `var(--name)`.
 */
function declaration(css: string, name: string): string | undefined {
	const matches = [
		...css.matchAll(new RegExp(`(?:^|[^-\\w])--${name}\\s*:\\s*([^;}]+)`, "g")),
	];
	return matches.at(-1)?.[1].trim();
}

/** How many times `--name` is declared anywhere in the stylesheet. */
export function declarationCount(css: string, name: string): number {
	return (
		stripComments(css).match(new RegExp(`(?:^|[^-\\w])--${name}\\s*:`, "g"))
			?.length ?? 0
	);
}

/**
 * Every style rule in the stylesheet paired with its *own* declarations —
 * at-rule bodies and nested rules walked into, so a theme nested in `@media`
 * or under a parent selector is still found as itself rather than folded into
 * whatever encloses it.
 *
 * At-rules are not returned as rules of their own: `@theme inline` declares
 * `--color-th-accent: var(--th-accent)`, which is the alias layer, not a
 * variant. Statement at-rules (`@import`, `@custom-variant`) are not selectors
 * either, which is why a prelude is cut at its last `;`.
 */
function styleRules(css: string): { selector: string; body: string }[] {
	const out: { selector: string; body: string }[] = [];

	/** Nesting reads as a descendant here; `&` is the common case and stays readable. */
	const join = (parent: string | undefined, child: string) =>
		parent === undefined ? child : `${parent} ${child}`;

	/** Collects `source`'s own declarations, recursing; pushes them under `selector`. */
	const walk = (source: string, selector: string | undefined) => {
		let own = "";
		let i = 0;
		while (i < source.length) {
			const open = source.indexOf("{", i);
			if (open < 0) {
				own += source.slice(i);
				break;
			}
			let depth = 0;
			let close = open;
			for (; close < source.length; close++) {
				if (source[close] === "{") depth++;
				else if (source[close] === "}" && --depth === 0) break;
			}
			const prelude = source.slice(i, open);
			const cut = prelude.lastIndexOf(";");
			own += prelude.slice(0, cut + 1);
			const prefix = prelude.slice(cut + 1).trim();
			const body = source.slice(open + 1, close);
			// An at-rule keeps the enclosing selector: `@media` inside a theme
			// still declares that theme's tokens.
			walk(body, prefix.startsWith("@") ? selector : join(selector, prefix));
			i = close + 1;
		}
		if (selector !== undefined) out.push({ selector, body: own });
	};

	walk(stripComments(css), undefined);
	return out;
}

/**
 * Every variant in the stylesheet that declares `pair`, discovered rather than
 * listed, so a theme added later is guarded without anyone remembering to add
 * it here.
 *
 * A rule counts as a variant when it declares the pair's background. Both
 * halves are read from that same rule and never from the cascade: a rule that
 * overrode only one half would silently pair its fill with another theme's
 * foreground, and resolving that properly means implementing the cascade. The
 * test asserts the pair is complete instead.
 */
export function themeVariants(css: string, pair: TokenPair): ThemeVariant[] {
	return styleRules(css)
		.filter((rule) => declaration(rule.body, pair.background) !== undefined)
		.map((rule) => ({
			selector: rule.selector.replace(/\s+/g, " "),
			background: declaration(rule.body, pair.background) ?? "",
			foreground: declaration(rule.body, pair.foreground) ?? "",
		}));
}
