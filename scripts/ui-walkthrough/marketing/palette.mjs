// The colours the finished assets are painted in, read from the site's
// stylesheet — the tokens of its top-level `:root` rule, which pockode.com is
// painted in too (docs/site-design.md §2.1). Nothing here holds a colour of
// its own: a page takes PALETTE_CSS and writes `var(--token)`, so a palette
// change on the site is a re-render here, never an edit.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dirname, "../../..");
const FILE = join(PROJECT_DIR, "site/themes/pockode/assets/css/main.css");
const LOGO = join(PROJECT_DIR, "site/static/images/logo.svg");

/** The body of the first rule at the top level whose selector is `:root`. */
function rootRule(css) {
	let depth = 0;
	let start = 0;
	for (let i = 0; i < css.length; i++) {
		if (css[i] === "{") {
			if (depth === 0 && css.slice(start, i).trim() === ":root") {
				const end = css.indexOf("}", i);
				return css.slice(i + 1, end);
			}
			depth++;
		} else if (css[i] === "}") {
			depth--;
			if (depth === 0) start = i + 1;
		} else if (css[i] === ";" && depth === 0) start = i + 1;
	}
	throw new Error(
		`${FILE} has no top-level :root rule to take the palette from.`,
	);
}

const css = readFileSync(FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// Custom properties only: the rule's `color-scheme: dark` would give the
// diagram's transparent page a dark canvas.
export const tokens = new Map(
	rootRule(css)
		.split(";")
		.map((declaration) =>
			declaration.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/),
		)
		.filter(Boolean)
		.map(([, name, value]) => [name, value.replace(/\s+/g, " ")]),
);

export const PALETTE_CSS = `:root { ${[...tokens].map(([name, value]) => `${name}: ${value};`).join(" ")} }`;

/**
 * `page` as it is, refused if it uses a token the site does not define: an
 * unknown `var()` paints nothing, and a render would not say so. For a
 * page's own markup only — the frames set and read a variable of their own.
 */
export function painted(page) {
	const missing = [
		...new Set(
			[...(page + PALETTE_CSS).matchAll(/var\(\s*(--[\w-]+)/g)]
				.map(([, name]) => name)
				.filter((name) => !tokens.has(name)),
		),
	];
	if (missing.length)
		throw new Error(
			`${FILE}'s :root has no ${missing.join(", ")}, which the marketing assets paint with.`,
		);
	return page;
}

// The logo's own two stops, which the light diagram draws with: the site's
// lighter brand stops fall to 1.8:1 on white (docs/marketing-assets.md §6).
const stops = [
	...readFileSync(LOGO, "utf8").matchAll(/<stop\b[^>]*stop-color="([^"]+)"/g),
].map(([, color]) => color);
if (stops.length !== 2)
	throw new Error(
		`${LOGO} has ${stops.length} gradient stops; the light diagram draws with exactly two.`,
	);
export const LOGO_STOPS = stops;
