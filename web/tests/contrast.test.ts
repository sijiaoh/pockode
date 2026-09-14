import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AA_FLOOR,
	backdrop,
	composite,
	contrastRatio,
	GUARDED_PAIRS,
	lightness,
	pairName,
	parseAlphaColor,
	parseColor,
	TEXT_TIER_STEP,
	type TokenPair,
	themeRules,
	themeVariants,
} from "./contrast";
import { declarationCount, declaredNames } from "./css";
import { STYLESHEETS } from "./sourceScan";

// A fill and a foreground read on it — `--th-accent` under `--th-accent-text`,
// `--th-bg-tertiary` under `--th-text-muted` — are both read as text, so both
// owe WCAG AA. The ratio is arithmetic over values sitting in the stylesheet,
// which makes it the kind of thing a test should catch rather than the next
// person reviewing a colour by eye: two light variants, one of them the default
// theme in the mode a first-run user most likely lands in, sat below the floor
// through several reviews — and did it twice over, because the bubble held the
// same value as the accent and nobody had looked at it under its second name.
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
		(pair) => [`${name} ${pairName(pair)}`, path, pair] as const,
	),
);

/** The foregrounds guarded, each appearing once however many fills carry it. */
const FOREGROUNDS = [...new Set(GUARDED_PAIRS.map((p) => p.foreground))];

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

	// The other half of the same hole, and the wider one: the tier check below
	// is driven by STYLESHEETS alone, with no pair list behind it, so emptying
	// that would take the whole file down without a word.
	it("has stylesheets to read", () => {
		expect(
			Object.keys(STYLESHEETS).length,
			"STYLESHEETS is empty, so every table below is empty and this file guards nothing",
		).toBeGreaterThan(0);
	});

	// A pair whose tokens were renamed or misspelled finds nothing in any
	// stylesheet, and a per-stylesheet check cannot tell that from a pair a
	// stylesheet legitimately does not use — web-cluster has no chat bubbles.
	it.each(
		GUARDED_PAIRS.map((pair) => [pairName(pair), pair] as const),
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

// A fill and its foreground used to be declared by the same set of rules, so
// counting either proved the walk had found every variant. `--th-text-muted`
// breaks that: it is carried by five fills, and one of them — `--th-ai-bubble`
// — web-cluster does not declare at all, having no chat bubbles. Counting per
// pair would now demand a bubble that should not exist.
//
// The invariant that survives is the one that was always the point: a variant
// that declares a guarded foreground is checked against *something*. It is
// stricter than the count it replaces, because it compares selectors rather
// than totals, and it is what stops a surface being added to the stylesheet
// while one theme quietly goes unguarded on it.
describe.each(
	Object.entries(STYLESHEETS),
)("%s guards every declared foreground", (_name, path) => {
	const css = read(path);

	it.each(FOREGROUNDS)("--%s", (foreground) => {
		const declared = themeRules(css, foreground, []).map((r) => r.selector);
		expect(
			declared.length,
			"either a variant the rule walk did not find, or one rule declaring the token twice",
		).toBe(declarationCount(css, foreground));

		const checked = new Set(
			GUARDED_PAIRS.filter((p) => p.foreground === foreground).flatMap((p) =>
				themeVariants(css, p).map((v) => v.selector),
			),
		);
		expect(
			[...checked].sort(),
			`a variant declares --${foreground} but no guarded fill under it, so its ratio is never computed`,
		).toEqual([...new Set(declared)].sort());
	});
});

// Losing a whole pair is the one edit the checks above cannot see. Every
// variant stays covered by a sibling pair, so the table simply gets shorter and
// the report stays green — and the pair most worth deleting is the one with the
// least margin, which here is the hover overlay, the worst surface muted lands
// on and the only one that would put every variant back below AA. Asserting the
// list's own length would be circular, so the cross-check comes from outside
// it: the translucent fills are the ones no reading of the stylesheet's colours
// would turn up, and the stylesheet does say which ones it has.
//
// It buys exactly that much. Dropping one of the opaque surfaces still passes,
// because "which surfaces a foreground lands on" is not something the
// stylesheet knows — but those are the pairs with margin to spare, and none of
// them is the one a red suite would point at.
describe.each(
	Object.entries(STYLESHEETS),
)("%s guards every overlay it declares", (_name, path) => {
	const fills = new Set(GUARDED_PAIRS.map((p) => p.background));
	const overlays = declaredNames(read(path), "th-overlay-");

	it("has overlays to check", () => {
		expect(
			overlays.length,
			"no --th-overlay-* token found, so the table below is empty and this guards nothing",
		).toBeGreaterThan(0);
	});

	it.each(overlays)("--%s", (overlay) => {
		expect(
			fills.has(overlay),
			`--${overlay} is painted over a surface the app reads text on, but no ` +
				"pair in GUARDED_PAIRS names it as a fill — add one under the " +
				"foreground read on it, or say here what is read on it instead",
		).toBe(true);
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
		// A translucent fill is worth nothing without the surface under it, and
		// that surface is read from the same rule, so it is counted the same way.
		if (pair.onto)
			expect(variants.length, mismatch).toBe(declarationCount(css, pair.onto));
	});

	it.each(
		variants.map((v) => [v.selector, v] as const),
	)("%s clears AA", (selector, variant) => {
		// What the fill actually paints: the value itself, or — for a translucent
		// token — the composite it makes over the surface the pair names.
		const background = backdrop(variant);
		const foreground = parseColor(variant.foreground);
		// Every half declared by the same rule, all of them readable: the ratio
		// cannot be computed otherwise, and a variant whose ratio cannot be
		// computed is not a variant that passed.
		expect(
			background,
			`${selector}: --${pair.background} is "${variant.background}"` +
				(pair.onto ? ` over --${pair.onto} "${variant.onto}"` : "") +
				", which does not resolve to a colour",
		).toBeDefined();
		expect(
			foreground,
			`${selector}: --${pair.foreground} is "${variant.foreground}", not a hex colour`,
		).toBeDefined();
		if (!background || !foreground) return;

		const ratio = contrastRatio(background, foreground);
		expect(
			ratio,
			`${selector}: --${pair.foreground} ${variant.foreground} on --${pair.background} ${variant.background}` +
				(pair.onto ? ` over --${pair.onto} ${variant.onto}` : "") +
				` is ${ratio.toFixed(2)}:1, short of ${AA_FLOOR}:1 by ${(AA_FLOOR - ratio).toFixed(2)}`,
		).toBeGreaterThanOrEqual(AA_FLOOR);
	});
});

// The ratios above say the text tokens are readable. They cannot say there are
// still three of them — every way of raising a dimmer token's ratio against the
// page moves it towards the body colour, so a theme could satisfy every
// assertion in this file by painting muted as secondary and collapsing a tier
// the whole type scale is built on. This is the other half of the same rule,
// and it is why the ratios can be trusted as a floor rather than read as a
// target.
//
// Both rungs are checked, not just the one this was written for. That is what
// keeps `TEXT_TIER_STEP` from being a number invented to fit muted: it is the
// step the scale already holds end to end, so lowering it to clear a failure is
// visibly a change of policy rather than a local escape.
const TIERS = [
	["th-text-muted", "th-text-secondary"],
	["th-text-secondary", "th-text-primary"],
] as const;

describe.each(
	Object.entries(STYLESHEETS),
)("%s keeps its text tiers apart", (_name, path) => {
	const css = read(path);
	// Anchored on muted, so a variant is found by the token the story is about
	// and both rungs are read off that same rule.
	const variants = themeRules(css, "th-text-muted", [
		"th-text-muted",
		"th-text-secondary",
		"th-text-primary",
	]);

	it("finds every variant that declares --th-text-muted", () => {
		expect(
			variants.length,
			"either a variant the rule walk did not find, or one rule declaring the token twice",
		).toBe(declarationCount(css, "th-text-muted"));
		expect(
			variants.length,
			"no variant found, so the table below is empty and this guards nothing",
		).toBeGreaterThan(0);
	});

	const CASES = variants.flatMap((v) =>
		TIERS.map(
			([dimmer, brighter]) =>
				[
					`${v.selector}: --${dimmer} vs --${brighter}`,
					v.values,
					dimmer,
					brighter,
				] as const,
		),
	);

	it.each(CASES)("%s", (label, values, dimmer, brighter) => {
		const a = parseColor(values[dimmer] ?? "");
		const b = parseColor(values[brighter] ?? "");
		// Every tier read off the same rule, all of them hex: a step cannot be
		// measured otherwise, and a step that cannot be measured is not one that
		// held.
		expect(
			a,
			`${label}: --${dimmer} is "${values[dimmer]}", not a hex colour`,
		).toBeDefined();
		expect(
			b,
			`${label}: --${brighter} is "${values[brighter]}", not a hex colour`,
		).toBeDefined();
		if (!a || !b) return;

		const step = Math.abs(lightness(a) - lightness(b));
		expect(
			step,
			`${label}: ${values[dimmer]} is ΔL* ${step.toFixed(1)} from ${values[brighter]}, ` +
				`under ${TEXT_TIER_STEP} — move the brighter tier too rather than closing the gap, ` +
				"or the two read as one",
		).toBeGreaterThanOrEqual(TEXT_TIER_STEP);
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

	// The overlay tokens are the only translucent values guarded, and the alpha
	// is the whole difference between a hover state that is read and one that is
	// not — a notation silently read as opaque would report the resting ratio.
	it("reads an overlay's alpha, and refuses a notation it does not know", () => {
		expect(parseAlphaColor("rgba(0, 0, 0, 0.08)")).toEqual({
			color: [0, 0, 0],
			alpha: 0.08,
		});
		expect(parseAlphaColor("rgba(255, 255, 255, 0.1)")).toEqual({
			color: [255, 255, 255],
			alpha: 0.1,
		});
		expect(parseAlphaColor("rgb(0 0 0 / 8%)")).toBeUndefined();
		expect(parseAlphaColor("rgba(0, 0, 0)")).toBeUndefined();
		expect(parseAlphaColor("#000000")).toBeUndefined();
		expect(parseAlphaColor("rgba(0, 0, 0, 8%)")).toBeUndefined();
		// `Number("")` is 0, and an alpha silently read as 0 composites to the
		// bare surface — a hover state reported as the resting one, which is the
		// single most convincing wrong answer this parser could give.
		expect(parseAlphaColor("rgba(0, 0, 0, )")).toBeUndefined();
		expect(parseAlphaColor("rgba(, 0, 0, 0.5)")).toBeUndefined();
		expect(parseAlphaColor("rgba(0, 0, 0, 1.5)")).toBeUndefined();
		expect(parseAlphaColor("rgba(300, 0, 0, 0.5)")).toBeUndefined();
	});

	it("resolves a translucent fill against the surface it is painted onto", () => {
		const resolved = backdrop({
			selector: ".theme-x",
			background: "rgba(0, 0, 0, 0.5)",
			foreground: "#000000",
			onto: "#ffffff",
		});
		expect(resolved).toEqual([127.5, 127.5, 127.5]);
		// Without the surface there is nothing to composite against, and a pair
		// that guessed one would report a ratio the app never renders.
		expect(
			backdrop({
				selector: ".theme-x",
				background: "rgba(0, 0, 0, 0.5)",
				foreground: "#000000",
			}),
		).toBeUndefined();
	});

	// L* is what the tier step is measured in, so it has to be CIE's and not a
	// second luminance formula wearing the name. The anchors are the ones CIELab
	// is defined by; #777777 is the reminder that L* is not 46.7% of anything.
	it("reproduces known CIELab lightness", () => {
		const L = (hex: string) => {
			const rgb = parseColor(hex);
			if (!rgb) throw new Error(`unparsed: ${hex}`);
			return Number(lightness(rgb).toFixed(2));
		};
		expect(L("#ffffff")).toBe(100);
		expect(L("#000000")).toBe(0);
		expect(L("#777777")).toBe(50.03);
		expect(L("#808080")).toBe(53.59);
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
