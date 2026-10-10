// Fails when the README links to a pockode.com page that the site build does
// not produce. Run it after `hugo` with the build's output directory:
//
//   node scripts/site/links.mjs site/public
//
// The README is published apart from the site, so a page renamed or dropped
// there would leave its links dead with nothing else noticing.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const SOURCES = ["README.md"];
const SITE = "https://pockode.com";

/**
 * Every pockode.com link in a text: { path, line }. The path is the URL's,
 * so `..` is resolved and the query and fragment are gone, as a browser
 * would have them.
 */
export function siteLinks(text) {
	const found = [];
	text.split("\n").forEach((line, index) => {
		for (const m of line.matchAll(
			/https?:\/\/(?:www\.)?pockode\.com(?![\w.-])[^\s)<>\]"'`]*/gi,
		)) {
			found.push({ path: new URL(m[0]).pathname, line: index + 1 });
		}
	});
	return found;
}

/**
 * The file a static host serves for a URL path, or null when the build has
 * none: a directory path is its index.html, and a host also answers `/docs`
 * with `/docs/`.
 */
export function servedFile(publicDir, path) {
	let decoded;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		return null; // a malformed escape no host can serve
	}
	// An escaped `..` (%2E%2E%2F) survives URL parsing; it must not reach
	// outside the build either.
	const root = resolve(publicDir);
	const file = resolve(root, `.${decoded}`);
	if (file !== root && !file.startsWith(root + sep)) return null;
	for (const candidate of [file, join(file, "index.html")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function main() {
	const publicDir = process.argv[2];
	if (!publicDir) {
		console.error("usage: node scripts/site/links.mjs <hugo output directory>");
		process.exit(2);
	}
	// Without a build every link would be reported missing, which reads as a
	// broken README rather than a missing step.
	if (!servedFile(publicDir, "/")) {
		console.error(`${publicDir} has no index.html; build the site first`);
		process.exit(2);
	}

	let checked = 0;
	const missing = [];
	for (const source of SOURCES) {
		const text = readFileSync(join(ROOT, source), "utf8");
		for (const { path, line } of siteLinks(text)) {
			checked++;
			if (!servedFile(publicDir, path))
				missing.push(`${source}:${line}: ${SITE}${path}`);
		}
	}

	// A README that stopped linking to the site, or a pattern that stopped
	// matching, would otherwise pass by checking nothing.
	if (checked === 0) {
		console.error(`no ${SITE} links found in ${SOURCES.join(", ")}`);
		process.exit(1);
	}
	if (missing.length) {
		console.error(`Links to pages that ${publicDir} does not have:`);
		for (const m of missing) console.error(`  ${m}`);
		process.exit(1);
	}
	console.log(`${checked} ${SITE} links resolve to built pages`);
}

if (import.meta.main) main();
