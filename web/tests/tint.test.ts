import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classHelpers } from "./classScan";
import {
	AA_FLOOR,
	composite,
	contrastRatio,
	NON_TEXT_FLOOR,
	parseColor,
	type Rgb,
	themeRules,
} from "./contrast";
import { declarationCount } from "./css";
import {
	ROOT_STYLESHEETS,
	ROOTS,
	repoPath,
	STYLESHEETS,
	sourceFiles,
} from "./sourceScan";
import {
	BANNED_FOREGROUNDS,
	BASE_BACKGROUNDS,
	MAX_TINT_ALPHA,
	scanTints,
	TINTED_BACKGROUNDS,
} from "./tint";

// `bg-th-accent/10` under `text-th-accent` is the accent read against a wash of
// itself, and in every light variant that is somewhere around 3.5:1 — a chip
// label, a status badge on every row of a list, and the one sentence a
// disconnected user most needs to read. contrast.test.ts cannot see any of it:
// the fill is not a colour the stylesheet holds, it is one the compositor makes
// out of three things, only one of which is written down.
//
// So this file makes the other two readable. The alpha and the foreground come
// from the source, discovered rather than listed, so a chip written next year
// is checked without anyone remembering this file exists — a hand-kept list
// would have gone stale at the first new component and stayed green while doing
// it. The backdrop is the one thing a text scan genuinely cannot know, and
// rather than guess, every tint is held to clearing the floor over all three
// page backgrounds (see `BASE_BACKGROUNDS`).
//
// The rule being guarded, from the design: text on an accent tint is
// `text-th-text-primary`, the alpha stops at /20, and the hue moves to a border
// or an icon, which owe only the non-text floor. This file is what keeps the
// first half of that true — the second half is `MAX_TINT_ALPHA` below.
//
// Lives outside `src` for the same reason contrast.test.ts does: reading the
// stylesheet and the components as text needs Node types the app project
// deliberately does not have. Paths resolve from the project vitest runs in.

function read(path: string): string {
	return readFileSync(resolve(process.cwd(), path), "utf8");
}

const helpers = classHelpers(ROOTS.flatMap(sourceFiles));

/** Every root's tints, kept with the root so the right stylesheets are used. */
const SCANNED = ROOTS.map((root) => ({ root, ...scanTints(root, helpers) }));

// A root compiles into the stylesheets ROOT_STYLESHEETS names, and
// `packages/shared` compiles into both: one chip there can be fine in web and
// fail in web-cluster, so a usage is checked against every stylesheet its own
// root reaches rather than against web's alone.
const CASES = SCANNED.flatMap(({ root, usages }) =>
	ROOT_STYLESHEETS[root].flatMap((name) =>
		usages.map(
			(usage) =>
				[
					`${name} bg-${usage.background}/${usage.alpha} under text-${usage.foreground}`,
					STYLESHEETS[name],
					usage,
				] as const,
		),
	),
);

describe("tint discovery", () => {
	// Every table below is generated from this list, and vitest registers no
	// tests at all for an empty `each`, so an emptied list disables the whole
	// guard without turning anything red.
	it("guards at least one fill", () => {
		expect(
			TINTED_BACKGROUNDS.length,
			"TINTED_BACKGROUNDS is empty, so every table below is empty and this file guards nothing",
		).toBeGreaterThan(0);
	});

	// Unlike the lists above, an emptied ban list empties no table — every check
	// below simply passes. That is the one edit in this file that turns a
	// failure green while looking like a tidy-up.
	it("still refuses the foregrounds the rule refuses", () => {
		expect(
			BANNED_FOREGROUNDS.length,
			"BANNED_FOREGROUNDS is empty, so the R4 check below passes whatever a chip writes",
		).toBeGreaterThan(0);
	});

	it("finds tinted elements to check", () => {
		expect(
			CASES.length,
			"no element pairs a guarded tint with a foreground: either the app stopped using them, or the scan stopped reading them",
		).toBeGreaterThan(0);
	});

	// The scan reads `className` expressions, splices helpers into them and
	// enumerates their branches, and every one of those steps can fail by
	// producing nothing — which reads exactly like a file with no tint in it.
	// The raw text says which files write one, and a file the walk cannot read
	// has to fail here rather than drop quietly out of the tables below.
	it.each(
		SCANNED.map(({ root, alphas }) => [root, alphas] as const),
	)("%s: reads every file that writes a tint", (root, alphas) => {
		const pattern = new RegExp(`bg-(?:${TINTED_BACKGROUNDS.join("|")})/\\d`);
		const written = sourceFiles(root)
			.filter((file) => pattern.test(readFileSync(file, "utf8")))
			.map(repoPath);
		const seen = new Set(
			alphas.flatMap(({ sites }) => sites.map((s) => s.replace(/:\d+$/, ""))),
		);
		expect(
			written.filter((file) => !seen.has(file)),
			"these files write a tint the class scan did not read: a className shape it cannot follow",
		).toEqual([]);
	});

	// R4, the half of the rule the arithmetic cannot state. A tint's foreground
	// is the body colour, and `text-th-accent-hover` clears AA on a /15 tint by a
	// margin thin enough that the check below reads it as a pass — which is exactly
	// what the ban is for. The margin itself is written once, beside
	// `BANNED_FOREGROUNDS`, rather than restated here.
	it.each(
		SCANNED.flatMap(({ usages }) =>
			usages.map(
				(usage) =>
					[
						`text-${usage.foreground} on bg-${usage.background}/${usage.alpha}`,
						usage,
					] as const,
			),
		),
	)("%s is a foreground this tint may carry", (_what, usage) => {
		expect(
			BANNED_FOREGROUNDS.includes(usage.foreground),
			`${usage.sites.join(", ")}: text-${usage.foreground} on bg-${usage.background}/${usage.alpha} — text on an accent tint is the body colour, and the hue moves to a border or an icon`,
		).toBe(false);
	});

	// The alpha ceiling is not about the text — `text-th-text-primary` clears AA
	// at /30 too. It is what keeps a full-strength accent border or icon legible
	// on the tint, which is where the design puts the hue now that the label is
	// the body colour. Checked here rather than by computing every icon's ratio
	// because it is the ceiling itself that makes the rule one sentence long.
	it.each(
		SCANNED.flatMap(({ alphas }) => alphas.map((a) => [a.alpha, a] as const)),
	)("/%s is within the alpha ceiling", (_alpha, { alpha, sites }) => {
		expect(
			alpha,
			`${sites.join(", ")}: /${alpha} is past the /${MAX_TINT_ALPHA} ceiling, where a full-strength accent icon or border on this tint drops below the non-text 3:1 floor`,
		).toBeLessThanOrEqual(MAX_TINT_ALPHA);
	});
});

describe.each(CASES)("%s", (_name, path, usage) => {
	const css = read(path);
	const names = [usage.background, usage.foreground, ...BASE_BACKGROUNDS];
	const variants = themeRules(css, usage.background, names);

	// Discovery failing open is the one way this file passes while proving
	// nothing — `it.each` over an empty table registers no tests at all and
	// vitest reports green — so the rule walk is cross-checked against a plain
	// text count of the declarations, the same way contrast.test.ts does it.
	it("finds every variant that declares the fill", () => {
		expect(
			variants.length,
			"either a variant the rule walk did not find, or one rule declaring the token twice",
		).toBe(declarationCount(css, usage.background));
	});

	it.each(
		variants.flatMap((variant) =>
			BASE_BACKGROUNDS.map(
				(base) => [variant.selector, base, variant] as const,
			),
		),
	)("%s over --%s clears AA", (selector, base, variant) => {
		const where = `${selector}: ${usage.sites.join(", ")}`;
		// All three read from the one rule and never from the cascade, so a
		// variant that overrode only some of them is reported rather than
		// silently mixed with another theme's colours.
		const colour = (name: string): Rgb | undefined => {
			const value = variant.values[name];
			expect(
				value,
				`${where}: --${name} is not declared by this variant, so the ratio cannot be computed`,
			).toBeDefined();
			const rgb = value === undefined ? undefined : parseColor(value);
			expect(
				rgb,
				`${where}: --${name} is "${value}", not a hex colour`,
			).toBeDefined();
			return rgb;
		};
		const fill = colour(usage.background);
		const foreground = colour(usage.foreground);
		const backdrop = colour(base);
		if (!fill || !foreground || !backdrop) return;

		const tint = composite(fill, backdrop, usage.alpha / 100);
		const ratio = contrastRatio(tint, foreground);
		expect(
			ratio,
			`${where}: --${usage.foreground} ${variant.values[usage.foreground]} on ` +
				`--${usage.background} ${variant.values[usage.background]} at ${usage.alpha}% over ` +
				`--${base} ${variant.values[base]} is ${ratio.toFixed(2)}:1, ` +
				`short of ${AA_FLOOR}:1 by ${(AA_FLOOR - ratio).toFixed(2)}`,
		).toBeGreaterThanOrEqual(AA_FLOOR);
	});
});

// Why the ceiling is where it is, rather than that it is where it is.
//
// `MAX_TINT_ALPHA` is not arithmetic anyone can check by reading it, and a
// number in a constant is the easiest thing in this file to edit upwards the
// day a design wants a stronger wash. What it buys is the other half of the
// rule: with the label back to the body colour, the hue is carried by a
// full-strength accent border or icon sitting *on* the tint, and that owes
// WCAG's non-text floor. Asserting the floor still holds at the ceiling ties
// the two together — raise the constant and this goes red on its own, naming
// the variant where the icon stopped being visible.
//
// Every stylesheet, not only the ones with tinted call sites today: this is a
// property of the token, and web-cluster inherits the rule the moment it writes
// its first chip.
describe.each(
	Object.entries(STYLESHEETS).flatMap(([name, path]) =>
		TINTED_BACKGROUNDS.map(
			(background) => [`${name} --${background}`, path, background] as const,
		),
	),
)("%s at the alpha ceiling", (_name, path, background) => {
	const css = read(path);
	const variants = themeRules(css, background, [
		background,
		...BASE_BACKGROUNDS,
	]);

	it("finds every variant that declares the fill", () => {
		expect(
			variants.length,
			"either a variant the rule walk did not find, or one rule declaring the token twice",
		).toBe(declarationCount(css, background));
	});

	it.each(
		variants.flatMap((variant) =>
			BASE_BACKGROUNDS.map(
				(base) => [variant.selector, base, variant] as const,
			),
		),
	)("%s over --%s keeps a full-strength fill legible on its own tint", (selector, base, variant) => {
		const fill = parseColor(variant.values[background] ?? "");
		const backdrop = parseColor(variant.values[base] ?? "");
		expect(
			fill && backdrop,
			`${selector}: --${background} or --${base} is missing or not a hex colour`,
		).toBeTruthy();
		if (!fill || !backdrop) return;

		const tint = composite(fill, backdrop, MAX_TINT_ALPHA / 100);
		const ratio = contrastRatio(tint, fill);
		expect(
			ratio,
			`${selector}: --${background} ${variant.values[background]} on its own ${MAX_TINT_ALPHA}% tint over ` +
				`--${base} ${variant.values[base]} is ${ratio.toFixed(2)}:1, short of the non-text ` +
				`${NON_TEXT_FLOOR}:1 an icon or border owes — /${MAX_TINT_ALPHA} is too strong a ceiling for this palette`,
		).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
	});
});
