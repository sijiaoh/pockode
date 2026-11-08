import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPH_COLORS } from "../src/lib/commitHistory";
import {
	contrastRatio,
	NON_TEXT_FLOOR,
	parseColor,
	themeRules,
} from "./contrast";
import { declaration, declaredNames, styleRules } from "./css";
import { STYLESHEETS } from "./sourceScan";

// The commit graph's line colours are one palette per mode, shared by every
// theme, so a theme added or retinted later can put a background under them
// that no one compared them with. Each colour owes WCAG 1.4.11's non-text 3:1
// against every surface a row is drawn on — primary, secondary, and tertiary,
// which is the selected row (docs/git-history-ui.md#line-colours).
//
// Discovered, not listed: every theme rule declaring the backgrounds is
// checked, in the mode its selector names.

const STYLESHEET = "web/src/index.css" satisfies keyof typeof STYLESHEETS;
const css = readFileSync(
	resolve(process.cwd(), STYLESHEETS[STYLESHEET]),
	"utf8",
);

const TOKENS = Array.from(
	{ length: GRAPH_COLORS },
	(_, i) => `th-graph-${i + 1}`,
);
const BACKGROUNDS = ["th-bg-primary", "th-bg-secondary", "th-bg-tertiary"];
type Mode = "light" | "dark";

/** The palette rule of each mode: `:root` and `.dark`, exactly one each. */
function palettes(): Record<Mode, string[]> {
	const found: Record<Mode, string[]> = { light: [], dark: [] };
	for (const rule of styleRules(css)) {
		if (declaration(rule.body, TOKENS[0]) === undefined) continue;
		const selector = rule.selector.replace(/\s+/g, "");
		if (selector === ":root") found.light.push(rule.body);
		else if (selector === ".dark") found.dark.push(rule.body);
		else throw new Error(`--${TOKENS[0]} declared under ${rule.selector}`);
	}
	return found;
}

const PALETTES = palettes();
const THEMES = themeRules(css, BACKGROUNDS[0], BACKGROUNDS).map((rule) => ({
	...rule,
	mode: (rule.selector.includes(".dark") ? "dark" : "light") as Mode,
}));

describe(`${STYLESHEET} graph line colours`, () => {
	it("declares exactly the colours the graph cycles through", () => {
		expect(declaredNames(css, "th-graph-").sort()).toEqual([...TOKENS].sort());
	});

	it.each(["light", "dark"] as const)("has one %s palette", (mode) => {
		expect(PALETTES[mode]).toHaveLength(1);
	});

	// An empty table registers no tests at all, which would read as green.
	it("finds themes of both modes to check against", () => {
		expect(THEMES.some((t) => t.mode === "light")).toBe(true);
		expect(THEMES.some((t) => t.mode === "dark")).toBe(true);
	});

	describe.each(THEMES)("$selector", ({ mode, values }) => {
		it.each(
			TOKENS,
		)(`--%s clears ${NON_TEXT_FLOOR}:1 on every row background`, (token) => {
			const value = declaration(PALETTES[mode][0] ?? "", token);
			const line = value === undefined ? undefined : parseColor(value);
			expect(line, `--${token} (${mode}) is not a hex colour`).toBeDefined();
			for (const background of BACKGROUNDS) {
				const fill = parseColor(values[background] ?? "");
				expect(fill, `--${background} is not a hex colour`).toBeDefined();
				if (!line || !fill) continue;
				expect(
					contrastRatio(line, fill),
					`--${token} ${value} on --${background} ${values[background]}`,
				).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
			}
		});
	});
});
