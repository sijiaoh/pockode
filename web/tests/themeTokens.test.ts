import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	THEME_INFO,
	THEME_NAMES,
	type ThemeInfo,
} from "../src/lib/registries/themeRegistry";
import { declaration, declarationCount, styleRules } from "./css";
import { STYLESHEETS } from "./sourceScan";

// The theme picker paints its swatches from THEME_INFO rather than from the
// DOM, because it has to show a theme that is not applied. That makes the
// registry a second copy of five themes' colours, and the only thing keeping it
// honest was a comment saying it must match index.css: 18 of the 40 values had
// drifted, `--th-text-muted` in every single variant, so the swatch showed one
// palette and picking the theme gave another.
//
// Both sides are discovered and compared as sets, never zipped over whichever
// is shorter. A missing entry is the shape this drift hides in: a registry
// entry for a deleted theme renders a swatch for nothing, a stylesheet theme
// missing from the registry never reaches the picker, a colour field nobody
// mapped is simply never compared — and all three are green under a check that
// only walks the intersection.
//
// Only web/src/index.css is compared. web-cluster has no theme picker and no
// registry; if it grows one, this file should grow a second case rather than
// silently keep proving something about the other stylesheet.

const STYLESHEET = "web/src/index.css" satisfies keyof typeof STYLESHEETS;
const css = readFileSync(
	resolve(process.cwd(), STYLESHEETS[STYLESHEET]),
	"utf8",
);

/** Which custom property each preview colour is a copy of. */
const TOKENS = {
	accent: "th-accent",
	bg: "th-bg-primary",
	text: "th-text-primary",
	textMuted: "th-text-muted",
} as const;

type ColourField = keyof typeof TOKENS;
type Variant = keyof ThemeInfo[ColourField];

const FIELDS = Object.keys(TOKENS) as ColourField[];
const VARIANTS: Variant[] = ["light", "dark"];

/**
 * Every rule that declares a theme's tokens, keyed `name/variant`.
 *
 * Bodies are collected into a list rather than overwritten, so a theme declared
 * by two rules — a second one under `@media (prefers-contrast: more)`, say — is
 * reported instead of quietly deciding which of them the registry copies.
 */
function themeRules(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const rule of styleRules(css)) {
		for (const part of rule.selector.split(",")) {
			// `:root, .theme-abyss` declares the default theme under two
			// selectors; `.dark.theme-abyss` is that theme's other variant.
			const match = /^(\.dark)?\.theme-([\w-]+)$/.exec(
				part.replace(/\s+/g, ""),
			);
			if (!match) continue;
			const key = `${match[2]}/${match[1] ? "dark" : "light"}`;
			found.set(key, [...(found.get(key) ?? []), rule.body]);
		}
	}
	return found;
}

const RULES = themeRules();
const themeNames = [...new Set([...RULES.keys()].map((k) => k.split("/")[0]))];

describe(`${STYLESHEET} theme tokens`, () => {
	// Every table below is generated from THEME_NAMES and TOKENS, and vitest
	// registers no tests at all for an empty `each`, so emptying either would
	// disable the whole guard while reporting green.
	it("has themes and fields to compare", () => {
		expect(THEME_NAMES.length).toBeGreaterThan(0);
		expect(FIELDS.length).toBeGreaterThan(0);
	});

	// The rule walk failing open is the other way this file passes while proving
	// nothing, so it is cross-checked against a plain text count: every
	// declaration of a mapped token in the stylesheet has to belong to a rule the
	// walk attributed to a theme. A declaration somewhere else is not a variant
	// the registry can preview.
	it.each(FIELDS)("%s: every declaration belongs to a theme rule", (field) => {
		expect(
			declarationCount(css, TOKENS[field]),
			`--${TOKENS[field]} is declared outside the .theme-* rules, twice in one rule, or by a rule the walk did not find`,
		).toBe(RULES.size);
	});

	it("declares exactly the themes the registry knows", () => {
		expect(themeNames.sort()).toEqual([...THEME_NAMES].sort());
	});

	// A colour the registry previews but nothing maps is never compared below,
	// which is the same silence the whole file exists to end — one field short of
	// a full mapping looks exactly like a full one. Reading the fields off every
	// theme rather than one keeps this true of a registry whose entries stop
	// being uniform.
	it("maps every preview colour the registry holds", () => {
		const previewed = THEME_NAMES.flatMap((theme) =>
			Object.entries(THEME_INFO[theme])
				.filter(([, value]) => typeof value === "object")
				.map(([key]) => key),
		);
		expect(
			[...new Set(previewed)].sort(),
			"a ThemeInfo colour field is missing from TOKENS, so nothing checks it",
		).toEqual([...FIELDS].sort());
	});

	it.each(THEME_NAMES)("%s is declared once per variant", (theme) => {
		expect(
			VARIANTS.map((v) => RULES.get(`${theme}/${v}`)?.length ?? 0),
			"expected one light rule and one dark rule",
		).toEqual([1, 1]);
	});

	describe.each(THEME_NAMES)("%s", (theme) => {
		it.each(
			VARIANTS.flatMap((variant) =>
				FIELDS.map((field) => [variant, field] as const),
			),
		)("%s %s matches the stylesheet", (variant, field) => {
			const body = RULES.get(`${theme}/${variant}`)?.at(0);
			expect(body, `no ${variant} rule for .theme-${theme}`).toBeDefined();
			if (body === undefined) return;

			const token = TOKENS[field];
			const declared = declaration(body, token);
			expect(
				declared,
				`.theme-${theme} (${variant}) does not declare --${token}, so ${field} previews nothing`,
			).toBeDefined();
			expect(
				THEME_INFO[theme][field][variant].toLowerCase(),
				`THEME_INFO.${theme}.${field}.${variant} previews a colour --${token} no longer has`,
			).toBe(declared?.toLowerCase());
		});
	});
});
