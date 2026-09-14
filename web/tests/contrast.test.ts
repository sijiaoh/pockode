import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AA_FLOOR,
	composite,
	contrastRatio,
	GUARDED_PAIRS,
	parseColor,
	type TokenPair,
	themeVariants,
} from "./contrast";
import { declarationCount } from "./css";
import { STYLESHEETS } from "./sourceScan";

// A theme pins a fill colour and the foreground that sits on it — `--th-accent`
// under `--th-accent-text`, `--th-user-bubble` under `--th-user-bubble-text` —
// and both are read as text, so both owe WCAG AA. The ratio is arithmetic over
// two values sitting in the stylesheet, which makes it the kind of thing a test
// should catch rather than the next person reviewing a colour by eye: two light
// variants, one of them the default theme in the mode a first-run user most
// likely lands in, sat below the floor through several reviews — and did it
// twice over, because the bubble held the same value as the accent and nobody
// had looked at it under its second name.
//
// Both the variants and the stylesheets are discovered, not listed here, so a
// theme added later is guarded without anyone remembering this file exists. A
// list gone stale would stay green while an unguarded variant shipped. The
// pairs themselves are the one list, in contrast.ts, because there is no way to
// tell from the stylesheet alone which foreground token belongs to which fill.
//
// Lives outside `src` for the same reason responsiveTokens.test.ts does:
// reading the stylesheet as text needs Node types the app project deliberately
// does not have. Paths resolve from the project vitest runs in.

function read(path: string): string {
	return readFileSync(resolve(process.cwd(), path), "utf8");
}

const CASES = Object.entries(STYLESHEETS).flatMap(([name, path]) =>
	GUARDED_PAIRS.map(
		(pair) => [`${name} --${pair.background}`, path, pair] as const,
	),
);

describe("guarded pairs", () => {
	// Every table in this file is generated from this list, and vitest registers
	// no tests at all for an empty `each`, so an emptied list disables the whole
	// guard without turning anything red.
	it("is not empty", () => {
		expect(
			GUARDED_PAIRS.length,
			"GUARDED_PAIRS is empty, so every table below is empty and this file guards nothing",
		).toBeGreaterThan(0);
	});

	// A pair whose tokens were renamed or misspelled finds nothing in any
	// stylesheet, and a per-stylesheet check cannot tell that from a pair a
	// stylesheet legitimately does not use — web-cluster has no chat bubbles.
	it.each(
		GUARDED_PAIRS.map((pair) => [pair.background, pair] as const),
	)("%s is declared by some stylesheet", (_name, pair) => {
		const found = Object.values(STYLESHEETS).map(
			(path) => themeVariants(read(path), pair).length,
		);
		expect(
			Math.max(...found),
			`no stylesheet declares --${pair.background}: renamed, removed, or misspelled in GUARDED_PAIRS`,
		).toBeGreaterThan(0);
	});
});

describe.each(CASES)("%s contrast", (_name, path, pair: TokenPair) => {
	const css = read(path);
	const variants = themeVariants(css, pair);

	// Discovery failing open is the one way this file passes while proving
	// nothing — `it.each` over an empty table registers no tests at all and
	// vitest reports green — so the rule walk is cross-checked against a plain
	// text count of the declarations. A variant written in a shape the walk
	// misreads fails here instead of quietly dropping out of the table below.
	it("finds every variant that declares the pair", () => {
		const mismatch =
			"either a variant the rule walk did not find, or one rule declaring the token twice";
		expect(variants.length, mismatch).toBe(
			declarationCount(css, pair.background),
		);
		expect(variants.length, mismatch).toBe(
			declarationCount(css, pair.foreground),
		);
	});

	it.each(
		variants.map((v) => [v.selector, v] as const),
	)("%s clears AA", (selector, variant) => {
		const background = parseColor(variant.background);
		const foreground = parseColor(variant.foreground);
		// Both halves declared by the same rule, both readable: the ratio
		// cannot be computed otherwise, and a variant whose ratio cannot be
		// computed is not a variant that passed.
		expect(
			background,
			`${selector}: --${pair.background} is "${variant.background}", not a hex colour`,
		).toBeDefined();
		expect(
			foreground,
			`${selector}: --${pair.foreground} is "${variant.foreground}", not a hex colour`,
		).toBeDefined();
		if (!background || !foreground) return;

		const ratio = contrastRatio(background, foreground);
		expect(
			ratio,
			`${selector}: --${pair.background} ${variant.background} on --${pair.foreground} ${variant.foreground} ` +
				`is ${ratio.toFixed(2)}:1, short of ${AA_FLOOR}:1 by ${(AA_FLOOR - ratio).toFixed(2)}`,
		).toBeGreaterThanOrEqual(AA_FLOOR);
	});
});

// The assertions above are only worth their green as far as three things hold:
// that the walk finds a variant wherever one can be written, that the formula
// produces real WCAG numbers, and that the floor is still WCAG's. A luminance
// formula returning 21 for everything, or a floor edited down to fit the value
// that failed, would pass every variant above in silence.
describe("variant discovery", () => {
	const css = `
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
@theme inline { --color-th-accent: var(--th-accent); --color-th-accent-text: var(--th-accent-text); }
/* a comment holding a stray brace { and --th-accent: #000000; */
:root, .theme-a { --th-accent-hover: #111111; --th-accent: #0d9488; --th-accent-text: #ffffff; }
@media (prefers-contrast: more) { .theme-b { --th-accent: #000000; --th-accent-text: #ffffff; } }
.theme-c { color: red; &.dark { --th-accent: #ffffff; --th-accent-text: #000000; } }
`;
	// Its own pair, not GUARDED_PAIRS: this is testing the walk, not the policy.
	const accent = { background: "th-accent", foreground: "th-accent-text" };
	const variants = themeVariants(css, accent);

	it("finds variants behind at-rules and nesting, and nothing else", () => {
		expect(variants.map((v) => v.selector)).toEqual([
			":root, .theme-a",
			".theme-b",
			".theme-c &.dark",
		]);
		expect(variants[0]).toMatchObject({
			background: "#0d9488",
			foreground: "#ffffff",
		});
	});

	it("reads the last declaration, as the cascade does", () => {
		const twice = themeVariants(
			".theme-x { --th-accent: #aaaaaa; --th-accent: #000000; --th-accent-text: #ffffff; }",
			accent,
		);
		expect(twice[0]?.background).toBe("#000000");
	});

	it("counts declarations without counting aliases or comments", () => {
		expect(declarationCount(css, "th-accent")).toBe(variants.length);
		expect(declarationCount(css, "th-accent-text")).toBe(variants.length);
	});

	// A token that is a prefix of another — `--th-user-bubble` of
	// `--th-user-bubble-text` — is the shape that makes a pair read its own
	// foreground as its fill, which would report a flawless 1:1.
	it("does not confuse a token with one that extends its name", () => {
		const bubble = { background: "th-a", foreground: "th-a-text" };
		const nested = ".theme-y { --th-a-text: #ffffff; --th-a: #000000; }";
		expect(themeVariants(nested, bubble)).toEqual([
			{ selector: ".theme-y", background: "#000000", foreground: "#ffffff" },
		]);
		expect(declarationCount(nested, "th-a")).toBe(1);
		expect(declarationCount(nested, "th-a-text")).toBe(1);
	});
});

describe("contrast", () => {
	const ratio = (a: string, b: string) => {
		const [x, y] = [parseColor(a), parseColor(b)];
		if (!x || !y) throw new Error(`unparsed: ${a} ${b}`);
		return Number(contrastRatio(x, y).toFixed(2));
	};

	it("refuses a colour it cannot evaluate rather than passing it", () => {
		expect(parseColor("rgb(1 2 3)")).toBeUndefined();
		expect(parseColor("var(--th-accent)")).toBeUndefined();
		expect(parseColor("#0d948880")).toBeUndefined();
		expect(parseColor("#08f")).toEqual([0, 136, 255]);
	});

	// 4.5:1 is WCAG's number for normal-size text, not this project's preference,
	// so it is not a knob. Lowering it is the one edit that turns every failure
	// in this file green at once, and it looks like a fix while being the
	// opposite of one.
	it("holds the floor at what WCAG asks for", () => {
		expect(
			AA_FLOOR,
			"AA_FLOOR is WCAG AA for normal text; a variant that cannot meet it needs a new colour, not a lower floor",
		).toBe(4.5);
	});

	// Black on white is WCAG's own 21:1 anchor; the rest are the values measured
	// by hand when the two failing variants were found, so a rewrite of the
	// formula has to reproduce them.
	it("reproduces known WCAG ratios", () => {
		expect(ratio("#ffffff", "#000000")).toBe(21);
		expect(ratio("#ffffff", "#ffffff")).toBe(1);
		expect(ratio("#0d9488", "#ffffff")).toBe(3.74);
		expect(ratio("#0891b2", "#ffffff")).toBe(3.68);
		expect(ratio("#2dd4bf", "#042f2e")).toBe(7.77);
		expect(ratio("#fb923c", "#1c1412")).toBe(8.01);
		expect(ratio("#fafafa", "#09090b")).toBe(19.06);
	});

	it("does not depend on the order of the pair", () => {
		expect(ratio("#0d9488", "#ffffff")).toBe(ratio("#ffffff", "#0d9488"));
	});
});

// The arithmetic tint.test.ts rests on. Every ratio it computes is against a
// colour that exists nowhere in the stylesheet, so an error here would not look
// like an error anywhere — it would look like a chip that passes.
describe("composite", () => {
	const over = parseColor("#0d9488");
	const base = parseColor("#ffffff");
	if (!over || !base) throw new Error("unparsed fixture");

	it("is the base at no opacity and the fill at full", () => {
		expect(composite(over, base, 0)).toEqual(base);
		expect(composite(over, base, 1)).toEqual(over);
	});

	it("halves the distance at half opacity", () => {
		const white = [255, 255, 255] as const;
		const black = [0, 0, 0] as const;
		expect(composite([...black], [...white], 0.5)).toEqual([
			127.5, 127.5, 127.5,
		]);
	});

	// A tint of a colour on itself is that colour, whatever the alpha. The one
	// property that has to hold for the compositing to be per-channel at all.
	// Approximately, because the mix is left unrounded on purpose: `13 * 0.1 +
	// 13 * 0.9` is not 13 in binary floating point, and a ratio does not care.
	it("leaves a fill painted on its own colour alone", () => {
		for (const [i, channel] of composite(over, over, 0.1).entries())
			expect(channel).toBeCloseTo(over[i]);
	});

	// The direction that matters: a tint is always closer to its backdrop than
	// the full-strength fill is, which is exactly why `text-th-accent` on an
	// accent tint reads worse than on the accent itself.
	it("moves a tint towards the backdrop it sits on", () => {
		const tint = composite(over, base, 0.1);
		expect(contrastRatio(tint, base)).toBeLessThan(contrastRatio(over, base));
	});
});
