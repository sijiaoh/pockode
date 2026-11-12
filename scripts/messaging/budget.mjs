// Fails when the homepage's prose reaches its word budget
// (docs/site-design.md §4.8): the words a visitor reads without opening
// anything. Labels, the install box and the folded FAQ answers do not count.
//
// Which fields those are is the homepage template's choice
// (site/themes/pockode/layouts/index.html); a field it starts showing as prose
// belongs in PARTS too.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../..");
const SOURCE = join(ROOT, "site/data/messaging.yaml");

// §4.8's limit: the total has to stay under it.
const LIMIT = 150;

const PARTS = {
	hero: (m) => [m.tagline, m.subtitle],
	screens: (m) =>
		m.pillars.flatMap((p) => [
			p.title,
			p.description,
			...(p.facts ?? []).map((f) => f.text),
		]),
	"Get started": (m) => [m.quickstart.prerequisite, m.quickstart.next],
};

/** A word is anything between spaces but a lone "&". */
const words = (text) =>
	text.split(/\s+/).filter((word) => word && word !== "&").length;

if (import.meta.main) {
	const messaging = parse(readFileSync(SOURCE, "utf8"));
	const counts = Object.entries(PARTS).map(([name, part]) => [
		name,
		part(messaging).reduce((sum, text) => sum + words(text), 0),
	]);
	const total = counts.reduce((sum, [, count]) => sum + count, 0);
	const summary = `${total} words (${counts.map(([name, count]) => `${name} ${count}`).join(", ")})`;
	if (total >= LIMIT) {
		console.error(
			`The homepage's prose in ${relative(ROOT, SOURCE)} is ${summary}; it has to stay under ${LIMIT}.\n` +
				"Cut words rather than raise the limit (docs/site-design.md §4.8).",
		);
		process.exit(1);
	}
	console.log(`The homepage's prose is ${summary}, under ${LIMIT}.`);
}
