import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { styleRules } from "./css";
import { STYLESHEETS } from "./sourceScan";

// What the browser draws itself — radios, checkboxes, scrollbars, autofill —
// follows `color-scheme`, not the theme tokens, and defaults to light. Nothing
// else fails when it is missing: the controls just come out white on a dark
// card, which is how it went unnoticed.

function colorSchemes(stylesheet: keyof typeof STYLESHEETS) {
	const css = readFileSync(
		resolve(process.cwd(), STYLESHEETS[stylesheet]),
		"utf8",
	);
	const found: Record<string, string> = {};
	for (const { selector, body } of styleRules(css)) {
		const value = /(?:^|[;\s])color-scheme\s*:\s*([^;}]+)/.exec(body)?.[1];
		if (value) found[selector.replace(/\s+/g, " ").trim()] = value.trim();
	}
	return found;
}

describe("color-scheme", () => {
	// The mode is the `dark` class themeStore puts on <html>, so the scheme has
	// to follow that class rather than `prefers-color-scheme`: a user who picked
	// dark on a light system still gets dark controls.
	it("follows the dark class in web", () => {
		expect(colorSchemes("web/src/index.css")).toEqual({
			html: "light",
			"html.dark": "dark",
		});
	});

	it("is dark in web-cluster, whose only theme is", () => {
		expect(colorSchemes("web-cluster/src/index.css")).toEqual({
			html: "dark",
		});
	});
});
